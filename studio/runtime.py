"""Own containers, not an inference engine. Never operate on shared services."""
import json
import hashlib
import math
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import threading
import time
import uuid

from .chat_adapters import CHAT_PACKAGES, writing_body, chat_contract
from .docker_local import LocalDocker, DockerLocalError
from .local_qwen3 import LocalPackageError, LocalQwen3Validator
from .media import image_info, letterbox, video_info
from .registry import compatibility, validate_snapshot
from .telemetry import gpu_status
from .store import atomic, safe_path
from .performance import normalize_performance, response_performance

ROOT=Path(__file__).resolve().parents[1]
LABEL='dev.paiton.studio.owner'
# Keep-ready choices in minutes. The sentinel keeps a supported text model
# loaded with no idle expiry: it is still released on request, at shutdown,
# or when a queued request needs the GPU for another tool.
KEEP_READY_UNTIL_RELEASED=-1
KEEP_READY_DEFAULT_MINUTES=15
KEEP_READY_CHOICES=(KEEP_READY_DEFAULT_MINUTES,60,KEEP_READY_UNTIL_RELEASED)
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
        self._active_text=None
        self._text_hard_stops=set()
        self.text_cancel_timeout=5.0
        # None means no idle expiry; deadlines derive from activity timestamps.
        self.warm_seconds=KEEP_READY_DEFAULT_MINUTES*60
        self._chat_active_at=0
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

    def pin_request(self, request):
        """Record an installed artifact before enqueue, including retries."""
        if request.get('runtime_image') or not request.get('profile'):
            return request
        from .setup_catalog import PACKAGES as catalog
        package = request['profile'].get('package')
        reference = self.config.get(catalog.get(package, {}).get('image_key'))
        if package == 'qwen38-mxfp4':
            # Qwen's release contract owns its image, including installations
            # connected through checkpoint folders without an image config key.
            from .conversation_options import image_for
            reference = image_for(request['profile'])
        if not reference:
            return request  # Uninstalled requests keep the existing setup flow.
        inspected = self.command(['image', 'inspect', reference], timeout=5)
        if inspected.returncode:
            raise RuntimeFailure('The selected runtime package is missing. Repair it in Settings before adding this request.')
        try:
            image_id = json.loads(inspected.stdout)[0]['Id']
            if not re.fullmatch(r'sha256:[a-f0-9]{64}', image_id): raise ValueError()
        except (ValueError, KeyError, IndexError, TypeError) as error:
            raise RuntimeFailure('The selected runtime package could not be identified.') from error
        selection = self.config.get('runtime_package_selections', {}).get(catalog.get(package, {}).get('image_key'), {})
        display = selection.get('reference') if selection.get('image_id') == image_id else reference
        return {**request, 'runtime_image': image_id, 'runtime_ref': display or reference}

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

    def preflight(self,request,*,verify_content=True):
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
        if selected['adapter']=='paiton-qwen-image21' and 'prompt' in request:
            from .qwen_image21 import validate_request, validate_source
            validate_request({**request,'profile':selected})
            if selected['mode']=='edit': validate_source(self.store,request)
        image_key={'qwen-image21':'qwen_image21_image','qwen-image21-uncensored':'qwen_image21_uncensored_image',
                   'flux':'flux_image','h3':'h3_image','wan':'wan_image','fastwan':'wan_image'}.get(package)
        if selected['adapter']=='paiton-chat':
            if package not in CHAT_PACKAGES: raise RuntimeFailure('This text model has no qualified launch contract yet.')
            image_key=CHAT_PACKAGES[package]['image_key']
        image=request.get('runtime_image') or self.config.get(image_key)
        if package=='qwen38-mxfp4' and not request.get('runtime_image'):
            from .conversation_options import image_for
            image=image_for(selected)
        if request.get('runtime_image') and not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
            raise RuntimeFailure('The saved runtime package identity is invalid. Create a new request.')
        inspected=self.command(['image','inspect',image]) if image else None
        if inspected is None or inspected.returncode: raise RuntimeFailure('The local runtime image is not installed. Open Creation tools.')
        if shutil.disk_usage(self.store.root).free<2*1024**3: raise RuntimeFailure('Less than 2 GB of free disk remains. Free space before creating media.')
        if selected['adapter']=='paiton-qwen-image21':
            from .qwen_image21 import preflight
            try: preflight(self,inspected.stdout,selected)
            except (ValueError,OSError,KeyError) as error:
                raise RuntimeFailure(str(error) if isinstance(error,ValueError) else 'Qwen image files could not be verified. Repair setup in Settings.') from error
        elif package=='qwen38-mxfp4':
            from .qwen_mxfp4 import preflight
            try:
                from .qwen_mxfp4 import verify_image
                from .conversation_options import ConversationOptions, release_spec
                reference=verify_image(inspected.stdout,image)
                weights=ConversationOptions.model_validate(selected.get('conversation_options',{})).weights
                release_spec(selected.get('conversation_options'),reference)
                # Only trusted readiness callers select metadata inspection.
                # Request payloads cannot disable execution-time checksums.
                preflight(self,image,inspected.stdout,weights=weights,verify_content=verify_content)
                self._source_checks[('qwen-image',image)]=reference
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
                    probe=self.command(['run','--rm','--pull=never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--label',LABEL+'='+self.owner,'--entrypoint','python3','--mount','type=volume,src='+mounts[0][0]+',dst=/base,readonly,volume-nocopy',image,'-c',script,env['PAITON_BASE_MODEL']])
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
            self._chat_active_at=time.monotonic()

    def request_release(self):
        """Mark a retained tool for the worker's next idle cleanup boundary."""
        with self._memory_policy_lock:
            if self._active_text:
                self._active_text['release_requested']=True
            if self._warm:
                self._warm={**self._warm,'releasing':True,'release_requested':True}
                self._chat_active_at=0
            return self.memory_status()

    def configure_memory_policy(self, minutes):
        """Update idle retention without loading, stopping or interrupting a tool."""
        if type(minutes) is not int or minutes not in KEEP_READY_CHOICES:
            raise ValueError('Choose a supported keep-ready time: 15 minutes, 1 hour, or until you release the model.')
        with self._memory_policy_lock:
            # Deadlines derive from the last activity when read, so a new
            # policy applies immediately without resetting the idle clock.
            self.warm_seconds=None if minutes==KEEP_READY_UNTIL_RELEASED else minutes*60

    def memory_status(self):
        """Sanitized lifecycle record, not a live GPU residency measurement."""
        from .registry import PACKAGES
        with self._memory_policy_lock:
            warm=self._warm
            retained=None
            if warm:
                deadline=self._warm_deadline(warm)
                remaining=None if deadline==math.inf else max(0,deadline-time.monotonic())
                model=next((p['model'] for p in PACKAGES if p['id']==warm['package']),None)
                retained=dict(package=warm['package'],model=model,runtime_image=warm['image'],
                              state='releasing' if warm.get('releasing') or remaining==0 else 'ready',
                              idle_remaining_seconds=None if remaining is None else round(remaining))
                if warm.get('conversation'): retained['conversation']=warm['conversation']
            minutes=KEEP_READY_UNTIL_RELEASED if self.warm_seconds is None else self.warm_seconds//60
            return dict(keep_ready_minutes=minutes,retained_model=retained,
                        retention_package_ids=[p for p,c in CHAT_PACKAGES.items() if c.get('keep_warm')])

    def _warm_deadline(self,warm):
        # Explicit release and failed cleanup remain pending even if another
        # browser sends presence heartbeats or changes the retention interval.
        if warm.get('releasing'):
            return 0
        if self.warm_seconds is None:
            return math.inf
        # An unrelated GPT tab must not pin a writing-only model indefinitely.
        # Zero denotes no browser presence; a preference never creates it.
        presence=self._chat_active_at+self.warm_seconds if self._chat_active_at and CHAT_PACKAGES.get(warm['package'],{}).get('chat_presence') else 0
        return max(warm['since']+self.warm_seconds,presence)

    def _qwen_reference(self, request, image=None):
        from .conversation_options import image_for, release_spec
        reference=image or request.get('runtime_image') or image_for(request['profile'])
        reference=self._source_checks.get(('qwen-image',reference),reference)
        # Unknown classic Docker IDs cannot establish a warm launch identity
        # until preflight has tied them to an approved immutable RepoDigest.
        return release_spec(request['profile'].get('conversation_options'),reference)['registry_image']

    def _qwen_execution(self, request, image=None):
        from .conversation_options import ConversationOptions, engine_profile, launch_identity, details
        from .qwen_mxfp4 import source_contract
        profile=request['profile']
        reference=self._qwen_reference(request,image)
        weights=ConversationOptions.model_validate(profile.get('conversation_options',{})).weights
        sources=source_contract(self.config,reference,weights)
        engine=engine_profile(profile.get('conversation_options'),reference,sources)
        env={'USER':'paiton','LOGNAME':'paiton','HOME':'/models/cache',**engine['environment']}
        cache={}
        if engine['entrypoint_kind']=='direct-cli':
            env.update(HOME='/cache',HF_HOME='/cache/hf',HF_HUB_CACHE='/cache/hf/hub',
                       TORCHINDUCTOR_CACHE_DIR='/cache/inductor',TRITON_CACHE_DIR='/cache/triton',
                       XDG_CACHE_HOME='/cache/xdg',AITER_ROOT_DIR='/cache/aiter',VLLM_CACHE_ROOT='/cache/vllm')
            if engine.get('host_visibility'):
                # The published launcher removes image-default GPU masks when
                # absent on the host, and preserves explicit values, even empty.
                env.update({key:os.environ.get(key) for key in
                            ('ROCR_VISIBLE_DEVICES','HIP_VISIBLE_DEVICES','CUDA_VISIBLE_DEVICES')})
            cache={'cache_variant':'rocm10-'+reference.rsplit(':',1)[-1][:16],'cache_target':'/cache'}
        receipt={'runtime_image':reference,'weights':weights,'entrypoint_kind':engine['entrypoint_kind'],
                 'arguments':engine['arguments'],'environment':env,'manifest_sha256':sources['manifest_sha256'],
                 'components':{role:{'repository':component['spec']['repository'],
                                     'revision':component['spec']['revision']}
                               for role,component in sources['components'].items()},
                 'cache_target':cache.get('cache_target','/models/cache')}
        # The launch identity includes private mount paths while the public
        # reply receipt exposes pinned source identities without host paths.
        identity=hashlib.sha256(json.dumps({'contract':launch_identity(profile,sources,reference),
                                          'environment':env,'cache':cache},sort_keys=True).encode()).hexdigest()
        return dict(reference=reference,sources=sources,engine=engine,env=env,cache=cache,
                    identity=identity,conversation=details(profile,reference),receipt=receipt)

    def warm_for(self,request,finish_active=False):
        profile=request['profile']; contract=CHAT_PACKAGES.get(profile['package'],{})
        warm=self._warm
        image=self.config.get(contract.get('image_key'))
        if profile['package']=='qwen38-mxfp4':
            try: execution=self._qwen_execution(request)
            except (ValueError,OSError,KeyError):return False
            image=execution['reference']
            if not warm or warm.get('launch_identity')!=execution['identity']:return False
        pending=bool(warm and finish_active and warm.get('release_requested'))
        return bool(warm and (not warm.get('releasing') or pending) and contract.get('keep_warm')
                    and warm.get('package')==profile['package']
                    and warm.get('revision')==profile['revision']
                    and warm['image']==(request.get('runtime_image') or image)
                    and (pending or time.monotonic()<self._warm_deadline(warm)))

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

    def cancel_text(self, identity, container):
        """Claim cancellation only after this owned text server became ready."""
        from scripts.cancellable_stream import request_cancel
        with self._memory_policy_lock:
            active=self._active_text
            if (not active or active['job']!=identity or active['container']!=container
                or not active.get('ready') or active.get('http_busy')):
                self._text_hard_stops.add((identity,container))
                return False
            invocation=active.get('invocation')
            if invocation:
                try:request_cancel(invocation['directory'],invocation['nonce'])
                except Exception:
                    active['safe']=False
                    self._text_hard_stops.add((identity,container))
                    raise
            return True

    def finish_job(self, identity):
        # Keep the handoff alive through the worker's terminal transaction: a
        # Stop racing with result saving must not kill an already idle server.
        with self._memory_policy_lock:
            if self._active_text and self._active_text['job']==identity:
                self._active_text=None
            self._text_hard_stops={entry for entry in self._text_hard_stops if entry[0]!=identity}

    def _remember_warm(self, request, image, container, *, cleanup_failed=False, execution=None):
        profile=request['profile'];package=profile['package']
        with self._memory_policy_lock:
            active=self._active_text
            release=bool((self._warm and self._warm['container']==container and self._warm.get('release_requested'))
                         or (active and active['container']==container and active.get('release_requested')))
            warm={'container':container,'image':image,'package':package,'revision':profile['revision'],'since':time.monotonic()}
            if package=='qwen38-mxfp4':
                execution=execution or self._qwen_execution(request,image)
                warm.update(launch_identity=execution['identity'],conversation=execution['conversation'])
            if release:warm.update(releasing=True,release_requested=True)
            if cleanup_failed:warm['releasing']=True
            self._warm=warm

    def _stream_invocation(self, job, command):
        if len(command)<5 or command[0]!='exec' or command[3]!='/studio/chat_stream.py':
            return None
        directory=Path(command[-1])
        try:
            relative=directory.relative_to('/studio-jobs/'+job['id'])
            directory=safe_path(self.store.root/'jobs'/job['id'],str(relative))
            request=json.loads((directory/'writing-request.json').read_text())
            nonce=request['invocation_nonce']
            if not isinstance(nonce,str) or not re.fullmatch('[a-f0-9]{32}',nonce):raise ValueError()
        except (ValueError,KeyError,OSError) as error:
            raise RuntimeFailure('The local reply invocation could not be identified safely.') from error
        invocation=dict(directory=directory,nonce=nonce,internal=bool(request.get('internal')))
        # A previous retry's result cannot prove that this invocation completed.
        (directory/'writing-result.json').unlink(missing_ok=True)
        with self._memory_policy_lock:
            active=self._active_text
            if active and active['job']==job['id'] and active['container']==command[1]:
                active.update(invocation=invocation,safe=False)
        return invocation

    def _accept_stream_ack(self, job, invocation, ack, exited):
        safe=bool(ack and exited and ack['state'] in ('cancelled','closed'))
        if safe and ack['state']=='closed' and self.store.job(job['id'])['cancel']:
            try:
                result=json.loads((invocation['directory']/'writing-result.json').read_text())
                safe=bool(result.get('invocation_nonce')==invocation['nonce'] and not result.get('error')
                          and result['choices'][0].get('finish_reason') in ('stop','length','tool_calls'))
            except (OSError,ValueError,KeyError,IndexError,TypeError):safe=False
        if ack and not invocation['internal']:
            self.store.save_partial(job['id'],ack.get('partial'))
        with self._memory_policy_lock:
            active=self._active_text
            if active and active['job']==job['id'] and active.get('invocation') is invocation:
                active.update(invocation=None,safe=safe)
        return safe

    def _cancel_stream(self, job, invocation, process):
        from scripts.cancellable_stream import request_cancel, read_ack
        request_cancel(invocation['directory'],invocation['nonce'])
        # Event.wait uses a real monotonic timeout even in tests with a frozen
        # inference clock. Never terminate docker exec before giving the relay
        # a chance to close its in-container HTTP socket and acknowledge it.
        deadline=time.perf_counter()+self.text_cancel_timeout
        ack=None
        while time.perf_counter()<deadline:
            exited=process.poll() is not None
            ack=read_ack(invocation['directory'],invocation['nonce'])
            if ack and exited:break
            threading.Event().wait(.02)
        exited=process.poll() is not None
        ack=read_ack(invocation['directory'],invocation['nonce'])
        self._accept_stream_ack(job,invocation,ack,exited)

    def _cancelled_text_ready(self, job, container):
        with self._memory_policy_lock:
            active=self._active_text
            if (not active or active['job']!=job['id'] or active['container']!=container
                or not active.get('ready') or not active.get('safe') or active.get('invocation')
                or (job['id'],container) in self._text_hard_stops):
                return False
            port=active['port']
        try:
            if not self.owned(container):return False
            self.http(container,port,'/health',timeout=5)
            return True
        except Exception:return False

    def start(self,job,image,args,env=None,mounts=None,entrypoint=None,workdir=None,cache_variant=None,cache_target=None):
        directory=self.store.root/'jobs'/job['id']; directory.mkdir(parents=True,exist_ok=True)
        for name in ('data','data/custom_nodes','data/models','user','output','temp'):
            (directory/name).mkdir(parents=True,exist_ok=True)
        cache=self.store.root/'runtime-cache'/job['request']['profile']['package']
        if cache_variant:
            if not re.fullmatch(r'rocm10-[a-f0-9]{16}',cache_variant) or cache_target!='/cache':
                raise RuntimeFailure('The runtime cache contract is invalid.')
            cache=cache/cache_variant
        elif cache_target:
            raise RuntimeFailure('The runtime cache target requires a pinned release.')
        cache.mkdir(parents=True,exist_ok=True)
        command=['create','--pull=never','--name','paiton-studio-'+self.owner[:8]+'-'+job['id'][:12],'--label',LABEL+'='+self.owner,
                 '--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--log-driver','local','--log-opt','max-size=1m','--log-opt','max-file=2','--init','--device','/dev/kfd','--device','/dev/dri','--group-add',str(os.stat('/dev/kfd').st_gid),'--shm-size','2g',
                 '--user',f'{os.getuid()}:{os.getgid()}', '-v',str(directory)+':/job','-v',str(ROOT/'scripts')+':/studio:ro','-v',str(cache)+':'+(cache_target or '/models/cache')+(':rw' if cache_target else ''),'-v',str(self.store.root/'jobs')+':/studio-jobs']
        for key,value in {'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','HF_DATASETS_OFFLINE':'1',
                          'HF_HOME':'/models/cache/huggingface','HF_HUB_CACHE':'/models/cache/huggingface/hub',
                          'TORCHINDUCTOR_CACHE_DIR':'/models/cache/inductor','TRITON_CACHE_DIR':'/models/cache/triton',
                          'XDG_CACHE_HOME':'/models/cache/xdg',**(env or {})}.items(): command += ['-e',key if value is None else key+'='+value]
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
        invocation=self._stream_invocation(job,command)
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
                if self.store.job(job['id'])['cancel']:
                    if invocation:self._cancel_stream(job,invocation,process)
                    raise Cancelled()
                if time.monotonic()>deadline: raise RuntimeFailure('The local tool timed out. Your project is saved; retry when ready.')
                try: line=messages.get(timeout=.2)
                except queue.Empty: continue
                error_tail=(error_tail+line)[-8000:]
                if line.startswith('STUDIO:'):
                    try:data=json.loads(line[7:])
                    except (ValueError,RecursionError):continue
                    if (not isinstance(data,dict) or data.get('state') not in ('preparing','loading','generating','saving','cancelling')
                        or not isinstance(data.get('message'),str) or len(data['message'])>1500
                        or (data.get('progress') is not None and not isinstance(data['progress'],dict))):continue
                    progress=data.get('progress')
                    if progress is not None:
                        previous=self.store.job(job['id']).get('progress') or {}
                        if previous.get('context'): progress={**progress,'context':previous['context']}
                    self.store.status(job['id'],data['state'],data['message'],progress)
            if invocation:
                from scripts.cancellable_stream import read_ack
                self._accept_stream_ack(job,invocation,read_ack(invocation['directory'],invocation['nonce']),True)
            self.check_cancel(job)
            if process.returncode:
                from .diagnostics import write_job_log, classify_failure
                try:write_job_log(self.store,job['id'],error_tail,filename='runtime-error.log')
                except (OSError,ValueError):pass
                if 'out of memory' in error_tail.lower() or 'cannot allocate memory' in error_tail.lower():
                    raise RuntimeFailure('There is not enough free memory for this profile. Close another GPU application or explicitly select a supported smaller profile. Your original request is saved.')
                failure=classify_failure(error_tail)
                if failure['code']!='unknown':raise RuntimeFailure(failure['message'])
                raise RuntimeFailure('The local tool stopped before completing. Check available memory and the installed package, then retry. The profile was not changed.')
        finally:
            if process.poll() is None: process.terminate()
            try: process.wait(timeout=3)
            except subprocess.TimeoutExpired: process.kill();process.wait()

    def http(self,container,port,path,body=None,timeout=5):
        request=dict(port=port,path=path,timeout=timeout)
        if body is not None: request['body']=body
        active=None
        if path=='/tokenize':
            with self._memory_policy_lock:
                if self._active_text and self._active_text['container']==container:
                    active=self._active_text
                    active['http_busy']=True
            if active and self.store.job(active['job'])['cancel']:
                active['http_busy']=False
                raise Cancelled()
        try:
            result=self.command(['exec','-i',container,'python3','/studio/http_bridge.py'],input=json.dumps(request),timeout=timeout+10)
        finally:
            if active:
                with self._memory_policy_lock:active['http_busy']=False
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
        with self._memory_policy_lock:
            self._active_text=None
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
        started=time.monotonic(); container=None;retain=False;execution=None
        try:
            if profile['adapter']=='paiton-qwen-image21':
                from .qwen_image21 import run
                return run(self,job,image,directory)
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
            if package=='qwen38-mxfp4':
                execution=self._qwen_execution(request,image)
                request={**request,'runtime_ref':execution['reference']}
                body=writing_body(request)
                contract=chat_contract(profile,execution['reference'])
                mounts=execution['sources']['mounts']
                env=execution['env']
            else:
                contract=CHAT_PACKAGES[package]
                mounts,env=self.chat_source(package,profile['revision'])
            if package=='gptoss':
                from .release_adapters import prepare_harmony
                prepare_harmony(self,job,image)
            # Admission already chose this tool. A release click arriving now
            # waits for this request instead of forcing a needless cold reload.
            loading_started=time.monotonic()
            reused=self.warm_for(request,finish_active=True)
            if reused:
                container=self._warm['container']
                self.store.status(job['id'],'loading','Reusing the ready local text model.',container=container)
            else:
                self.drop_warm()
                args=contract['args']
                if package=='qwen38-mxfp4':
                    if execution['engine']['entrypoint_kind']=='direct-cli':
                        args=execution['engine']['arguments']
                    else:
                        paths=execution['sources']['paths']
                        args=['--offline','--target',paths['target'],'--draft',paths['draft']]
                        launch=directory/'engine-profile.json'
                        atomic(launch,json.dumps(execution['engine'],sort_keys=True).encode())
                        mounts=[*mounts,(str(launch),'/opt/paiton-release/engine-profile.json')]
                container,_=self.start(job,image,['/studio/gptoss_server.py',*args] if package=='gptoss' else args,mounts=mounts,env=env,entrypoint='python3' if package=='gptoss' else None,**(execution['cache'] if execution else {}))
                self.command(['start',container])
            managed_text=bool(contract.get('keep_warm') and (request.get('chat_id') or request.get('agent_run_id') or request.get('mail_draft_id') or request.get('mcp_request_id')))
            if managed_text:
                with self._memory_policy_lock:
                    self._active_text=dict(job=job['id'],container=container,port=contract['port'],
                                           invocation=None,safe=False,ready=False,release_requested=False)
            self.wait_ready(job,container,contract['port'],'/health')
            if managed_text:
                with self._memory_policy_lock:
                    if (job['id'],container) not in self._text_hard_stops:
                        self._active_text.update(ready=True,safe=True)
            load_seconds=time.monotonic()-loading_started
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
                atomic(directory/'writing-request.json',json.dumps(dict(port=contract['port'],path='/v1/chat/completions',body=body,timeout=600,
                                                                     invocation_nonce=uuid.uuid4().hex)).encode())
                if request.get('chat_id') or request.get('agent_run_id') or (request.get('mail_draft_id') or request.get('mcp_request_id')):
                    self.stream(job,['exec',container,'python3','/studio/chat_stream.py','/studio-jobs/'+job['id']],limit=630)
                else:
                    result=self.command(['exec',container,'python3','-c',"import subprocess; from pathlib import Path; r=subprocess.run(['python3','/studio/http_bridge.py'],input=Path('/studio-jobs/"+job['id']+"/writing-request.json').read_bytes(),capture_output=True); Path('/studio-jobs/"+job['id']+"/writing-result.json').write_bytes(r.stdout); raise SystemExit(r.returncode)"],timeout=630)
                    self.check_cancel(job)
                    if result.returncode: raise RuntimeFailure('The writing tool did not complete. Retry the saved request.')
                response=json.loads((directory/'writing-result.json').read_text()); content=response['choices'][0]['message']['content']
            if not isinstance(content,str) or not content.strip(): raise RuntimeFailure('The local model did not return a final answer. Your request is saved; retry it or shorten the request.')
            atomic(directory/'result.md',content.encode())
            if (contract.get('keep_warm') and (contract.get('retain_for_writing') or request.get('chat_id') or request.get('agent_run_id') or (request.get('mail_draft_id') or request.get('mcp_request_id')))
                and not self.store.job(job['id'])['cancel'] and (not managed_text or self._active_text.get('safe'))):
                self._remember_warm(request,image,container,execution=execution)
                retain=True
            performance=response_performance(response,replayed=conversation_meta.get('response_replayed',False))
            performance=normalize_performance({**performance,'model_state':'warm' if reused else 'cold',
                                               'load_seconds':load_seconds,'turn_seconds':time.monotonic()-started})
            return 'text',directory/'result.md',dict(format=request.get('format','Website plan' if request.get('messages') else 'Blog post'),context=request.get('context',''),text_only=True,finish_reason=response['choices'][0].get('finish_reason'),usage=response.get('usage'),reasoning_effort=request.get('reasoning_effort'),thinking_token_budget=body.get('thinking_token_budget'),max_output_tokens=body['max_tokens'],reasoning_observed=response.get('reasoning_observed',False),context_selection=conversation_meta.get('context'),tool_artifacts=conversation_meta.get('tool_artifacts',[]),tool_rounds=conversation_meta.get('tool_rounds',0),timing=response.get('timing'),performance=performance,inference=conversation_meta.get('inference'),**({'conversation':execution['conversation'],'runtime_contract':execution['receipt']} if execution else {}))
        except Cancelled:
            if self._cancelled_text_ready(job,container):
                self._remember_warm(request,image,container,execution=execution)
                retain=True
            raise
        finally:
            container=container or self.store.job(job['id']).get('container')
            if not retain:
                if container and not (directory/'runtime-container.log').exists():
                    try:
                        logs=self.command(['logs','--tail','100',container])
                        from .diagnostics import write_job_log
                        write_job_log(self.store,job['id'],logs.stdout+logs.stderr)
                    except Exception:pass  # Diagnostics must never prevent owned-container cleanup.
                try:self.stop(container)
                except Exception:
                    if container and profile.get('adapter')=='paiton-chat':
                        # Retain ownership, not reuse permission, until recovery
                        # confirms that this exact container has stopped.
                        self._remember_warm(request,image,container,cleanup_failed=True,execution=execution)
                    raise
                if self._warm and self._warm['container']==container:self._warm=None

    def video_recoverable(self,job):
        """Cheap per-adapter gate for the Recover action; recover_video still validates the media.

        Only the H3 adapter saves clips that the recovery checks accept. Wan and
        FastWan clips are silent by contract and bind a source image through a
        different graph node, so their failed requests are never offered recovery.
        """
        request=job.get('request') or {}
        if job.get('state')!='failed' or request.get('task')!='video' or (request.get('profile') or {}).get('adapter')!='paiton-h3':
            return False
        directory=self.store.root/'jobs'/job['id']
        try:
            record=json.loads((directory/'result.json').read_text())
        except (OSError,ValueError):
            return False
        status=record.get('status') if isinstance(record,dict) else None
        if not isinstance(status,dict) or not status.get('completed') or len(list((directory/'output').glob('*.mp4')))!=1:
            return False
        return not request.get('source') or all((directory/name).is_file() for name in ('workflow.json','input.png'))

    def recover_video(self,job):
        """Recover a completed, validated file; this never resumes GPU computation."""
        if job['state']!='failed' or job['request']['task']!='video':
            raise ValueError('Only a failed video request with a completed file can be recovered.')
        if (job['request'].get('profile') or {}).get('adapter')!='paiton-h3':
            raise ValueError('Only the Video tool (H3) can recover a saved output. Retry the request instead.')
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
