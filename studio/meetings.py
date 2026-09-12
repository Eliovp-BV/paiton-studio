"""Local recording imports with resumable bounded uploads and explicit deletion."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import threading
import time
import uuid
import weakref

import av
from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field, ConfigDict
from .store import atomic

CHUNK_BYTES=4*1024*1024
MAX_BYTES=4*1024**3
_locks=weakref.WeakValueDictionary()
_locks_guard=threading.Lock()

class MeetingInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    name:str=Field(min_length=1,max_length=150)
    filename:str=Field(min_length=1,max_length=255)
    source:str=Field(default='import',pattern='^(import|microphone|shared-audio)$')
    project:str|None=None
    retention:str=Field(default='keep',pattern='^(keep|delete-recording-after-processing)$')

class ProcessInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    track:int=Field(default=0,ge=0,le=63)
    channel:int|None=Field(default=None,ge=0,le=63)

class RetentionInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    retention:str=Field(pattern='^(keep|delete-recording-after-processing)$')

class SpeakerName(BaseModel):
    model_config=ConfigDict(extra='forbid')
    name:str=Field(min_length=1,max_length=100)

class Meetings:
    def __init__(self,root,store=None,runtime=None,worker=None):
        self.store=store;self.runtime=runtime;self.worker=worker
        self.root=Path(root)/'meetings';self.root.mkdir(mode=0o700,exist_ok=True)
        # The HTTP router and queue completion adapter use separate managers.
        # Serialize their updates to the same persisted meeting metadata.
        with _locks_guard:
            key=str(self.root.resolve())
            self.lock=_locks.get(key)
            if self.lock is None:
                self.lock=threading.RLock();_locks[key]=self.lock

    def directory(self,identity):
        if not re.fullmatch('[0-9a-f]{32}',identity):raise HTTPException(404,'Meeting not found.')
        path=self.root/identity
        if not path.is_dir():raise HTTPException(404,'Meeting not found.')
        return path

    def get(self,identity):
        data=json.loads((self.directory(identity)/'meeting.json').read_text())
        if self.store and data.get('job') and data['state']!='completed':
            job=self.store.job(data['job'])
            data['state']='processing' if job['state'] in ('preparing','loading','processing','running') else job['state']
            data['message']=job['message']
        return data

    def save(self,data):
        atomic(self.directory(data['id'])/'meeting.json',json.dumps(data,ensure_ascii=False).encode())

    def create(self,request):
        if request.project and self.store:self.store.project(request.project)
        identity=uuid.uuid4().hex
        directory=self.root/identity;directory.mkdir(mode=0o700)
        data=dict(id=identity,name=request.name,filename=Path(request.filename).name,
                  source=request.source,retention=request.retention,state='uploading',project=request.project,
                  bytes=0,next_chunk=0,chunks=[],created_at=time.time(),speaker_names={},
                  message='Waiting for recording data.')
        self.save(data);return data

    def append(self,identity,index,content):
        if not content or len(content)>CHUNK_BYTES:raise HTTPException(413,'Recording chunks must contain 1–4 MiB.')
        digest=hashlib.sha256(content).hexdigest()
        with self.lock:
            data=self.get(identity)
            if data['state']!='uploading':raise HTTPException(409,'Recording upload is closed.')
            if index<data['next_chunk']:
                if index>=0 and data['chunks'][index]==[len(content),digest]:return data
                raise HTTPException(409,'Previously uploaded chunk differs.')
            if index!=data['next_chunk']:raise HTTPException(409,'Upload chunks in order.')
            if data['bytes']+len(content)>MAX_BYTES:raise HTTPException(413,'Recording exceeds 4 GiB.')
            path=self.directory(identity)/'recording'
            with path.open('r+b' if path.exists() else 'w+b') as stream:
                # Recover only an uncommitted append in this owned upload.
                stream.truncate(data['bytes']);stream.seek(data['bytes']);stream.write(content);stream.flush();os.fsync(stream.fileno())
            data['bytes']+=len(content);data['next_chunk']+=1;data['chunks'].append([len(content),digest]);self.save(data)
            return data

    def finish(self,identity):
        with self.lock:
            data=self.get(identity)
            if data['state']=='imported':return data
            if data['state']!='uploading' or not data['bytes']:raise HTTPException(409,'Upload a recording first.')
            path=self.directory(identity)/'recording'
            try:
                with path.open('rb') as source,av.open(source, options={'protocol_whitelist':'file,pipe','format_whitelist':'wav,mp3,mov,flac,ogg,matroska,webm'}) as container:
                    tracks=[dict(index=s.index,codec=s.codec_context.name,channels=s.codec_context.channels,rate=s.codec_context.sample_rate) for s in container.streams.audio]
                    if not tracks:raise ValueError('No audio track.')
                    duration=container.duration/av.time_base if container.duration else None
                    if duration and duration>8*3600:raise ValueError('Recording exceeds eight hours.')
                    # Verify a real decoded frame, not just a claimed MIME/container.
                    frame=next(container.decode(audio=0),None)
                    if frame is None:raise ValueError('Recording contains no decodable audio.')
            except Exception as error:
                raise HTTPException(422,'This file has no supported, decodable audio. Try WAV, MP3, MP4/M4A, FLAC, Ogg or WebM.') from error
            data.update(state='imported',tracks=tracks,duration=duration,message='Recording imported. Ready for local processing.')
            self.save(data);return data

    def process(self,identity,request):
        if not self.store or not self.runtime:raise HTTPException(503,'Meeting processing is not configured.')
        from .meeting_runtime import profile_for
        with self.lock:
            data=self.get(identity)
            if data['state'] not in ('imported','failed','cancelled'):raise HTTPException(409,'This meeting is already queued or processed.')
            if request.track>=len(data['tracks']):raise HTTPException(422,'Audio track does not exist.')
            if request.channel is not None and request.channel>=data['tracks'][request.track]['channels']:raise HTTPException(422,'Audio channel does not exist.')
            payload=dict(task='meeting',profile=profile_for(self.runtime),meeting_id=identity,track=request.track,channel=request.channel)
            try:self.runtime.preflight(payload)
            except (ValueError,RuntimeError) as error:raise HTTPException(422,str(error)) from error
            project=data.get('project') or self.store.create_project('Meetings')['id']
            job=self.store.enqueue(project,payload)
            data.setdefault('jobs',[]).append(job['id'])
            data.update(state='queued',job=job['id'],project=project,message='Queued for local meeting processing.')
            self.save(data);return data

    def complete(self,identity,result_path,metadata):
        with self.lock:
            data=self.get(identity)
            expected=self.root.parent/'jobs'/data['job']
            if result_path.parent.resolve()!=expected.resolve() or result_path.is_symlink():raise ValueError('Meeting output is outside its owned job directory.')
            if result_path.stat().st_size>128*1024*1024:raise ValueError('Meeting output exceeds the size limit.')
            result=json.loads(result_path.read_text())
            required=('segments','summary','summary_status')
            if any(k not in result for k in required) or result['summary_status']!='generated-draft':raise ValueError('The meeting result is incomplete.')
            segments=result['segments'];summary=result['summary']
            if not isinstance(segments,list) or not isinstance(summary,dict) or set(summary)!={'overview','topics','decisions','actions','open_questions'}:raise ValueError('The meeting result has invalid fields.')
            sources={s['id']:s for s in segments}
            if len(sources)!=len(segments):raise ValueError('Transcript references must be unique.')
            for category in ('decisions','actions','open_questions'):
                for claim in summary[category]:
                    ids=claim['segment_ids']
                    if not ids or any(i not in sources for i in ids):raise ValueError('Summary references are not in the transcript.')
                    if not claim.get('quote') or not any(claim['quote'] in sources[i]['text'] for i in ids):raise ValueError('Summary quote is not in the recording transcript.')
            directory=self.directory(identity)
            playback=result_path.parent/'playback.wav'
            if not playback.is_file():raise ValueError('Synchronized playback was not prepared.')
            atomic(directory/'result.json',json.dumps(result,ensure_ascii=False).encode())
            os.replace(playback,directory/'playback.wav')
            data.update(state='completed',message='Transcript and generated meeting notes saved locally.',
                        transcript=result['segments'],summary=result['summary'],summary_audit=result.get('summary_audit',[]),
                        pipeline_timings=metadata.get('pipeline_timings',{}),
                        asr_backend=metadata.get('asr_backend','unknown'),recording_retained=True)
            self.save(data)
            if data['retention']=='delete-recording-after-processing':
                (directory/'recording').unlink(missing_ok=True);(directory/'playback.wav').unlink(missing_ok=True)
                data['recording_retained']=False;self.save(data)
            # Stage outputs can contain meeting text. Keep one owned result and
            # remove redundant job files after successful persistence.
            shutil.rmtree(result_path.parent)

    def delete(self,identity):
        with self.lock:
            data=self.get(identity)
            if data['state'] in ('queued','processing'):raise HTTPException(409,'Stop processing before deleting this meeting.')
            if self.store and data.get('job'):
                job=self.store.job(data['job'])
                if job['state'] not in ('completed','failed','cancelled'):raise HTTPException(409,'Stop processing before deleting this meeting.')
                for job_id in data.get('jobs',[job['id']]):
                    if not re.fullmatch('[0-9a-f]{32}',job_id):raise ValueError('Invalid saved meeting job.')
                    shutil.rmtree(self.store.root/'jobs'/job_id,ignore_errors=True)
            shutil.rmtree(self.directory(identity))
        return {'deleted':True}

    def router(self):
        router=APIRouter(prefix='/api/meetings')
        @router.get('/readiness')
        def readiness():
            from .meeting_runtime import installation, profile_for
            try:
                if not self.runtime:raise ValueError('Meeting processing has not been configured.')
                installation(self.runtime)
                return dict(ready=True,message='Local meeting package found. Checkpoints are fully verified before processing.',backend='paiton' if profile_for(self.runtime)['compiler'] else 'stock')
            except (ValueError,RuntimeError,OSError,KeyError) as error:
                return dict(ready=False,message=str(error),backend=None)

        @router.get('')
        def listing(project:str|None=None):
            with self.lock:
                items=[self.get(p.name) for p in self.root.iterdir() if p.is_dir() and re.fullmatch('[0-9a-f]{32}',p.name)]
                if project:items=[item for item in items if item.get('project')==project]
                return sorted([{k:v for k,v in item.items() if k not in ('chunks','transcript','summary','summary_audit')} for item in items],key=lambda d:d['created_at'],reverse=True)
        @router.post('')
        def create(request:MeetingInput):return self.create(request)
        @router.get('/{identity}')
        def get(identity:str):return self.get(identity)
        @router.post('/{identity}/chunks/{index}')
        async def upload(identity:str,index:int,file:UploadFile):
            content=await file.read(CHUNK_BYTES+1)
            return self.append(identity,index,content)
        @router.post('/{identity}/process')
        def process(identity:str,request:ProcessInput):return self.process(identity,request)
        @router.post('/{identity}/cancel')
        def cancel(identity:str):
            data=self.get(identity)
            if not self.worker or not data.get('job'):raise HTTPException(409,'No active meeting job.')
            self.worker.cancel(data['job']);return self.get(identity)
        @router.post('/{identity}/finish')
        def finish(identity:str):return self.finish(identity)
        @router.get('/{identity}/recording')
        def recording(identity:str):
            data=self.get(identity)
            path=self.directory(identity)/'recording'
            if data['state']=='uploading' or not path.exists():raise HTTPException(404,'Recording unavailable.')
            playback=self.directory(identity)/'playback.wav'
            if playback.exists():return FileResponse(playback,media_type='audio/wav')
            # Original file is served as media; never as executable HTML.
            media={'mp4':'video/mp4','m4a':'audio/mp4','mp3':'audio/mpeg','wav':'audio/wav','flac':'audio/flac','webm':'audio/webm','ogg':'audio/ogg'}.get(Path(data['filename']).suffix.lower().lstrip('.'),'application/octet-stream')
            return FileResponse(path,media_type=media)
        @router.get('/{identity}/export')
        def export(identity:str,format:str='json'):
            data=self.get(identity)
            data.pop('chunks',None)
            if format=='json':return data
            if format not in ('txt','srt','vtt'):raise HTTPException(422,'Choose JSON, text, SRT or VTT.')
            if data['state']!='completed':raise HTTPException(409,'Wait for transcription to finish before exporting text.')
            def timestamp(seconds,separator='.'):
                millis=round(float(seconds)*1000)
                hours,remainder=divmod(millis,3600000);minutes,remainder=divmod(remainder,60000);secs,ms=divmod(remainder,1000)
                return f'{hours:02}:{minutes:02}:{secs:02}{separator}{ms:03}'
            lines=['WEBVTT',''] if format=='vtt' else []
            for i,segment in enumerate(data.get('transcript',[]),1):
                speaker=data.get('speaker_names',{}).get(segment['speaker'],segment['speaker'])
                text=speaker+': '+segment['text']
                if format=='txt':lines.append(f"[{timestamp(segment['start'])}] {text}")
                else:
                    if format=='srt':lines.append(str(i))
                    separator=',' if format=='srt' else '.'
                    lines += [timestamp(segment['start'],separator)+' --> '+timestamp(segment['end'],separator),text,'']
            return Response('\n'.join(lines),media_type='text/vtt' if format=='vtt' else 'text/plain',headers={'Content-Disposition':f'attachment; filename="meeting.{format}"'})

        @router.post('/{identity}/retention')
        def retention(identity:str,request:RetentionInput):
            with self.lock:
                data=self.get(identity)
                if data['state'] in ('queued','processing'):raise HTTPException(409,'Wait for processing to finish before changing retention.')
                data['retention']=request.retention
                if data['state']=='completed' and request.retention=='delete-recording-after-processing':
                    directory=self.directory(identity)
                    (directory/'recording').unlink(missing_ok=True)
                    (directory/'playback.wav').unlink(missing_ok=True)
                    data['recording_retained']=False
                self.save(data);return data
        @router.post('/{identity}/speakers/{speaker}')
        def rename(identity:str,speaker:str,request:SpeakerName):
            with self.lock:
                data=self.get(identity)
                known={s['speaker'] for s in data.get('transcript',[])}
                if speaker not in known or speaker in ('UNKNOWN','UNCERTAIN'):raise HTTPException(400,'Choose an assigned anonymous speaker.')
                data['speaker_names'][speaker]=request.name;self.save(data);return data
        @router.delete('/{identity}')
        def delete(identity:str):return self.delete(identity)
        return router
