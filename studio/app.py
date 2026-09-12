import hashlib
import io
import json
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
import secrets
import threading
from typing import Literal

from fastapi import FastAPI, Request, UploadFile, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from PIL import Image, ImageOps

from .meetings import Meetings
from .chat import Chats, ChatCreate, ChatSend
from .host_guidance import guidance, SourceCheck
from .mcp_bridge import MCPBridge, ConnectionInput, server_app
from .mcp_agents import AgentServers, ServerInput, ServerToggle, server_app as agent_server_app
from .smtp_connector import SMTPSettings
from . import mail_source
from .agents import Agents, AgentInput, RunInput, TEMPLATES
from .documents import import_document
from .export import export_project, page_html
from .archives import ExportFileResponse
from .media import image_info, letterbox
from .network import allowed_authorities
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

class ProjectUpdate(BaseModel):
    name: str=Field(min_length=1,max_length=150)
    state: dict=Field(default_factory=dict)
    revision: int=Field(ge=0)

class JobInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    task: Literal['image','video','write']
    profile_id: str | None = None
    prompt: str=Field(min_length=1,max_length=2500)
    seed: int | None=Field(default=None,ge=0,le=2**53-1,strict=True)
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


def create_app(data=None,config=None,worker_enabled=True):
    store=Store(data or os.environ.get('PAITON_STUDIO_DATA',str(ROOT/'.data')))
    config_location=Path(os.environ.get('PAITON_STUDIO_CONFIG',str(ROOT/'config.local.json' if store.root==(ROOT/'.data').resolve() else store.root/'config.local.json')))
    if config is None:
        location=config_location if config_location.exists() else ROOT/'config.local.json'
        config=json.loads(location.read_text()) if location.exists() else {}
    runtime=Runtime(store,config)
    runtime.configure_memory_policy(get_settings(store)["performance"]["keep_ready_minutes"])
    worker=Worker(store,runtime)
    settings_lock=threading.Lock()
    websites=Websites(store,runtime,worker);worker.workflows=websites
    chats=Chats(store,runtime)
    agents=Agents(store,runtime,worker,chats);worker.agents=agents
    bridge=MCPBridge(store,runtime,worker)
    agent_servers=AgentServers(agents)
    setup=SetupManager(store,runtime,config_path=config_location)
    system_info=SystemInfo(store.root)
    source_check=SourceCheck()
    renditions=Renditions(store)
    thumbnails=Thumbnails(store)
    token_path=store.root/'session-token'
    if not token_path.exists(): token_path.write_text(secrets.token_urlsafe(32));token_path.chmod(0o600)
    token=token_path.read_text()
    authorities=allowed_authorities()
    if not worker_enabled: authorities.add('testserver')
    mcp_http=server_app(bridge,authorities)
    agent_mcp_http=agent_server_app(agent_servers,authorities)
    @asynccontextmanager
    async def lifespan(app):
        bridge.retire_legacy()
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
            async with mcp_http.router.lifespan_context(mcp_http):
                async with agent_mcp_http.router.lifespan_context(agent_mcp_http):
                    yield
        finally:
            if worker_enabled:
                renditions.close()
                setup.close()
                worker.close()
    app=FastAPI(title='Paiton Studio',lifespan=lifespan,docs_url=None,redoc_url=None,openapi_url=None)
    app.state.store=store;app.state.worker=worker;app.state.setup=setup
    meetings=Meetings(store.root,store,runtime,worker);app.state.meetings=meetings;app.include_router(meetings.router())
    app.state.renditions=renditions
    app.state.mcp_bridge=bridge
    app.state.agent_servers=agent_servers
    app.mount('/mcp/agents',agent_mcp_http)
    app.mount('/mcp',mcp_http)

    @app.middleware('http')
    async def security(request,call_next):
        host=request.headers.get('host','').lower()
        if host not in authorities: return JSONResponse({'error':'Unrecognized Studio host.'},403)
        if request.url.path.startswith('/mcp/') or request.url.path=='/mcp':
            auth_bridge=agent_servers if request.url.path.rstrip('/')=='/mcp/agents' else bridge
            try: auth_bridge.authorize(request.headers.get('authorization',''))
            except ValueError: return JSONResponse({'error':'Valid MCP connection token required.'},401,headers={'WWW-Authenticate':'Bearer'})
        origin=request.headers.get('origin')
        valid_origins={f'https://{host}', f'http://{host}', 'http://127.0.0.1:5173', 'http://localhost:5173'}
        if (origin and origin not in valid_origins) or request.headers.get('sec-fetch-site')=='cross-site': return JSONResponse({'error':'This request came from another site.'},403)
        if request.url.path.startswith('/api/') and request.url.path!='/api/session':
            if not secrets.compare_digest(request.cookies.get('studio_session',''),token): return JSONResponse({'error':'Open Studio to begin a local session.'},401)
            if request.method not in ('GET','HEAD') and not secrets.compare_digest(request.headers.get('x-studio-token',''),token): return JSONResponse({'error':'Local session token required.'},403)
        try:
            if int(request.headers.get('content-length','0'))>32*1024*1024: return JSONResponse({'error':'Choose a file smaller than 32 MB.'},413)
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
        if not request.url.path.startswith(('/api/preview/', '/api/website-preview/')):
            response.headers['Content-Security-Policy']="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"
        return response

    @app.exception_handler(RuntimeFailure)
    async def runtime_error(request,error): return JSONResponse({'error':str(error)},400)

    @app.exception_handler(ValueError)
    async def invalid(request,error): return JSONResponse({'error':str(error)},400)

    @app.exception_handler(ProjectConflict)
    async def project_conflict(request,error): return JSONResponse({'error':str(error)},409)

    @app.get('/api/session')
    def session():
        response=JSONResponse({'token':token});response.set_cookie('studio_session',token,httponly=True,samesite='strict')
        return response

    @app.post('/api/chat-presence')
    def chat_presence():
        runtime.touch_chat()
        return {'ok':True}

    @app.get('/api/projects/{identity}/chats')
    def chat_list(identity): return chats.list(identity)

    @app.post('/api/projects/{identity}/chats')
    def chat_create(identity,body:ChatCreate): return chats.create(identity,body.title)

    @app.get('/api/chats/{identity}')
    def chat_get(identity): return chats.get(identity)

    @app.post('/api/chats/{identity}/messages')
    def chat_send(identity,body:ChatSend): return chats.send(identity,body)

    @app.post('/api/projects/{identity}/attachments')
    async def chat_attachment(identity,file:UploadFile):
        content=await file.read(8*1024*1024+1)
        from starlette.concurrency import run_in_threadpool
        return await run_in_threadpool(import_document,store,identity,file.filename,content)

    @app.get('/api/status')
    def status(): return {'gpu':gpu_status(),'jobs':store.rows('SELECT * FROM jobs ORDER BY created DESC LIMIT 100'),'worker':worker.diagnostics(),'chat_model_ready':runtime.warm_live(),'model_memory':runtime.memory_status()}

    @app.get('/api/system')
    def system_get(): return {**system_info.snapshot(),'runtime_docker_endpoint':runtime.docker.endpoint}

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

    @app.post('/api/setup-jobs/{identity}/cancel')
    def setup_cancel(identity): return setup.cancel(identity)

    @app.get('/api/settings')
    def settings_get(): return settings_response(store)

    @app.put('/api/settings')
    def settings_put(body:SettingsInput):
        # Keep the persisted preference and live idle policy ordered across LAN tabs.
        with settings_lock:
            # An older open Studio tab cannot erase a newly introduced policy.
            if 'performance' not in body.model_fields_set:
                body.performance.keep_ready_minutes=get_settings(store)['performance']['keep_ready_minutes']
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
        for package in PACKAGES:
            if not package['integrated']:
                continue
            profiles=[]
            for item in package['profiles']:
                selected=profile(item['id'],item['task'])
                eligible=compatibility(selected,hardware)
                installed=False
                message='Installed locally. Loads when a request starts.'
                try:
                    runtime.preflight({'profile':selected})
                    installed=True
                except Exception as error:
                    message=str(error) if isinstance(error,RuntimeFailure) else 'Local model files need configuration.'
                state='ready' if installed else 'setup_required'
                if not eligible['compatible']:state='incompatible';message=eligible['reason']
                profiles.append({**item,'state':state,'installed':installed,'message':message,'compatibility':eligible})
            eligible=compatibility(package,hardware)
            state='available';message='Integration planned; not selectable yet.'
            if profiles:
                chosen=next((p for p in profiles if p['state']=='ready'),None) or next((p for p in profiles if p['state']=='setup_required'),profiles[0])
                state=chosen['state'];message=chosen['message']
                eligible=chosen['compatibility']
            results.append({**package,'profiles':profiles,'state':state,'message':message,
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

    @app.get('/api/projects/{project}/mcp')
    def mcp_settings(project):
        return {**bridge.settings(project),'smtp':bridge.smtp.status(project)}

    @app.post('/api/projects/{project}/mcp')
    def mcp_configure(project,body:ConnectionInput):
        return bridge.configure(project,body)

    @app.get('/api/projects/{project}/mcp/config')
    def mcp_config(project,request:Request):
        return JSONResponse(bridge.configuration(project,str(request.base_url)),headers={'Content-Disposition':'attachment; filename="paiton-studio-mcp.json"'})

    @app.post('/api/projects/{project}/mcp/smtp')
    def smtp_save(project,body:SMTPSettings):
        return bridge.smtp.save(project,body)

    @app.delete('/api/projects/{project}/mcp/smtp')
    def smtp_disconnect(project):
        return bridge.smtp.disconnect(project)

    @app.post('/api/projects/{project}/mcp/smtp/test')
    def smtp_test(project):
        return bridge.smtp.test(project)

    @app.get('/api/mcp/license')
    @app.get('/api/paitonmail/license')
    def mail_license():
        return FileResponse(ROOT/'studio/mail_core/LICENSE',media_type='text/plain')

    @app.get('/api/mcp/source')
    @app.get('/api/paitonmail/source')
    def mail_source_download():
        return Response(mail_source.source_archive(),media_type='application/zip',headers={'Content-Disposition':'attachment; filename="paiton-studio-source.zip"'})

    @app.api_route('/api/projects/{project}/mail/{path:path}',methods=['GET','POST'])
    @app.api_route('/api/projects/{project}/mail',methods=['GET','POST'])
    def retired_mail(project,path=''):
        store.project(project)
        return JSONResponse({'error':'The built-in mail client has been replaced by MCP Servers. Existing mail data is preserved on the host.'},410)

    @app.get('/api/agent-templates')
    def agent_templates(): return TEMPLATES

    @app.get('/api/projects/{identity}/agents')
    def agent_list(identity): return agents.list(identity)

    @app.post('/api/projects/{identity}/agents')
    def agent_create(identity, body: AgentInput): return agents.create(identity, body)

    @app.post('/api/agents/{identity}/runs')
    def agent_start(identity, body: RunInput): return agents.start(identity, body)

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
        role='video_text' if body.task=='video' and not body.source_id else body.task
        p=profile(body.profile_id,body.task,role=role) if body.profile_id and body.profile_id!='auto' else resolve_profile(store,runtime,role)
        eligible=compatibility(p,gpu_status())
        if not eligible['compatible']: raise ValueError(eligible['reason'])
        request=body.model_dump(exclude={'profile_id','source_id'});request['profile']=p
        request['seed']=body.seed if body.seed is not None else get_settings(store)['generation']['seed']
        if body.source_id:
            asset=store.asset(body.source_id,identity)
            if body.task!='video' or asset['kind']!='image': raise ValueError('Animate an image from this project.')
            request['source']={'id':asset['id'],'sha256':asset['metadata']['sha256'],'path':asset['path'],'fit':body.fit}
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
                raise ValueError('Retry this individual output in Build Page to preserve the saved website and its revision. Completed assets are saved.')
            raise ValueError('Use Retry unfinished steps in Build Page to reuse completed writing and artwork. Completed assets are saved.')
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
                               'generation_seconds':job['updated']-job['created']})
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
