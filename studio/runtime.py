"""Own containers, not an inference engine. Never operate on shared services."""
import json
import hashlib
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import threading
import time

from .chat_adapters import CHAT_PACKAGES, writing_body
from .docker_local import LocalDocker, DockerLocalError
from .local_qwen3 import LocalPackageError, LocalQwen3Validator
from .media import image_info, letterbox, video_info
from .registry import compatibility, validate_snapshot
from .telemetry import gpu_status
from .store import atomic, safe_path

ROOT=Path(__file__).resolve().parents[1]
LABEL='dev.paiton.studio.owner'
# Exact public cyankiwi snapshot 4bd30395... retained in the working cache.
# Check lengths before parsing; a config-only or truncated cache is not ready.
CODER_SUPPORT_SIZES = {
    'config.json': 3514, 'model.safetensors.index.json': 5412994,
    'tokenizer.json': 11422654, 'tokenizer_config.json': 5405,
    'chat_template.jinja': 6211, 'generation_config.json': 217,
    'merges.txt': 1671853, 'vocab.json': 2776833,
    'special_tokens_map.json': 613, 'added_tokens.json': 707,
}
CODER_SHARD_SIZES = {
    'model-00001-of-00004.safetensors': 5001707008,
    'model-00002-of-00004.safetensors': 5001283696,
    'model-00003-of-00004.safetensors': 5001283912,
    'model-00004-of-00004.safetensors': 3090232736,
}
CODER_INDEX_SHA256 = '0c3f353c78e88d8578823b831c11e6ee8d4c42a5c0fcc3c0a311f65d307c50ad'


class Cancelled(Exception): pass
class RuntimeFailure(RuntimeError): pass
class InputRejected(RuntimeFailure):
    """A healthy runtime rejected input before generation; cleanup is complete."""



class Runtime:
    def __init__(self,store,config):
        self.store=store; self.config=config; self._source_checks={}
        self._local_qwen3=LocalQwen3Validator()
        self._warm=None
        self._memory_policy_lock=threading.RLock()
        self.warm_seconds=120
        self._chat_active_until=0
        self.docker=LocalDocker()
        self.owner_path=store.root/'owner'
        if not self.owner_path.exists():
            import secrets
            atomic(self.owner_path,secrets.token_hex(16).encode())
        self.owner=self.owner_path.read_text()

    def command(self,args,**kw):
        try:
            command,environment=self.docker.invocation(args,kw.pop('env',None))
            return subprocess.run(command,env=environment,capture_output=True,text=True,timeout=kw.pop('timeout',30),**kw)
        except DockerLocalError as error:raise RuntimeFailure(str(error)) from error
        except OSError:return subprocess.CompletedProcess(['docker',*args],127,'','Docker is unavailable.')
        except subprocess.TimeoutExpired:raise RuntimeFailure('Docker did not respond in time. Your project is saved; check the local runtime and retry.')

    def config_path(self,key):
        value=self.config.get(key)
        if not value or not Path(value).is_dir(): raise RuntimeFailure('A required model package is missing. Open Creation tools for setup details.')
        return str(Path(value).resolve())

    def chat_source(self, package, revision):
        contract=CHAT_PACKAGES[package]
        if package=='qwen38-mxfp4':
            from .qwen_mxfp4 import sources
            # The stock image has no passwd entry for the host UID. vLLM's
            # framework imports call getpass.getuser even with cache paths set.
            # Keep the host UID and give it a private writable cache home.
            return sources(self.config)[0], {'USER':'paiton','LOGNAME':'paiton','HOME':'/models/cache'}
        if package=='minicpm5-2b':
            return [(self.config_path('minicpm5_hub_dir'),'/models/cache/huggingface/hub')],{}
        if package=='gptoss':
            return [(self.config_path('gptoss_hub_dir'),'/models/cache/huggingface/hub')],{'TIKTOKEN_RS_CACHE_DIR':'/models/cache/harmony'}
        if package=='qwen-coder':
            key='writing_hub_dir' if self.config.get('writing_hub_dir') else 'hf_hub_dir'
            return [(self.config_path(key),'/models/cache/huggingface/hub')],{}
        if package=='qwen3-4b':
            return [(self.config_path('qwen3_4b_model_dir'),'/models/checkpoint')],{}
        if package!='qwen38':
            raise RuntimeFailure('This text model has no qualified checkpoint source contract.')
        if self.config.get('qwen38_model_dir'):
            return [(self.config_path('qwen38_model_dir'),'/base')],{'PAITON_BASE_MODEL':'/base'}
        if self.config.get('qwen38_cache_volume'):
            volume=self.config['qwen38_cache_volume']
            if not isinstance(volume,str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*',volume):
                raise RuntimeFailure('Choose a valid local Docker volume for the writing checkpoint.')
            return [(volume,'/base')],{'PAITON_BASE_MODEL':f"/base/hub/{contract['repository']}/snapshots/{revision}"}
        return [(self.config_path('hf_hub_dir'),'/base')],{'PAITON_BASE_MODEL':f"/base/{contract['repository']}/snapshots/{revision}"}

    def preflight(self,request):
        if request.get('task')=='meeting':
            from .meeting_runtime import preflight
            return preflight(self,request)
        from .readiness import host_compatibility
        host = host_compatibility()
        if not host['compatible']:
            raise RuntimeFailure('These Paiton adapters need a supported host. ' + host['reason'])
        selected=validate_snapshot(request['profile'],request.get('task'))
        package=selected['package']
        # Capability probes carry only a profile. Actual queued text requests
        # also carry a prompt/messages; validate those before the worker evicts
        # any ready model or spends time launching a replacement.
        if selected['adapter']=='paiton-chat' and ('prompt' in request or 'messages' in request):
            writing_body({**request,'profile':selected})
        image_key={'flux':'flux_image','h3':'h3_image','wan':'wan_image','fastwan':'wan_image'}.get(package)
        if selected['adapter']=='paiton-chat':
            if package not in CHAT_PACKAGES: raise RuntimeFailure('This text model has no qualified launch contract yet.')
            image_key=CHAT_PACKAGES[package]['image_key']
        image=self.config.get(image_key)
        if package=='qwen38-mxfp4':
            from .conversation_options import image_for
            image=image_for(selected)
        inspected=self.command(['image','inspect',image]) if image else None
        if inspected is None or inspected.returncode: raise RuntimeFailure('The local runtime image is not installed. Open Creation tools.')
        if shutil.disk_usage(self.store.root).free<2*1024**3: raise RuntimeFailure('Less than 2 GB of free disk remains. Free space before creating media.')
        if package=='qwen38-mxfp4':
            from .qwen_mxfp4 import preflight
            try: preflight(self,image,inspected.stdout)
            except (ValueError,OSError,KeyError) as error:
                raise RuntimeFailure(str(error) if isinstance(error,ValueError) else 'Qwen MXFP4 files could not be verified. Open Creation tools to repair setup.') from error
        elif package in ('minicpm5-2b','gptoss','wan','fastwan'):
            from .release_adapters import preflight
            try: preflight(self,selected,inspected.stdout)
            except (ValueError,OSError) as error: raise RuntimeFailure(str(error) if isinstance(error,ValueError) else 'Model files are missing. Open Settings → Set up creation tools.') from error
        elif package=='flux':
            directory=Path(self.config_path('flux_model_dir'))
            data=json.loads((directory/'conversion.json').read_text())
            if data.get('source_revision')!=selected['revision']: raise RuntimeFailure('The image model revision does not match this profile.')
            for name,item in data['files'].items():
                file=safe_path(directory,name)
                if not file.is_file() or file.stat().st_size!=item['size_bytes']: raise RuntimeFailure('Prepared image weights are incomplete. Re-run the package preparation tool.')
        elif package=='h3':
            directory=Path(self.config_path('h3_models_dir')); package_dir=Path(self.config_path('h3_package_dir'))
            lock=json.loads((package_dir/'checkpoints.lock.json').read_text())
            for item in lock['files']:
                if selected['preset'] in item['profiles']:
                    file=directory/item['destination']
                    if not file.is_file() or file.stat().st_size!=item['bytes']: raise RuntimeFailure('The selected video profile needs missing or incomplete weights. Open Creation tools.')
        elif package=='qwen-coder':
            key='writing_hub_dir' if self.config.get('writing_hub_dir') else 'hf_hub_dir'
            directory=Path(self.config_path(key))/CHAT_PACKAGES[package]['repository']/'snapshots'/selected['revision']
            try:
                for name, size in {**CODER_SUPPORT_SIZES, **CODER_SHARD_SIZES}.items():
                    file=directory/name
                    if not file.is_file() or file.stat().st_size!=size:
                        raise RuntimeFailure('The Qwen-Coder checkpoint is missing or incomplete. Open Creation tools to download or repair it.')
                content=(directory/'model.safetensors.index.json').read_bytes()
                if hashlib.sha256(content).hexdigest()!=CODER_INDEX_SHA256:
                    raise RuntimeFailure('The Qwen-Coder weight index does not match the pinned release. Download the package again.')
                index=json.loads(content)
                if set(index.get('weight_map',{}).values())!=set(CODER_SHARD_SIZES):
                    raise RuntimeFailure('The writing checkpoint shard list is incomplete.')
                for name in CODER_SHARD_SIZES:
                    with (directory/name).open('rb') as source:
                        prefix=source.read(8)
                    header_bytes=int.from_bytes(prefix,'little')
                    if len(prefix)!=8 or not 2<=header_bytes<=64*1024**2 or header_bytes+8>=CODER_SHARD_SIZES[name]:
                        raise RuntimeFailure('A writing checkpoint shard is incomplete or has an invalid header. Download the package again.')
            except (OSError, ValueError, TypeError) as error:
                raise RuntimeFailure('The Qwen-Coder checkpoint could not be verified. Open Creation tools to download or repair it.') from error
        elif package=='qwen3-4b':
            try:
                self._local_qwen3.validate(self.command,self.owner,image,
                    self.config_path('qwen3_4b_model_dir'),selected['revision'],inspected.stdout)
            except LocalPackageError as error:
                raise RuntimeFailure(str(error)) from error
        elif package=='qwen38':
            contract=CHAT_PACKAGES[package]
            mounts,env=self.chat_source(package,selected['revision'])
            if self.config.get('qwen38_cache_volume') and not self.config.get('qwen38_model_dir'):
                if self.command(['volume','inspect',mounts[0][0]]).returncode:
                    raise RuntimeFailure('The configured writing cache volume is missing. Studio will not create or download one.')
                # A CPU-only, read-only probe can inspect the Docker-owned cache
                # without changing its permissions or writing shared model files.
                script="from pathlib import Path; import sys; p=Path(sys.argv[1]); names="+repr(contract['runtime_files'])+"; ok=all((p/n).is_file() for n in names); sys.exit(0 if ok and (p/'model.safetensors').stat().st_size=="+str(contract['checkpoint_bytes'])+" else 2)"
                check_key=(image,mounts[0][0],selected['revision'])
                complete=check_key in self._source_checks and time.monotonic()-self._source_checks[check_key]<30
                if not complete:
                    probe=self.command(['run','--rm','--pull=never','--network','none','--read-only','--label',LABEL+'='+self.owner,'--entrypoint','python3','--mount','type=volume,src='+mounts[0][0]+',dst=/base,readonly,volume-nocopy',image,'-c',script,env['PAITON_BASE_MODEL']])
                    complete=probe.returncode==0
                    if complete:self._source_checks[check_key]=time.monotonic()
            else:
                directory=Path(mounts[0][0])
                if not self.config.get('qwen38_model_dir'): directory=directory/contract['repository']/'snapshots'/selected['revision']
                complete=all((directory/name).is_file() for name in contract['runtime_files'])
                complete=complete and (directory/'model.safetensors').stat().st_size==contract['checkpoint_bytes']
            if not complete: raise RuntimeFailure('The exact Qwen3.8 checkpoint is incomplete. Configure a complete local cache in Creation tools.')
        else:
            raise RuntimeFailure('This model does not have a qualified runtime adapter.')
        return image

    def owned(self,container):
        if not container: return False
        result=self.command(['inspect','--format','{{index .Config.Labels "'+LABEL+'"}}',container])
        if result.returncode:
            missing=re.fullmatch(r'(?:Error(?: response from daemon)?: )?No such (?:object|container): '+re.escape(container),getattr(result,'stderr','').strip(),flags=re.IGNORECASE)
            if missing:return False
            raise RuntimeFailure('Studio could not verify its creation tool. Restore local Docker access before retrying.')
        return result.stdout.strip()==self.owner

    def stop(self,container):
        if not self.owned(container): return
        self.command(['stop','--time','10',container],timeout=20)
        if self.owned(container):
            # docker rm -f is restricted to this exact persisted ID + ownership label.
            self.command(['rm','-f',container],timeout=20)
        if self.owned(container):
            raise RuntimeFailure('Studio could not confirm that its creation tool stopped. Creation will wait for recovery.')

    def cleanup_owned(self):
        # Handles a crash between Docker create and persistence of its returned ID.
        result=self.command(['ps','--all','--quiet','--no-trunc','--filter','label='+LABEL+'='+self.owner])
        if result.returncode:raise RuntimeFailure('Docker is unavailable. Start Docker before recovering creation work.')
        for container in result.stdout.split():self.stop(container)
        remaining=self.command(['ps','--all','--quiet','--no-trunc','--filter','label='+LABEL+'='+self.owner])
        if remaining.returncode or remaining.stdout.strip():
            raise RuntimeFailure('Studio could not confirm that its previous tool stopped. Creation will wait and retry recovery.')

    def touch_chat(self):
        # A browser heartbeat retains an already loaded model; it never loads one.
        with self._memory_policy_lock:
            self._chat_active_until=time.monotonic()+self.warm_seconds

    def configure_memory_policy(self, minutes):
        """Update idle retention without loading, stopping or interrupting a tool."""
        if type(minutes) is not int or minutes not in (2,5,15):
            raise ValueError('Choose a supported keep-ready time: 2, 5 or 15 minutes.')
        with self._memory_policy_lock:
            delta=minutes*60-self.warm_seconds
            self.warm_seconds=minutes*60
            if self._warm:
                self._warm={**self._warm,'until':self._warm['until']+delta}
            # Zero denotes no browser presence; a preference must not create it.
            if self._chat_active_until:
                self._chat_active_until+=delta

    def memory_status(self):
        """Sanitized lifecycle record, not a live GPU residency measurement."""
        from .registry import PACKAGES
        with self._memory_policy_lock:
            warm=self._warm
            retained=None
            if warm:
                remaining=max(0,self._warm_deadline(warm)-time.monotonic())
                model=next((p['model'] for p in PACKAGES if p['id']==warm['package']),None)
                retained=dict(package=warm['package'],model=model,
                              state='releasing' if warm.get('releasing') or not remaining else 'ready',
                              idle_remaining_seconds=round(remaining))
                if warm.get('conversation'): retained['conversation']=warm['conversation']
            return dict(keep_ready_minutes=self.warm_seconds//60,retained_model=retained,
                        retention_package_ids=[p for p,c in CHAT_PACKAGES.items() if c.get('keep_warm')],
                        ram_resume_supported=False)

    def _warm_deadline(self,warm):
        # An unrelated GPT tab must not pin a writing-only model indefinitely.
        presence=self._chat_active_until if CHAT_PACKAGES.get(warm['package'],{}).get('chat_presence') else 0
        return max(warm['until'],presence)

    def warm_for(self,request):
        profile=request['profile']; contract=CHAT_PACKAGES.get(profile['package'],{})
        warm=self._warm
        image=self.config.get(contract.get('image_key'))
        if profile['package']=='qwen38-mxfp4':
            from .conversation_options import image_for,launch_identity
            image=image_for(profile)
            if not warm or warm.get('launch_identity')!=launch_identity(profile,self.chat_source(profile['package'],profile['revision'])[0]):return False
        return bool(warm and not warm.get('releasing') and contract.get('keep_warm')
                    and warm.get('package')==profile['package']
                    and warm.get('revision')==profile['revision']
                    and warm['image']==image
                    and time.monotonic()<self._warm_deadline(warm))

    def warm_live(self):
        return bool(self._warm)

    def warm_expired(self):
        warm=self._warm
        return bool(warm and time.monotonic()>=self._warm_deadline(warm))

    def warm_owns_gpu(self,status):
        if not self._warm or not self.owned(self._warm['container']):return False
        result=self.command(['top',self._warm['container'],'-eo','pid'])
        pids={int(p) for p in result.stdout.split() if p.isdigit()}
        return result.returncode==0 and set(status.get('pids',[])).issubset(pids)

    def drop_warm(self):
        with self._memory_policy_lock:
            warm=self._warm
            if warm:self._warm={**warm,'releasing':True}
        if warm:
            # Slow Docker shutdown never holds the settings/status lock. A stop
            # failure preserves the record and the worker's exclusive GPU lease.
            self.stop(warm['container'])
            with self._memory_policy_lock:
                self._warm=None

    def check_cancel(self,job):
        if self.store.job(job['id'])['cancel']: raise Cancelled()

    def start(self,job,image,args,env=None,mounts=None,entrypoint=None,workdir=None):
        directory=self.store.root/'jobs'/job['id']; directory.mkdir(parents=True,exist_ok=True)
        for name in ('data','data/custom_nodes','data/models','user','output','temp'):
            (directory/name).mkdir(parents=True,exist_ok=True)
        cache=self.store.root/'runtime-cache'/job['request']['profile']['package']; cache.mkdir(parents=True,exist_ok=True)
        command=['create','--pull=never','--name','paiton-studio-'+self.owner[:8]+'-'+job['id'][:12],'--label',LABEL+'='+self.owner,
                 '--network','none','--log-driver','local','--log-opt','max-size=1m','--log-opt','max-file=2','--init','--device','/dev/kfd','--device','/dev/dri','--group-add',str(os.stat('/dev/kfd').st_gid),'--shm-size','2g',
                 '--user',f'{os.getuid()}:{os.getgid()}', '-v',str(directory)+':/job','-v',str(ROOT/'scripts')+':/studio:ro','-v',str(cache)+':/models/cache','-v',str(self.store.root/'jobs')+':/studio-jobs']
        for key,value in {'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','HF_DATASETS_OFFLINE':'1',
                          'HF_HOME':'/models/cache/huggingface','HF_HUB_CACHE':'/models/cache/huggingface/hub',
                          'TORCHINDUCTOR_CACHE_DIR':'/models/cache/inductor','TRITON_CACHE_DIR':'/models/cache/triton',
                          'XDG_CACHE_HOME':'/models/cache/xdg',**(env or {})}.items(): command += ['-e',key+'='+value]
        for source,dest in mounts or []: command += ['-v',source+':'+dest+':ro']
        if workdir: command += ['-w',workdir]
        if entrypoint: command += ['--entrypoint',entrypoint]
        command += [image,*args]
        created=self.command(command)
        if created.returncode: raise RuntimeFailure('Could not start the local tool. Check Docker and GPU device access.')
        container=created.stdout.strip()
        self.store.status(job['id'],'loading','Loading the creation tool.',container=container)
        self.check_cancel(job)
        return container,directory

    def stream(self,job,command,limit=1800):
        try:
            command,environment=self.docker.invocation(command)
            process=subprocess.Popen(command,env=environment,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
        except DockerLocalError as error:raise RuntimeFailure(str(error)) from error
        messages=queue.Queue()
        def reader():
            for line in process.stdout: messages.put(line)
        thread=threading.Thread(target=reader,daemon=True);thread.start()
        deadline=time.monotonic()+limit
        error_tail=''
        try:
            while process.poll() is None or not messages.empty() or thread.is_alive():
                self.check_cancel(job)
                if time.monotonic()>deadline: raise RuntimeFailure('The local tool timed out. Your project is saved; retry when ready.')
                try: line=messages.get(timeout=.2)
                except queue.Empty: continue
                error_tail=(error_tail+line)[-8000:]
                if line.startswith('STUDIO:'):
                    data=json.loads(line[7:])
                    progress=data.get('progress')
                    if progress is not None:
                        previous=self.store.job(job['id']).get('progress') or {}
                        if previous.get('context'): progress={**progress,'context':previous['context']}
                    self.store.status(job['id'],data['state'],data['message'],progress)
            if process.returncode:
                atomic(self.store.root/'jobs'/job['id']/'runtime-error.log',error_tail.encode())
                if 'out of memory' in error_tail.lower() or 'cannot allocate memory' in error_tail.lower():
                    raise RuntimeFailure('There is not enough free memory for this profile. Close another GPU application or explicitly select a supported smaller profile. Your original request is saved.')
                raise RuntimeFailure('The local tool stopped before completing. Check available memory and the installed package, then retry. The profile was not changed.')
        finally:
            if process.poll() is None: process.terminate()
            try: process.wait(timeout=3)
            except subprocess.TimeoutExpired: process.kill();process.wait()

    def http(self,container,port,path,body=None,timeout=5):
        request=dict(port=port,path=path,timeout=timeout)
        if body is not None: request['body']=body
        result=self.command(['exec','-i',container,'python3','/studio/http_bridge.py'],input=json.dumps(request),timeout=timeout+10)
        if result.returncode: raise RuntimeFailure('The local tool is not ready.')
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def wait_ready(self,job,container,port,path):
        deadline=time.monotonic()+1200
        while time.monotonic()<deadline:
            self.check_cancel(job)
            try: return self.http(container,port,path)
            except RuntimeFailure: pass
            state=self.command(['inspect','--format','{{json .State}}',container])
            details=json.loads(state.stdout) if state.returncode==0 else {}
            if details.get('OOMKilled'):raise RuntimeFailure('The tool ran out of system memory while loading. Close other local applications and retry the saved request.')
            if not details.get('Running'): raise RuntimeFailure('The tool exited during loading. Check its installed weights and runtime.')
            time.sleep(1)
        raise RuntimeFailure('Loading took too long. Your work is saved; retry after checking the local package.')

    def run(self,job):
        if job['request'].get('task')=='meeting':
            from .meeting_runtime import run
            return run(self,job)
        request=job['request']; profile=validate_snapshot(request['profile'],request.get('task')); package=profile['package']
        request={**request,'profile':profile}
        self.check_cancel(job)
        # Build the exact request before entering runtime ownership. Invalid
        # internal planning messages must not trigger a costly load or release
        # a model that is still usable by the next valid request.
        body=writing_body(request) if profile['adapter']=='paiton-chat' else None
        hardware=compatibility(profile,gpu_status())
        if not hardware['compatible']: raise RuntimeFailure(hardware['reason'])
        image=self.preflight(request)
        directory=self.store.root/'jobs'/job['id'];directory.mkdir(parents=True,exist_ok=True)
        atomic(directory/'request.json',json.dumps(request).encode())
        started=time.monotonic(); container=None;retain=False
        try:
            if profile['adapter']=='paiton-wan':
                from .release_adapters import wan_run
                return wan_run(self,job,image,directory)
            if profile['adapter']=='paiton-flux':
                container,_=self.start(job,image,['/studio/flux_job.py'],env={'PAITON_MODEL_DIR':'/prepared'},mounts=[(self.config_path('flux_model_dir'),'/prepared')],entrypoint='python3')
                self.stream(job,['start','-a',container])
                info=image_info((directory/'result.png').read_bytes())
                if (info['width'],info['height'])!=(profile['width'],profile['height']): raise RuntimeFailure('Image dimensions do not match the selected profile.')
                return 'image',directory/'result.png',info
            if profile['adapter']=='paiton-h3':
                package_dir=Path(self.config_path('h3_package_dir'))
                graph=json.loads((package_dir/'comfyui/workflows'/f"{profile['preset']}.api.json").read_text())
                graph['5']['inputs'].update(prompt=request['prompt'],width=profile['width'],height=profile['height'],length=profile['frames'])
                graph['12']['inputs']['noise_seed']=request['seed']; graph['17']['inputs']['filename_prefix']='clip'
                transform=None
                if request.get('source'):
                    source=self.store.asset(request['source']['id'],job['project'])
                    if source['metadata']['sha256']!=request['source']['sha256']: raise RuntimeFailure('The source image changed. Select it again.')
                    transform=letterbox(self.store.file(source),directory/'input.png',profile['width'],profile['height'])
                    import hashlib
                    transform['sha256']=hashlib.sha256((directory/'input.png').read_bytes()).hexdigest()
                    graph['18']={'class_type':'LoadImage','inputs':{'image':'input.png'}}
                    graph['5']['inputs']['first_frame']=['18',0]
                atomic(directory/'workflow.json',json.dumps(graph).encode())
                container,_=self.start(job,image,['main.py','--base-directory','/job/data','--input-directory','/job','--output-directory','/job/output','--user-directory','/job/user','--extra-model-paths-config','/job/models.yaml','--listen','127.0.0.1','--port','8188','--disable-api-nodes','--use-ck-attention','--bf16-vae','--fast-disk','--reserve-vram','2','--cache-ram','2','--preview-method','none'],mounts=[(self.config_path('h3_models_dir'),'/weights')],entrypoint='python3',workdir='/opt/comfyui')
                atomic(directory/'models.yaml',b'paiton_runtime:\n  base_path: /opt/comfyui\n  custom_nodes: custom_nodes\npaiton_studio:\n  base_path: /weights\n  diffusion_models: diffusion_models\n  text_encoders: text_encoders\n  vae: vae\n  loras: loras\n')
                self.command(['start',container]);self.wait_ready(job,container,8188,'/system_stats')
                info=self.http(container,8188,'/object_info/MiniMaxH3ImageToVideo')
                if 'MiniMaxH3ImageToVideo' not in info: raise RuntimeFailure('This installed video runtime lacks the image input node. Select the newer local package.')
                self.stream(job,['exec',container,'python3','/studio/comfy_job.py'],limit=2400)
                outputs=list((directory/'output').rglob('*.mp4'))
                if len(outputs)!=1: raise RuntimeFailure('A complete video output was not found.')
                info=video_info(outputs[0]);info['transform']=transform
                if info['width']!=profile['width'] or info['height']!=profile['height'] or not info['audio'] or abs(info['duration']-profile['frames']/profile['fps'])>.15: raise RuntimeFailure('The output media does not match the selected video profile.')
                return 'video',outputs[0],info
            if profile['adapter']!='paiton-chat' or profile['task']!='write':
                raise RuntimeFailure('The selected model cannot perform this creation task.')
            contract=CHAT_PACKAGES[package]
            mounts,env=self.chat_source(package,profile['revision'])
            if package=='gptoss':
                from .release_adapters import prepare_harmony
                prepare_harmony(self,job,image)
            if self.warm_for(request):
                container=self._warm['container']
                self.store.status(job['id'],'loading','Reusing the ready local text model.',container=container)
            else:
                self.drop_warm()
                args=contract['args']
                if package=='qwen38-mxfp4':
                    from .qwen_mxfp4 import sources
                    args=sources(self.config)[1]
                    from .conversation_options import engine_profile
                    launch=directory/'engine-profile.json'
                    atomic(launch,json.dumps(engine_profile(profile.get('conversation_options')),sort_keys=True).encode())
                    mounts=[*mounts,(str(launch),'/opt/paiton-release/engine-profile.json')]
                container,_=self.start(job,image,['/studio/gptoss_server.py',*args] if package=='gptoss' else args,mounts=mounts,env=env,entrypoint='python3' if package=='gptoss' else None)
                self.command(['start',container])
            self.wait_ready(job,container,contract['port'],'/health')
            conversation_meta={}
            if request.get('chat_id') or request.get('agent_run_id'):
                from .conversation_runner import run as run_conversation
                try:
                    response,conversation_meta=run_conversation(self,job,container,contract['port'],body,directory)
                except ValueError as error:
                    retain=bool(self._warm and self._warm['container']==container and self.warm_for(request)
                                and not self.store.job(job['id'])['cancel'])
                    raise InputRejected(str(error)) from error
                content=response['choices'][0]['message']['content']
            else:
                # All current supported text packages expose vLLM's tokenizer API.
                # Count the exact templated input and reserve the unchanged output
                # budget, including for long edited pages and ordinary writing.
                self.check_cancel(job)
                tokenized=self.http(container,contract['port'],'/tokenize',{k:body[k] for k in ('model','messages','chat_template_kwargs') if k in body},timeout=20)
                self.check_cancel(job)
                count=tokenized.get('count') if isinstance(tokenized,dict) else None
                if type(count) is not int or count<0:
                    raise RuntimeFailure('The local model could not verify this request’s context size. No generation was started. Check the installed package and retry.')
                if count+profile['max_tokens']>profile['context']:
                    # A successful tokenizer response confirms the existing server
                    # is healthy. Preserve only an already-retained matching model
                    # so shortening the input does not pay for another cold load.
                    warm=self._warm
                    retain=bool(warm and warm['container']==container and self.warm_for(request)
                                and not self.store.job(job['id'])['cancel'])
                    raise InputRejected('This request and its source text exceed the selected model’s context budget. Shorten the page or notes, use fewer attachments, or start a new conversation. Nothing was truncated and no generation was started.')
                message='Drafting your email reply locally.' if (request.get('mail_draft_id') or request.get('mcp_request_id')) else 'Working on your agent’s '+('review.' if request.get('purpose')=='agent-review' else 'draft.') if request.get('agent_run_id') else 'Preparing your conversation reply.' if request.get('chat_id') else 'Rewriting this page from your saved copy and requested changes.' if request.get('purpose')=='website-page-copy' else 'Planning your website from your brief and selected text context.' if request.get('messages') else 'Writing your draft from your notes and selected text context.'
                self.store.status(job['id'],'generating',message)
                # Poll cancellation while the isolated HTTP client waits for the local response.
                atomic(directory/'writing-request.json',json.dumps(dict(port=contract['port'],path='/v1/chat/completions',body=body,timeout=600)).encode())
                if request.get('chat_id') or request.get('agent_run_id') or (request.get('mail_draft_id') or request.get('mcp_request_id')):
                    self.stream(job,['exec',container,'python3','/studio/chat_stream.py','/studio-jobs/'+job['id']],limit=630)
                else:
                    result=self.command(['exec',container,'python3','-c',"import subprocess; from pathlib import Path; r=subprocess.run(['python3','/studio/http_bridge.py'],input=Path('/studio-jobs/"+job['id']+"/writing-request.json').read_bytes(),capture_output=True); Path('/studio-jobs/"+job['id']+"/writing-result.json').write_bytes(r.stdout); raise SystemExit(r.returncode)"],timeout=630)
                    self.check_cancel(job)
                    if result.returncode: raise RuntimeFailure('The writing tool did not complete. Retry the saved request.')
                response=json.loads((directory/'writing-result.json').read_text()); content=response['choices'][0]['message']['content']
            if not isinstance(content,str) or not content.strip(): raise RuntimeFailure('The local model did not return a final answer. Your request is saved; retry it or shorten the request.')
            atomic(directory/'result.md',content.encode())
            if contract.get('keep_warm') and (contract.get('retain_for_writing') or request.get('chat_id') or request.get('agent_run_id') or (request.get('mail_draft_id') or request.get('mcp_request_id'))) and not self.store.job(job['id'])['cancel']:
                with self._memory_policy_lock:
                    self._warm={'container':container,'image':image,'package':package,'revision':profile['revision'],'until':time.monotonic()+self.warm_seconds}
                    if package=='qwen38-mxfp4':
                        from .conversation_options import launch_identity,details
                        self._warm.update(launch_identity=launch_identity(profile,self.chat_source(package,profile['revision'])[0]),conversation=details(profile))
                retain=True
            return 'text',directory/'result.md',dict(format=request.get('format','Website plan' if request.get('messages') else 'Blog post'),context=request.get('context',''),text_only=True,finish_reason=response['choices'][0].get('finish_reason'),usage=response.get('usage'),reasoning_effort=request.get('reasoning_effort'),thinking_token_budget=body.get('thinking_token_budget'),max_output_tokens=body['max_tokens'],reasoning_observed=response.get('reasoning_observed',False),context_selection=conversation_meta.get('context'),tool_artifacts=conversation_meta.get('tool_artifacts',[]),tool_rounds=conversation_meta.get('tool_rounds',0),timing=conversation_meta.get('timing'))
        finally:
            container=container or self.store.job(job['id']).get('container')
            if not retain:
                if container:
                    try:
                        logs=self.command(['logs','--tail','100',container])
                        atomic(directory/'runtime-container.log',(logs.stdout+logs.stderr).encode())
                    except Exception:pass  # Diagnostics must never prevent owned-container cleanup.
                self.stop(container)
                if self._warm and self._warm['container']==container:self._warm=None

    def recover_video(self,job):
        """Recover a completed, validated file; this never resumes GPU computation."""
        if job['state']!='failed' or job['request']['task']!='video':
            raise ValueError('Only a failed video request with a completed file can be recovered.')
        directory=self.store.root/'jobs'/job['id']
        result=directory/'result.json'
        if not result.is_file() or not json.loads(result.read_text()).get('status',{}).get('completed'):
            raise ValueError('No completed video is available to recover. Retry the request instead.')
        files=list((directory/'output').glob('*.mp4'))
        if len(files)!=1: raise ValueError('A single completed output was not found.')
        path=safe_path(directory,str(files[0].relative_to(directory)))
        info=video_info(path);p=job['request']['profile']
        if (info['width'],info['height'],info['decoded_frames'])!=(p['width'],p['height'],p['frames']) or not info['audio'] or abs(info['duration']-p['frames']/p['fps'])>.15:
            raise ValueError('The saved video does not match the original request.')
        if job['request'].get('source'):
            source=self.store.asset(job['request']['source']['id'],job['project'])
            if source['metadata']['sha256']!=job['request']['source']['sha256']: raise ValueError('Source image verification failed.')
            transform=letterbox(self.store.file(source),directory/'verify-input.png',p['width'],p['height'])
            import hashlib
            digest=hashlib.sha256((directory/'input.png').read_bytes()).hexdigest()
            if hashlib.sha256((directory/'verify-input.png').read_bytes()).hexdigest()!=digest: raise ValueError('The fitted source image does not match the saved request.')
            transform['sha256']=digest;info['transform']=transform
            graph=json.loads((directory/'workflow.json').read_text())
            if graph['5']['inputs'].get('first_frame')!=['18',0]: raise ValueError('The saved workflow has no source image binding.')
        info['recovered_completed_file']=True
        return path,info
