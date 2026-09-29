"""Host discovery keeps addresses a browser can reach and skips container bridges."""
import json
from subprocess import CompletedProcess

import pytest

from studio import network


def link(ifname, addresses, kind=None, master=None, parent=None, tun_type=None):
    entry = {'ifname': ifname, 'link_type': 'ether', 'operstate': 'UP', 'addr_info': [
        {'family': 'inet6' if ':' in address else 'inet', 'local': address, 'scope': 'global'} for address in addresses]}
    if kind:
        entry['linkinfo'] = {'info_kind': kind}
    if tun_type:
        entry.setdefault('linkinfo', {})['info_data'] = {'type': tun_type}
    if parent:
        entry['link'] = parent
    if master:
        entry['master'] = master
        entry.setdefault('linkinfo', {})['info_slave_kind'] = 'bond_slave' if master.startswith('bond') else 'bridge_slave'
    return entry


PAYLOAD = [
    link('lo', ['127.0.0.1', '::1']),
    link('enp5s0', ['192.168.10.20', 'fe80::1']),
    link('wlp3s0', ['192.168.10.21']),
    link('docker0', ['172.17.0.1'], kind='bridge'),
    link('docker1', ['172.19.0.1']),
    link('br-0018a8c119c5', ['172.18.0.1'], kind='bridge'),
    link('veth1a2b3c', ['fe80::2'], kind='veth', master='docker0'),
    link('virbr0', ['192.168.122.1'], kind='bridge'),
    link('lxdbr0', ['10.0.0.1'], kind='bridge'),
    link('br0', ['192.168.10.30'], kind='bridge'),
    link('eno1', [], master='br0'),
]


def browsable(payload):
    return [entry['ifname'] for entry in network.browsable_interfaces(payload)]


def test_local_hosts_skip_container_bridges_but_keep_browsable_addresses(monkeypatch):
    calls = []
    def run(args, **kwargs):
        calls.append(args)
        return CompletedProcess(args, 0, json.dumps(PAYLOAD), '')
    monkeypatch.setattr(network.subprocess, 'run', run)
    monkeypatch.setattr(network.socket, 'gethostname', lambda: 'Studio-Host')
    monkeypatch.setattr(network.socket, 'getaddrinfo', lambda *args, **kwargs: [(None, None, None, None, ('192.168.10.20', 0))])
    monkeypatch.delenv('PAITON_STUDIO_ALLOWED_HOSTS', raising=False)
    monkeypatch.setenv('PAITON_STUDIO_PORT', '8877')
    hosts = network.local_hosts()
    assert calls == [['ip', '-j', '-details', 'address', 'show']]
    assert {'localhost', 'studio-host', '127.0.0.1', '::1', '192.168.10.20', 'fe80::1', '192.168.10.21', '192.168.10.30'} <= hosts
    assert hosts.isdisjoint({'172.17.0.1', '172.19.0.1', '172.18.0.1', 'fe80::2', '192.168.122.1', '10.0.0.1'})
    authorities = network.allowed_authorities()
    assert '192.168.10.20:8877' in authorities and '[fe80::1]:8877' in authorities
    assert '172.17.0.1:8877' not in authorities and '172.18.0.1:8877' not in authorities


def test_docker_libvirt_and_veth_links_are_excluded_and_wifi_is_kept():
    kept = browsable(PAYLOAD)
    assert 'wlp3s0' in kept and 'enp5s0' in kept and 'lo' in kept
    assert {'docker0', 'docker1', 'br-0018a8c119c5', 'veth1a2b3c', 'virbr0', 'lxdbr0'}.isdisjoint(kept)


def test_docker_network_bridge_with_veth_slaves_is_excluded():
    payload = [link('br-1234567890ab', ['172.20.0.1'], kind='bridge'),
               link('veth9f8e7d', [], kind='veth', master='br-1234567890ab'),
               link('vethabc123', [], kind='veth', master='br-1234567890ab')]
    assert browsable(payload) == []


def test_bridge_on_a_bond_keeps_the_lan_address():
    payload = [link('eno1', [], master='bond0'), link('eno2', [], master='bond0'),
               link('bond0', [], kind='bond', master='br0'), link('br0', ['192.168.10.40'], kind='bridge')]
    assert 'br0' in browsable(payload)


def test_bridge_on_a_vlan_sub_interface_keeps_the_lan_address():
    payload = [link('eno1', []), link('eno1.100', [], kind='vlan', parent='eno1', master='br0'),
               link('br0', ['10.100.0.5'], kind='bridge')]
    assert 'br0' in browsable(payload)


def test_bridge_named_br_lan_with_a_physical_port_is_kept():
    payload = [link('br-lan', ['192.168.1.1'], kind='bridge'), link('eno1', [], master='br-lan')]
    assert 'br-lan' in browsable(payload)


def test_bridge_without_a_physical_port_is_excluded():
    payload = [link('cni0', ['10.244.0.1'], kind='bridge'), link('veth0a1b2c', [], kind='veth', master='cni0'),
               link('br0', ['192.168.50.1'], kind='bridge'), link('vnet0', [], kind='tun', tun_type='tap', master='br0'),
               link('tap5', ['10.9.0.1'], kind='tun', tun_type='tap'), link('dummy0', ['10.8.0.1'], kind='dummy')]
    assert browsable(payload) == []


def test_vpn_tunnels_and_vlans_on_physical_ports_are_kept():
    payload = [link('eno1', ['192.168.10.20']), link('eno1.200', ['10.200.0.2'], kind='vlan', parent='eno1'),
               link('tun0', ['10.8.0.6'], kind='tun', tun_type='tun'), link('wg0', ['10.7.0.2'], kind='wireguard'),
               link('tailscale0', ['100.64.0.1'], kind='tun', tun_type='tun')]
    assert browsable(payload) == ['eno1', 'eno1.200', 'tun0', 'wg0', 'tailscale0']


def test_older_ip_output_without_link_details_still_filters_by_name(monkeypatch):
    payload = [{key: value for key, value in entry.items() if key != 'linkinfo'} for entry in PAYLOAD]
    monkeypatch.setattr(network.subprocess, 'run', lambda args, **kwargs: CompletedProcess(args, 0, json.dumps(payload), ''))
    monkeypatch.setattr(network.socket, 'getaddrinfo', lambda *args, **kwargs: [])
    hosts = network.local_hosts()
    assert {'127.0.0.1', '192.168.10.20', '192.168.10.21', '192.168.10.30'} <= hosts
    assert hosts.isdisjoint({'172.17.0.1', '172.19.0.1', '172.18.0.1', 'fe80::2', '192.168.122.1', '10.0.0.1'})


def test_unexpected_ip_output_leaves_hostname_discovery_intact(monkeypatch):
    monkeypatch.setattr(network.subprocess, 'run', lambda args, **kwargs: CompletedProcess(args, 0, '{"not": "a list"}', ''))
    monkeypatch.setattr(network.socket, 'getaddrinfo', lambda *args, **kwargs: [])
    assert {'localhost', '127.0.0.1', '::1'} <= network.local_hosts()


@pytest.fixture
def local_authority_discovery(monkeypatch):
    monkeypatch.setattr(network.subprocess, 'run', lambda args, **kwargs: CompletedProcess(args, 0, '[]', ''))
    monkeypatch.setattr(network.socket, 'gethostname', lambda: 'studio-host')
    monkeypatch.setattr(network.socket, 'getaddrinfo', lambda *args, **kwargs: [])
    monkeypatch.setenv('PAITON_STUDIO_PORT', '8877')
    monkeypatch.delenv('PAITON_STUDIO_ALLOWED_HOSTS', raising=False)
    return {'localhost:8877', '127.0.0.1:8877', '[::1]:8877', 'studio-host:8877'}


def test_explicit_forwarded_authorities_preserve_native_port(local_authority_discovery, monkeypatch):
    monkeypatch.setenv('PAITON_STUDIO_ALLOWED_HOSTS',
                      ' localhost:51148 , 127.0.0.1:51148, [::1]:51148, Studio.LAN, preview.lan:51148 ')
    assert network.allowed_authorities() == local_authority_discovery | {
        'localhost:51148', '127.0.0.1:51148', '[::1]:51148', 'studio.lan:8877', 'preview.lan:51148'}


def test_bare_ipv6_keeps_the_configured_port(local_authority_discovery, monkeypatch):
    monkeypatch.setenv('PAITON_STUDIO_ALLOWED_HOSTS', '2001:db8::2')
    assert network.allowed_authorities() == local_authority_discovery | {'[2001:db8::2]:8877'}


@pytest.mark.parametrize('port', [80, 443])
def test_explicit_standard_port_accepts_browser_authority_without_port(local_authority_discovery, monkeypatch, port):
    monkeypatch.setenv('PAITON_STUDIO_ALLOWED_HOSTS', f'preview.lan:{port},[2001:db8::2]:{port}')
    assert network.allowed_authorities() == local_authority_discovery | {
        f'preview.lan:{port}', 'preview.lan', f'[2001:db8::2]:{port}', '[2001:db8::2]'}


@pytest.mark.parametrize('invalid', [
    '*', '*.example.com', '*:51148', ':51148', 'localhost:', 'localhost:0',
    'localhost:65536', 'localhost:-1', 'localhost:+51148', 'localhost:not-a-port',
    'http://localhost:51148', 'user@localhost:51148', 'localhost:51148/path',
    'localhost:51148?query=yes', 'localhost:51148#fragment', 'local host:51148',
    'localhost\n:51148', 'localhost:51148:80', '[::1', '[::1]junk:51148',
    '[not-ipv6]:51148', '[v1.localhost]:51148', 'localhost\\evil:51148',
])
def test_invalid_entries_do_not_expand_valid_authorities(local_authority_discovery, monkeypatch, invalid):
    monkeypatch.setenv('PAITON_STUDIO_ALLOWED_HOSTS', f'{invalid},localhost:51148')
    assert network.allowed_authorities() == local_authority_discovery | {'localhost:51148'}
