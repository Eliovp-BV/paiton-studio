import json
import pytest
from fastapi.testclient import TestClient
from studio.app import create_app
from studio.registry import profile
from studio.mcp_agents import AgentServers


@pytest.fixture
def app_client(tmp_path, monkeypatch):
    for module in ('studio.agents', 'studio.mcp_agents'):
        monkeypatch.setattr(module+'.resolve_profile', lambda *a: profile('gptoss-chat','write','chat'))
    app = create_app(tmp_path, {}, worker_enabled=False)
    with TestClient(app) as client:
        client.headers['x-studio-token'] = client.get('/api/session').json()['token']
        yield app, client


def create(client, project, name='Document expert'):
    agent = client.post(f'/api/projects/{project}/agents', json={'name':name,'purpose':'Summarize only the approved facts.','template':'brief'}).json()
    response = client.post(f'/api/projects/{project}/mcp-servers', json={'agent_id':agent['id']})
    assert response.status_code == 200, response.text
    server = response.json()
    assert not server['enabled'] and 'token' not in server
    return server


def enable(client, project, server):
    base = f"/api/projects/{project}/mcp-servers/{server['id']}"
    assert client.post(base, json={'enabled':True}).status_code == 200
    config = client.get(base+'/config').json()
    entry = next(iter(config['mcpServers'].values()))
    assert entry['url'] == 'http://testserver/mcp/agents/'
    return entry['headers']['Authorization']


def rpc(c, auth, method, params=None, origin=None):
    headers = {'Authorization':auth,'Accept':'application/json, text/event-stream'}
    if origin: headers['Origin'] = origin
    return c.post('/mcp/agents/', headers=headers, json={'jsonrpc':'2.0','id':1,'method':method,'params':params or {}})


def tool(c, auth, name, arguments=None):
    response = rpc(c, auth, 'tools/call', {'name':name,'arguments':arguments or {}})
    assert response.status_code == 200, response.text
    result = response.json()['result']
    return result if result.get('isError') else result.get('structuredContent') or json.loads(result['content'][0]['text'])


def test_protocol_scope_revocation_and_durable_retry(app_client):
    app,c = app_client
    p = c.post('/api/projects').json()['id']
    a = create(c,p); b = create(c,p,'Other expert')
    # Registration retries cannot create duplicate servers or rotate their grants.
    assert c.post(f'/api/projects/{p}/mcp-servers',json={'agent_id':a['agent']}).json()['id']==a['id']
    auth=enable(c,p,a); other=enable(c,p,b)
    assert rpc(c,'','tools/list').status_code == 401
    assert rpc(c,auth,'tools/list',origin='https://evil.example').status_code == 403
    init=rpc(c,auth,'initialize',{'protocolVersion':'2026-07-28','capabilities':{},'clientInfo':{'name':'test','version':'1'}})
    assert init.status_code==200
    assert {t['name'] for t in rpc(c,auth,'tools/list').json()['result']['tools']} == {'server_info','run_agent','get_result','cancel_request'}
    assert tool(c,auth,'server_info')['name']=='Document expert'
    assert tool(c,other,'server_info')['name']=='Other expert'
    args={'instruction':'Summarize these facts: we meet Monday.','client_id':'agent-client-request-001'}
    result=tool(c,auth,'run_agent',args)
    assert result['state']=='drafting' and result['step_state']=='queued'
    assert tool(c,auth,'run_agent',args)['request_id']==result['request_id']
    # Reconstruct controller: same client request resumes the durable run.
    rebuilt=AgentServers(app.state.agent_servers.agents)
    assert rebuilt.result(auth,result['request_id'])['state']=='drafting'
    assert len(app.state.store.rows('SELECT id FROM agent_runs'))==1
    assert tool(c,other,'get_result',{'request_id':result['request_id']})['isError']
    assert tool(c,auth,'run_agent',{**args,'client_id':'agent-client-request-002'})['isError']
    assert 'snapshot' not in result and 'jobs' not in result
    cancelled=tool(c,auth,'cancel_request',{'request_id':result['request_id']})
    assert cancelled['state']=='cancelled'
    new_auth=enable(c,p,a)
    assert rpc(c,auth,'tools/list').status_code==401
    assert tool(c,new_auth,'get_result',{'request_id':result['request_id']})['isError']
    c.post(f"/api/projects/{p}/mcp-servers/{a['id']}",json={'enabled':False})
    assert rpc(c,new_auth,'tools/list').status_code==401
    # Mail credentials cannot grant access to agent tools, or vice versa.
    assert c.post('/mcp/',headers={'Authorization':other},json={}).status_code==401


def test_two_step_results_and_project_quota(app_client):
    app,c=app_client;bridge=app.state.agent_servers;store=app.state.store
    p=c.post('/api/projects').json()['id']; servers=[create(c,p,f'Agent {i}') for i in range(4)]
    auth=[enable(c,p,s) for s in servers]
    args={'instruction':'Write a brief.','client_id':'agent-client-request-001'}
    results=[tool(c,t,'run_agent',args) for t in auth[:3]]
    assert tool(c,auth[3],'run_agent',args)['isError']
    grant=bridge.authorize(auth[0]);run=bridge._run(grant,args['client_id'])
    draft=store.add_asset(p,'text','Test fixture',b'Monday meeting.','.md',{})
    store.status(run['jobs'][0]['id'],'completed','Saved',asset=draft['id'])
    bridge.agents.tick()
    assert bridge.result(auth[0],args['client_id'])['state']=='reviewing'
    run=bridge._run(grant,args['client_id'])
    final=store.add_asset(p,'text','Reviewed fixture',b'Meeting: Monday.','.md',{})
    store.status(run['jobs'][1]['id'],'completed','Saved',asset=final['id'])
    bridge.agents.tick()
    result=tool(c,auth[0],'get_result',{'request_id':args['client_id']})
    assert result['state']=='completed' and result['text']=='Meeting: Monday.' and result['poll_after_seconds'] is None
    assert tool(c,auth[3],'run_agent',args)['state']=='drafting'
    other_project=c.post('/api/projects').json()['id']
    assert c.post(f'/api/projects/{other_project}/mcp-servers',json={'agent_id':servers[0]['agent']}).status_code==400
    assert c.post(f"/api/projects/{other_project}/mcp-servers/{servers[0]['id']}",json={'enabled':True}).status_code==400
    assert c.get(f"/api/projects/{other_project}/mcp-servers/{servers[0]['id']}/config").status_code==400


def test_missing_model_and_atomic_grant_guard(app_client,monkeypatch):
    app,c=app_client;bridge=app.state.agent_servers
    p=c.post('/api/projects').json()['id'];server=create(c,p)
    def unavailable(*a):raise ValueError('Install a model first.')
    monkeypatch.setattr('studio.mcp_agents.resolve_profile',unavailable)
    response=c.post(f"/api/projects/{p}/mcp-servers/{server['id']}",json={'enabled':True})
    assert response.status_code==400 and not bridge.get(p,server['id'])['enabled']
    monkeypatch.setattr('studio.mcp_agents.resolve_profile',lambda *a:profile('gptoss-chat','write','chat'))
    auth=enable(c,p,server)
    # Revoke after the initial authorization but before the queue transaction.
    def revoke(*a):
        with bridge.store.connect() as db:db.execute('UPDATE mcp_agent_servers SET enabled=0')
        return profile('gptoss-chat','write','chat')
    monkeypatch.setattr('studio.agents.resolve_profile',revoke)
    assert tool(c,auth,'run_agent',{'instruction':'A request','client_id':'agent-client-request-001'})['isError']
    assert not bridge.store.rows('SELECT id FROM jobs')
