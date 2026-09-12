# SPDX-License-Identifier: AGPL-3.0-or-later
"""Mailbox-owner operations. Never invoked by inference or an MCP tool."""
import argparse
import getpass
import json
import os
import sys
from pathlib import Path
from .store import Store
from .paitonmail import PaitonMail

def visible(text):
    # Email/model text must not control the owner's terminal during review.
    return ''.join(c if c.isprintable() or c in '\n\t' else '\\u'+format(ord(c),'04x') for c in text)

def main():
    parser=argparse.ArgumentParser(prog='python -m studio.mail_cli')
    parser.add_argument('--data',default=os.environ.get('PAITON_STUDIO_DATA',str(Path(__file__).resolve().parents[1]/'.data')))
    sub=parser.add_subparsers(dest='action',required=True)
    add=sub.add_parser('add-account');add.add_argument('--project',required=True)
    sub.add_parser('pending')
    approve=sub.add_parser('approve');approve.add_argument('identity')
    reject=sub.add_parser('reject');reject.add_argument('identity')
    args=parser.parse_args()
    mail=PaitonMail(Store(args.data))
    if args.action=='pending':
        for row in mail.store.rows("SELECT id,snapshot,state FROM mail_outbox WHERE state IN ('awaiting_owner','sending','uncertain') ORDER BY created"):
            payload=json.loads(row['snapshot'])
            print(row['id'],row['state'],visible(payload['recipient']),visible(payload['subject']))
        return
    if not sys.stdin.isatty():
        raise SystemExit('Run owner operations interactively on the Studio host. No non-interactive approval is supported.')
    if args.action=='add-account':
        if not mail.capabilities()['connected_accounts']:
            raise SystemExit('Connected mailbox storage is not yet qualified on this platform; use .eml import.')
        project=mail.store.project(args.project)
        print('This mailbox will be readable by trusted users of the Studio workspace in project: '+project['name'])
        print('Credentials stay in an owner-only host file. Inference receives only selected email/document text.')
        if input('Type SHARE to connect this mailbox to that project: ')!='SHARE':return
        config=dict(address=input('Sending email address: ').strip(),imap_host=input('IMAP TLS hostname: ').strip(),
                    imap_port=int(input('IMAP port [993]: ').strip() or '993'),
                    smtp_host=input('SMTP hostname: ').strip())
        config['smtp_mode']=input('SMTP security, starttls or tls [starttls]: ').strip() or 'starttls'
        config['smtp_port']=int(input('SMTP port [587 / 465 for tls]: ').strip() or ('465' if config['smtp_mode']=='tls' else '587'))
        config['username']=input('Account login: ').strip()
        config['password']=getpass.getpass('Mail app password (not shown): ')
        identity=mail.add_account(args.project,input('Mailbox label: ').strip() or config['address'],config)
        print('Mailbox configured: '+identity+'. Open PaitonMail and choose Sync inbox. No email was sent.')
        return
    rows=mail.store.rows('SELECT * FROM mail_outbox WHERE id=?',(args.identity,))
    if not rows:raise SystemExit('Delivery request not found.')
    row=rows[0]
    if args.action=='reject':
        mail.cancel_delivery(row['id'],row['project']);print('Delivery rejected.');return
    if row['state']!='awaiting_owner':raise SystemExit('This delivery is not awaiting approval. Never retry an uncertain send without checking the provider.')
    if not mail.capabilities()['direct_send']:
        raise SystemExit(mail.capabilities()['send_message'])
    value=json.loads(row['snapshot'])
    print(visible('\nTO: '+value['recipient']+'\nSUBJECT: '+value['subject']+'\n\n'+value['body']+'\n'))
    print('Protected OS verification follows. This sends the exact text above using the connected account. SMTP acceptance does not confirm recipient delivery.')
    if input('Type the full recipient address to approve this one send: ').strip()!=value['recipient']:
        print('Not approved.');return
    result=mail.deliver_approved(row['id'],row['snapshot'])
    print(result['message'])

if __name__=='__main__':
    try:main()
    except (ValueError,OSError):
        raise SystemExit('PaitonMail could not complete the owner operation. Check the account, data directory and request state.')
