# SPDX-License-Identifier: AGPL-3.0-or-later
"""PaitonMail transport: verified TLS, read-only IMAP, explicit SMTP delivery."""
import email.policy
from email.parser import BytesParser
from email.message import EmailMessage
from email.utils import parseaddr, make_msgid, getaddresses, formatdate
from html.parser import HTMLParser
from .mail_core import imap as mail_core
import re
import smtplib
import ssl

MAX_MESSAGE = 2 * 1024 * 1024

def line(value, limit=300):
    return ' '.join(str(value or '').split())[:limit]

def address(value):
    if not isinstance(value, str) or '\r' in value or '\n' in value:
        raise ValueError('Choose one valid email address.')
    recipients=getaddresses([value])
    if len(recipients)!=1:
        raise ValueError('Choose one valid email address.')
    parsed = recipients[0][1]
    if not re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_{}|~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", parsed):
        raise ValueError('Choose one valid email address.')
    return parsed

class TextOnly(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.hidden = [], 0
    def handle_starttag(self, tag, attrs):
        if tag in ('script','style','head'): self.hidden += 1
        if tag in ('br','p','div','li','tr'): self.parts.append('\n')
    def handle_endtag(self, tag):
        if tag in ('script','style','head'): self.hidden = max(0,self.hidden-1)
    def handle_data(self, data):
        if not self.hidden: self.parts.append(data)

def parse_message(raw):
    if not raw or len(raw)>MAX_MESSAGE:
        raise ValueError('Choose an email file smaller than 2 MiB.')
    msg = BytesParser(policy=email.policy.default).parsebytes(raw)
    if not any(msg.get(k) for k in ('From','To','Subject')):
        raise ValueError('This file does not look like an email message.')
    attachments=sum(1 for index,part in enumerate(msg.walk()) if index<100 and
                    (part.get_content_disposition()=='attachment' or part.get_filename()))
    text,kind=mail_core._get_body(msg)
    if kind=='html':
        parser=TextOnly();parser.feed(text);text=''.join(parser.parts)
    try: sender=address(str(msg.get('From','')))
    except ValueError: sender=''
    message_id=line(msg.get('Message-ID'), 250)
    if not re.fullmatch(r'<[^<>\s]+@[^<>\s]+>',message_id): message_id=''
    return dict(subject=line(msg.get('Subject')) or '(No subject)',sender=sender,
                sender_label=line(msg.get('From')),recipient=line(msg.get('To')),
                date=line(msg.get('Date')),body=text[:60000],truncated=len(text)>60000,
                attachments=attachments,message_id=message_id)

def inbox(account, stop):
    """Yield the latest 25 bounded messages without setting the Seen flag."""
    with mail_core._connect(account['imap_host'],account.get('imap_port',993),
                            account['username'],account['password']) as client:
        status,_=client.select('INBOX',readonly=True)
        if status!='OK': raise ValueError('The inbox could not be opened.')
        validity=client.response('UIDVALIDITY')[1][0]
        if not isinstance(validity,bytes) or not validity.isdigit():
            raise ValueError('The mailbox identity could not be verified.')
        for identity in mail_core._uid_recent_ids(client,25):
            if stop(): return
            if not identity.isdigit(): continue
            status,size_data=client.uid('fetch',identity,'(RFC822.SIZE)')
            size=re.search(rb'RFC822.SIZE (\d+)',b' '.join(x for x in size_data if isinstance(x,bytes)))
            if status!='OK' or not size or int(size[1])>MAX_MESSAGE: continue
            status,parts=client.uid('fetch',identity,'(BODY.PEEK[]<0.'+str(MAX_MESSAGE+1)+'>)')
            raw=next((p[1] for p in parts if isinstance(p,tuple) and isinstance(p[1],bytes)),None)
            if status=='OK' and raw and len(raw)<=MAX_MESSAGE:
                yield 'INBOX:'+validity.decode()+':'+identity.decode(),raw

def compose(account, recipient, subject, body, reply_id='', delivery_id=None):
    message=EmailMessage(policy=email.policy.SMTP)
    message['From']=address(account['address'])
    message['To']=address(recipient)
    if '\n' in subject or '\r' in subject: raise ValueError('The subject must be one line.')
    message['Subject']=subject
    message['Date']=formatdate(localtime=True)
    message['Message-ID']=delivery_id or make_msgid(domain='paiton.local')
    if reply_id and re.fullmatch(r'<[^<>\s]+@[^<>\s]+>',reply_id):
        message['In-Reply-To']=reply_id
        message['References']=reply_id
    message.set_content(body)
    return message

def deliver(account, message):
    context=ssl.create_default_context()
    if account.get('smtp_mode','starttls')=='tls':
        client=smtplib.SMTP_SSL(account['smtp_host'],account.get('smtp_port',465),timeout=20,context=context)
    else:
        client=smtplib.SMTP(account['smtp_host'],account.get('smtp_port',587),timeout=20)
    with client:
        client.ehlo()
        if account.get('smtp_mode','starttls')=='starttls':
            client.starttls(context=context); client.ehlo()
        client.login(account['username'],account['password'])
        refused=client.send_message(message)
        if refused: raise ValueError('The mail server refused the recipient.')
