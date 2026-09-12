import io,wave
import pytest
from fastapi import HTTPException
from studio.meetings import Meetings,MeetingInput,CHUNK_BYTES

def wav():
    b=io.BytesIO()
    with wave.open(b,'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(b'\0\0'*16000)
    return b.getvalue()

def test_managers_serialize_updates_to_same_store(tmp_path):
    import threading
    first=Meetings(tmp_path);second=Meetings(tmp_path)
    acquired=[]
    with first.lock:
        def contender():
            obtained=second.lock.acquire(blocking=False)
            acquired.append(obtained)
            if obtained:second.lock.release()
        thread=threading.Thread(target=contender);thread.start();thread.join()
    assert acquired==[False]

def test_retention_selected_after_completion_removes_owned_audio(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    manager=Meetings(tmp_path)
    item=manager.create(MeetingInput(name='Meeting',filename='meeting.wav'))
    manager.append(item['id'],0,wav());manager.finish(item['id'])
    item=manager.get(item['id']);item.update(state='completed',recording_retained=True)
    manager.save(item)
    directory=manager.directory(item['id'])
    (directory/'playback.wav').write_bytes(wav())
    original=tmp_path/'original.wav';original.write_bytes(wav())
    app=FastAPI();app.include_router(manager.router())
    with TestClient(app) as client:
        response=client.post(f"/api/meetings/{item['id']}/retention",json={'retention':'delete-recording-after-processing'})
        assert response.status_code==200 and not response.json()['recording_retained']
    assert not (directory/'recording').exists() and not (directory/'playback.wav').exists()
    assert original.read_bytes()==wav()

def test_resumable_import_and_delete(tmp_path):
    manager=Meetings(tmp_path);item=manager.create(MeetingInput(name='Meeting',filename='meeting.wav'))
    data=wav();manager.append(item['id'],0,data);manager.append(item['id'],0,data)
    assert manager.get(item['id'])['bytes']==len(data)
    result=manager.finish(item['id']);assert result['tracks'][0]['rate']==16000
    assert result['state']=='imported' and result['duration']==1
    assert manager.delete(item['id'])['deleted']
    assert not (manager.root/item['id']).exists()

def test_invalid_upload_and_paths(tmp_path):
    manager=Meetings(tmp_path);item=manager.create(MeetingInput(name='Meeting',filename='meeting.wav'))
    for index,data in [(2,b'a'),(0,b'a'*(CHUNK_BYTES+1))]:
        with pytest.raises(HTTPException):manager.append(item['id'],index,data)
    manager.append(item['id'],0,b'<html>invalid</html>')
    with pytest.raises(HTTPException):manager.finish(item['id'])
    with pytest.raises(HTTPException):manager.get('../file')

def test_uncommitted_tail_recovery(tmp_path):
    manager=Meetings(tmp_path);item=manager.create(MeetingInput(name='Meeting',filename='meeting.wav'))
    data=wav();manager.append(item['id'],0,data[:100])
    with (manager.directory(item['id'])/'recording').open('ab') as f:f.write(b'crashed append')
    manager.append(item['id'],1,data[100:]);assert manager.finish(item['id'])['state']=='imported'

def test_queue_completion_and_recording_retention(tmp_path):
    import json
    from studio.store import Store
    from studio.meetings import ProcessInput
    class Runtime:
        config={}
        def preflight(self,payload):assert payload['task']=='meeting'
    store=Store(tmp_path);manager=Meetings(tmp_path,store,Runtime())
    item=manager.create(MeetingInput(name='Meeting',filename='meeting.wav',retention='delete-recording-after-processing'))
    manager.append(item['id'],0,wav());manager.finish(item['id'])
    queued=manager.process(item['id'],ProcessInput())
    assert store.job(queued['job'])['state']=='queued'
    with pytest.raises(HTTPException):manager.process(item['id'],ProcessInput())
    with pytest.raises(HTTPException):manager.delete(item['id'])
    directory=tmp_path/'jobs'/queued['job'];directory.mkdir(parents=True)
    result=directory/'result.json';result.write_text(json.dumps(dict(segments=[],summary=dict(overview='No speech.',topics=[],decisions=[],actions=[],open_questions=[]),summary_status='generated-draft')))
    (directory/'playback.wav').write_bytes(wav())
    (directory/'asr.json').write_text('private intermediate')
    manager.complete(item['id'],result,{'pipeline_timings':{'complete_pipeline_seconds':1},'asr_backend':'stock'})
    completed=manager.get(item['id'])
    assert completed['state']=='completed'
    assert completed['asr_backend']=='stock'
    assert completed['recording_retained'] is False
    assert not (manager.directory(item['id'])/'recording').exists()
    assert not (manager.directory(item['id'])/'playback.wav').exists()
    assert not directory.exists()
    assert (manager.directory(item['id'])/'result.json').exists()
    store.status(queued['job'],'completed','saved')
    manager.delete(item['id'])
    assert not (manager.root/item['id']).exists()


def test_project_scope_readiness_and_subtitle_exports(tmp_path):
    from studio.app import create_app
    from fastapi.testclient import TestClient
    app=create_app(tmp_path,{},worker_enabled=False)
    with TestClient(app) as c:
        c.headers['x-studio-token']=c.get('/api/session').json()['token']
        p=c.post('/api/projects').json()['id'];other=c.post('/api/projects').json()['id']
        status=c.get('/api/meetings/readiness')
        assert status.status_code==200 and not status.json()['ready']
        created=c.post('/api/meetings',json={'name':'Meeting fixture','filename':'fixture.wav','project':p})
        assert created.status_code==200,created.text
        identity=created.json()['id'];manager=app.state.meetings
        manager.append(identity,0,wav());manager.finish(identity)
        assert len(c.get('/api/meetings',params={'project':p}).json())==1
        assert c.get('/api/meetings',params={'project':other}).json()==[]
        assert c.get(f'/api/meetings/{identity}/export?format=txt').status_code==409
        data=manager.get(identity)
        data.update(state='completed',transcript=[dict(id='s1',start=0.12,end=0.98,speaker='SPEAKER_00',text='A fixture only.')],speaker_names={'SPEAKER_00':'Ada'})
        manager.save(data)
        srt=c.get(f'/api/meetings/{identity}/export?format=srt')
        assert '00:00:00,120 --> 00:00:00,980' in srt.text and 'Ada: A fixture only.' in srt.text
        assert 'attachment' in srt.headers['content-disposition']
        assert c.get(f'/api/meetings/{identity}/export?format=vtt').text.startswith('WEBVTT\n')
        assert '[00:00:00.120] Ada:' in c.get(f'/api/meetings/{identity}/export?format=txt').text
        assert c.get(f'/api/meetings/{identity}/export?format=exe').status_code==422
        assert c.post('/api/meetings',json={'name':'Wrong project','filename':'test.wav','project':'missing'}).status_code==400


def test_recording_import_rejects_playlists(tmp_path):
    manager=Meetings(tmp_path)
    item=manager.create(MeetingInput(name='Not audio',filename='playlist.wav'))
    manager.append(item['id'],0,b'#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1,\nhttp://127.0.0.1:1/private\n#EXT-X-ENDLIST\n')
    with pytest.raises(HTTPException) as error:manager.finish(item['id'])
    assert error.value.status_code==422
