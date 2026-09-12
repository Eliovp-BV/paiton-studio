"""Public package adapters, with no compiler or shared-service dependencies."""
import hashlib,json
from pathlib import Path
from .alternative_models import GPT_IMAGE,WAN_IMAGE_ID
from .store import atomic
from .media import letterbox,video_info

ROOT=Path(__file__).resolve().parent

def verify_files(root,files):
    for name,record in files.items():
        path=root/name
        if not path.is_file() or path.stat().st_size!=record['bytes']:
            raise ValueError('Model files are missing or incomplete. Open Settings → Set up creation tools.')
        if 'sha256' in record and hashlib.sha256(path.read_bytes()).hexdigest()!=record['sha256']:
            raise ValueError('Model configuration does not match the pinned Paiton release.')

def preflight(runtime,selected,inspected):
    package=selected['package']; image=json.loads(inspected)[0]
    if package=='minicpm5-2b':
        expected=json.loads((ROOT/'contracts/minicpm5-image.json').read_text())['image_id']
        if not expected or image['Id']!=expected:
            raise ValueError('Connect the qualified MiniCPM5 Paiton runtime before using this profile.')
        directory=Path(runtime.config_path('minicpm5_hub_dir'))/'models--openbmb--MiniCPM5-2B-GPTQ/snapshots'/selected['revision']
        files=json.loads((ROOT/'contracts/minicpm5-files.json').read_text())
        # The server verifies all pinned SHA-256 values on first load and reuses
        # stat-bound receipts. Avoid rehashing 2 GB for every warm chat turn.
        verify_files(directory,{name:record if record['bytes']<=1024**2 else {'bytes':record['bytes']}
                                for name,record in files.items()})
    elif package=='gptoss':
        digest=GPT_IMAGE.split('@')[1]
        if image['Id']!=digest and not any(x.endswith('@'+digest) for x in image.get('RepoDigests',[])):
            raise ValueError('Install the pinned GPT-OSS Paiton runtime before using this profile.')
        directory=Path(runtime.config_path('gptoss_hub_dir'))/'models--openai--gpt-oss-20b/snapshots'/selected['revision']
        verify_files(directory,json.loads((ROOT/'contracts/gptoss-files.json').read_text()))
    else:
        built_here=(image['Id']==runtime.config.get('wan_verified_image_id') and runtime.config.get('wan_package_revision')=='043c10768a3dab586d55e1abb20a35b2bd2820ba')
        if image['Id']!=WAN_IMAGE_ID and not built_here:
            raise ValueError('This Wan runtime has not been verified for the Studio workflow. Connect the qualified package.')
        directory=Path(runtime.config_path('fastwan_data_dir' if package=='fastwan' and runtime.config.get('fastwan_data_dir') else 'wan_data_dir'))/'models'
        verify_wan_data(directory,package)

def verify_wan_data(directory,package):
    files=json.loads((ROOT/'contracts/wan-files.json').read_text())
    wanted={k:v for k,v in files.items() if 'diffusion_models' not in k or ('fastwan' in k)==(package=='fastwan')}
    verify_files(directory,wanted)
    if package=='fastwan':
        conversion=json.loads((directory/'diffusion_models/fastwan22_5b_fullattn_comfy_bf16.conversion.json').read_text())
        if conversion.get('converted_sha256')!='4167885e2463373d94b06939cebe15fc950e857f919bfa53793ab39b00741782':
            raise ValueError('FastWan converted weights do not have the release provenance.')

def wan_run(runtime,job,image,directory):
    request=job['request'];p=request['profile']
    if request.get('source') and p['preset']=='fast': raise ValueError('FastWan is text-only. Choose Wan or H3 to animate an image.')
    graph=json.loads((ROOT/'contracts'/f"wan-{p['preset']}.json").read_text())
    graph['1']['inputs']['engine']=p['engine']
    graph['2']['inputs'].update(duration='2 seconds (49 frames)' if p['frames']==49 else '5 seconds (121 frames)',resolution='720 class (1280 x 704)' if p['width']==1280 else '480 class (832 x 480)',orientation='Portrait' if p['height']>p['width'] else 'Landscape')
    graph['3']['inputs']['text']=request['prompt'];graph['7']['inputs']['seed']=request['seed'];graph['10']['inputs']['filename_prefix']='clip'
    transform=None
    if request.get('source'):
        asset=runtime.store.asset(request['source']['id'],job['project'])
        if asset['metadata']['sha256']!=request['source']['sha256']:raise ValueError('Source image identity changed.')
        transform=letterbox(runtime.store.file(asset),directory/'input.png',p['width'],p['height'])
        graph['5']['inputs']['image']='input.png'
    atomic(directory/'workflow.json',json.dumps(graph).encode())
    atomic(directory/'models.yaml',b'paiton_runtime:\n  base_path: /opt/comfyui\n  custom_nodes: custom_nodes\npaiton_studio:\n  base_path: /wan_data/models\n  diffusion_models: diffusion_models\n  text_encoders: text_encoders\n  vae: vae\n')
    container,_=runtime.start(job,image,['main.py','--base-directory','/job/data','--input-directory','/job','--output-directory','/job/output','--temp-directory','/job/temp','--user-directory','/job/user','--extra-model-paths-config','/job/models.yaml','--listen','127.0.0.1','--port','8188','--disable-api-nodes','--use-ck-attention','--bf16-vae','--bf16-unet','--supports-fp8-compute','--fast-disk','--reserve-vram','2','--cache-ram','2','--preview-method','none'],mounts=[(runtime.config_path('fastwan_data_dir' if p['package']=='fastwan' and runtime.config.get('fastwan_data_dir') else 'wan_data_dir'),'/wan_data')],entrypoint='python3',workdir='/opt/comfyui')
    runtime.command(['start',container]);runtime.wait_ready(job,container,8188,'/system_stats')
    runtime.stream(job,['exec',container,'python3','/studio/comfy_job.py'],limit=2400)
    outputs=list((directory/'output').rglob('*.mp4'))
    if len(outputs)!=1:raise ValueError('The video runtime did not save exactly one completed clip.')
    info=video_info(outputs[0])
    if (info['width'],info['height'])!=(p['width'],p['height']) or info['audio'] or abs(info['duration']-p['frames']/24)>.15:raise ValueError('The saved clip does not match the selected silent-video profile.')
    return 'video',outputs[0],{**info,'transform':transform,'engine':p['engine']}


def prepare_harmony(runtime,job,image):
    """Read the pinned image vocabulary without GPU access; repair no shared files.

    The release ADD created a non-traversable cache directory for non-root users.
    Copy its public vocabulary into Studio's private, non-root-readable cache.
    """
    from .runtime import LABEL
    digest='446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d'
    name='fb374d419588a4632f3f557e76b4b70aebbca790'
    cache=runtime.store.root/'runtime-cache/gptoss/harmony';cache.mkdir(parents=True,exist_ok=True)
    target=cache/name
    if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest()==digest:return
    runtime.check_cancel(job)
    runtime.store.status(job['id'],'preparing','Preparing the verified offline chat vocabulary.')
    container=None
    try:
        result=runtime.command(['create','--pull=never','--name','paiton-studio-vocab-'+job['id'],
            '--label',LABEL+'='+runtime.owner,'--network','none','--entrypoint','cat',image,'/opt/paiton/harmony-cache/'+name])
        if result.returncode:raise ValueError('Could not prepare the offline chat vocabulary.')
        container=result.stdout.strip()
        runtime.store.status(job['id'],'preparing','Preparing the verified offline chat vocabulary.',container=container)
        result=runtime.command(['start','-a',container])
        data=result.stdout.encode()
        if result.returncode or hashlib.sha256(data).hexdigest()!=digest:raise ValueError('The offline chat vocabulary did not match its published checksum.')
        atomic(target,data)
        runtime.check_cancel(job)
    finally:runtime.stop(container)
