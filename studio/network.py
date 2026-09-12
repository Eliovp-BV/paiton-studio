"""Discover this host's addresses without trusting client-supplied DNS names."""
import json
import os
import socket
import subprocess


def local_hosts():
    hosts = {'localhost', '127.0.0.1', '::1', socket.gethostname().lower()}
    try:
        hosts.update(item[4][0] for item in socket.getaddrinfo(socket.gethostname(), None))
    except socket.gaierror:
        pass
    # Linux discovery includes interfaces not registered in hostname resolution.
    # Other platforms can use hostname resolution or explicit allowed hosts.
    try:
        result = subprocess.run(['ip', '-j', 'address', 'show'], capture_output=True,
                                text=True, timeout=3, check=True)
        hosts.update(address['local'] for interface in json.loads(result.stdout)
                     for address in interface.get('addr_info', [])
                     if address.get('family') in ('inet', 'inet6'))
    except (OSError, subprocess.SubprocessError, ValueError, KeyError):
        pass
    hosts.update(value.strip().lower() for value in
                 os.environ.get('PAITON_STUDIO_ALLOWED_HOSTS', '').split(',') if value.strip())
    return hosts


def allowed_authorities():
    port = int(os.environ.get('PAITON_STUDIO_PORT', '8877'))
    authorities = set()
    for host in local_hosts():
        host = f'[{host}]' if ':' in host else host
        authorities.add(f'{host}:{port}')
        if port in (80,443):
            authorities.add(host)
    return authorities
