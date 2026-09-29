"""LAN session security: synthetic socket peers, no hardware or workers."""
from fastapi.testclient import TestClient
from studio.app import create_app


def clients(tmp_path):
    app=create_app(data=tmp_path,config={},worker_enabled=False)
    local=TestClient(app,client=('127.0.0.1',5000))
    remote=TestClient(app,client=('192.0.2.4',5001))
    session=local.get('/api/session').json()
    local.headers['x-studio-token']=session['token']
    return app,local,remote,session['token']


def test_lan_never_receives_owner_token_and_requires_one_time_pairing(tmp_path):
    app,local,remote,owner=clients(tmp_path)
    response=remote.get('/api/session')
    assert response.status_code==401 and response.json()['pairing_required']
    assert 'set-cookie' not in response.headers and owner not in response.text
    # A legacy/copied owner cookie does not authorize a remote socket.
    remote.cookies.set('studio_session',owner)
    assert remote.get('/api/projects').status_code==401
    code=local.put('/api/network-access',json={'enabled':True}).json()['pairing_token']
    assert remote.get('/api/session').status_code==401
    response=remote.post('/api/session/pair',json={'code':code,'name':'Synthetic browser'})
    assert response.status_code==200 and response.json()['token']!=owner
    assert 'HttpOnly' in response.headers['set-cookie'] and 'SameSite=strict' in response.headers['set-cookie']
    remote.headers['x-studio-token']=response.json()['token']
    resumed=remote.get('/api/session')
    assert resumed.status_code==200
    assert resumed.json()=={'token':response.json()['token'],'local_owner':False}
    # A late read must not overwrite the cookie from a newer successful pairing.
    assert 'set-cookie' not in resumed.headers
    assert remote.get('/api/projects').status_code==200
    assert remote.post('/api/projects',json={}).status_code==200
    assert remote.post('/api/session/pair',json={'code':code}).status_code==400
    assert remote.get('/api/network-access').json()['local_owner'] is False
    assert remote.put('/api/network-access',json={'enabled':False}).status_code==403
    assert remote.post('/api/network-access/token',json={}).status_code==403


def test_revocation_disable_and_csrf_protect_remote_session(tmp_path):
    app,local,remote,owner=clients(tmp_path)
    code=local.put('/api/network-access',json={'enabled':True}).json()['pairing_token']
    token=remote.post('/api/session/pair',json={'code':code}).json()['token']
    assert remote.post('/api/projects',json={}).status_code==403
    remote.headers['x-studio-token']=token
    assert remote.post('/api/projects',json={},headers={'Origin':'http://attacker.invalid'}).status_code==403
    device=local.get('/api/network-access').json()['devices'][0]['id']
    assert local.delete('/api/network-access/devices/'+device).status_code==200
    assert remote.get('/api/projects').status_code==401
    code=local.post('/api/network-access/token',json={}).json()['pairing_token']
    token=remote.post('/api/session/pair',json={'code':code}).json()['token']
    remote.headers['x-studio-token']=token
    assert remote.get('/api/projects').status_code==200
    local.put('/api/network-access',json={'enabled':False})
    assert remote.get('/api/projects').status_code==401
    assert local.get('/api/projects').status_code==200


def test_forwarded_and_host_headers_cannot_bootstrap_local_owner(tmp_path):
    app,local,remote,owner=clients(tmp_path)
    for header in ({'x-forwarded-for':'127.0.0.1'},{'forwarded':'for=127.0.0.1'},{'x-real-ip':'127.0.0.1'}):
        assert remote.get('/api/session',headers=header).status_code==401
        assert local.get('/api/session',headers=header).status_code==401
    assert remote.get('/api/session',headers={'host':'localhost:8877'}).status_code in (401,403)
    assert remote.get('/api/session',headers={'host':'attacker.invalid'}).status_code==403
    assert remote.post('/api/session/pair',json={'code':'invalid'},headers={'origin':'http://attacker.invalid'}).status_code==403


def test_explicit_tunnel_port_preserves_session_origin_and_pairing_rules(tmp_path, monkeypatch):
    monkeypatch.setenv('PAITON_STUDIO_PORT', '8877')
    monkeypatch.setenv('PAITON_STUDIO_ALLOWED_HOSTS', 'localhost:51148')
    app = create_app(data=tmp_path, config={}, worker_enabled=False)
    with TestClient(app, base_url='http://localhost:51148', client=('127.0.0.1', 5000)) as local:
        response = local.get('/api/session')
        assert response.status_code == 200 and response.json()['local_owner'] is True
        local.headers['x-studio-token'] = response.json()['token']
        local.headers['origin'] = 'http://localhost:51148'
        assert local.get('/api/projects').status_code == 200
        assert local.post('/api/projects', json={}).status_code == 200
        for origin in ('http://localhost:51149', 'https://attacker.invalid'):
            assert local.get('/api/projects', headers={'origin': origin}).status_code == 403
        assert local.get('/api/session', headers={'host': 'localhost:51149'}).status_code == 403
        assert local.get('/api/session', headers={'x-forwarded-for': '127.0.0.1'}).status_code == 401
        native = TestClient(app, base_url='http://localhost:8877', client=('127.0.0.1', 5001))
        assert native.get('/api/session').status_code == 200
        remote = TestClient(app, base_url='http://localhost:51148', client=('192.0.2.4', 5002))
        response = remote.get('/api/session')
        assert response.status_code == 401 and response.json()['pairing_required'] is True
