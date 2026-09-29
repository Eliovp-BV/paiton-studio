"""Discover this host's addresses without trusting client-supplied DNS names."""
import ipaddress
import json
import os
import re
import socket
import subprocess
from urllib.parse import urlsplit

# Container and VM plumbing is reached from inside containers and guests, not
# from a person's browser: Docker's bridges (docker0, br-<network id>),
# libvirt's virbr bridges, veth ends, VM taps and dummy links. A tun device
# stays: OpenVPN and Tailscale users browse Studio over it.
VIRTUAL_PREFIXES = ('docker', 'veth', 'virbr')
DOCKER_NETWORK = re.compile(r'^br-[0-9a-f]{12}$')
VIRTUAL_KINDS = {'veth', 'dummy'}
# Without link details (older iproute2) a bridge is recognised by its name.
BRIDGE_NAME = re.compile(r'^br|br\d+$')


def _name(interface):
    return str(interface.get('ifname') or '').lower()


def _kind(interface):
    return str((interface.get('linkinfo') or {}).get('info_kind') or '').lower()


def _tun_type(interface):
    return str(((interface.get('linkinfo') or {}).get('info_data') or {}).get('type') or '').lower()


def _is_virtual(interface):
    name, kind = _name(interface), _kind(interface)
    if name.startswith(VIRTUAL_PREFIXES) or DOCKER_NETWORK.match(name) or kind in VIRTUAL_KINDS:
        return True
    return kind == 'tun' and _tun_type(interface) == 'tap'


def _browsable(interface, by_name, slaves, seen=()):
    """A link is browsable when it is not container plumbing and, for a bridge, bond
    or VLAN, when its uplink leads to a physical port (br0 <- bond0 <- eno1)."""
    name = _name(interface)
    if _is_virtual(interface) or name in seen:
        return False
    seen = seen + (name,)
    parent = str(interface.get('link') or '').lower()
    if parent in by_name:
        return _browsable(by_name[parent], by_name, slaves, seen)
    members = slaves.get(name, ())
    if members or _kind(interface) == 'bridge' or BRIDGE_NAME.search(name):
        return any(_browsable(member, by_name, slaves, seen) for member in members)
    return True


def browsable_interfaces(interfaces):
    """Keep loopback, physical links, Wi-Fi, VPN tunnels and bridges that carry a physical port."""
    by_name = {_name(interface): interface for interface in interfaces}
    slaves = {}
    for interface in interfaces:
        master = str(interface.get('master') or '').lower()
        if master:
            slaves.setdefault(master, []).append(interface)
    for interface in interfaces:
        if _browsable(interface, by_name, slaves):
            yield interface


def local_hosts():
    hosts = {'localhost', '127.0.0.1', '::1', socket.gethostname().lower()}
    try:
        hosts.update(item[4][0] for item in socket.getaddrinfo(socket.gethostname(), None))
    except socket.gaierror:
        pass
    # Linux discovery includes interfaces not registered in hostname resolution.
    # Other platforms can use hostname resolution or explicit allowed hosts.
    try:
        result = subprocess.run(['ip', '-j', '-details', 'address', 'show'], capture_output=True,
                                text=True, timeout=3, check=True)
        hosts.update(address['local'] for interface in browsable_interfaces(json.loads(result.stdout))
                     for address in interface.get('addr_info', [])
                     if address.get('family') in ('inet', 'inet6'))
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, AttributeError, TypeError):
        pass
    hosts.update(value.strip().lower() for value in
                 os.environ.get('PAITON_STUDIO_ALLOWED_HOSTS', '').split(',') if value.strip())
    return hosts


def _host_port(value, default_port):
    """Accept a host or an explicit browser authority, including tunnel ports."""
    if not value or any(character.isspace() for character in value):
        return None
    try:
        ipaddress.ip_address(value)
        return value, default_port
    except ValueError:
        pass
    if ('[' in value or ']' in value) and not re.fullmatch(r'\[[^\[\]]+\](?::[0-9]+)?', value):
        return None
    try:
        parsed = urlsplit(f'//{value}')
        host, port = parsed.hostname, parsed.port
    except ValueError:
        return None
    if (not host or parsed.username is not None or parsed.password is not None
            or parsed.path or parsed.query or parsed.fragment or value.endswith(':')
            or any(character in value for character in '/?#@')):
        return None
    if value.startswith('['):
        try:
            ipaddress.IPv6Address(host)
        except ValueError:
            return None
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if not re.fullmatch(r'[a-z0-9_.-]+', host):
            return None
    port = default_port if port is None else port
    return (host, port) if 1 <= port <= 65535 else None


def allowed_authorities():
    port = int(os.environ.get('PAITON_STUDIO_PORT', '8877'))
    authorities = set()
    for value in local_hosts():
        parsed = _host_port(value, port)
        if parsed is None:
            continue
        host, host_port = parsed
        host = f'[{host}]' if ':' in host else host
        authorities.add(f'{host}:{host_port}')
        if host_port in (80,443):
            authorities.add(host)
    return authorities
