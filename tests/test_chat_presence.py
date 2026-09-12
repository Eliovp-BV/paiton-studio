from studio.runtime import Runtime
from studio.store import Store
from studio.app import create_app
from fastapi.testclient import TestClient


def test_presence_keeps_loaded_model_beyond_reply_timeout_then_expires(tmp_path,monkeypatch):
    clock=[1000.0]
    monkeypatch.setattr('studio.runtime.time.monotonic',lambda:clock[0])
    runtime=Runtime(Store(tmp_path),{'gptoss_image':'pinned'})
    runtime._warm={'container':'owned','image':'pinned','until':1120,'package':'gptoss','revision':'pinned-revision'}
    clock[0]=1110;runtime.touch_chat()
    clock[0]=1200
    assert not runtime.warm_expired()
    assert runtime.warm_for({'profile':{'package':'gptoss','revision':'pinned-revision'}})
    assert not runtime.warm_for({'profile':{'package':'flux'}})
    clock[0]=1231
    assert runtime.warm_expired()
    assert not runtime.warm_for({'profile':{'package':'gptoss','revision':'pinned-revision'}})


def test_presence_never_loads_a_model_and_requires_local_session(tmp_path):
    app=create_app(data=tmp_path,config={},worker_enabled=False)
    with TestClient(app) as client:
        assert client.post('/api/chat-presence',json={}).status_code==401
        token=client.get('/api/session').json()['token']
        assert client.post('/api/chat-presence',json={}).status_code==403
        assert client.post('/api/chat-presence',json={},headers={'X-Studio-Token':token}).status_code==200
        assert client.get('/api/status').json()['chat_model_ready'] is False
