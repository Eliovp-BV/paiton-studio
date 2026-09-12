"""Submit the trusted graph to our isolated ComfyUI and relay genuine events."""
import asyncio
import json
from pathlib import Path
import uuid
import aiohttp


def event(state, message, progress=None):
    print('STUDIO:' + json.dumps(dict(state=state,message=message,progress=progress)),flush=True)

async def main():
    workflow=json.loads(Path('/job/workflow.json').read_text())
    client=uuid.uuid4().hex
    async with aiohttp.ClientSession() as session:
        async with session.ws_connect('http://127.0.0.1:8188/ws?clientId='+client, max_msg_size=16*1024*1024) as ws:
            async with session.post('http://127.0.0.1:8188/prompt',json={'prompt':workflow,'client_id':client}) as response:
                result=await response.json()
                if response.status != 200: raise RuntimeError('Video workflow rejected: '+str(result.get('error',{}).get('type','invalid graph')))
                prompt_id=result['prompt_id']
            async for message in ws:
                if message.type != aiohttp.WSMsgType.TEXT: continue
                payload=json.loads(message.data); data=payload.get('data',{}); kind=payload['type']
                if data.get('prompt_id',prompt_id)!=prompt_id: continue
                if kind=='progress': event('generating','Animating your scene.',{'value':data['value'],'maximum':data['max']})
                if kind=='executing':
                    node=data.get('node')
                    if node is None: break
                    cls=workflow.get(node,{}).get('class_type','')
                    if 'Loader' in cls or 'Optimize' in cls: event('loading','Loading the video tool.')
                    elif cls in ['SaveVideo','CreateVideo','VAEDecode','VAEDecodeAudio']: event('saving','Decoding and saving your video.')
                    else: event('generating','Preparing your scene and animating it.')
                if kind in ['execution_error','execution_interrupted']:
                    raise RuntimeError('The video runtime could not complete the request. No profile was changed.')
            async with session.get('http://127.0.0.1:8188/history/'+prompt_id) as response: history=await response.json()
            record=history[prompt_id]
            if not record.get('status',{}).get('completed'): raise RuntimeError('The video did not finish.')
            Path('/job/result.json').write_text(json.dumps(record))
asyncio.run(main())
