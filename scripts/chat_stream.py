"""Relay real local deltas and structured calls; execution belongs to Studio."""
import json,time,urllib.request,urllib.error,sys
from pathlib import Path
from stream_protocol import StreamResponse

directory=Path(sys.argv[1]) if len(sys.argv)>1 else Path('/job')
request=json.loads((directory/'writing-request.json').read_text());body=request['body'].copy()
body.update(stream=True,stream_options={'include_usage':True})
req=urllib.request.Request(f"http://127.0.0.1:{request['port']}/v1/chat/completions",data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
result=StreamResponse(bool(body.get('tools')));last=0
try:
 response=urllib.request.urlopen(req,timeout=600)
except urllib.error.HTTPError as error:
 raise RuntimeError(error.read(16000).decode(errors='replace')) from error
try:
 with response:
  for line in response:
   if not line.startswith(b'data:'):continue
   raw=line[5:].strip()
   if raw==b'[DONE]':break
   result.feed(json.loads(raw))
   if time.monotonic()-last>.4 and not request.get('internal'):
    message='Preparing a project tool call.' if result.calls else 'Writing your reply.' if result.content else 'Reasoning locally, with space reserved for your answer.' if result.reasoning else 'Preparing your reply.'
    print('STUDIO:'+json.dumps({'state':'generating','message':message,'progress':{'text':result.content}}),flush=True)
    last=time.monotonic()
 value=result.result()
except ValueError as error:
 value={'error':{'message':'The local reply was incomplete or malformed. No new tools were run in this round. '+str(error)}}
(directory/'writing-result.json').write_text(json.dumps(value))
