"""Trusted local templates. All user/model text is escaped, never executable."""
import html
import json
from .archives import atomic_archive, export_path


def page_html(title,text,assets,template='story',theme='light',order=None,base='assets/'):
    esc=html.escape
    order=order or ['media','text']
    media=''
    for asset in assets:
        path=base+asset['id']+asset['path'][asset['path'].rfind('.'):]
        if asset['kind']=='image': media+=f'<figure><img src="{esc(path)}" alt="{esc(asset["name"])}"></figure>'
        if asset['kind']=='video':
            poster=next((a for a in assets if a['id'] in asset['metadata'].get('source_ids',[]) and a['kind']=='image'),None)
            poster_attr=' poster="'+esc(base+poster['id']+poster['path'][poster['path'].rfind('.'):])+'"' if poster else ''
            media+=f'<figure><video controls preload="metadata"{poster_attr} src="{esc(path)}"></video></figure>'
    paragraphs=''.join('<p>'+esc(p).replace('\n','<br>')+'</p>' for p in text.split('\n\n'))
    blocks={'media':'<div class="media">'+media+'</div>','text':'<section>'+paragraphs+'</section>'}
    body=''.join(blocks[x] for x in order if x in blocks)
    bg,fg=('#101719','#f3f5ef') if theme=='dark' else ('#f8faf5','#17211a')
    width='1100px' if template in ('portfolio','product') else '850px'
    layout={
        'story':'.content section{margin:auto}.content .media{margin:0 0 40px}header{max-width:720px}',
        'product':'.content{display:grid;grid-template-columns:1.1fr 1fr;gap:40px;align-items:start}.content section{padding:24px;border:1px solid #81907b;border-radius:12px}.media figure:first-child{margin-top:0}@media(max-width:700px){.content{grid-template-columns:1fr;gap:12px}}',
        'portfolio':'.media{display:grid;grid-template-columns:1fr 1fr;gap:20px}.media figure{margin:0}.media figure:first-child{grid-column:1/-1}header{text-align:center}.content section{margin:40px auto}@media(max-width:600px){.media{grid-template-columns:1fr}}',
    }.get(template,'')
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'"><title>{esc(title)}</title><style>body{{margin:0;background:{bg};color:{fg};font:18px/1.75 system-ui,sans-serif}}main{{max-width:{width};margin:0 auto;padding:clamp(24px,6vw,80px)}}h1{{font-size:clamp(36px,6vw,64px);line-height:1.1;letter-spacing:-.045em}}p{{white-space:normal;overflow-wrap:anywhere}}figure{{margin:28px 0}}img,video{{display:block;width:100%;max-height:75vh;object-fit:contain;border-radius:12px}}section{{max-width:720px}}header{{border-bottom:1px solid #81907b;padding-bottom:25px;margin-bottom:30px}}{layout}</style></head><body><main><header><h1>{esc(title)}</h1></header><div class="content">{body}</div></main></body></html>'''


def export_project(store,identity):
    project=store.project(identity);assets=store.assets(identity)
    with store.connect() as db: website_row=db.execute('SELECT document FROM websites WHERE project=?',(identity,)).fetchone()
    website=json.loads(website_row['document']) if website_row else None
    page=project['state'].get('page',{})
    selected=[store.asset(x,identity) for x in page.get('assets',[])]
    document=store.asset(page['document'],identity) if page.get('document') else None
    text=store.file(document).read_text() if document and document['kind']=='text' else page.get('text','')
    destination=export_path(store,identity)
    with atomic_archive(destination) as archive:
        for asset in assets:
            extension=store.file(asset).suffix
            archive.write(store.file(asset),'assets/'+asset['id']+extension)
        manifest={'format':'paiton-studio-project','version':2,'website':website,'project':project,'assets':[{**a,'path':'assets/'+a['id']+store.file(a).suffix} for a in assets]}
        with store.connect() as db:
            has_chats=db.execute("SELECT 1 FROM sqlite_master WHERE name='chats'").fetchone()
        if has_chats:
            from .chat import Chats
            chats=Chats(store,None)
            manifest['conversations']=[chats.get(c['id']) for c in chats.list(identity)]
            archive.writestr('conversations.json',json.dumps(manifest['conversations'],indent=2))
            from .conversation_memory import records
            archive.writestr('conversation-context.json',json.dumps({turn['job']['id']:records(store,turn['job']['id'])
                for chat in manifest['conversations'] for turn in chat['turns']},indent=2))
        with store.connect() as db:
            has_agents=db.execute("SELECT 1 FROM sqlite_master WHERE name='agents'").fetchone()
        if has_agents:
            from .agents import Agents
            manifest['agents']=Agents(store,None,None,None).list(identity)
            archive.writestr('agents.json',json.dumps(manifest['agents'],indent=2))
        archive.writestr('project.json',json.dumps(manifest,indent=2))
        archive.writestr('index.html',page_html(page.get('title') or project['name'],text,selected,page.get('template','story'),page.get('theme','light'),page.get('order')))
        if website:
            from .websites import website_html
            for site_page in website['pages']:
                archive.writestr('website/'+site_page['slug']+'.html',website_html(store,identity,website,site_page['slug'],asset_base='../assets/'))
            archive.writestr('website/website.json',json.dumps(website,indent=2))
        archive.writestr('README.txt','Open index.html locally in a browser, or website/index.html for the full website when included. Assets, text and project metadata are included. No internet or server is required. To resume editing on this computer, reopen the project in Paiton Studio. Importing this ZIP into another Studio installation is not implemented in v0.1.\n')
    return destination
