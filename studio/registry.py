"""Versioned capabilities and bounded profiles for installed Paiton adapters.

A model is eligible because its adapter declares a capability and profile role,
never because its display name resembles a task. New model packages can reuse an
adapter after their launch contract and profiles have been qualified.
"""
from copy import deepcopy
from .qwen_mxfp4 import REVISION as MXFP4_REVISION

SCHEMA_VERSION = 1
ADAPTERS = {
    'paiton-flux': {'tasks': ['image'], 'capabilities': ['image.generate']},
    'paiton-h3': {'tasks': ['video'], 'capabilities': ['video.animate_image', 'video.generate', 'audio.video_soundtrack']},
    'paiton-wan': {'tasks': ['video'], 'capabilities': ['video.generate','video.animate_image']},
    'paiton-chat': {'tasks': ['write'], 'capabilities': ['text.generate', 'text.plan_site', 'text.chat', 'text.code']},
}
ROLE_TASKS = {'image': 'image', 'video': 'video', 'write': 'write', 'website': 'write', 'chat':'write', 'code':'write', 'video_text':'video'}
ROLE_CAPABILITIES = {'image': 'image.generate', 'video': 'video.animate_image', 'write': 'text.generate', 'website': 'text.plan_site', 'chat':'text.chat', 'code':'text.code', 'video_text':'video.generate'}
PACKAGES = [
    dict(id='qwen38-mxfp4', name='Fast writing, websites & chat', model='Qwen3.8 27B MXFP4 + DFlash2 · Paiton',
         revision=MXFP4_REVISION, integrated=True, adapter='paiton-chat',
         default_for=['write', 'website', 'chat', 'code'], tasks=['write'],
         capabilities=['text.generate', 'text.plan_site', 'text.chat', 'text.code'], vram_gib=None,
         license='Component-specific terms; see the published runtime and checkpoint notices',
         quality_note='Recommended local text model. DFlash2 accelerates replies; this profile uses direct answers with extended thinking off. Review facts and generated code.',
         preparation_note='First setup downloads both the target and draft model. Loading verifies their weights and prepares the local runtime; follow-up requests reuse the ready model.',
         profiles=[dict(id='qwen38-mxfp4-writing', label='Writing · up to 2048 tokens', task='write', roles=['write'], context=8192, max_tokens=2048),
                   dict(id='qwen38-mxfp4-website', label='Website planning · up to 3500 tokens', task='write', roles=['website'], context=8192, max_tokens=3500),
                   dict(id='qwen38-mxfp4-chat', label='Conversation & code · up to 2048 tokens', task='write', roles=['chat', 'code'], context=8192, max_tokens=2048)]),
    dict(id='minicpm5-2b', name='Small local chat & code', model='MiniCPM5-2B W4A16 · Paiton',
         revision='6c1ee6fa521aa53f47cfb32696e6d8ef5b0db805', integrated=True,
         adapter='paiton-chat', default_for=[], tasks=['write'],
         capabilities=['text.chat', 'text.code'], vram_gib=4.8,
         license='Apache-2.0 checkpoint and plugin; runtime notices apply',
         quality_note='Faster, smaller model with lower answer quality than larger models. Review arithmetic, strict instructions and unfamiliar code. Extended thinking is disabled for quick replies.',
         preparation_note='Studio verifies cached weights and prepares the model before answering. Recent conversations reuse the ready model.',
         profiles=[dict(id='minicpm5-chat', label='Quick chat · up to 1024 tokens', task='write',
                        roles=['chat','code'], context=8192, max_tokens=1024)]),
    dict(id='flux', name='Image tool', model='FLUX.2 klein 4B · Paiton', revision='45e9cc76cb70f84473ce5c6c2e2282d0ef3c6ecd', integrated=True, adapter='paiton-flux', default_for=['image'], tasks=['image'], capabilities=['image.generate'], vram_gib=14.6, license='Apache-2.0 runtime; see upstream quantization provenance notices', profiles=[dict(id='image-standard', label='Square · 1024 × 1024', task='image', roles=['image'], width=1024, height=1024, steps=4, guidance=1.0, batch=1)]),
    dict(id='h3', name='Video tool', model='MiniMax H3 W4A8 · Paiton', revision='42ed227ee7df40d41602854ae760620d6eb651fe', integrated=True, adapter='paiton-h3', default_for=['video'], tasks=['video'], capabilities=['video.animate_image', 'video.generate', 'audio.video_soundtrack'], vram_gib=30.34, license='MiniMax community terms; ComfyUI GPL-3.0', profiles=[dict(id='video-short', label='Short scene · 5.17 seconds', task='video', roles=['video'], width=864, height=480, frames=124, fps=24, steps=8, preset='turbo8', audio=True),dict(id='video-fast', label='Faster · 5.17 seconds · less detail', task='video', roles=['video'], width=864, height=480, frames=124, fps=24, steps=4, preset='turbo4', audio=True),dict(id='video-long', label='Long scene · 15.08 seconds', task='video', roles=['video'], width=864, height=480, frames=362, fps=24, steps=8, preset='turbo8', audio=True)]),
    dict(id='qwen-coder', name='Writing & website tool', model='Qwen3-Coder 30B A3B AWQ · Paiton', revision='4bd30395b72ea6045edd04806c4fea448d4467b3', integrated=True, adapter='paiton-chat', default_for=[], tasks=['write'], capabilities=['text.generate', 'text.plan_site'], vram_gib=20.1, license='Apache-2.0; upstream revision provenance limitation', profiles=[dict(id='writing-standard', label='Quick local draft · up to 1024 tokens', task='write', roles=['write'], context=4096, max_tokens=1024),dict(id='writing-website', label='Website plan · up to 2048 tokens', task='write', roles=['website'], context=4096, max_tokens=2048)]),
    dict(id='qwen38', name='Writing & website tool', model='Qwen3.8 27B Qronos · Paiton', revision='649ca9d47a7de5364c6fcccc0c1b4f6e542e15e2', integrated=True, adapter='paiton-chat', default_for=['write', 'website'], tasks=['write'], capabilities=['text.generate', 'text.plan_site'], vram_gib=None, license='Apache-2.0 AND MIT runtime; see installed package notices', preparation_note='The release reports about 10–12 minutes for a cold model load. Studio reports loading until the runtime is ready. Follow-up writing and website plans reuse the ready model until it expires or another tool needs the GPU.', profiles=[dict(id='qwen38-writing', label='Longer local draft · up to 2048 tokens', task='write', roles=['write'], context=8192, max_tokens=2048),dict(id='qwen38-website', label='Website plan · up to 3500 tokens', task='write', roles=['website'], context=8192, max_tokens=3500)]),
    dict(id='qwen3-4b', name='Short-draft writing tool', model='Qwen3-4B Instruct 2507 BF16 · Paiton', revision='cdbee75f17c01a7cc42f958dc650907174af0554', integrated=False, adapter='paiton-chat', default_for=[], tasks=['write'], capabilities=['text.generate'], vram_gib=None, license='Apache-2.0 checkpoint and plugin; runtime notices apply', quality_note='Experimental and unavailable: this candidate failed factual writing checks. It has not been qualified for Studio writing or website planning.', preparation_note='The local checkpoint is verified before loading. Your request stays queued while the model prepares.', profiles=[dict(id='qwen3-4b-short', label='Short first draft · up to 512 tokens', task='write', roles=['write'], context=8192, max_tokens=512, quality_note='Experimental and unavailable: this candidate failed factual writing checks. It has not been qualified for Studio writing or website planning.')]),
    dict(id='ornith', name='Alternative writing tool', model='Ornith 1.5 35B A3B MXFP4 · Paiton', revision='9e488f46c0f7969f84c9923ee0256311cd50316e', integrated=False, adapter=None, default_for=[], tasks=['write'], capabilities=['text.generate'], vram_gib=None, license='See installed package notices', profiles=[]),
]

from .alternative_models import PACKAGES as ALTERNATIVES
PACKAGES.extend(ALTERNATIVES)
for _package in PACKAGES:
    if _package['id']=='h3':
        for _profile in _package['profiles']: _profile['roles'].append('video_text')

# These are admission floors derived from retained driver-memory peaks, not
# claims of qualification on smaller boards. Device qualification is separate.
HARDWARE = {
    'qwen38-mxfp4': dict(supported_architectures=['gfx1201'], required_device_names=['AMD Radeon AI PRO R9700'],
                         required_vram_gib=32, minimum_reported_vram_gib=31,
                         qualification='Published MXFP4 + DFlash2 release qualified on one 32 GB Radeon AI PRO R9700. Other GPUs are not yet qualified.',
                         memory_basis='Target, draft and fixed 5 GiB KV cache use the published 32 GB hardware profile.'),
    'minicpm5-2b': dict(supported_architectures=['gfx1201'], required_device_names=['AMD Radeon AI PRO R9700'],
                      required_vram_gib=8, minimum_reported_vram_gib=8,
                      qualification='Qualified on one 32 GB Radeon AI PRO R9700. Other GPUs have not been tested.',
                      memory_basis='4.8 GiB sampled driver peak in the 8K/two-request profile; 8 GiB admission floor retains workspace margin.'),
    'flux': dict(supported_architectures=['gfx1201'], required_device_names=['AMD Radeon AI PRO R9700'], required_vram_gib=16, minimum_reported_vram_gib=15,
                 qualification='The installed pipeline and attention code explicitly require Radeon AI PRO R9700. Its measured driver peak was 14.6 GiB; a smaller board has not been qualified.', memory_basis='14.6 GiB measured driver peak, rounded up for admission.'),
    'h3': dict(supported_architectures=['gfx1201'], required_device_names=['AMD Radeon AI PRO R9700'], required_vram_gib=32, minimum_reported_vram_gib=31,
               qualification='The installed video release is qualified on a 32 GB Radeon AI PRO R9700; its measured driver peak was 30.34 GiB.', memory_basis='30.34 GiB measured driver peak, rounded up for admission.'),
    'qwen-coder': dict(supported_architectures=['gfx1201'], required_device_names=['AMD Radeon AI PRO R9700'], required_vram_gib=24, minimum_reported_vram_gib=21,
                       qualification='The installed writing release is qualified on Radeon AI PRO R9700; its measured driver peak was 20.1 GiB.', memory_basis='20.1 GiB measured driver peak, rounded up for admission.'),
    'qwen38': dict(supported_architectures=['gfx1201'], required_device_names=['AMD Radeon AI PRO R9700'], required_vram_gib=32, minimum_reported_vram_gib=31,
                   qualification='The installed release is qualified on a 32 GB Radeon AI PRO R9700. Smaller-card operation has not been qualified.', memory_basis='Published 32 GB release qualification; 31 GiB admission floor allows driver-reserved capacity.'),
}
for _model in PACKAGES:
    _model['hardware'] = deepcopy(HARDWARE.get(_model['id'], _model.get('hardware', {})))


def compatibility(selection, gpu):
    """Resolve registry requirements and apply the shared admission policy."""
    from .hardware_policy import evaluate
    try:
        model = package(selection) if isinstance(selection, str) else selection
        if not isinstance(model, dict):
            return evaluate(None, gpu)
        base = package(model['package']) if 'package' in model else model
        requirements = {**base.get('hardware', {}), **model.get('hardware', {})}
        return evaluate(requirements, gpu, integrated=base.get('integrated', True))
    except (KeyError, ValueError, TypeError):
        return evaluate(None, gpu)


hardware_compatibility = compatibility


def package(identity):
    for item in PACKAGES:
        if item['id'] == identity:
            return deepcopy(item)
    raise ValueError('This model package is not registered with Studio.')


def profile(identity, task, role=None):
    for model in PACKAGES:
        adapter = ADAPTERS.get(model.get('adapter'), {})
        if not model['integrated'] or task not in model['tasks'] or task not in adapter.get('tasks', []):
            continue
        for item in model['profiles']:
            if item['id'] == identity and item['task'] == task:
                if role is not None and (role not in item.get('roles', []) or ROLE_CAPABILITIES.get(role) not in model['capabilities'] or ROLE_CAPABILITIES.get(role) not in adapter.get('capabilities', [])):
                    raise ValueError('Choose a model profile compatible with this purpose.')
                return deepcopy({**item, 'package': model['id'], 'model': model['model'], 'revision': model['revision'], 'adapter': model['adapter'], 'capabilities': model['capabilities'], 'hardware': {**model.get('hardware', {}), **item.get('hardware', {})}})
    raise ValueError('Choose an installed, compatible creation profile.')


def compatible_profiles(role):
    if role not in ROLE_TASKS:
        raise ValueError('Choose a supported creation purpose.')
    result = []
    for model in PACKAGES:
        adapter = ADAPTERS.get(model.get('adapter'), {})
        if not model['integrated'] or ROLE_TASKS[role] not in adapter.get('tasks', []) or ROLE_CAPABILITIES[role] not in adapter.get('capabilities', []) or ROLE_CAPABILITIES[role] not in model.get('capabilities', []):
            continue
        for item in model['profiles']:
            if role in item.get('roles', []):
                result.append(profile(item['id'], ROLE_TASKS[role], role))
    return result


def validate_snapshot(snapshot, task=None):
    """Recheck persisted profiles at execution; tolerate added registry metadata.

    Existing requests retain their exact settings. A changed/removed release fails
    explicitly instead of silently running a different model or quality profile.
    """
    if not isinstance(snapshot, dict):
        raise ValueError('The saved creation profile is invalid.')
    canonical = profile(snapshot.get('id'), task or snapshot.get('task'))
    if canonical['package']=='qwen38-mxfp4' and 'conversation_options' in snapshot:
        from .conversation_options import apply_options
        canonical=apply_options(canonical,snapshot['conversation_options'])
    metadata = {'roles', 'adapter', 'capabilities', 'hardware'}
    for key, value in canonical.items():
        # Hardware policy is evaluated anew below by Runtime; old descriptive
        # qualification text must not prevent retrying an unchanged model.
        if key in ('label', 'hardware', 'quality_note'):
            continue
        if key == 'roles' and isinstance(snapshot.get(key), list) and all(isinstance(role,str) and role in value for role in snapshot[key]):
            continue  # Adding a task role does not change an existing render's settings.
        if key in metadata and key not in snapshot:
            continue
        if snapshot.get(key) != value:
            raise ValueError('The saved profile no longer matches an installed release. Select a compatible model again.')
    if set(snapshot) - set(canonical):
        raise ValueError('The saved profile contains unsupported settings.')
    return canonical
