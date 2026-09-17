"""Bounded local conversation/tool loop under Runtime's existing GPU ownership."""
from copy import deepcopy
import json
from .conversation_memory import select_context, record_request, records, digest
from .project_tools import ProjectTools
from .store import atomic


def run(runtime, job, container, port, body, directory):
    store=runtime.store; request=job['request']; profile=request['profile']
    checks=lambda: runtime.check_cancel(job)
    ceiling=profile['context']; counter=0; summary_counter=-1; selections=[]
    exchange=[]; artifacts=[]; toolkit=ProjectTools(store)
    previous={r['round']:r for r in records(store,job['id'])}

    def tokenize(value):
        checks()
        token_body={k:value[k] for k in ('model','messages','chat_template_kwargs','tools') if k in value}
        token_body['add_generation_prompt']=True
        result=runtime.http(container,port,'/tokenize',token_body,timeout=60)
        checks(); count=result.get('count') if isinstance(result,dict) else None
        if type(count) is not int or count<0: raise ValueError('The local model could not verify the exact context size. No generation was started.')
        return count

    def complete(value, number, selection, internal=False):
        checks()
        saved=previous.get(number)
        if saved and saved['response'] is not None:
            if digest(saved['body'])!=digest(value):
                raise ValueError('This retry no longer matches its saved request. Start a new turn; completed drafts are preserved.')
            return saved['response']
        record_request(store,job['id'],number,value,selection)
        path=directory/'calls'/str(number); path.mkdir(parents=True,exist_ok=True)
        atomic(path/'writing-request.json',json.dumps(dict(port=port,body=value,internal=internal)).encode())
        runtime.stream(job,['exec',container,'python3','/studio/chat_stream.py',
                           '/studio-jobs/'+job['id']+'/calls/'+str(number)],limit=630)
        checks()
        response=json.loads((path/'writing-result.json').read_text())
        if response.get('error'):
            raise ValueError(response['error']['message'])
        record_request(store,job['id'],number,value,selection,response)
        return response

    def summarize(value):
        store.status(job['id'],'generating','Summarizing older material locally. Original messages stay saved.')
        response=complete(value,-int(digest(value)[:12],16)-1,dict(internal='summary',input_tokens=tokenize(value)),True)
        choice=response['choices'][0]
        if choice['finish_reason']!='stop': raise ValueError('The continuation summary was cut short. Choose Longer context; original messages remain saved.')
        return choice['message']['content']

    tools_enabled=bool(request.get('tools_enabled'))
    # Canonical source stays intact. Only each submitted body is compacted.
    original=deepcopy(body)
    while counter<6:
        checks()
        selected,selection=select_context(store,request.get('chat_id') or request.get('agent_run_id') or job['id'],
            original,ceiling,tokenize,summarize,checks)
        selections.append(selection)
        store.status(job['id'],'generating','Working with your selected project sources.' if tools_enabled else 'Preparing your conversation reply.',
                     {'context':selection})
        response=complete(selected,counter,selection)
        choice=response['choices'][0]; message=choice['message']; calls=message.get('tool_calls') or []
        if not calls:
            if not isinstance(message.get('content'),str) or not message['content'].strip():
                raise ValueError('The local model did not return a final answer. Your request and completed tools are saved for retry.')
            exchange.append(message)
            atomic(directory/'conversation-exchange.json',json.dumps(exchange).encode())
            atomic(directory/'writing-request.json',json.dumps(dict(port=port,body=selected)).encode())
            atomic(directory/'writing-result.json',json.dumps(response).encode())
            return response,dict(context=selection,tool_artifacts=artifacts,tool_rounds=counter,timing=response.get('timing'))
        if not tools_enabled or choice.get('finish_reason')!='tool_calls' or counter>=5:
            raise ValueError('Unexpected or incomplete tool calls. No new tools were run.')
        if len(calls)>8: raise ValueError('Too many tool calls in one reply.')
        # Validate every complete JSON argument before executing this round.
        arguments=[json.loads(call['function']['arguments']) for call in calls]
        if any(not isinstance(arg,dict) for arg in arguments): raise ValueError('Tool arguments must be JSON objects.')
        original['messages'].append(message); exchange.append(message)
        for call,args in zip(calls,arguments):
            checks()
            try:
                result=toolkit.execute(job['project'],request.get('operation_scope',job['id']),str(counter)+':'+call['id'],
                    call['function']['name'],args,request.get('source_snapshots',[]),checks)
            except ValueError as error:
                result=dict(error=str(error),performed=False)
            if result.get('asset_id'): artifacts.append(result['asset_id'])
            tool_message=dict(role='tool',tool_call_id=call['id'],content=json.dumps(result,ensure_ascii=False,sort_keys=True))
            original['messages'].append(tool_message); exchange.append(tool_message)
            atomic(directory/'conversation-exchange.json',json.dumps(exchange).encode())
        counter+=1
        if counter==5:
            # Final bounded synthesis; no further side effects are permitted.
            original['tool_choice']='none'
            original['messages'].append(dict(role='user',content='Tool budget reached. Summarize completed work, saved drafts and unfinished steps. Do not request more tools.'))
    raise ValueError('The assistant reached its tool budget. Completed drafts and the transcript are saved; continue in another turn.')
