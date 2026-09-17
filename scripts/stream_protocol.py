"""Assemble OpenAI-compatible deltas without executing any model output."""
import json
import time


class StreamResponse:
    def __init__(self, allow_tools=False):
        self.allow_tools=allow_tools
        self.content=''; self.calls={}; self.finish=None; self.usage=None
        self.reasoning=False; self.started=time.monotonic(); self.first=None; self.last=None
        self.started_at=time.time(); self.first_output_at=None

    def feed(self, event):
        if event.get('error'): raise ValueError('The local server returned a streaming error.')
        if event.get('usage'): self.usage=event['usage']
        for choice in event.get('choices', []):
            if choice.get('index',0)!=0: raise ValueError('Multiple completions are not supported.')
            delta=choice.get('delta', {})
            self.reasoning |= bool(delta.get('reasoning') or delta.get('reasoning_content'))
            text=delta.get('content') or ''
            if text or delta.get('tool_calls'):
                now=time.monotonic(); self.first=self.first or now; self.last=now
                self.first_output_at=self.first_output_at or time.time()
            self.content+=text
            if len(self.content)>200000: raise ValueError('The reply exceeded the supported size.')
            for fragment in delta.get('tool_calls') or []:
                if not self.allow_tools: raise ValueError('Project tools were not enabled for this request.')
                index=fragment.get('index')
                if type(index) is not int or not 0<=index<8: raise ValueError('Invalid tool-call index.')
                call=self.calls.setdefault(index, dict(id='',type='function',function=dict(name='',arguments='')))
                if fragment.get('type') not in (None,'function'): raise ValueError('Unsupported tool-call type.')
                if fragment.get('id'):
                    if call['id'] and call['id']!=fragment['id']: raise ValueError('Tool-call ID changed during streaming.')
                    call['id']=fragment['id']
                function=fragment.get('function') or {}
                for key in ('name','arguments'):
                    piece=function.get(key) or ''
                    if not isinstance(piece,str): raise ValueError('Malformed tool-call fragment.')
                    call['function'][key]+=piece
                if len(call['function']['arguments'])>120000: raise ValueError('Tool arguments are too large.')
            if choice.get('finish_reason'): self.finish=choice['finish_reason']

    def result(self):
        calls=[self.calls[i] for i in sorted(self.calls)]
        if self.finish is None: raise ValueError('The reply stream ended before completion; no tools were run.')
        if calls:
            if self.finish!='tool_calls': raise ValueError('Tool arguments were truncated; no tools were run.')
            ids=set()
            for call in calls:
                if not call['id'] or call['id'] in ids or not call['function']['name']:
                    raise ValueError('Missing or duplicate tool-call identity.')
                ids.add(call['id'])
                try: arguments=json.loads(call['function']['arguments'])
                except (ValueError,TypeError) as error: raise ValueError('Incomplete tool arguments; no tools were run.') from error
                if not isinstance(arguments,dict): raise ValueError('Tool arguments must be a JSON object.')
        elif self.finish=='tool_calls': raise ValueError('The server returned no complete tool calls.')
        message=dict(role='assistant',content=self.content)
        if calls: message['tool_calls']=calls
        return dict(choices=[dict(message=message,finish_reason=self.finish)], usage=self.usage,
                    reasoning_observed=self.reasoning, timing=dict(
                        request_started_at=self.started_at, first_output_at=self.first_output_at,
                        first_token_seconds=self.first-self.started if self.first else None,
                        decode_seconds=self.last-self.first if self.first and self.last else None,
                        total_seconds=time.monotonic()-self.started))
