"""Meeting adapter using Studio's existing GPU queue and owned containers."""
import json
import hashlib
from pathlib import Path
import time

PROFILE = dict(id='meeting-english-v1', package='meeting', task='meeting',
               model='Parakeet 0.6B + community-1 + Granite 4.2 3B',
               revision='541d1f99c6b0c3cd0b11a95167540bb8edefd82b',
               diarization_revision='3533c8cf8e369892e6b79ff1bf80f7b0286a54ee',
               summary_revision='e459acceac81e5fe67c07d9cfc72329a332e7eb1',
               dtype='float16', compiler=False, context=16384)
COMPILED_PROFILE = dict(PROFILE, compiler=True)


def profile_for(runtime):
    selected = COMPILED_PROFILE if runtime.config.get('meeting_compiler_enabled') is True else PROFILE
    return dict(selected)


def preflight(runtime, request):
    from .runtime import RuntimeFailure
    if request.get('profile') not in (PROFILE, COMPILED_PROFILE) or request.get('task') != 'meeting':
        raise RuntimeFailure('The meeting profile does not match this installed pipeline.')
    image = installation(runtime, verify=True)
    from .meetings import Meetings
    manager=Meetings(runtime.store.root)
    if not (manager.directory(request['meeting_id'])/'recording').is_file():
        raise RuntimeFailure('The imported recording is unavailable.')
    return image


def installation(runtime, verify=False):
    from .runtime import RuntimeFailure
    from .readiness import host_compatibility
    host=host_compatibility()
    if not host['compatible']: raise RuntimeFailure(host['reason'])
    from .hardware_policy import evaluate
    from .telemetry import gpu_status
    hardware=evaluate(dict(supported_architectures=['gfx1201'],required_device_names=['AMD Radeon AI PRO R9700'],required_vram_gib=32,minimum_reported_vram_gib=31),gpu_status())
    if not hardware['compatible']:raise RuntimeFailure(hardware['reason'])
    if not runtime.config.get('meeting_enabled'):
        raise RuntimeFailure('The local meeting runtime has not been configured.')
    image=runtime.config.get('meeting_image')
    inspected=runtime.command(['image','inspect',image]) if image else None
    if inspected is None or inspected.returncode:
        raise RuntimeFailure('Install the local meeting runtime image.')
    models=Path(runtime.config_path('meeting_models_dir'))
    for relative in ('parakeet/config.json','pyannote/config.yaml','silero/silero_vad.jit','granite-summary/config.json'):
        if not (models/relative).is_file():raise RuntimeFailure('Pinned meeting model files are incomplete.')
    receipt_path=models/'model-provenance.json'
    if not receipt_path.is_file():raise RuntimeFailure('Record the pinned meeting checkpoint provenance during setup.')
    receipt=json.loads(receipt_path.read_text())
    expected={'parakeet':PROFILE['revision'],'pyannote':PROFILE['diarization_revision'],'granite-summary':PROFILE['summary_revision'],'silero':'867c2aa692646a1f1de3e94a15c9dd9f614c0acb'}
    for role,revision in expected.items():
        entry=receipt.get(role,{})
        if entry.get('revision')!=revision or not entry.get('files'):raise RuntimeFailure('Meeting checkpoint revision mismatch.')
        for name,record in entry['files'].items():
            path=models/role/name
            if Path(name).is_absolute() or '..' in Path(name).parts or not path.is_file():raise RuntimeFailure('Invalid or missing meeting checkpoint file.')
            stat=path.stat();key=('meeting',str(path.resolve()),stat.st_size,stat.st_mtime_ns,record['sha256'])
            if stat.st_size!=record['bytes']:raise RuntimeFailure('Meeting checkpoint is truncated.')
            if verify and key not in runtime._source_checks:
                digest=hashlib.sha256()
                with path.open('rb') as source:
                    for block in iter(lambda:source.read(8*1024*1024),b''):digest.update(block)
                if digest.hexdigest()!=record['sha256']:raise RuntimeFailure('Meeting checkpoint checksum mismatch.')
                runtime._source_checks[key]=True
    return runtime.config['meeting_image']


def run(runtime, job):
    from .runtime import RuntimeFailure
    from .meetings import Meetings
    request=job['request'];image=preflight(runtime,request)
    directory=runtime.store.root/'jobs'/job['id'];directory.mkdir(parents=True,exist_ok=True)
    manager=Meetings(runtime.store.root);source=manager.directory(request['meeting_id'])
    mounts=[(str(source),'/recording'),(runtime.config_path('meeting_models_dir'),'/models/meeting')]
    timings={};started=time.monotonic()
    def stage(label,args):
        runtime.check_cancel(job)
        runtime.store.status(job['id'],'processing',label)
        container,_=runtime.start(job,image,args,mounts=mounts)
        runtime.store.status(job['id'],'processing',label+' Model loading and processing can take a while; all inference stays local.')
        start=time.monotonic()
        try:runtime.stream(job,['start','-a',container],limit=8*3600)
        finally:runtime.stop(container)
        timings[label]=time.monotonic()-start
    selection=['--track',str(request.get('track',0))]
    if request.get('channel') is not None:selection+=['--channel',str(request['channel'])]
    compiled=request['profile']['compiler']
    compiler_args=['--artifact','/opt/paiton/meeting-artifacts/meeting_lstm_float16_gfx1201.so'] if compiled else []
    stage('Transcribing speech locally.', ['transcribe','/recording/recording','--model','/models/meeting/parakeet',
          '--vad','/models/meeting/silero/silero_vad.jit',*compiler_args,
          '--output','/job/asr.json',*selection])
    stage('Determining anonymous speakers.', ['diarize','/recording/recording','--model','/models/meeting/pyannote',
          '--output','/job/diarization.json','--scratch','/job/temp',*selection])
    stage('Attaching speaker turns.', ['attribute','/job/asr.json','/job/diarization.json','--output','/job/transcript.json'])
    stage('Preparing synchronized playback.', ['normalize','/recording/recording','--output','/job/playback.wav',*selection])
    stage('Writing and checking evidence-linked meeting notes.',
          ['summarize','/job/transcript.json','--checkpoint','/models/meeting/granite-summary',
           '--output','/job/result.json'])
    timings['complete_pipeline_seconds']=time.monotonic()-started
    return 'meeting',directory/'result.json',{'pipeline_timings':timings,'asr_backend':'paiton' if compiled else 'stock'}
