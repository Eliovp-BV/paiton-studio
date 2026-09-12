import io
import json
import os
import ssl
import threading
import zipfile
from concurrent.futures import ThreadPoolExecutor
from email.message import EmailMessage
from email.parser import BytesParser

import pytest
from fastapi.testclient import TestClient
from studio.app import create_app
from studio.store import Store
from studio.registry import profile
from studio.paitonmail import PaitonMail, DraftRequest, DraftEdit
from studio.mail_transport import parse_message, address, compose, inbox
from studio.mail_core import consent, imap
from studio.mail_source import source_archive

RAW=b'From: Ada <ada@example.org>\r\nTo: studio@example.org\r\nSubject: Workshop\r\nMessage-ID: <workshop@example.org>\r\n\r\nPlease confirm Monday at 9.\r\n'

@pytest.fixture
def mail(tmp_path,monkeypatch):
    store=Store(tmp_path)
    p=store.create_project('Mail tests')
    monkeypatch.setattr('studio.paitonmail.resolve_profile',lambda *a:profile('gptoss-chat','write','chat'))
    module=PaitonMail(store)
    return module,p['id'],module.import_message(p['id'],RAW)


def draft(mail,key='mail-client-000000001'):
    m,p,msg=mail
    return m.create_draft(p,msg['id'],DraftRequest(instruction='Confirm Monday at 9.',client_id=key))


def finish(mail,d):
    m,p,_=mail
    asset=m.store.add_asset(p,'text','Reply',b'Monday at 9 works.','.md',{'job':d['job']})
    m.store.status(d['job'],'completed','Saved',asset=asset['id'])
    return m.draft(d['id'],p)


def test_import_deduplicates_and_scopes(mail):
    m,p,msg=mail
    assert m.import_message(p,RAW)['id']==msg['id']
    other=m.store.create_project('Other')['id']
    with pytest.raises(ValueError):m.message(msg['id'],other)
    assert not m.messages(other)
    assert m.messages(p,'monday')[0]['id']==msg['id']
    assert 'body' not in m.messages(p)[0]['payload']
    assert m.message(msg['id'],p)['payload']['body'].startswith('Please')


def test_mime_plaintext_priority_and_no_html_execution():
    msg=EmailMessage();msg['From']='a@example.org';msg['Subject']='Hello'
    msg.set_content('Plain visible text')
    msg.add_alternative('<p>Hidden HTML alternative</p>',subtype='html')
    msg.add_attachment(b'secret attachment',maintype='application',subtype='octet-stream',filename='file.bin')
    parsed=parse_message(msg.as_bytes())
    assert parsed['body']=='Plain visible text' and parsed['attachments']==1
    raw=b'From: a@example.org\nContent-Type: text/html\n\n<head>hidden</head><script>alert(1)</script><p>Visible<img src="https://example.org/pixel"></p>'
    parsed=parse_message(raw)
    assert 'Visible' in parsed['body'] and 'hidden' not in parsed['body'] and 'alert' not in parsed['body'] and 'https' not in parsed['body']


def test_unknown_charset_and_bounds():
    raw=b'From: a@example.org\nContent-Type: text/plain; charset=unknown-charset\n\nHello \xff'
    assert 'Hello' in parse_message(raw)['body']
    with pytest.raises(ValueError):parse_message(b'x'* (2*1024*1024+1))
    with pytest.raises(ValueError):parse_message(b'not an email')
    assert parse_message(RAW+b'a'*70000)['truncated']


@pytest.mark.parametrize('value',['a@example.org\r\nBcc: victim@example.org','a@example.org,b@example.org','no-address','a@example.org; b@example.org'])
def test_recipient_is_exactly_one(value):
    with pytest.raises(ValueError):address(value)


def test_local_queue_idempotency_and_context(mail):
    m,p,msg=mail
    with ThreadPoolExecutor(2) as pool: results=list(pool.map(lambda _:draft(mail),range(2)))
    assert results[0]['id']==results[1]['id']
    request=m.store.job(results[0]['job'])['request']
    assert request['task']=='write' and request['purpose']=='mail-reply'
    assert request['mail_draft_id']==results[0]['id']
    assert 'untrusted' in request['messages'][0]['content']
    assert 'Monday at 9' in request['messages'][-1]['content']
    assert 'tools' not in request and 'password' not in json.dumps(request)
    with pytest.raises(ValueError,match='already generating'):draft(mail,'mail-client-000000002')


def test_draft_reopen_edit_conflict_export(mail):
    m,p,_=mail;d=finish(mail,draft(mail))
    reopened=PaitonMail(Store(m.store.root))
    assert reopened.draft(d['id'],p)['body']=='Monday at 9 works.'
    edit=DraftEdit(recipient=d['recipient'],subject=d['subject'],body='See you Monday.',revision=d['revision'])
    saved=m.edit(d['id'],p,edit)
    with pytest.raises(ValueError,match='changed'):m.edit(d['id'],p,edit)
    assert saved['revision']==d['revision']+1
    exported=BytesParser().parsebytes(m.export_draft(d['id'],p))
    assert exported['To']=='ada@example.org' and exported['X-Unsent']=='1'
    assert exported['In-Reply-To']=='<workshop@example.org>'
    assert 'See you Monday' in exported.get_payload()


def test_cancelled_queue_reconciles_without_output(mail):
    m,p,_=mail;d=draft(mail)
    m.store.status(d['job'],'cancelled','Stopped')
    assert m.draft(d['id'],p)['state']=='cancelled'
    assert draft(mail,'mail-client-000000002')['state']=='generating'


def test_credentials_are_outside_exports_and_scoped(mail):
    m,p,_=mail
    account=m.add_account(p,'Test',dict(address='studio@example.org',imap_host='imap.example.org',smtp_host='smtp.example.org',username='studio',password='test-secret'))
    assert m.credentials()[account]['password']=='test-secret'
    assert not (m.store.root/'mail-private/accounts.json').stat().st_mode & 0o077
    assert 'test-secret' not in json.dumps(m.accounts(p))
    other=m.store.create_project('Other')['id']
    with pytest.raises(ValueError):m.import_message(other,RAW,account,'INBOX:1:1')
    with pytest.raises(ValueError):m.queue_sync(account,other)
    assert m.queue_sync(account,p)==m.queue_sync(account,p)


def connected_draft(mail,monkeypatch):
    m,p,_=mail
    a=m.add_account(p,'Test',dict(address='studio@example.org',imap_host='imap.example.org',smtp_host='smtp.example.org',username='studio',password='test-secret'))
    msg=m.import_message(p,RAW,a,'INBOX:1:1')
    linked=(m,p,msg);d=finish(linked,draft(linked))
    monkeypatch.setattr(consent,'available',lambda:True)
    req=m.request_delivery(d['id'],p,d['revision'])
    return d,req


def test_delivery_requires_native_approval_and_immutable_review(mail,monkeypatch):
    m,p,_=mail;d,req=connected_draft(mail,monkeypatch)
    sent=[];monkeypatch.setattr('studio.paitonmail.deliver',lambda *a:sent.append(a))
    row=m.store.rows('SELECT * FROM mail_outbox WHERE id=?',(req['id'],))[0]
    monkeypatch.setattr(consent,'require_human',lambda _:False)
    with pytest.raises(ValueError,match='declined'):m.deliver_approved(req['id'],row['snapshot'])
    assert not sent
    monkeypatch.setattr(consent,'require_human',lambda _:True)
    with pytest.raises(ValueError):m.deliver_approved(req['id'],row['snapshot']+' ')
    result=m.deliver_approved(req['id'],row['snapshot'])
    assert result['state']=='sent' and len(sent)==1
    with pytest.raises(ValueError):m.deliver_approved(req['id'],row['snapshot'])
    assert len(sent)==1


def test_edit_during_native_prompt_cancels_send(mail,monkeypatch):
    m,p,_=mail;d,req=connected_draft(mail,monkeypatch)
    row=m.store.rows('SELECT * FROM mail_outbox WHERE id=?',(req['id'],))[0]
    sent=[];monkeypatch.setattr('studio.paitonmail.deliver',lambda *a:sent.append(a))
    def consent_then_edit(_):
        m.edit(d['id'],p,DraftEdit(recipient=d['recipient'],subject=d['subject'],body='Updated',revision=d['revision']))
        return True
    monkeypatch.setattr(consent,'require_human',consent_then_edit)
    with pytest.raises(ValueError,match='cancelled'):m.deliver_approved(req['id'],row['snapshot'])
    assert not sent


def test_linux_approval_cannot_be_bypassed_by_env(monkeypatch):
    monkeypatch.setattr(consent,'_WIN',False);monkeypatch.setattr(consent,'_MAC',False)
    monkeypatch.setenv('ADE_MAIL_DRYRUN','1');monkeypatch.setenv('GIGAMAIL_CONSENT_BACKEND','allow')
    assert not consent.available()
    with pytest.raises(consent.ConsentUnavailable):consent.require_human('send')


def test_uncertain_delivery_never_retried(mail,monkeypatch):
    m,p,_=mail;d,req=connected_draft(mail,monkeypatch)
    monkeypatch.setattr(consent,'require_human',lambda _:True)
    def failed(*_):raise TimeoutError()
    monkeypatch.setattr('studio.paitonmail.deliver',failed)
    row=m.store.rows('SELECT * FROM mail_outbox WHERE id=?',(req['id'],))[0]
    assert m.deliver_approved(req['id'],row['snapshot'])['state']=='uncertain'
    with pytest.raises(ValueError):m.deliver_approved(req['id'],row['snapshot'])


def test_read_only_imap_bounds_validity_and_verified_tls(monkeypatch):
    calls=[]
    class IMAP:
        def __init__(self,*args,**kw):
            assert kw['ssl_context'].verify_mode==ssl.CERT_REQUIRED
            assert kw['ssl_context'].check_hostname and kw['timeout']==15
        def __enter__(self):return self
        def __exit__(self,*_):pass
        def login(self,*_):pass
        def select(self,*args,**kwargs):
            assert kwargs=={'readonly':True};return 'OK',[b'1']
        def response(self,_):return 'UIDVALIDITY',[b'42']
        def uid(self,*args):
            calls.append(args)
            if args[0]=='SORT':return 'BAD',[b'unsupported']
            if args[0]=='search':return 'OK',[b'1 2']
            if args[-1]=='(RFC822.SIZE)':return 'OK',[b'1 RFC822.SIZE '+str(9*1024*1024 if args[1]==b'2' else len(RAW)).encode()]
            assert 'BODY.PEEK[]' in args[-1]
            return 'OK',[(b'1',RAW)]
    monkeypatch.setattr(imap.imaplib,'IMAP4_SSL',IMAP)
    result=list(inbox(dict(imap_host='example.org',username='u',password='p'),lambda:False))
    assert result==[('INBOX:42:1',RAW)]
    assert not any('STORE' in str(c) for c in calls)


def test_source_offer_contains_build_license_and_no_private_material(tmp_path):
    (tmp_path/'studio/mail_core').mkdir(parents=True)
    (tmp_path/'studio/mail_core/LICENSE').write_text('license')
    (tmp_path/'studio/mail_core/NOTICE').write_text('notice')
    (tmp_path/'studio/app.py').write_text('source')
    (tmp_path/'package.json').write_text('{}')
    (tmp_path/'config.local.json').write_text('secret')
    (tmp_path/'docs').mkdir();(tmp_path/'docs/research.md').write_text('private')
    (tmp_path/'studio/leak.py').symlink_to(tmp_path/'config.local.json')
    with zipfile.ZipFile(io.BytesIO(source_archive(tmp_path))) as z:
        assert 'paiton-studio/studio/mail_core/LICENSE' in z.namelist()
        assert 'paiton-studio/package.json' in z.namelist()
        assert all('config.local' not in n and '/docs/' not in n and 'leak' not in n for n in z.namelist())


def test_retired_mail_data_is_preserved(tmp_path):
    store=Store(tmp_path);project=store.create_project('Legacy mail')
    mail=PaitonMail(store);saved=mail.import_message(project['id'],RAW)
    with store.connect() as db:db.execute('INSERT INTO preferences VALUES(?,?)',('mail-mcp:'+project['id'],json.dumps({'enabled':True,'token':'old-token'})))
    app=create_app(tmp_path,{},worker_enabled=False)
    with TestClient(app) as c:
        assert not json.loads(store.rows('SELECT value FROM preferences WHERE key=?',('mail-mcp:'+project['id'],))[0]['value'])['enabled']
        token=c.get('/api/session').json()['token'];c.headers['x-studio-token']=token
        assert c.get('/api/projects/'+project['id']+'/mail').status_code==410
        assert mail.message(saved['id'],project['id'])['payload']['body'].startswith('Please confirm')
        assert c.get('/api/mcp/source').status_code==200
