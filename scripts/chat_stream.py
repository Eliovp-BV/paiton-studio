"""Relay real local answer deltas; never synthesize tokens or execute tool calls."""
import json,time,urllib.request,urllib.error,sys
from pathlib import Path
directory=Path(sys.argv[1]) if len(sys.argv)>1 else Path('/job')
request=json.loads((directory/'writing-request.json').read_text());body=request['body']
body.update(stream=True,stream_options={'include_usage':True})
req=urllib.request.Request(f"http://127.0.0.1:{request['port']}/v1/chat/completions",data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
answer='';reasoning=False;finish=None;usage=None;last=0
try:
 response=urllib.request.urlopen(req,timeout=600)
except urllib.error.HTTPError as error:
 raise RuntimeError(error.read(16000).decode(errors='replace')) from error
with response:
 for line in response:
  if not line.startswith(b'data:'):continue
  raw=line[5:].strip()
  if raw==b'[DONE]':break
  event=json.loads(raw)
  if event.get('error'):raise RuntimeError('Local model returned an error')
  if event.get('usage'):usage=event['usage']
  for choice in event.get('choices',[]):
   delta=choice.get('delta',{})
   if delta.get('tool_calls'):raise RuntimeError('This conversation does not execute model-generated tools')
   if delta.get('reasoning') or delta.get('reasoning_content'):reasoning=True
   text=delta.get('content')
   if text:answer+=text
   if len(answer)>100000:raise RuntimeError('Answer exceeded the supported size')
   if choice.get('finish_reason'):finish=choice['finish_reason']
  if time.monotonic()-last>.4:
   print('STUDIO:'+json.dumps({'state':'generating','message':'Writing your reply.' if answer else 'Reasoning locally, with space reserved for your answer.' if reasoning else 'Preparing your reply.','progress':{'text':answer}}),flush=True);last=time.monotonic()
result={'choices':[{'message':{'content':answer},'finish_reason':finish}],'usage':usage,'reasoning_observed':reasoning}
(directory/'writing-result.json').write_text(json.dumps(result))
