import hashlib
import io
import json
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
import secrets
import shutil
import threading
from typing import Literal

from fastapi import FastAPI, Request, UploadFile, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field
from PIL import Image, ImageOps

from .meetings import Meetings
from .chat import Chats, ChatCreate, ChatSend, ChatUpdate, ChatRegenerate
from .comfy_workspace import ComfyWorkspace
from .host_guidance import guidance, SourceCheck
from .mcp_agents import AgentServers, ServerInput, ServerToggle, server_app as agent_server_app
from .agents import Agents, AgentInput, AgentUpdateInput, RunInput, TEMPLATES
from .coding import CodingWorkspace
from .model_api import ModelAPI, error as model_api_error
from .project_context import ProjectContext, BriefInput
from .project_search import ProjectSearch
from .recipes import RecipeManager
from .inbox import CompletionInbox
from .workspace_links import WorkspaceLinks
from .documents import import_document
from .export import export_project, page_html
from .archives import ExportFileResponse
from .media import image_info, letterbox
from .network import allowed_authorities
from .pairing import Pairing, local_peer, SESSION_SECONDS
from .version import version_info
from .queue import Worker
from .setup import SetupManager, SetupFailure
from .preferences import SettingsInput, get_settings, resolve_profile, save_settings, settings_response
from .websites import Websites, WebsiteInput, RegenerateInput, SiteInput, ApplyInput, website_html, export_website
from .registry import PACKAGES, profile, compatibility
from .runtime import ROOT, Runtime, RuntimeFailure, gpu_status
from .store import Store, safe_path, ProjectConflict
from .system_info import SystemInfo
from .renditions import Renditions, RenditionInput, PRESETS as DELIVERY_PRESETS
from .thumbnails import Thumbnails

BODY_LIMIT=32*1024*1024


class BodyTooLarge(HTTPException):
    def __init__(self): super().__init__(413,'Choose a file smaller than 32 MB.')


class BodyLimit:
    """Reject an /api/ body above the cap while it streams, before it is buffered."""
    def __init__(self,app,limit=BODY_LIMIT): self.app=app;self.limit=limit
    async def __call__(self,scope,receive,send):
        if scope['type']!='http' or not scope['path'].startswith('/api/'): return await self.app(scope,receive,send)
        received=0
        async def counted():
            nonlocal received
            message=await receive()
            if message['type']=='http.request':
                received+=len(message.get('body',b''))
                if received>self.limit: raise BodyTooLarge()
            return message
        await self.app(scope,counted,send)


class ProjectUpdate(BaseModel):
    name: str=Field(min_length=1,max_length=150)
    state: dict=Field(default_factory=dict)
    revision: int=Field(ge=0)

class ChatPreviewInput(ChatSend):
    # Inspection is read-only; only a real submission needs a client retry identity.
    client_id: str=Field(default='context-preview-00000000',pattern=r'^[a-zA-Z0-9-]{16,64}$')

class AgentPreviewInput(RunInput):
    client_id: str=Field(default='context-preview-00000000',pattern=r'^[a-zA-Z0-9-]{16,64}$')

class JobInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    task: Literal['image','video','write']
    profile_id: str | None = None
    prompt: str=Field(min_length=1,max_length=2500)
    seed: int | None=Field(default=None,ge=0,le=2**53-1,strict=True)
    # Recorded beside the styled prompt so a saved image can restore the chip; the prompt already carries the phrase.
    style: Literal['photograph','illustration','product','cinematic'] | None = None
    reasoning_effort: Literal['low','medium','high']='low'
    source_id: str|None=None
    fit: Literal['letterbox']='letterbox'
    format: Literal['Blog post','Social caption','Product story','Short script']='Blog post'
    tone: Literal['Natural','Warm','Professional','Playful']='Natural'
    length: int=Field(default=250,ge=50,le=500)
    context_ids: list[str]=Field(default_factory=list,max_length=8)

class DocumentInput(BaseModel):
    text: str=Field(max_length=100000)
    name: str=Field(default='Writing draft',min_length=1,max_length=150)
    parent: str|None=None

class RuntimePackageInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    reference: str=Field(min_length=1,max_length=300)

class OptionalComponentInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    enabled: bool=Field(strict=True)

class NetworkInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    enabled: bool

class PairInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    code: str=Field(max_length=128)
    name: str=Field(default='Paired browser',max_length=80)

class AssetUpdate(BaseModel):
    name: str=Field(min_length=1,max_length=150)
    favorite: bool=False

class PageState(BaseModel):
    model_config=ConfigDict(extra='forbid')
    title: str=Field(default='',max_length=300)
    text: str=Field(default='',max_length=100000)
    document: str|None=None
    assets: list[str]=Field(default_factory=list,max_length=100)
    template: Literal['story','product','portfolio']='story'
    theme: Literal['light','dark']='light'
    order: list[Literal['media','text']]=Field(default_factory=lambda:['media','text'],min_length=2,max_length=2)


def retire_mail_data(store):
    """One-time cleanup after the mail stack was removed: the SMTP connector kept
    plaintext app passwords in owner-only files, the older built-in mail client
    stored IMAP/SMTP passwords in mail-private/accounts.json and the Mail MCP
    connection rows held bearer tokens; nothing reads any of them any more. The
    mail_* tables stay untouched: they may hold the only copy of a draft."""
    credentials=store.root/'smtp-private'
    if credentials.is_dir() and not credentials.is_symlink(): shutil.rmtree(credentials)
    private=store.root/'mail-private'
    if private.is_dir() and not private.is_symlink():
        accounts=private/'accounts.json'
        if accounts.is_file() and not accounts.is_symlink(): accounts.unlink()
        try: private.rmdir()  # only an emptied folder goes; anything else in it is kept
        except OSError: pass
    with store.connect() as db:
        db.execute("DELETE FROM preferences WHERE key LIKE 'mail-mcp:%'")
        db.execute('DROP TABLE IF EXISTS smtp_deliveries')
        db.execute('DROP TABLE IF EXISTS mcp_connections')


def create_app(data=None,config=None,worker_enabled=True):
    store=Store(data or os.environ.get('PAITON_STUDIO_DATA',str(ROOT/'.data')))
    retire_mail_data(store)
    config_location=Path(os.environ.get('PAITON_STUDIO_CONFIG',str(ROOT/'config.local.json' if store.root==(ROOT/'.data').resolve() else store.root/'config.local.json')))
    if config is None:
        location=config_location if config_location.exists() else ROOT/'config.local.json'
        config=json.loads(location.read_text()) if location.exists() else {}
    runtime=Runtime(store,config)
    store.prepare_request=runtime.pin_request
    runtime.configure_memory_policy(get_settings(store)["performance"]["keep_ready_minutes"])
    worker=Worker(store,runtime)
    settings_lock=threading.Lock()
    websites=Websites(store,runtime,worker);worker.workflows=websites
    chats=Chats(store,runtime)
    project_context=ProjectContext(store)
    agents=Agents(store,runtime,worker,chats);worker.agents=agents
    coding=CodingWorkspace(store)
    model_api=ModelAPI(store,runtime,worker)
    agent_servers=AgentServers(agents)
    setup=SetupManager(store,runtime,config_path=config_location)
    system_info=SystemInfo(store.root)
    source_check=SourceCheck()
    renditions=Renditions(store)
    thumbnails=Thumbnails(store)
    token_path=store.root/'session-token'
    if not token_path.exists(): token_path.write_text(secrets.token_urlsafe(32));token_path.chmod(0o600)
    token=token_path.read_text()
    pairing=Pairing(store)
    def is_local(connection):
        return local_peer(connection.client.host if connection.client else None,connection.headers)
    def browser_authorized(connection):
        supplied=connection.cookies.get('studio_session','')
        return (is_local(connection) and secrets.compare_digest(supplied.encode(),token.encode())) or pairing.authorized(supplied)
    def require_local_owner(request):
        if not is_local(request) or not browser_authorized(request):
            raise HTTPException(403,'Manage paired devices from Studio on the host using localhost.')
    authorities=allowed_authorities()
    if not worker_enabled: authorities.add('testserver')
    comfy=ComfyWorkspace(store,runtime,token,authorities)
    comfy.browser_authorized=browser_authorized
    agent_mcp_http=agent_server_app(agent_servers,authorities)
    @asynccontextmanager
    async def lifespan(app):
        if worker_enabled:
            worker.start()
            try:
                setup.start()
                renditions.start()
            except Exception:
                setup.close()
                worker.close()
                raise
        try:
            async with agent_mcp_http.router.lifespan_context(agent_mcp_http):
                yield
        finally:
            try:
                comfy.close()
            finally:
                if worker_enabled:
                    renditions.close()
                    setup.close()
                    worker.close()
    app=FastAPI(title='Paiton Studio',lifespan=lifespan,docs_url=None,redoc_url=None,openapi_url=None)
    app.state.store=store;app.state.worker=worker;app.state.setup=setup
    app.state.pairing=pairing
    app.state.coding=coding;app.include_router(coding.router())
    app.include_router(ProjectSearch(store).router())
    app.include_router(RecipeManager(store).router())
    app.include_router(CompletionInbox(store).router())
    app.include_router(WorkspaceLinks(store,agents,websites).router())
    app.state.model_api=model_api;app.include_router(model_api.router())
    app.state.comfy=comfy;app.include_router(comfy.router())
    meetings=Meetings(store.root,store,runtime,worker);app.state.meetings=meetings;app.include_router(meetings.router())
    app.state.renditions=renditions
    app.state.agent_servers=agent_servers
    app.mount('/mcp/agents',agent_mcp_http)
    # Registered before the security middleware so it wraps the routes' body
    # reads; Content-Length is still checked first for a quick rejection.
    app.add_middleware(BodyLimit)

    @app.middleware('http')
    async def security(request,call_next):
        host=request.headers.get('host','').lower()
        if host not in authorities: return JSONResponse({'error':'Unrecognized Studio host; launch with PAITON_STUDIO_ALLOWED_HOSTS=<host-or-ip[:port]> to add this address.'},403)
        if request.url.path.startswith('/v1/'):
            try: await run_in_threadpool(model_api.authorize,request.headers.get('authorization',''))
            except HTTPException as failure: return model_api_error(failure.detail,failure.status_code,'authentication_error')
        if request.url.path.startswith('/mcp/') or request.url.path=='/mcp':
            try: agent_servers.authorize(request.headers.get('authorization',''))
            except ValueError: return JSONResponse({'error':'Valid MCP connection token required.'},401,headers={'WWW-Authenticate':'Bearer'})
        origin=request.headers.get('origin')
        valid_origins={f'https://{host}', f'http://{host}', 'http://127.0.0.1:5173', 'http://localhost:5173'}
        if (origin and origin not in valid_origins) or request.headers.get('sec-fetch-site')=='cross-site': return JSONResponse({'error':'This request came from another site.'},403)
        if request.url.path.startswith('/api/') and request.url.path not in ('/api/session','/api/session/pair'):
            if not browser_authorized(request):
                if not is_local(request):
                    return JSONResponse({'error':'Pair this browser on the Studio host.','pairing_required':True,
                                         'network_enabled':pairing.snapshot()['enabled']},401)
                return JSONResponse({'error':'Open Studio to begin a local session.'},401)
            if request.method not in ('GET','HEAD') and not secrets.compare_digest(request.headers.get('x-studio-token','').encode(),request.cookies.get('studio_session','').encode()): return JSONResponse({'error':'Local session token required.'},403)
        try:
            if int(request.headers.get('content-length','0'))>BODY_LIMIT: return JSONResponse({'error':'Choose a file smaller than 32 MB.'},413)
        except ValueError: return JSONResponse({'error':'Invalid request length.'},400)
        response=await call_next(request)
        response.headers['X-Content-Type-Options']='nosniff'
        response.headers['Referrer-Policy']='no-referrer'
        response.headers['Cross-Origin-Resource-Policy']='same-origin'
        # Only Vite's fingerprinted public UI files are immutable. Private
        # media, exports, API responses and the HTML shell remain uncached.
        bundled_asset=(request.method in ('GET','HEAD') and response.status_code in (200,304)
            and re.fullmatch(r'/assets/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css|svg|png|webp|jpe?g|woff2?)',request.url.path))
        response.headers['Cache-Control']='public, max-age=31536000, immutable' if bundled_asset else 'no-store'
        if request.url.path.startswith('/comfy/'):
            # The reviewed ComfyUI frontend needs dynamic scripts and workers.
            # Keep that policy scoped to the authenticated editor proxy.
            response.headers['Content-Security-Policy']="default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self' data: blob:; frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
        elif not request.url.path.startswith(('/api/preview/', '/api/website-preview/')):
            response.headers['Content-Security-Policy']="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"
        return response

    @app.exception_handler(RuntimeFailure)
    async def runtime_error(request,error): return JSONResponse({'error':str(error)},400)

    @app.exception_handler(BodyTooLarge)
    async def body_too_large(request,error): return JSONResponse({'error':error.detail},413)

    @app.exception_handler(ValueError)
    async def invalid(request,error): return JSONResponse({'error':str(error)},400)

    @app.exception_handler(ProjectConflict)
    async def project_conflict(request,error): return JSONResponse({'error':str(error)},409)

    def session_response(request,value,local=False):
        response=JSONResponse({'token':value,'local_owner':local})
        response.set_cookie('studio_session',value,httponly=True,samesite='strict',
                            secure=request.url.scheme=='https',max_age=None if local else SESSION_SECONDS)
        return response

    @app.get('/api/session')
    def session(request:Request):
        if is_local(request):return session_response(request,token,True)
        current=request.cookies.get('studio_session','')
        # A delayed renewal must not overwrite the cookie from a later pairing.
        if pairing.authorized(current):return JSONResponse({'token':current,'local_owner':False})
        return JSONResponse({'error':'Pair this browser on the Studio host.','pairing_required':True,
                             'network_enabled':pairing.snapshot()['enabled']},401)

    @app.post('/api/session/pair')
    def session_pair(request:Request,body:PairInput):
        value=pairing.pair(body.code,body.name,request.client.host if request.client else '')
        return session_response(request,value)

    @app.get('/api/network-access')
    def network_access(request:Request):
        if not is_local(request):return {'local_owner':False,'enabled':pairing.snapshot()['enabled']}
        require_local_owner(request)
        return {**pairing.snapshot(),'local_owner':True}

    @app.put('/api/network-access')
    def network_configure(request:Request,body:NetworkInput):
        require_local_owner(request)
        return {**pairing.configure(body.enabled),'local_owner':True}

    @app.post('/api/network-access/token')
    def network_token(request:Request):
        require_local_owner(request)
        return {**pairing.new_code(),'local_owner':True}

    @app.delete('/api/network-access/devices/{identity}')
    def network_revoke(request:Request,identity:str):
        require_local_owner(request)
        return {**pairing.revoke(identity),'local_owner':True}

    @app.post('/api/chat-presence')
    def chat_presence():
        runtime.touch_chat()
        return {'ok':True}

    @app.get('/api/projects/{identity}/chats')
    def chat_list(identity,archived:Literal['active','only','all']='active'): return chats.list(identity,archived)

    @app.get('/api/projects/{identity}/brief')
    def project_brief(identity): return project_context.get(identity)

    @app.put('/api/projects/{identity}/brief')
    def project_brief_update(identity,body:BriefInput): return project_context.save(identity,body)

    @app.post('/api/projects/{identity}/chat-context')
    def project_chat_context(identity,body:ChatPreviewInput): return chats.preview(identity,body)

    @app.post('/api/projects/{identity}/chats')
    def chat_create(identity,body:ChatCreate): return chats.create(identity,body.title)

    @app.get('/api/chats/{identity}')
    def chat_get(identity,compact:bool=False): return chats.get(identity,compact=compact)

    @app.patch('/api/chats/{identity}')
    def chat_update(identity,body:ChatUpdate): return chats.update(identity,body)

    @app.post('/api/chats/{identity}/messages')
    def chat_send(identity,body:ChatSend): return chats.send(identity,body)

    from .chat import ChatOptions

    @app.put('/api/chats/{identity}/options')
    def chat_options(identity,body:ChatOptions): return chats.options(identity,body)

    @app.get('/api/chats/{identity}/context/{job}')
    def chat_context_records(identity,job): return chats.context(identity,job)

    @app.get('/api/chats/{identity}/snapshot/{job}')
    def chat_context_snapshot(identity,job): return chats.snapshot(identity,job)

    @app.post('/api/chats/{identity}/retry/{job}')
    def chat_retry(identity,job): return chats.retry(identity,job)

    @app.post('/api/chats/{identity}/regenerate/{job}')
    def chat_regenerate(identity,job,body:ChatRegenerate): return chats.regenerate(identity,job,body)

    @app.post('/api/chats/{identity}/context')
    def chat_context_preview(identity,body:ChatPreviewInput):
        return chats.preview(chats.get(identity)['project'],body,chat_id=identity)

    @app.post('/api/projects/{identity}/attachments')
    async def chat_attachment(identity,file:UploadFile):
        content=await file.read(8*1024*1024+1)
        from starlette.concurrency import run_in_threadpool
        return await run_in_threadpool(import_document,store,identity,file.filename,content)

    @app.get('/api/status')
    def status(compact:bool=False):
        from .chat import compact_job
        from .performance import attach_job_performance
        # The Recover action is offered only where the adapter's recovery path can succeed.
        measured=attach_job_performance(store,store.rows('SELECT * FROM jobs ORDER BY created DESC LIMIT 100'))
        jobs=[{**(compact_job(j) if compact else j),'recoverable':runtime.video_recoverable(j)} for j in measured]
        return {'gpu':gpu_status(),'jobs':jobs,'worker':worker.diagnostics(),'chat_model_ready':runtime.warm_live(),'model_memory':runtime.memory_status()}

    @app.post('/api/model-memory/release')
    def model_memory_release(): return runtime.request_release()

    @app.get('/api/version')
    def version_get(): return version_info()

    @app.get('/api/system')
    def system_get(): return {**system_info.snapshot(),'runtime_docker_endpoint':runtime.docker.endpoint,'studio':version_info()}

    @app.get('/api/delivery-presets')
    def delivery_presets(): return DELIVERY_PRESETS

    @app.get('/api/projects/{identity}/renditions')
    def rendition_list(identity): return renditions.list(identity)

    @app.post('/api/projects/{identity}/renditions')
    def rendition_create(identity,body:RenditionInput): return renditions.submit(identity,body)

    @app.post('/api/renditions/{identity}/cancel')
    def rendition_cancel(identity): return renditions.cancel(identity)

    @app.exception_handler(SetupFailure)
    async def setup_error(request,error): return JSONResponse({'error':str(error)},400)

    @app.get('/api/setup')
    def setup_get(): return setup.snapshot()

    @app.post('/api/setup/{identity}/install')
    def setup_install(identity): return setup.install(identity)

    @app.post('/api/setup/{identity}/components/{component}/install')
    def component_install(identity,component): return setup.install(identity,component)

    @app.put('/api/setup/{identity}/components/{component}')
    def component_update(identity,component,body:OptionalComponentInput):
        return setup.set_component_enabled(identity,component,body.enabled)

    @app.post('/api/setup-jobs/{identity}/cancel')
    def setup_cancel(identity): return setup.cancel(identity)

    def diagnostic_payload(log, execution):
        from .diagnostics import diagnostics_bundle, diagnostics_text, classify_failure
        # Copy diagnostics never starts a tool or a hardware probe. Include
        # inventory/readiness already collected by the normal Models UI.
        with setup.lock:
            cached=setup._snapshot_cache or {}
            readiness={'models':cached.get('tools',[])}
        bundle=diagnostics_bundle(version_info(),readiness,system_info.cached(),log,execution)
        return dict(log=log,diagnostics=bundle,copy_text=diagnostics_text(bundle),failure=classify_failure(log['text']))

    @app.get('/api/jobs/{identity}/diagnostics')
    def job_diagnostics(identity):
        from .diagnostics import read_job_log
        log=read_job_log(store,identity)
        job=store.job(identity);saved=job['request'];selected=saved.get('profile') or {}
        execution=dict(task=saved.get('task'),state=job['state'],package=selected.get('package'),
                       profile_id=selected.get('id'),revision=selected.get('revision'),runtime_image=saved.get('runtime_image'))
        return diagnostic_payload(log,execution)

    @app.get('/api/setup-jobs/{identity}/diagnostics')
    def setup_diagnostics(identity):
        from .diagnostics import read_setup_log
        log=read_setup_log(setup,identity);job=setup.job(identity)
        return diagnostic_payload(log,dict(package=job['package'],state=job['state']))

    @app.get('/api/settings')
    def settings_get(): return settings_response(store)

    @app.get('/api/runtime-packages')
    def runtime_packages_get(): return setup.runtime_packages.snapshot()

    @app.post('/api/runtime-packages/{package}/select')
    def runtime_packages_select(package,body:RuntimePackageInput):
        return setup.runtime_packages.select(package,body.reference)

    @app.post('/api/runtime-packages/{package}/pull')
    def runtime_packages_pull(package,body:RuntimePackageInput):
        return setup.runtime_packages.pull(package,body.reference)

    @app.put('/api/settings')
    def settings_put(body:SettingsInput):
        # Keep the persisted preference and live idle policy ordered across LAN tabs.
        with settings_lock:
            # An older open Studio tab cannot erase a newly introduced policy.
            if 'performance' not in body.model_fields_set:
                body.performance.keep_ready_minutes=get_settings(store)['performance']['keep_ready_minutes']
            if 'conversation' not in body.model_fields_set:
                from .conversation_options import ConversationOptions
                body.conversation=ConversationOptions.model_validate(get_settings(store)['conversation'])
            save_settings(store,body)
            runtime.configure_memory_policy(body.performance.keep_ready_minutes)
            return settings_response(store)

    @app.get('/api/projects/{identity}/website')
    def website_get(identity): return {'site':websites.site(identity),'runs':websites.runs(identity)}

    @app.post('/api/projects/{identity}/website/generate')
    def website_generate(identity,body:WebsiteInput): return websites.generate(identity,body)

    @app.post('/api/projects/{identity}/website/regenerate')
    def website_regenerate(identity,body:RegenerateInput): return websites.regenerate(identity,body)

    @app.put('/api/projects/{identity}/website')
    def website_save(identity,body:SiteInput): return websites.save(identity,body)

    @app.post('/api/website-runs/{identity}/cancel')
    def website_cancel(identity): return websites.cancel(identity)

    @app.post('/api/website-runs/{identity}/apply')
    def website_apply(identity,body:ApplyInput): return websites.apply(identity,body.revision)

    @app.post('/api/website-runs/{identity}/discard')
    def website_discard(identity): return websites.discard(identity)

    @app.post('/api/website-runs/{identity}/retry')
    def website_retry(identity): return websites.retry(identity)

    @app.get('/api/website-preview/{identity}/{slug}')
    def website_preview(identity,slug):
        site=websites.site(identity)
        if not site: raise ValueError('Apply a website draft before previewing it.')
        response=HTMLResponse(website_html(store,identity,site,slug,True))
        response.headers['Content-Security-Policy']="sandbox allow-same-origin; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
        return response

    @app.post('/api/projects/{identity}/website/export')
    def website_export(identity):
        site=websites.site(identity)
        if not site: raise ValueError('Apply a website draft before exporting it.')
        return ExportFileResponse(export_website(store,identity,site),media_type='application/zip',filename='paiton-website.zip')

    @app.get('/api/tools')
    def tools():
        results=[]
        hardware=gpu_status()
        def availability(selected):
            eligible=compatibility(selected,hardware)
            installed=False
            message='Installed locally. Loads when a request starts.'
            try:
                if selected['package']=='qwen38-mxfp4':
                    runtime.preflight({'profile':selected},verify_content=False)
                    message='Installed locally. File hashes are checked before loading.'
                else:
                    runtime.preflight({'profile':selected})
                installed=True
            except Exception as error:
                message=str(error) if isinstance(error,RuntimeFailure) else 'Local model files need configuration.'
            state='ready' if installed else 'setup_required'
            if not eligible['compatible']:state='incompatible';message=eligible['reason']
            return dict(state=state,installed=installed,message=message,compatibility=eligible)
        for package in PACKAGES:
            if not package['integrated']:
                continue
            profiles=[]
            additions={}
            if package['id']=='qwen38-mxfp4':
                from .conversation_options import apply_options,image_for
                from .qwen_mxfp4 import optional_status
                releases={}
                base=profile(package['profiles'][0]['id'],package['profiles'][0]['task'])
                for release,mode,modes in [('64k','long',['short','long']),('200k','extra_long',['extra_long'])]:
                    selected=apply_options(base,{'context_mode':mode,'weights':'mxfp4'})
                    releases[release]={**availability(selected),'runtime_image':image_for(selected),'context_modes':modes}
                additions={'release_states':releases,'optional_components':[optional_status(runtime)]}
            for item in package['profiles']:
                selected=profile(item['id'],item['task'])
                # The three Qwen roles share files and images; probe each release once.
                status=additions['release_states']['64k'] if additions else availability(selected)
                profiles.append({**item,**{key:status[key] for key in ('state','installed','message','compatibility')}})
            eligible=compatibility(package,hardware)
            state='available';message='Integration planned; not selectable yet.'
            if profiles:
                chosen=next((p for p in profiles if p['state']=='ready'),None) or next((p for p in profiles if p['state']=='setup_required'),profiles[0])
                state=chosen['state'];message=chosen['message']
                eligible=chosen['compatibility']
            results.append({**package,**additions,'profiles':profiles,'state':state,'message':message,
                            'installed':any(p['installed'] for p in profiles),'compatibility':eligible,'estimate_seconds':None})
        return results

    @app.get('/api/projects/{project}/mcp-servers')
    def mcp_server_list(project): return agent_servers.list(project)

    @app.post('/api/projects/{project}/mcp-servers')
    def mcp_server_create(project, body:ServerInput): return agent_servers.create(project,body.agent_id)

    @app.post('/api/projects/{project}/mcp-servers/{identity}')
    def mcp_server_toggle(project, identity, body:ServerToggle): return agent_servers.configure(project,identity,body.enabled)

    @app.get('/api/projects/{project}/mcp-servers/{identity}/config')
    def mcp_server_config(project, identity, request:Request):
        return JSONResponse(agent_servers.configuration(project,identity,str(request.base_url)),headers={'Content-Disposition':'attachment; filename="paiton-agent-mcp.json"'})

    @app.get('/api/agent-templates')
    def agent_templates(): return TEMPLATES

    @app.get('/api/projects/{identity}/agents')
    def agent_list(identity): return agents.list(identity)

    @app.post('/api/projects/{identity}/agents')
    def agent_create(identity, body: AgentInput): return agents.create(identity, body)

    @app.put('/api/agents/{identity}')
    def agent_update(identity, body: AgentUpdateInput): return agents.update(identity, body)

    @app.post('/api/agents/{identity}/runs')
    def agent_start(identity, body: RunInput): return agents.start(identity, body)

    @app.post('/api/agents/{identity}/context')
    def agent_context(identity, body: AgentPreviewInput): return agents.preview(identity,body)

    @app.post('/api/agent-runs/{identity}/cancel')
    def agent_cancel(identity): return agents.cancel(identity)

    @app.get('/api/host-guidance')
    def host_guidance(): return guidance(system_info.snapshot())

    @app.post('/api/host-guidance/check-source')
    def check_host_source(): return source_check.check()

    @app.get('/api/readiness')
    def readiness_get():
        from .readiness import report
        return report(system_info.snapshot(), tools())

    @app.get('/api/projects')
    def projects():
        return store.rows("SELECT p.*,(SELECT id FROM assets WHERE project=p.id AND kind='image' ORDER BY created DESC LIMIT 1) AS cover,(SELECT kind FROM assets WHERE project=p.id ORDER BY created DESC LIMIT 1) AS preview_kind,(SELECT id FROM assets WHERE project=p.id ORDER BY created DESC LIMIT 1) AS preview_asset,(SELECT name FROM assets WHERE project=p.id ORDER BY created DESC LIMIT 1) AS preview_name FROM projects p ORDER BY updated DESC")

    @app.post('/api/projects')
    def new_project(): return store.create_project()

    @app.get('/api/projects/{identity}')
    def project_get(identity): return {**store.project(identity),'assets':store.assets(identity)}

    @app.put('/api/projects/{identity}')
    def project_put(identity,body:ProjectUpdate):
        if len(json.dumps(body.state))>200000: raise ValueError('Project settings are too large.')
        page=body.state.get('page',{})
        if page:
            try:PageState.model_validate(page)
            except ValueError:raise ValueError('Page settings must contain valid titles, text, assets and template choices.')
            if page.get('template','story') not in ('story','product','portfolio') or page.get('theme','light') not in ('light','dark'): raise ValueError('Choose a supported page template and theme.')
            if page.get('order',['media','text']) not in (['media','text'],['text','media']): raise ValueError('Choose a supported section order.')
            for aid in page.get('assets',[]):
                if store.asset(aid,identity)['kind'] not in ('image','video'): raise ValueError('Select image or video assets for the page.')
            if page.get('document') and store.asset(page['document'],identity)['kind']!='text': raise ValueError('Choose a writing document.')
        return store.update_project(identity,body.name,body.state,body.revision)

    @app.post('/api/projects/{identity}/import')
    async def import_image(identity,file:UploadFile):
        store.project(identity)
        content=await file.read(32*1024*1024+1)
        if len(content)>32*1024*1024: raise ValueError('Choose a file smaller than 32 MB.')
        info=image_info(content);name=Path(file.filename or 'Imported image').name[:150]
        return store.add_asset(identity,'image',name,content,'.png' if info['format']=='PNG' else '.jpg',{**info,'origin':'imported','source_ids':[]})

    @app.get('/api/assets/{identity}')
    def asset_file(identity,download:bool=False):
        asset=store.asset(identity)
        download=download or asset['kind']=='document'
        return FileResponse(store.file(asset),filename=asset['name']+store.file(asset).suffix if download else None,content_disposition_type='attachment' if download else 'inline')

    @app.get('/api/assets/{identity}/thumbnail')
    def asset_thumbnail(identity, width:int=Query(default=384,ge=64,le=512)):
        return FileResponse(thumbnails.get(identity,width),media_type='image/webp')

    @app.get('/api/assets/{identity}/fit')
    def fit_preview(identity,profile_id:str='video-short'):
        asset=store.asset(identity)
        if asset['kind']!='image': raise ValueError('Select an image.')
        p=profile(profile_id,'video');out=store.root/'previews'/(identity+'-'+profile_id+'.png');out.parent.mkdir(exist_ok=True)
        letterbox(store.file(asset),out,p['width'],p['height'])
        return FileResponse(out,media_type='image/png')

    @app.put('/api/assets/{identity}')
    def asset_put(identity,body:AssetUpdate):
        store.asset(identity)
        with store.connect() as db: db.execute('UPDATE assets SET name=?,favorite=? WHERE id=?',(body.name,int(body.favorite),identity))
        return store.asset(identity)

    @app.post('/api/projects/{identity}/documents')
    def document(identity,body:DocumentInput):
        if body.parent and store.asset(body.parent,identity)['kind']!='text': raise ValueError('Choose a text revision.')
        return store.add_asset(identity,'text',body.name,body.text.encode(),'.md',{'origin':'edited','parent':body.parent,'source_ids':[body.parent] if body.parent else []})

    @app.post('/api/projects/{identity}/jobs')
    def submit(identity,body:JobInput):
        store.project(identity)
        if not body.prompt.strip(): raise ValueError('Describe what you want to create.')
        role='image_edit' if body.task=='image' and body.source_id else 'video_text' if body.task=='video' and not body.source_id else body.task
        p=profile(body.profile_id,body.task,role=role) if body.profile_id and body.profile_id!='auto' else resolve_profile(store,runtime,role)
        eligible=compatibility(p,gpu_status())
        if not eligible['compatible']: raise ValueError(eligible['reason'])
        request=body.model_dump(exclude={'profile_id','source_id'},exclude_none=True);request['profile']=p
        request['seed']=body.seed if body.seed is not None else get_settings(store)['generation']['seed']
        if body.source_id:
            asset=store.asset(body.source_id,identity)
            if body.task not in ('video','image') or asset['kind']!='image': raise ValueError('Choose an image from this project.')
            request['source']={'id':asset['id'],'sha256':asset['metadata']['sha256'],'path':asset['path']}
            if body.task=='video': request['source']['fit']=body.fit
            else: request['source'].update(project=identity,name=asset['name'])
        if p['adapter']=='paiton-qwen-image21':
            from .qwen_image21 import validate_request, validate_source
            validate_request(request)
            if p['mode']=='edit': validate_source(store,request,project=identity)
        context=[]
        for aid in body.context_ids:
            asset=store.asset(aid,identity)
            text=store.file(asset).read_text()[:2000] if asset['kind']=='text' else asset['metadata'].get('request',{}).get('prompt','')
            context.append(asset['name']+': '+text)
        request['context']='\n'.join(context)[:4000]
        return store.enqueue(identity,request)

    @app.post('/api/jobs/{identity}/cancel')
    def cancel(identity): worker.cancel(identity);return store.job(identity)

    @app.post('/api/jobs/{identity}/retry')
    def retry(identity):
        job=store.job(identity)
        if job['state'] not in ('cancelled','failed'): raise ValueError('Only failed or cancelled requests can be retried.')
        if job['request'].get('chat_id'): raise ValueError('Retry from the conversation to preserve its history.')
        if job['request'].get('website_run'):
            if job['request'].get('purpose') in ('website-page-copy','website-section-artwork'):
                raise ValueError('Retry this individual output in Build Website to preserve the saved website and its revision. Completed assets are saved.')
            raise ValueError('Use Retry unfinished steps in Build Website to reuse completed writing and artwork. Completed assets are saved.')
        return store.enqueue(job['project'],job['request'])

    @app.post('/api/jobs/{identity}/recover')
    def recover(identity):
        job=store.job(identity)
        existing=store.rows('SELECT * FROM assets WHERE project=?',(job['project'],))
        found=next((a for a in existing if a['metadata'].get('job')==identity),None)
        if found: return found
        path,info=runtime.recover_video(job)
        request=job['request']
        asset=store.add_asset(job['project'],'video','Animated scene',path.read_bytes(),'.mp4',
                              {**info,'origin':'generated','job':identity,'request':request,
                               'source_ids':[request['source']['id']] if request.get('source') else [],
                               'recovered':True,'generation_seconds':job['updated']-job['created']})
        store.status(identity,'completed','Recovered the completed video. No generation was repeated.',asset=asset['id'])
        return asset

    @app.get('/api/preview/{identity}')
    def preview(identity):
        project=store.project(identity);page=project['state'].get('page',{})
        selected=[store.asset(x,identity) for x in page.get('assets',[])]
        document=store.asset(page['document'],identity) if page.get('document') else None
        text=store.file(document).read_text() if document else page.get('text','')
        # URLs remain local, stable IDs. No script permissions in sandbox.
        content=page_html(page.get('title') or project['name'],text,selected,page.get('template','story'),page.get('theme','light'),page.get('order'),base='/api/preview-media/')
        for asset in selected: content=content.replace('/api/preview-media/'+asset['id']+store.file(asset).suffix,'/api/assets/'+asset['id'])
        response=HTMLResponse(content)
        response.headers['Content-Security-Policy']="sandbox allow-same-origin; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
        return response

    @app.post('/api/projects/{identity}/export')
    def export(identity):
        path=export_project(store,identity)
        return ExportFileResponse(path,media_type='application/zip',filename='paiton-project.zip')

    dist=ROOT/'dist'
    if dist.exists():
        app.mount('/assets',StaticFiles(directory=dist/'assets'),name='static')
    @app.get('/')
    def index():
        return FileResponse(dist/'index.html') if (dist/'index.html').exists() else HTMLResponse('Build the workspace with npm run build, then reload.')
    return app

app=create_app()
