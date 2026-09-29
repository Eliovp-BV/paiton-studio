"""MCP grants retain existing clients while storing only hashes."""
import pytest
from fastapi.testclient import TestClient
from studio.app import create_app
from studio.registry import profile
from studio.mcp_agents import AgentServers


@pytest.fixture
def fixture(tmp_path,monkeypatch):
    for name in ('studio.agents','studio.mcp_agents'):
        monkeypatch.setattr(name+'.resolve_profile',lambda *a,**k:profile('gptoss-chat','write','chat'))
    app=create_app(tmp_path,{},worker_enabled=False)
    client=TestClient(app,client=('127.0.0.1',5000))
    client.headers['x-studio-token']=client.get('/api/session').json()['token']
    project=client.post('/api/projects').json()['id']
    agent=client.post(f'/api/projects/{project}/agents',json={'name':'Synthetic helper','purpose':'Summarize approved facts.','template':'brief'}).json()
    server=client.post(f'/api/projects/{project}/mcp-servers',json={'agent_id':agent['id']}).json()
    return app,client,project,server


def test_enable_and_rotate_return_secret_once_and_get_cannot_rotate(fixture):
    app,client,project,server=fixture
    base=f'/api/projects/{project}/mcp-servers/{server["id"]}'
    token=client.post(base,json={'enabled':True}).json()['token']
    bridge=app.state.agent_servers
    grant=bridge.authorize('Bearer '+token)
    assert grant['token'].startswith('sha256:') and token not in str(app.state.store.rows('SELECT * FROM mcp_agent_servers'))
    assert client.get(base+'/config').status_code==400
    assert bridge.authorize('Bearer '+token)['generation']==grant['generation']
    assert token not in client.get(f'/api/projects/{project}/mcp-servers').text
    other=client.post(base,json={'enabled':True}).json()['token']
    assert other!=token
    with pytest.raises(ValueError):bridge.authorize('Bearer '+token)
    assert bridge.authorize('Bearer '+other)
    assert 'token' not in client.post(base,json={'enabled':False}).json()
    with pytest.raises(ValueError):bridge.authorize('Bearer '+other)


def test_plaintext_migration_preserves_client_and_generation(fixture):
    app,client,project,server=fixture
    legacy='legacy-client-token-fixture-123456789'
    with app.state.store.connect() as db:
        db.execute('UPDATE mcp_agent_servers SET enabled=1,token=? WHERE id=?',(legacy,server['id']))
    before=app.state.agent_servers.get(project,server['id'])['generation']
    rebuilt=AgentServers(app.state.agent_servers.agents)
    assert rebuilt.authorize('Bearer '+legacy)['generation']==before
    assert legacy not in str(app.state.store.rows('SELECT * FROM mcp_agent_servers'))
    again=AgentServers(app.state.agent_servers.agents)
    assert again.authorize('Bearer '+legacy)['generation']==before


def test_migration_cannot_restore_token_rotated_after_its_snapshot(fixture, monkeypatch):
    app, client, project, server = fixture
    store = app.state.store
    legacy, rotated = 'legacy-token-before-race-12345', 'new-token-after-race-67890'
    import hashlib
    with store.connect() as db:
        db.execute('UPDATE mcp_agent_servers SET enabled=1,token=? WHERE id=?', (legacy, server['id']))
    connect = store.connect
    class RacingConnection:
        def __enter__(self):
            self.db = connect()
            self.db.__enter__()
            return self
        def __exit__(self, *args):
            try:
                return self.db.__exit__(*args)
            finally:
                self.db.close()
        def execute(self, sql, params=()):
            cursor = self.db.execute(sql, params)
            if sql.startswith('SELECT id,token FROM mcp_agent_servers'):
                rows = cursor.fetchall()
                with connect() as writer:
                    writer.execute('UPDATE mcp_agent_servers SET token=?,generation=? WHERE id=?',
                                   ('sha256:'+hashlib.sha256(rotated.encode()).hexdigest(), 'rotated-generation', server['id']))
                class Snapshot:
                    def fetchall(self): return rows
                return Snapshot()
            return cursor
    monkeypatch.setattr(store, 'connect', RacingConnection)
    rebuilt = AgentServers(app.state.agent_servers.agents)
    monkeypatch.setattr(store, 'connect', connect)
    with pytest.raises(ValueError): rebuilt.authorize('Bearer '+legacy)
    assert rebuilt.authorize('Bearer '+rotated)['generation'] == 'rotated-generation'
