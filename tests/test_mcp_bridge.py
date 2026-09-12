import json
import pytest
from fastapi.testclient import TestClient
from studio.app import create_app
from studio.registry import profile
from studio.mcp_bridge import ConnectionInput
from studio.smtp_connector import SMTPSettings
from studio.mail_core import consent

@pytest.fixture
def connection(tmp_path,monkeypatch):
    monkeypatch.setattr('studio.mcp_bridge.resolve_profile',lambda *a:profile('gptoss-chat','write','chat'))
    app=create_app(tmp_path,{},worker_enabled=False)
    with TestClient(app) as c:
        token=c.get('/api/session').json()['token'];c.headers['x-studio-token']=token
        p=c.post('/api/projects',json={'name':'MCP project'}).json()['id']
        bridge=app.state.mcp_bridge
        bridge.configure(p,ConnectionInput(enabled=True))
        config=bridge.configuration(p,'http://testserver')['mcpServers']['paiton-studio']
        yield c,bridge,p,config['headers']['Authorization']


def rpc(c,auth,method,params=None,identity=1):
    return c.post('/mcp/',headers={'Authorization':auth,'Accept':'application/json, text/event-stream'},json={'jsonrpc':'2.0','id':identity,'method':method,'params':params or {}})


def tool(c,auth,name,arguments={}):
    response=rpc(c,auth,'tools/call',{'name':name,'arguments':arguments})
    assert response.status_code==200,response.text
    body=response.json()['result']
    if body.get('isError'):return body
    return body.get('structuredContent') or json.loads(body['content'][0]['text'])


def test_actual_http_protocol_local_queue_and_scope(connection):
    c,b,p,auth=connection
    assert rpc(c,'','tools/list').status_code==401
    response=rpc(c,auth,'initialize',{'protocolVersion':'2026-07-28','capabilities':{},'clientInfo':{'name':'Studio test','version':'1'}})
    assert response.status_code==200,response.text
    assert response.json()['result']['serverInfo']['name']=='Paiton Studio'
    names={t['name'] for t in rpc(c,auth,'tools/list').json()['result']['tools']}
    assert names=={'assist_email','get_result','cancel_request','smtp_status','prepare_email','get_delivery'}
    args={'operation':'draft_reply','text':'Confirm Monday at 9.','client_id':'http-request-000000001'}
    result=tool(c,auth,'assist_email',args)
    assert result['state']=='queued'
    assert tool(c,auth,'assist_email',args)['request_id']==result['request_id']
    request=b.store.rows('SELECT * FROM mcp_requests WHERE id=?',(result['request_id'],))[0]
    job=b.store.job(request['job'])
    assert job['request']['profile']['package']=='gptoss' and 'tools' not in job['request']
    assert 'untrusted' in job['request']['messages'][0]['content']
    asset=b.store.add_asset(p,'text','Test reply',b'Monday at 9 works.','.md',{})
    b.store.status(job['id'],'completed','Saved',asset=asset['id'])
    assert tool(c,auth,'get_result',{'request_id':result['request_id']})['text']=='Monday at 9 works.'
    other=b.store.create_project('Other')['id'];b.configure(other,ConnectionInput(enabled=True))
    auth2=b.configuration(other,'http://testserver')['mcpServers']['paiton-studio']['headers']['Authorization']
    assert tool(c,auth2,'get_result',{'request_id':result['request_id']})['isError']
    b.configure(p,ConnectionInput(enabled=False))
    assert rpc(c,auth,'tools/list').status_code==401


def test_queue_cap_and_cancel(connection):
    c,b,p,auth=connection
    results=[tool(c,auth,'assist_email',{'operation':'summarize','text':'Text','client_id':f'bounded-request-{i:04}'}) for i in range(3)]
    assert tool(c,auth,'assist_email',{'operation':'summarize','text':'Text','client_id':'bounded-request-0004'})['isError']
    assert tool(c,auth,'cancel_request',{'request_id':results[0]['request_id']})['state']=='cancelled'
    assert tool(c,auth,'assist_email',{'operation':'summarize','text':'Text','client_id':'bounded-request-0004'})['state']=='queued'


def test_smtp_config_preparation_never_sends(connection,monkeypatch):
    c,b,p,auth=connection
    sends=[];monkeypatch.setattr('studio.smtp_connector.deliver',lambda *a:sends.append(a))
    response=c.post('/api/projects/'+p+'/mcp/smtp',json={'host':'smtp.example.org','sender':'studio@example.org','username':'studio','password':'PRIVATE-PASSWORD'})
    assert response.status_code==200,response.text
    assert 'PRIVATE-PASSWORD' not in response.text
    result=tool(c,auth,'prepare_email',{'recipient':'ada@example.org','subject':'Workshop','body':'Monday at 9 works.','client_id':'smtp-prepare-000001'})
    assert result['state']=='awaiting_owner' and 'X-Unsent: 1' in result['draft_eml'] and not sends
    rows=b.store.rows('SELECT * FROM smtp_deliveries WHERE id=?',(result['id'],))
    monkeypatch.setattr(consent,'_WIN',False);monkeypatch.setattr(consent,'_MAC',False)
    with pytest.raises(ValueError,match='unavailable'):b.smtp.approve(result['id'],rows[0]['snapshot'])
    assert not sends
    assert 'password' not in json.dumps(tool(c,auth,'smtp_status'))
    assert c.get('/api/projects/'+p+'/mail').status_code==410
    assert c.post('/api/projects/'+p+'/mail/accounts/anything/sync',json={}).status_code==410


def test_smtp_verified_login_without_send(connection,monkeypatch):
    c,b,p,auth=connection
    b.smtp.save(p,SMTPSettings(host='smtp.example.org',sender='studio@example.org',username='studio',password='secret'))
    events=[]
    class SMTP:
        def __init__(self,*a,**kw):events.append('connect')
        def __enter__(self):return self
        def __exit__(self,*a):pass
        def ehlo(self):events.append('ehlo')
        def starttls(self,context):
            assert context.check_hostname;events.append('tls')
        def login(self,*a):events.append('login')
        def send_message(self,*a):raise AssertionError('No send allowed during test')
    monkeypatch.setattr('studio.smtp_connector.smtplib.SMTP',SMTP)
    assert 'succeeded' in b.smtp.test(p)['message']
    assert events==['connect','ehlo','tls','ehlo','login']


def test_source_and_config(connection):
    c,b,p,auth=connection
    config=c.get('/api/projects/'+p+'/mcp/config').json()
    assert config['mcpServers']['paiton-studio']['url']=='http://testserver/mcp/'
    assert c.get('/api/mcp/source').status_code==200
    assert c.get('/api/mcp/license').status_code==200
    assert rpc(c,auth,'tools/list').status_code==200
    assert c.post('/mcp/',headers={'Authorization':auth,'Origin':'https://evil.example'},json={}).status_code==403


def test_smtp_account_binding_disconnect_and_no_retry(connection,monkeypatch):
    c,b,p,auth=connection
    account=SMTPSettings(host='smtp.example.org',sender='studio@example.org',username='studio',password='secret')
    b.smtp.save(p,account)
    with pytest.raises(ValueError,match='Re-enter'):
        b.smtp.save(p,SMTPSettings(host='different.example.org',sender='studio@example.org',username='studio'))
    result=tool(c,auth,'prepare_email',{'recipient':'ada@example.org','subject':'Workshop','body':'Monday at 9 works.','client_id':'smtp-prepare-unique01'})
    snapshot=b.store.rows('SELECT snapshot FROM smtp_deliveries WHERE id=?',(result['id'],))[0]['snapshot']
    monkeypatch.setattr(consent,'require_human',lambda _:True)
    attempts=[]
    def uncertain(*_):attempts.append(1);raise TimeoutError()
    monkeypatch.setattr('studio.smtp_connector.deliver',uncertain)
    assert b.smtp.approve(result['id'],snapshot)['state']=='uncertain'
    with pytest.raises(ValueError):b.smtp.approve(result['id'],snapshot)
    assert attempts==[1]
    assert c.delete('/api/projects/'+p+'/mcp/smtp').status_code==200
    assert not b.smtp.status(p)['configured']
