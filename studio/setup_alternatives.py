"""Pinned public downloads and CPU-only assembly for the supported alternatives."""
import fnmatch,json,os,hashlib
from pathlib import Path
from .alternative_models import GPT_IMAGE,GPT_REVISION,WAN_IMAGE_ID,WAN_REVISION,FAST_REVISION
from .setup_media import _hf_url,_owner,_cleanup_container,SETUP_OWNER_LABEL,SETUP_LABEL
from .store import atomic,safe_path

WAN_PACKAGE='EliovpAI/Wan2.2-FastWan-5B-Paiton-RDNA4'
WAN_PACKAGE_REVISION='043c10768a3dab586d55e1abb20a35b2bd2820ba'

def snapshot(manager,job,repo,revision,directory,patterns):
    data=manager.read_json(f'https://huggingface.co/api/models/{repo}/revision/{revision}?blobs=true',job,limit=16*1024**2)
    if data.get('sha')!=revision:raise ValueError('Package source revision did not match the pinned release.')
    selected=[item for item in data.get('siblings',[]) if any(fnmatch.fnmatchcase(item['rfilename'],pattern) for pattern in patterns)]
    if not selected:raise ValueError('The package did not provide the required files.')
    manager.update(job,'downloading','Downloading and verifying pinned local model files.',total_bytes=sum((x.get('lfs') or {}).get('size',x.get('size',0)) for x in selected),completed_bytes=0)
    for item in selected:
        lfs=item.get('lfs') or {};size=lfs.get('size',item.get('size'));digest=lfs.get('sha256') or ('git:'+item['blobId'] if item.get('blobId') else None)
        if not isinstance(size,int) or size<0 or not digest:raise ValueError('A source file has no integrity metadata.')
        manager.download(_hf_url(repo,revision,item['rfilename']),safe_path(directory,item['rfilename']),size,digest,job)
    return directory

def minicpm5(manager,job):
    """Reuse the pinned runtime and existing resumable, verified download flow."""
    from .release_adapters import ROOT
    spec=json.loads((ROOT/'contracts/minicpm5-image.json').read_text())
    image=spec['image_id']
    inspected=manager.run(['docker','image','inspect',image],None)
    if inspected.returncode:
        if spec['publication_status']!='published':
            raise ValueError('The reviewed MiniCPM runtime must be installed locally until publication is approved.')
        manager.update(job,'downloading_runtime','Downloading the pinned chat runtime. Existing Docker layers are reused.',total_bytes=None)
        manager.run(['docker','pull',spec['image_ref']],job)
    contract=json.loads((ROOT/'contracts/minicpm5-files.json').read_text())
    revision='6c1ee6fa521aa53f47cfb32696e6d8ef5b0db805'
    hub=manager.root/'model-packages/minicpm5-2b/hub'
    directory=hub/'models--openbmb--MiniCPM5-2B-GPTQ/snapshots'/revision
    manager.update(job,'downloading','Downloading and verifying the small chat checkpoint.',total_bytes=sum(item['bytes'] for item in contract.values()),completed_bytes=0)
    for name,item in contract.items():
        manager.download(_hf_url('openbmb/MiniCPM5-2B-GPTQ',revision,name),safe_path(directory,name),item['bytes'],item['sha256'],job)
    # download() verifies every exact SHA using bounded reads before registration.
    manager.configure({'minicpm5_image':image,'minicpm5_hub_dir':str(hub)},job)

def gptoss(manager,job):
    manager.update(job,'downloading_runtime','Downloading the large GPT-OSS runtime. Existing Docker layers are reused; model weights are a separate download.',total_bytes=None)
    manager.run(['docker','pull',GPT_IMAGE],job)
    hub=manager.root/'model-packages/gptoss/hub'
    from .release_adapters import verify_files,ROOT
    contract=json.loads((ROOT/'contracts/gptoss-files.json').read_text())
    snapshot(manager,job,'openai/gpt-oss-20b',GPT_REVISION,hub/'models--openai--gpt-oss-20b/snapshots'/GPT_REVISION,[*contract,'LICENSE','USAGE_POLICY'])
    verify_files(hub/'models--openai--gpt-oss-20b/snapshots'/GPT_REVISION,contract)
    manager.configure({'gptoss_image':GPT_IMAGE,'gptoss_hub_dir':str(hub)},job)

def wan(manager,job):
    # Reuse a known immutable local runtime when present. Otherwise build only
    # pinned public source into private Studio tags; never invoke launch.sh.
    inspected=manager.run(['docker','image','inspect',WAN_IMAGE_ID],None)
    if inspected.returncode==0:image=WAN_IMAGE_ID
    else:
        package=snapshot(manager,job,WAN_PACKAGE,WAN_PACKAGE_REVISION,manager.root/'model-packages/wan-runtime'/WAN_PACKAGE_REVISION,['models/Wan2.2/*'])/'models/Wan2.2'
        manager.update(job,'building_runtime','Assembling the pinned Wan runtime locally. This may take several minutes; no GPU is used.',total_bytes=None)
        tag='paiton-studio-wan-'+_owner(manager)[:12]
        manager.run(['docker','build','-t',tag+'-artifacts','-f',str(package/'Dockerfile'),str(package)],job)
        manager.run(['docker','build','--build-arg','PAITON_WAN_BASE_IMAGE='+tag+'-artifacts','-t',tag,'-f',str(package/'Dockerfile.local'),str(package)],job)
        result=manager.run(['docker','image','inspect',tag],job);image=json.loads(result.stdout)[0]['Id']
    data=manager.root/'model-packages/wan-data';preset='fast' if job['package']=='fastwan' else 'base'
    base=snapshot(manager,job,'Comfy-Org/Wan_2.2_ComfyUI_Repackaged',WAN_REVISION,data/'base',['split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors','split_files/vae/wan2.2_vae.safetensors']+(['split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors'] if preset=='base' else []))
    for source in (base/'split_files').rglob('*.safetensors'):
        dest=data/'models'/source.relative_to(base/'split_files');dest.parent.mkdir(parents=True,exist_ok=True)
        if not dest.exists():dest.symlink_to(os.path.relpath(source,dest.parent))
    if preset=='fast':
        original=snapshot(manager,job,'FastVideo/FastWan2.2-TI2V-5B-FullAttn-Diffusers',FAST_REVISION,data/'fast',['transformer/diffusion_pytorch_model.safetensors'])/'transformer/diffusion_pytorch_model.safetensors'
        dest=data/'models/diffusion_models/fastwan22_5b_fullattn_comfy_bf16.safetensors';manifest=dest.with_suffix('.conversion.json')
        if not dest.is_file() or not manifest.is_file():
            stage=data/'conversion-attempts'/job['id'];stage.mkdir(parents=True,exist_ok=True)
            owner=_owner(manager);name='paiton-studio-wan-convert-'+job['id'];ref=name
            code="from pathlib import Path;import json;from paiton_wan.convert import convert;r=convert('/source/model.safetensors','/stage/converted.safetensors');Path('/stage/conversion.json').write_text(json.dumps(r))"
            manager.update(job,'preparing','Preparing FastWan with a lossless, CPU-only key conversion. Original weights stay intact.')
            try:
                result=manager.run(['docker','create','--pull=never','--name',name,'--label',SETUP_OWNER_LABEL+'='+owner,'--label',SETUP_LABEL+'='+job['id'],'--network','none','--user',f'{os.getuid()}:{os.getgid()}','-v',str(original)+':/source/model.safetensors:ro','-v',str(stage)+':/stage','--entrypoint','python3',image,'-c',code],job)
                ref=result.stdout.strip();manager.run(['docker','start','-a',ref],job,timeout=600)
            finally:
                if not _cleanup_container(manager,ref,owner,job['id']):
                    manager._needs_recovery=True
                    raise ValueError('Studio must confirm its preparation container stopped before continuing. Retry after recovery.')
            report=json.loads((stage/'conversion.json').read_text())
            if report.get('converted_sha256')!='4167885e2463373d94b06939cebe15fc950e857f919bfa53793ab39b00741782':raise ValueError('Converted FastWan failed the published checksum.')
            dest.parent.mkdir(parents=True,exist_ok=True);os.replace(stage/'converted.safetensors',dest);atomic(manifest,json.dumps(report).encode())
    from .release_adapters import verify_wan_data
    verify_wan_data(data/'models',job['package'])
    manager.configure({'wan_image':image,'wan_verified_image_id':image,'wan_package_revision':WAN_PACKAGE_REVISION,('fastwan_data_dir' if preset=='fast' else 'wan_data_dir'):str(data)},job)
