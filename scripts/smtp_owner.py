# SPDX-License-Identifier: AGPL-3.0-or-later
"""Host-side, native-verified approval. No MCP approval tool exists."""
from pathlib import Path
import argparse,json,sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from studio.store import Store
from studio.smtp_connector import SMTPConnector
from studio.mail_cli import visible

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--data',default=str(Path(__file__).resolve().parents[1]/'.data'))
    parser.add_argument('delivery_id')
    args=parser.parse_args()
    if not sys.stdin.isatty():raise SystemExit('Run owner review interactively on the Studio host.')
    smtp=SMTPConnector(Store(args.data));rows=smtp.store.rows('SELECT * FROM smtp_deliveries WHERE id=?',(args.delivery_id,))
    if not rows:raise SystemExit('Delivery not found.')
    row=rows[0];value=json.loads(row['snapshot'])
    print(visible('FROM: '+value['sender']+'\nTO: '+value['recipient']+'\nSUBJECT: '+value['subject']+'\n\n'+value['body']))
    if input('Continue to native verification? Type REVIEW: ')!='REVIEW':return
    print(smtp.approve(row['id'],row['snapshot'])['note'])
if __name__=='__main__':
    try:main()
    except ValueError as error:raise SystemExit(str(error))
