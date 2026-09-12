"""CPU policy tests use an explicit device fixture, never physical GPU inference."""
import pytest


@pytest.fixture(autouse=True)
def api_hardware_fixture(monkeypatch):
    reading = dict(driver_available=True, supported=True, available=True, gpu_count=1,
                   name='AMD Radeon AI PRO R9700', architecture='gfx1201',
                   total=32*1024**3, used=0, pids=[])
    monkeypatch.setattr('studio.app.gpu_status', lambda: reading.copy())
    monkeypatch.setattr('studio.preferences.gpu_status', lambda: reading.copy())
