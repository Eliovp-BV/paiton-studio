# SPDX-License-Identifier: AGPL-3.0-or-later
"""SMTP transport for MCP requests; no inbox, IMAP sync or autonomous delivery."""
import hashlib
import json
import os
from pathlib import Path
import smtplib
import ssl
import time
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator
from .mail_transport import address, compose, deliver
from .mail_core import consent
from .store import uid


class SMTPSettings(BaseModel):
    model_config=ConfigDict(extra='forbid')
    host:str=Field(min_length=1,max_length=253,pattern=r'^[a-zA-Z0-9.-]+$')
    port:int=Field(default=587,ge=1,le=65535)
    security:Literal['starttls','tls']='starttls'
    sender:str=Field(max_length=254)
    username:str=Field(min_length=1,max_length=254)
    password:SecretStr=Field(default_factory=lambda:SecretStr(''))
    @field_validator('sender')
    @classmethod
    def sender_address(cls,value):return address(value)


class EmailInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    recipient:str=Field(max_length=254)
    subject:str=Field(min_length=1,max_length=300)
    body:str=Field(min_length=1,max_length=30000)
    client_id:str=Field(min_length=16,max_length=64,pattern=r'^[a-zA-Z0-9-]+$')
    @field_validator('recipient')
    @classmethod
    def recipient_address(cls,value):return address(value)
    @field_validator('subject')
    @classmethod
    def one_line(cls,value):
        if '\r' in value or '\n' in value:raise ValueError('Use a single-line subject.')
        return value


class SMTPConnector:
    def __init__(self,store):
        self.store=store
        with store.connect() as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS smtp_deliveries(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),generation TEXT NOT NULL,client_id TEXT NOT NULL,snapshot TEXT NOT NULL,account_hash TEXT NOT NULL,state TEXT NOT NULL,note TEXT NOT NULL,created REAL NOT NULL,UNIQUE(project,generation,client_id));''')

    def _path(self,project):
        self.store.project(project)
        if os.name!='posix':raise ValueError('A Windows credential-storage adapter is not qualified yet.')
        folder=self.store.root/'smtp-private'
        if folder.is_symlink():raise ValueError('SMTP settings cannot use a linked directory.')
        return folder/(project+'.json')

    def account(self,project):
        path=self._path(project)
        if not path.exists():return None
        if path.is_symlink() or path.stat().st_mode & 0o077:raise ValueError('SMTP credentials require owner-only file permissions.')
        return json.loads(path.read_text())

    def status(self,project):
        account=self.account(project) if os.name=='posix' else None
        return dict(configured=bool(account),credential_storage_available=os.name=='posix',
                    settings={k:account[k] for k in ('host','port','security','sender','username')} if account else None,
                    direct_send_available=bool(account) and consent.available(),approval_backend=consent.backend_name(),
                    message='SMTP delivery requires native owner approval.' if consent.available() else
                    'SMTP can be configured and tested. Direct sending needs a protected approval backend, unavailable on this Linux host. Prepared drafts can be returned to your mail app.')

    def save(self,project,body):
        path=self._path(project);path.parent.mkdir(mode=0o700,exist_ok=True);path.parent.chmod(0o700)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            previous=self.account(project) or {}
            values=body.model_dump(exclude={'password'})
            if previous and not body.password.get_secret_value() and any(values[k]!=previous[k] for k in ('host','port','security','sender','username')):
                raise ValueError('Re-enter the app password when changing the SMTP account or server.')
            values['password']=body.password.get_secret_value() or previous.get('password','')
            if not values['password']:raise ValueError('Provide your SMTP app password.')
            temporary=path.with_name(uid()+'.tmp')
            fd=os.open(temporary,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
            with os.fdopen(fd,'w') as file:
                json.dump(values,file);file.flush();os.fsync(file.fileno())
            os.replace(temporary,path)
            db.execute("UPDATE smtp_deliveries SET state='cancelled',note='SMTP settings changed. Prepare a new delivery for review.' WHERE project=? AND state='awaiting_owner'",(project,))
        return self.status(project)

    def disconnect(self,project):
        path=self._path(project)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            path.unlink(missing_ok=True)
            db.execute("UPDATE smtp_deliveries SET state='cancelled',note='SMTP connector disconnected.' WHERE project=? AND state='awaiting_owner'",(project,))
        return self.status(project)

    @staticmethod
    def transport(account):
        return dict(address=account['sender'],smtp_host=account['host'],smtp_port=account['port'],smtp_mode=account['security'],username=account['username'],password=account['password'])

    def test(self,project):
        account=self.account(project)
        if not account:raise ValueError('Configure SMTP first.')
        context=ssl.create_default_context()
        try:
            client=smtplib.SMTP_SSL(account['host'],account['port'],timeout=15,context=context) if account['security']=='tls' else smtplib.SMTP(account['host'],account['port'],timeout=15)
            with client:
                client.ehlo()
                if account['security']=='starttls':client.starttls(context=context);client.ehlo()
                client.login(account['username'],account['password'])
        except Exception:raise ValueError('SMTP login failed. Check the server, port, TLS mode and app password. No email was sent.') from None
        return dict(message='Verified TLS connection and SMTP login succeeded. No email was sent.')

    def prepare(self,grant,body):
        account=self.account(grant['project'])
        if not account:raise ValueError('The Studio owner must configure the SMTP connector first.')
        snapshot=json.dumps(dict(sender=account['sender'],recipient=body.recipient,subject=body.subject,body=body.body))
        identity=uid();fingerprint=hashlib.sha256(json.dumps(account,sort_keys=True).encode()).hexdigest()
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            current=db.execute('SELECT generation,enabled FROM mcp_connections WHERE project=?',(grant['project'],)).fetchone()
            if not current or not current['enabled'] or current['generation']!=grant['generation']:raise ValueError('This MCP connection was revoked.')
            existing=db.execute('SELECT id FROM smtp_deliveries WHERE project=? AND generation=? AND client_id=?',(grant['project'],grant['generation'],body.client_id)).fetchone()
            if existing:identity=existing['id']
            else:
                if db.execute("SELECT count(*) FROM smtp_deliveries WHERE project=? AND state='awaiting_owner'",(grant['project'],)).fetchone()[0]>=10:
                    raise ValueError('Ten SMTP drafts already await review. Disconnect SMTP to clear pending delivery requests before preparing more.')
                db.execute('INSERT INTO smtp_deliveries VALUES(?,?,?,?,?,?,?,?,?)',(identity,grant['project'],grant['generation'],body.client_id,snapshot,fingerprint,'awaiting_owner','Prepared only. Nothing sent. Native owner approval is required.',time.time()))
        return self.result(grant,identity)

    def result(self,grant,identity):
        rows=self.store.rows('SELECT id,snapshot,state,note,created FROM smtp_deliveries WHERE id=? AND project=? AND generation=?',(identity,grant['project'],grant['generation']))
        if not rows:raise ValueError('Delivery not found for this connection.')
        row=rows[0];snapshot=json.loads(row.pop('snapshot'))
        output=compose({'address':snapshot.pop('sender')},**snapshot,delivery_id='<'+identity+'@paiton.local>');output['X-Unsent']='1'
        return {**row,'approval_available':consent.available(),'draft_eml':output.as_string()}

    def approve(self,identity,expected_snapshot):
        rows=self.store.rows('SELECT * FROM smtp_deliveries WHERE id=?',(identity,))
        if not rows or rows[0]['state']!='awaiting_owner' or rows[0]['snapshot']!=expected_snapshot:raise ValueError('This delivery changed or was already attempted.')
        row=rows[0];payload=json.loads(expected_snapshot)
        try:ok=consent.require_human('Paiton Studio SMTP: send to '+payload['recipient']+'; review '+hashlib.sha256(expected_snapshot.encode()).hexdigest()[:16])
        except consent.ConsentUnavailable as error:raise ValueError(str(error)) from None
        if not ok:raise ValueError('Approval declined. Nothing was sent.')
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            current=db.execute('SELECT * FROM smtp_deliveries WHERE id=?',(identity,)).fetchone()
            grant=db.execute('SELECT * FROM mcp_connections WHERE project=?',(row['project'],)).fetchone()
            account=self.account(row['project'])
            if not grant or not grant['enabled'] or grant['generation']!=row['generation'] or current['state']!='awaiting_owner' or current['snapshot']!=expected_snapshot:raise ValueError('The connection or delivery changed during approval.')
            if not account or hashlib.sha256(json.dumps(account,sort_keys=True).encode()).hexdigest()!=row['account_hash']:raise ValueError('SMTP settings changed. Prepare a new delivery.')
            if time.time()-row['created']>3600:raise ValueError('Delivery review expired. Prepare a new request.')
            db.execute("UPDATE smtp_deliveries SET state='sending',note='Owner verified; delivery attempt started. Do not retry until checked.' WHERE id=?",(identity,))
        try:
            sender=payload.pop('sender')
            deliver(self.transport(account),compose({'address':sender},**payload,delivery_id='<'+identity+'@paiton.local>'))
            state,note='sent','SMTP server accepted the message; recipient delivery is not confirmed.'
        except Exception:state,note='uncertain','SMTP outcome is uncertain. Check the provider; Studio will not resend automatically.'
        with self.store.connect() as db:db.execute('UPDATE smtp_deliveries SET state=?,note=? WHERE id=?',(state,note,identity))
        return dict(state=state,note=note)
