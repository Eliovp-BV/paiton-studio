import io
import json
import time
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from studio.app import create_app
from studio.export import export_project,page_html
from studio.media import letterbox
from studio.queue import Worker
from studio.registry import profile
from studio.runtime import Runtime
from studio.store import Store,safe_path

@pytest.fixture
def client(tmp_path):
    app=create_app(tmp_path,config={},worker_enabled=False)
    with TestClient(app) as c:
        c.headers['X-Studio-Token']=c.get('/api/session').json()['token']
        c.store=app.state.store
        yield c

def project(c): return c.post('/api/projects',json={}).json()['id']
def png(size=(40,60)):
    stream=io.BytesIO();Image.new('RGB',size,'red').save(stream,format='PNG');return stream.getvalue()
def image(c,p):
    r=c.post(f'/api/projects/{p}/import',files={'file':('original.png',png(),'image/png')});assert r.status_code==200;return r.json()

def test_sessions_origin_csrf(client):
    assert client.get('/api/projects',headers={'Host':'evil.example'}).status_code==403
    assert client.get('/api/session',headers={'Origin':'https://evil.example'}).status_code==403
    assert client.get('/api/session',headers={'Sec-Fetch-Site':'cross-site'}).status_code==403
    assert client.post('/api/projects',json={},headers={'X-Studio-Token':''}).status_code==403
    client.cookies.clear();assert client.get('/api/projects').status_code==401

@pytest.mark.parametrize('name,task',[('image-standard','video'),('bogus','image'),('video-15-square','video')])
def test_capability_filter(name,task):
    with pytest.raises(ValueError):profile(name,task)

def test_import_persistence_path_safety(client,tmp_path):
    p=project(client);a=image(client,p)
    assert client.get('/api/assets/'+a['id']).content==png()
    with pytest.raises(ValueError):safe_path(tmp_path,'../outside')
    outside=tmp_path.parent/'outside';outside.write_text('secret');(tmp_path/'escape').symlink_to(outside)
    with pytest.raises(ValueError):safe_path(tmp_path,'escape')
    assert Store(tmp_path).asset(a['id'])['metadata']['origin']=='imported'
    assert client.post(f'/api/projects/{p}/import',files={'file':('bad.svg',b'<svg onload="evil()"/>','image/svg+xml')}).status_code==400


def test_lineage_immutable_inputs_and_cross_project(client):
    p=project(client);a=image(client,p)
    request={'task':'video','profile_id':'video-short','prompt':'Slow camera','source_id':a['id']}
    job=client.post(f'/api/projects/{p}/jobs',json=request).json()
    client.put('/api/assets/'+a['id'],json={'name':'renamed','favorite':True})
    request['prompt']='changed';assert client.store.job(job['id'])['request']['prompt']=='Slow camera'
    assert job['request']['source']['sha256']==a['metadata']['sha256']
    assert job['request']['profile']['frames']==124
    other=project(client)
    assert client.post(f'/api/projects/{other}/jobs',json=request).status_code==400
    assert client.post(f'/api/projects/{p}/jobs',json={**request,'frames':360}).status_code==422
    assert client.post(f'/api/projects/{p}/jobs',json={**request,'seed':True}).status_code==422


def test_cancel_and_retry(client):
    p=project(client);job=client.post(f'/api/projects/{p}/jobs',json={'task':'image','profile_id':'image-standard','prompt':'test'}).json()
    cancelled=client.post('/api/jobs/'+job['id']+'/cancel',json={}).json();assert cancelled['state']=='cancelled'
    retried=client.post('/api/jobs/'+job['id']+'/retry',json={}).json();assert retried['request']==job['request'];assert retried['id']!=job['id']


def test_recovery_preserves_completed_and_queued(tmp_path):
    store=Store(tmp_path);p=store.create_project();active=store.enqueue(p['id'],{});queued=store.enqueue(p['id'],{})
    store.status(active['id'],'loading','loading',container='owned-id')
    class Fake:
        def __init__(self):self.stopped=[]
        def stop(self,c):self.stopped.append(c)
        def preflight(self,r):raise ValueError('Missing package')
    fake=Fake();worker=Worker(store,fake);worker.start();worker.close()
    assert fake.stopped==['owned-id'];assert store.job(active['id'])['state']=='failed';assert store.job(queued['id'])['state']=='queued'


def test_ownership_guard_never_stops_another_container(tmp_path):
    runtime=Runtime(Store(tmp_path),{});calls=[]
    class Result:
        returncode=0;stdout='another-owner\n'
    runtime.command=lambda args,**kw:(calls.append(args) or Result())
    runtime.stop('foreign-container')
    assert len(calls)==1 and calls[0][0]=='inspect'


def test_letterbox_preserves_original(tmp_path):
    source=tmp_path/'source.png';source.write_bytes(png((100,200)));before=source.read_bytes()
    output=tmp_path/'fit.png';transform=letterbox(source,output,864,480)
    assert source.read_bytes()==before
    with Image.open(output) as img:
        assert img.size==(864,480);assert img.getpixel((0,0))==(11,15,17);assert img.getpixel((432,240))==(255,0,0)
    assert transform['method']=='letterbox'


def test_document_versions_page_and_offline_export(client):
    p=project(client);a=image(client,p)
    first=client.post(f'/api/projects/{p}/documents',json={'text':'First draft'}).json()
    second=client.post(f'/api/projects/{p}/documents',json={'text':'<script>alert(1)</script>\n\nApproved story','parent':first['id']}).json()
    assert client.get('/api/assets/'+first['id']).text=='First draft'
    state={'page':{'title':'<img src=x onerror=evil()>','document':second['id'],'assets':[a['id']],'theme':'dark','template':'story','order':['text','media']}}
    assert client.put(f'/api/projects/{p}',json={'name':'My project','state':state,'revision':0}).status_code==200
    preview=client.get('/api/preview/'+p);assert 'sandbox' in preview.headers['Content-Security-Policy'];assert '<script>' not in preview.text
    response=client.post(f'/api/projects/{p}/export',json={});assert response.status_code==200
    with zipfile.ZipFile(io.BytesIO(response.content)) as z:
        html=z.read('index.html').decode();assert '&lt;script&gt;' in html;assert '<script>' not in html;assert 'https://' not in html;assert 'http://' not in html
        manifest=json.loads(z.read('project.json'));assert len(manifest['assets'])==3
        assert z.read('assets/'+a['id']+'.png')==png()
    reopened=Store(client.store.root).project(p);assert reopened['state']==state


def test_gpu_queue_waits_for_external_process(tmp_path,monkeypatch):
    from studio import queue as queue_module
    store=Store(tmp_path);p=store.create_project();job=store.enqueue(p['id'],{'profile':profile('image-standard','image')})
    class Fake:
        def preflight(self,r): pass
        def run(self,j):raise AssertionError('Must never run while GPU is occupied')
        def stop(self,c):pass
    monkeypatch.setattr(queue_module,'gpu_status',lambda:dict(available=False,message='Another application is using the GPU.'))
    worker=Worker(store,Fake());worker.start();time.sleep(.8);worker.close()
    assert store.job(job['id'])['state']=='queued'

def test_cancellation_cannot_be_overwritten_by_late_progress(tmp_path):
    store=Store(tmp_path);p=store.create_project();j=store.enqueue(p['id'],{})
    store.status(j['id'],'cancelling','Stopping',cancel=1)
    store.status(j['id'],'generating','Late callback',{'value':1,'maximum':4})
    assert store.job(j['id'])['state']=='cancelling'
    store.status(j['id'],'cancelled','Stopped')
    assert store.job(j['id'])['state']=='cancelled'


def test_two_controllers_cannot_claim_one_database(tmp_path):
    from studio.resources import Lease
    first=Lease(tmp_path/'lock');second=Lease(tmp_path/'lock')
    assert first.acquire()
    try:assert not second.acquire()
    finally:first.close();second.close()


def test_queue_runs_profiles_sequentially(tmp_path,monkeypatch):
    from studio import queue as queue_module
    store=Store(tmp_path);p=store.create_project();calls=[]
    for kind,profile_id in [('image','image-standard'),('write','writing-standard')]:store.enqueue(p['id'],{'task':kind,'profile':profile(profile_id,kind)})
    class Fake:
        def preflight(self,r):pass
        def stop(self,c):pass
        def run(self,j):
            task=j['request']['task'];calls.append(('start',task));time.sleep(.03)
            path=tmp_path/(task+'.md');path.write_text('CPU fixture only')
            calls.append(('stop',task));return 'text',path,{'fixture':True}
    monkeypatch.setattr(queue_module,'gpu_status',lambda:dict(available=True))
    monkeypatch.setattr(queue_module,'gpu_lease',lambda:__import__('studio.resources',fromlist=['Lease']).Lease(tmp_path/'test-gpu'))
    worker=Worker(store,Fake());worker.start()
    deadline=time.monotonic()+5
    while time.monotonic()<deadline and not all(j['state']=='completed' for j in store.rows('SELECT * FROM jobs')):time.sleep(.05)
    worker.close()
    assert calls==[('start','image'),('stop','image'),('start','write'),('stop','write')]
    assert all(j['state']=='completed' for j in store.rows('SELECT * FROM jobs'))

def test_page_rejects_non_text_and_cross_project_document(client):
    p=project(client)
    assert client.put(f'/api/projects/{p}',json={'revision':0,'name':'Test','state':{'page':{'title':{'html':'bad'}}}}).status_code==400
    other=project(client);doc=client.post(f'/api/projects/{other}/documents',json={'text':'private'}).json()
    assert client.put(f'/api/projects/{p}',json={'revision':0,'name':'Test','state':{'page':{'document':doc['id']}}}).status_code==400


def test_recover_requires_completed_backend_record(client):
    p=project(client);j=client.post(f'/api/projects/{p}/jobs',json={'task':'video','profile_id':'video-short','prompt':'test'}).json()
    client.store.status(j['id'],'failed','Failed before generation')
    assert client.post('/api/jobs/'+j['id']+'/recover',json={}).status_code==400

def test_cancel_launch_race_still_records_owned_container(tmp_path):
    store=Store(tmp_path);p=store.create_project();j=store.enqueue(p['id'],{})
    store.status(j['id'],'cancelling','Stopping',cancel=1)
    store.status(j['id'],'loading','Late launch',container='exact-owned-id')
    after=store.job(j['id']);assert after['state']=='cancelling';assert after['container']=='exact-owned-id'

def test_cancel_at_save_boundary_reaches_terminal_state(tmp_path):
    store=Store(tmp_path);p=store.create_project();j=store.enqueue(p['id'],{})
    store.status(j['id'],'cancelling','Stopping',cancel=1)
    store.status(j['id'],'completed','Saved',asset='finished-asset')
    after=store.job(j['id']);assert after['state']=='cancelled';assert after['asset']=='finished-asset'


def test_lan_session_and_request_protection(tmp_path, monkeypatch):
    monkeypatch.setattr('studio.network.local_hosts', lambda: {'127.0.0.1', '192.168.10.20'})
    monkeypatch.setenv('PAITON_STUDIO_PORT', '9988')
    app = create_app(tmp_path, config={}, worker_enabled=False)
    with TestClient(app, base_url='http://192.168.10.20:9988') as c:
        token = c.get('/api/session').json()['token']
        headers = {'Origin': 'http://192.168.10.20:9988', 'X-Studio-Token': token}
        assert c.post('/api/projects', json={}, headers=headers).status_code == 200
        assert c.get('/api/projects').status_code == 200
        assert c.post('/api/projects', json={}).status_code == 403
        for origin in ('http://evil.example', 'http://192.168.10.20:9000', 'http://192.168.10.21:9988'):
            assert c.get('/api/session', headers={'Origin': origin}).status_code == 403
        for host in ('evil.example:9988', '192.168.10.21:9988', '192.168.10.20:8877'):
            assert c.get('/api/session', headers={'Host': host}).status_code == 403
        assert c.get('/api/session', headers={'Sec-Fetch-Site': 'cross-site'}).status_code == 403
        c.cookies.clear()
        assert c.get('/api/projects').status_code == 401
