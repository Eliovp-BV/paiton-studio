"""Bounded public Qwen profiles with explicit immutable runtime variants."""
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
CONTEXTS = {'short': 8192, 'long': 65536, 'extra_long': 200000}


class ConversationOptions(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    context_mode: Literal['short', 'long', 'extra_long'] = 'short'
    reuse_cache: bool = False
    weights: Literal['mxfp4', 'w3a4'] = 'mxfp4'

    @model_validator(mode='after')
    def supported(self):
        if self.reuse_cache and self.context_mode != 'long':
            raise ValueError('The conversation cache switch applies to Longer context (64K) only. Extra-long context uses its runtime’s required cache configuration.')
        return self


def release_spec(options=None, image=None):
    options = ConversationOptions.model_validate(options or {})
    mode = '200k' if options.context_mode == 'extra_long' else '64k'
    default = RELEASE['images'][mode]
    image = image or default['registry_image']
    # Immutable digest references also cover queued requests recorded as a
    # manifest ID. Classic Docker configuration IDs must be resolved by preflight.
    digest = image.rsplit('@', 1)[-1] if isinstance(image, str) else None
    candidates = [(key, spec) for key, spec in RELEASE['images'].items()]
    candidates += list(RELEASE.get('legacy_images', {}).items())
    candidates += list(RELEASE.get('previous_images', {}).items())
    matched = False
    for key, spec in candidates:
        if digest == spec['registry_image'].rsplit('@', 1)[-1]:
            matched = True
            if key != mode:
                continue
            if options.weights == 'w3a4' and spec.get('entrypoint_kind') != 'direct-cli':
                raise ValueError('W3A4 3-bit weights require a pinned ROCm 10 runtime.')
            return spec
    if matched:
        raise ValueError('The saved Qwen runtime does not match this conversation context.')
    raise ValueError('The saved Qwen runtime is not an approved immutable release.')


def _set_argument(arguments, flag, value):
    arguments[arguments.index(flag) + 1] = str(value)


def engine_profile(options=None, image=None, sources=None):
    options = ConversationOptions.model_validate(options or {})
    spec = release_spec(options, image)
    direct = spec.get('entrypoint_kind') == 'direct-cli'
    name = spec['profile_file'] if direct or spec['profile_file'].startswith('qwen38-') else 'qwen38-200k-v1.1.json'
    raw = (CONTRACTS / name).read_bytes()
    if hashlib.sha256(raw).hexdigest() != spec['profile_sha256']:
        raise ValueError('The pinned conversation profile failed integrity verification.')
    result = json.loads(raw)
    context = CONTEXTS[options.context_mode]
    if direct:
        chat = options.reuse_cache or bool(spec.get('unified_context') and options.context_mode == 'extra_long')
        variant = options.weights + ('-chat' if chat else '-release')
        selected = result.get('variants', {}).get(variant)
        if selected:
            result['arguments'] = deepcopy(selected['arguments'])
            result['environment'] = deepcopy(selected['environment_overrides'])
        result.pop('variants', None)
        result['environment'].update({key: '1' if options.weights == 'w3a4' else '0'
                                      for key in ('PAITON_W3_DECODE', 'PAITON_W3_PREFILL', 'PAITON_W3_A4')})
        # These are the launcher's documented --context and --max-num-seqs
        # overrides. The chat profile retains its own 8 GiB budget, small
        # capture set and 1024-token prefill chunk, including with W3A4.
        result['launcher_profile'] = 'chat' if chat else 'release'
        result['launcher_overrides'] = {'context': context, 'max_num_seqs': 1}
        result['aggregate_kv_tokens'] = (selected.get('aggregate_kv_tokens') if spec.get('unified_context')
                                         else 250578 if options.weights == 'w3a4' and not chat else None)
    else:
        result['entrypoint_kind'] = 'legacy-profile'
        for flag in GDN_FLAGS:
            result['environment'][flag] = '0' if options.reuse_cache else '1'
    args = result['arguments']
    _set_argument(args, '--max-model-len', context)
    _set_argument(args, '--max-num-seqs', 1)
    if not direct:
        _set_argument(args, '--mamba-cache-mode', 'align' if options.reuse_cache else 'none')
        if options.reuse_cache:
            args.remove('--no-enable-prefix-caching')
            args.append('--enable-prefix-caching')
    index = args.index('--speculative-config') + 1
    draft = json.loads(args[index])
    draft['max_model_len'] = context
    if sources:
        paths = sources['paths']
        if direct:
            args[1] = paths['target']
        else:
            _set_argument(args, '--model', paths['target'])
        _set_argument(args, '--tokenizer', paths['target'])
        draft['model'] = paths['draft']
        result['environment'].update(sources['environment'])
    args[index] = json.dumps(draft)
    result['profile'] = 'studio-' + options.context_mode + ('-apc' if options.reuse_cache else '') + '-' + options.weights
    result['weights'] = options.weights
    return result


def image_for(profile):
    options = ConversationOptions.model_validate(profile.get('conversation_options', {}))
    return IMAGES['200k' if options.context_mode == 'extra_long' else '64k']


def endpoint(profile, image=None):
    engine = engine_profile(profile.get('conversation_options'), image)
    args = engine['arguments']
    return {'port': int(args[args.index('--port') + 1]),
            'served_model': args[args.index('--served-model-name') + 1]}


def apply_options(profile, options=None):
    options = ConversationOptions.model_validate(options or {}).model_dump()
    result = deepcopy(profile)
    if result['package'] != 'qwen38-mxfp4':
        if options != ConversationOptions().model_dump():
            raise ValueError('Choose Qwen3.8 MXFP4 + DFlash2 to use these conversation settings.')
        return result
    result['conversation_options'] = options
    result['context'] = CONTEXTS[options['context_mode']]
    return result


def launch_identity(profile, sources, image=None):
    spec = release_spec(profile.get('conversation_options'), image)
    source_contract = sources if isinstance(sources, dict) else None
    value = dict(image=spec['registry_image'],
                 engine=engine_profile(profile.get('conversation_options'), image, source_contract),
                 sources=sources,
                 checkpoint_lock=spec.get('checkpoint_sha256') or RELEASE['legacy_release']['checkpoint_lock']['sha256'])
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def details(profile, image=None):
    options = ConversationOptions.model_validate(profile.get('conversation_options', {}))
    launch = engine_profile(options, image)
    args = launch['arguments']
    direct = launch.get('entrypoint_kind') == 'direct-cli'
    cache_bytes = int(args[args.index('--kv-cache-memory-bytes') + 1])
    return dict(**options.model_dump(), context=profile['context'],
                runtime_image=release_spec(options, image)['registry_image'],
                gdn_backend='ROCm 10' if direct else ('stock vLLM' if options.reuse_cache else 'compact native'),
                mamba_cache_mode=args[args.index('--mamba-cache-mode') + 1],
                kv_cache_gib=round(cache_bytes / 1024**3, 3), kv_cache_bytes=cache_bytes,
                kv_cache_mode='kv4' if launch['environment'].get('PAITON_KV4') == '1' else 'fp8',
                prefix_caching='--enable-prefix-caching' in args, vision=False,
                aggregate_kv_tokens=launch.get('aggregate_kv_tokens'),
                sequence_limit=int(args[args.index('--max-num-seqs') + 1]),
                prefill_chunk=int(args[args.index('--max-num-batched-tokens') + 1]),
                tool_parser=args[args.index('--tool-call-parser') + 1])
