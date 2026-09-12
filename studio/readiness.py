"""Explain local capability readiness without loading models or changing settings."""
import platform
from .system_info import environment_compatibility

# These are the current public adapters' host contract, not a general ROCm matrix.
HOST_REQUIREMENTS = {'systems': ['Linux'], 'machines': ['amd64']}
ROLE_NAMES = {'image': 'Create images', 'video': 'Animate an image', 'video_text': 'Create video from text',
              'write': 'Write a story', 'website': 'Build a website', 'chat': 'GPTPaiton', 'code': 'Code assistance'}


def host_compatibility(snapshot=None):
    if snapshot is None:
        snapshot = {'platform': {'system': platform.system(), 'machine': platform.machine()}}
    return environment_compatibility(HOST_REQUIREMENTS, snapshot)


def report(snapshot, tools):
    environment = host_compatibility(snapshot)
    models = []
    for tool in tools:
        hardware = tool.get('compatibility', {})
        state = tool['state']
        blockers = list(hardware.get('reasons') or ([] if hardware.get('compatible') else [hardware.get('reason')]))
        if tool['integrated'] and not environment['compatible']:
            state = 'environment_required'
            blockers = environment['reasons'] + blockers
        if tool['integrated'] and not tool.get('installed'):
            blockers.append('The local package needs download, configuration or repair.')
        profiles = [{key: p.get(key) for key in ('id', 'label', 'roles', 'state', 'installed', 'compatibility')}
                    for p in tool.get('profiles', [])]
        models.append(dict(id=tool['id'], name=tool['name'], model=tool['model'], state=state,
                           installed=bool(tool.get('installed')), integrated=tool['integrated'],
                           hardware=hardware, blockers=list(dict.fromkeys(b for b in blockers if b)),
                           profiles=profiles, quality_note=tool.get('quality_note'),
                           next_action='create' if state == 'ready' else 'setup' if state == 'setup_required' else 'review'))
    capabilities = []
    for role, name in ROLE_NAMES.items():
        candidates = [m for m in models if any(role in (p['roles'] or []) for p in m['profiles'])]
        ready = [m['id'] for m in candidates if environment['compatible'] and any(
            role in (p['roles'] or []) and p['state'] == 'ready' for p in m['profiles'])]
        installable = [m['id'] for m in candidates if environment['compatible'] and any(
            p['state'] == 'setup_required' and role in (p['roles'] or []) and p['compatibility'].get('compatible') for p in m['profiles'])]
        capabilities.append(dict(id=role, name=name, ready_models=ready, setup_models=installable,
                                 state='ready' if ready else 'setup_required' if installable else 'unavailable'))
    gpu = snapshot.get('gpu', {})
    return dict(schema_version=1, sampled_at=snapshot.get('sampled_at'), environment=environment,
                host={key: snapshot.get('platform', {}).get(key) for key in ('system', 'release', 'machine', 'distribution')},
                device={key: gpu.get(key) for key in ('name', 'architecture', 'gpu_count', 'total')},
                driver={key: snapshot.get('driver', {}).get(key) for key in ('name', 'version')},
                capabilities=capabilities, models=models,
                activity=dict(available=gpu.get('available'), message=gpu.get('message'),
                              note='Ready means installed and eligible. A busy GPU waits in the queue; it does not become incompatible.'),
                notes=[
                    'Dedicated GPU memory, system RAM and download storage are separate budgets.',
                    'Memory from multiple cards is not pooled. These adapters currently admit one identifiable Radeon GPU.',
                    'A GPU or driver supported by AMD still needs qualification with the exact Paiton package and profile.',
                    'No model was loaded and no benchmark ran for this check. Additional GPUs are not enabled by detection alone.'])
