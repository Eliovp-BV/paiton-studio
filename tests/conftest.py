"""CPU policy tests use an explicit device fixture, never physical GPU inference."""
import pytest


@pytest.fixture(autouse=True)
def api_hardware_fixture(monkeypatch):
    reading = dict(driver_available=True, supported=True, available=True, gpu_count=1,
                   name='AMD Radeon AI PRO R9700', architecture='gfx1201',
                   total=32*1024**3, used=0, pids=[])
    monkeypatch.setattr('studio.app.gpu_status', lambda: reading.copy())
    monkeypatch.setattr('studio.preferences.gpu_status', lambda: reading.copy())


@pytest.fixture(autouse=True)
def browser_socket_fixture(monkeypatch):
    """Ordinary tests model the host browser; LAN tests supply their own peer."""
    from inspect import signature
    from fastapi.testclient import TestClient
    original = TestClient.__init__
    parameters = signature(original)
    def initialize(self, *args, **kwargs):
        supplied = parameters.bind_partial(self, *args, **kwargs)
        if 'client' not in supplied.arguments:
            kwargs['client'] = ('127.0.0.1', 50000)
        original(self, *args, **kwargs)
    monkeypatch.setattr(TestClient, '__init__', initialize)
