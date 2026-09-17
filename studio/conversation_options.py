"""Bounded, public vLLM profiles. No compiler or private APC adapter is used."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
from typing import Literal
from pydantic import BaseModel, ConfigDict, model_validator

CONTRACTS = Path(__file__).parent / 'contracts'
RELEASE = json.loads((CONTRACTS / 'qwen38-agentic-release.json').read_text())
IMAGES = {key: value['registry_image'] for key, value in RELEASE['images'].items()}
GDN_FLAGS = ('PAITON_EXPERIMENTAL_GDN_REPLAY', 'PAITON_EXPERIMENTAL_GDN_PREFILL', 'PAITON_EXPERIMENTAL_GDN_CONV_PREFILL')


class ConversationOptions(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    context_mode: Literal['short', 'long', 'extra_long'] = 'short'
    reuse_cache: bool = False

    @model_validator(mode='after')
    def supported(self):
        if self.reuse_cache and self.context_mode != 'long':
            raise ValueError('Conversation cache is supported with Longer context (64K) only. It is not qualified with the 200K compact profile.')
        return self


def engine_profile(options=None):
    options = ConversationOptions.model_validate(options or {})
    mode = '200k' if options.context_mode == 'extra_long' else '64k'
    spec = RELEASE['images'][mode]
    raw = (CONTRACTS / ('qwen38-' + mode + '-v1.1.json')).read_bytes()
    if hashlib.sha256(raw).hexdigest() != spec['profile_sha256']:
        raise ValueError('The pinned conversation profile failed integrity verification.')
    result = json.loads(raw)
    args = result['arguments']
    context = {'short': 8192, 'long': 65536, 'extra_long': 200000}[options.context_mode]
    for flag, value in [('--max-model-len', str(context)), ('--max-num-seqs', '1'),
                        ('--mamba-cache-mode', 'align' if options.reuse_cache else 'none')]:
        args[args.index(flag) + 1] = value
    index = args.index('--speculative-config') + 1
    draft = json.loads(args[index]); draft['max_model_len'] = context
    args[index] = json.dumps(draft)
    if options.reuse_cache:
        args.remove('--no-enable-prefix-caching'); args.append('--enable-prefix-caching')
    # Public reproduction arms A/C. The entrypoint applies these after Docker env.
    for flag in GDN_FLAGS: result['environment'][flag] = '0' if options.reuse_cache else '1'
    result['profile'] = 'studio-' + options.context_mode + ('-apc' if options.reuse_cache else '')
    return result


def image_for(profile):
    return IMAGES['200k' if profile.get('conversation_options', {}).get('context_mode') == 'extra_long' else '64k']


def apply_options(profile, options=None):
    options = ConversationOptions.model_validate(options or {}).model_dump()
    result = deepcopy(profile)
    if result['package'] != 'qwen38-mxfp4':
        if options != ConversationOptions().model_dump():
            raise ValueError('Choose Qwen3.8 MXFP4 + DFlash2 to use these conversation settings.')
        return result
    result['conversation_options'] = options
    result['context'] = {'short': 8192, 'long': 65536, 'extra_long': 200000}[options['context_mode']]
    return result


def launch_identity(profile, sources):
    value = dict(image=image_for(profile), engine=engine_profile(profile.get('conversation_options')),
                 sources=sources, checkpoint_lock=RELEASE['checkpoint_lock']['sha256'])
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def details(profile):
    options = ConversationOptions.model_validate(profile.get('conversation_options', {}))
    return dict(**options.model_dump(), context=profile['context'],
                gdn_backend='stock vLLM' if options.reuse_cache else 'compact native',
                mamba_cache_mode='align' if options.reuse_cache else 'none',
                kv_cache_gib=8 if options.context_mode == 'extra_long' else 5,
                sequence_limit=1, prefill_chunk=4096, tool_parser='qwen3_xml')
