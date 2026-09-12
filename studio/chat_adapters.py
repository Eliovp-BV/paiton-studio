"""Pinned launch contracts for the installed Paiton text servers.

All ports are container loopback interfaces reached through docker exec, and
all model inputs are read-only. No arbitrary executable or remote endpoint is
accepted from a browser request.
"""
CHAT_PACKAGES = {
    'minicpm5-2b': {
        'image_key': 'minicpm5_image', 'port': 8036, 'served_model': 'minicpm5-2b',
        'args': ['--offline'], 'repository': 'models--openbmb--MiniCPM5-2B-GPTQ',
        'chat_template_kwargs': {'enable_thinking': False}, 'keep_warm': True, 'chat_presence': True, 'chat_temperature': 0.0,
    },
    'gptoss': {'keep_warm':True,'retain_for_writing':True,'chat_presence':True,'image_key':'gptoss_image','port':8020,'served_model':'gpt-oss-20b','args':['--offline'],'repository':'models--openai--gpt-oss-20b','chat_template_kwargs':None},
    'qwen3-4b': {
        'image_key': 'qwen3_4b_image', 'port': 8020, 'served_model': 'paiton-qwen3-4b',
        'args': [], 'repository': 'models--Qwen--Qwen3-4B-Instruct-2507',
        'chat_template_kwargs': None,
    },
    'qwen-coder': {
        'image_key': 'writing_image', 'port': 8010, 'served_model': 'qwen3-coder',
        'args': ['--offline'],
        'repository': 'models--cyankiwi--Qwen3-Coder-30B-A3B-Instruct-AWQ-4bit',
        'chat_template_kwargs': None,
    },
    'qwen38': {
        'keep_warm': True, 'retain_for_writing': True,
        'image_key': 'qwen38_image', 'port': 8000, 'served_model': 'qwen38',
        'args': [],
        'repository': 'models--amd--Qwen3.8-27B-Quark-Qronos-INT4-W4A16',
        'chat_template_kwargs': {'enable_thinking': False},
        'checkpoint_bytes': 19893384832,
        'runtime_files': ['chat_template.jinja', 'crc32.txt', 'generation_config.json',
                          'merges.txt', 'model.safetensors', 'preprocessor_config.json',
                          'processor_config.json', 'tokenizer.json', 'tokenizer_config.json',
                          'video_preprocessor_config.json', 'vocab.json'],
    },
}


def writing_body(request):
    profile = request['profile']
    contract = CHAT_PACKAGES[profile['package']]
    messages = request.get('messages')
    if messages is not None:
        # Only server-built website jobs can introduce the message template. The
        # public job schema rejects unknown fields, including messages.
        if not set(profile.get('roles', [])) & {'website','chat','code'}:
            raise ValueError('Structured planning requires a website model profile.')
        if not isinstance(messages, list) or not 1 <= len(messages) <= 64:
            raise ValueError('The saved website planning messages are invalid.')
        for message in messages:
            if not isinstance(message, dict) or set(message) != {'role', 'content'} or message['role'] not in ('system', 'user', 'assistant') or not isinstance(message['content'], str):
                raise ValueError('The saved website planning messages are invalid.')
    else:
        messages = [
            {'role': 'system', 'content': 'Write the requested content using only the supplied facts. You cannot see images or watch videos. Never invent names, prices, offers or contact details. Use visible [placeholders] for missing facts. Return only the requested draft, without commentary.'},
            {'role': 'user', 'content': f"Format: {request.get('format', 'Blog post')}. Tone: {request.get('tone', 'Natural')}. Approximate length: {request.get('length', 250)} words.\nNotes: {request['prompt']}\nApproved text context: {request.get('context', '')}"},
        ]
    if profile['package']=='gptoss' and request.get('messages') is None:
        messages[0]['content'] += ' Every factual product claim must be explicitly supported by the notes. Do not add claims about durability, feel, performance, safety, certifications or other qualities that were not supplied. A length target never justifies inventing facts: use a shorter draft when the notes are brief.'
    body = dict(model=contract['served_model'], messages=messages,
                max_tokens=profile['max_tokens'], temperature=contract.get('chat_temperature', 0.2 if request.get('messages') else 0.6))
    # Preserve the queued request's seed through the runtime boundary. This is
    # a sampling input, not a promise of bit-identical output across drivers.
    if 'seed' in request:
        body['seed'] = request['seed']
    if contract['chat_template_kwargs']:
        body['chat_template_kwargs'] = contract['chat_template_kwargs'].copy()
    # These release contracts have not qualified constrained-decoding JSON. The
    # planner asks for JSON in text and validates it before consuming any output.
    if profile['package']=='gptoss':
        effort=request.get('reasoning_effort','low')
        if effort not in ('low','medium','high'): raise ValueError('Choose a supported reasoning effort.')
        body['reasoning_effort']=effort
        # Reserve answer space within the qualified total output cap.
        body['thinking_token_budget']=min({'low':256,'medium':512,'high':1024}[effort], max(0,body['max_tokens']-1024))
    return body
