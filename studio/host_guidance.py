"""Read-only host guidance and an explicit, metadata-only community source check.

Never downloads or runs an installer. Source freshness is not driver eligibility.
"""
import json
import re
import threading
import time
import urllib.request
from datetime import datetime, timezone
from .hardware_policy import positive
from .readiness import host_compatibility
from .registry import PACKAGES, compatibility

REPOSITORY = 'JoergR75/amd-therock-7.15-rocm-10-0-0-pytorch-docker-cdna-rdna-automated-deployment'
REVIEWED_COMMIT = '57f9cef9c3736074d3140b1bed129464975d717a'
REPO_URL = 'https://github.com/' + REPOSITORY
OFFICIAL_URL = 'https://rocm.docs.amd.com/projects/install-on-linux/en/latest/'
SOURCE = dict(
    name='JoergR75 · TheRock / ROCm deployment',
    url=REPO_URL, reviewed_url=REPO_URL+'/tree/'+REVIEWED_COMMIT,
    reviewed_commit=REVIEWED_COMMIT, reviewed_at='2026-09-10',
    advertised_stack='TheRock 7.15 / ROCm 10.0.0 · amdgpu 31.50',
    qualification='Community setup reference. Not qualified as a Paiton upgrade.',
    warning='This script can upgrade OS packages, remove existing ROCm and PyTorch, change permissions, install/restart Docker and request a reboot. It can interrupt all GPU applications. Review and back up the host first.',
    install_enabled=False,
)

# Product guidance only, never an admission allowlist. Exact package/profile
# hardware policies remain authoritative when AMD adds cards or architectures.
# Known LLVM targets follow AMD's GPU specifications; unknown targets stay unknown.
GPU_FAMILIES = {
    **dict.fromkeys(('gfx1200', 'gfx1201'), 'RDNA4'),
    **dict.fromkeys(('gfx1100', 'gfx1101', 'gfx1102', 'gfx1103'), 'RDNA3'),
    **dict.fromkeys(('gfx1030', 'gfx1031', 'gfx1032', 'gfx1033', 'gfx1034', 'gfx1035', 'gfx1036'), 'RDNA2'),
}


def consumer_support(snapshot):
    """Explain the consumer support envelope without probing or changing gates.

    Hardware eligibility is independent of downloads, sensors and current GPU
    activity. In particular a busy qualified GPU must not become unsupported.
    Memory warnings come from current package requirements, not a fixed card size.
    """
    platform, gpu = snapshot.get('platform') or {}, snapshot.get('gpu') or {}
    environment = host_compatibility(snapshot)
    architecture = gpu.get('architecture')
    family = GPU_FAMILIES.get(architecture) if isinstance(architecture, str) else None
    total = gpu.get('total')
    capacity = total / 1024**3 if positive(total) else None
    policies = [(p['id'], compatibility(p['id'], gpu)) for p in PACKAGES if p['integrated']]
    detected = gpu.get('driver_available') is True
    single = type(gpu.get('gpu_count')) is int and gpu['gpu_count'] == 1
    qualified = [identity for identity, result in policies if detected and single and result['compatible']]
    memory_limited = [identity for identity, result in policies if detected and single and any(
        check['id'] == 'capacity' and check['status'] == 'incompatible' for check in result['checks'])]
    platform_message = 'Linux is the current supported host. Native Windows support is planned and has not been qualified.'
    if platform.get('system') == 'Windows':
        platform_message = 'Native Windows inference is not supported by the current Studio adapters. Windows support is planned; browsing, saving and export remain available.'
    elif not environment['compatible']:
        platform_message = 'Current inference adapters require Linux on x86-64. This host has not been qualified; browsing, saving and export remain available.'
    elif platform.get('wsl'):
        platform_message = 'WSL is detected. Native Windows and WSL inference have not been qualified for these Studio adapters; Linux-host validation does not establish Windows support.'
    memory_message = None
    if detected and single and memory_limited:
        memory_message = (
            f'Your GPU reports {capacity:.1f} GiB of memory. Some current model packages need more GPU memory and remain unavailable. '
            'Choose a smaller model only when its package is compatible with this card. '
            'System RAM and disk caches do not replace the GPU memory required by these adapters.')
    elif detected and single and capacity is None:
        memory_message = 'GPU memory capacity could not be read, so Studio cannot confirm which model packages fit. System RAM and download storage are separate from GPU memory.'

    if not environment['compatible']:
        status, title, message = 'environment_required', 'This operating system is not yet supported for inference', platform_message
    elif not detected:
        status, title, message = 'gpu_not_detected', 'Radeon compute is not detected', 'Studio cannot verify a compatible GPU. Review detection and device access before downloading models; an absent reading does not prove the driver needs replacing.'
    elif not single:
        status, title, message = 'gpu_selection_required', 'One identifiable Radeon GPU is required', 'The current adapters use one GPU. Memory from multiple GPUs is not combined; review System details before preparing models.'
    elif not qualified:
        status = 'unqualified_hardware'
        if family == 'RDNA4':
            title = 'RDNA4 detected; this GPU is not yet qualified'
            message = 'RDNA4 is Studio’s current focus, but this card does not meet any current package’s full qualification policy. Model operation is not guaranteed. Matching the GPU family or memory size alone is not enough; incompatible packages stay unavailable.'
        else:
            title = 'This GPU is not fully supported'
            message = 'Paiton Studio currently focuses on RDNA4. This GPU has no qualified model packages, so inference operation is not guaranteed. Review the package requirements in Creation tools; a driver upgrade alone does not qualify the card.'
    else:
        status, title = 'qualified_hardware', 'Hardware matches qualified Paiton packages'
        message = 'This GPU matches the hardware policy for one or more current Paiton packages. Each selected package still needs its runtime, download and readiness checks; this is not a guarantee that every model is installed or ready.'
    severity = 'warning' if status != 'qualified_hardware' or memory_message or family != 'RDNA4' or platform.get('wsl') else 'info'
    return dict(status=status, title=title, message=message, severity=severity,
                target_family='RDNA4', detected_family=family, architecture=architecture,
                detected_vram_gib=capacity, qualified_package_ids=qualified,
                qualification_scope='Hardware eligibility only; not installation, readiness or a benchmark.',
                memory_limited_package_ids=memory_limited, memory_message=memory_message,
                platform_message=platform_message)


def guidance(snapshot):
    platform = snapshot.get('platform', {})
    gpu, docker = snapshot.get('gpu', {}), snapshot.get('docker', {})
    support = consumer_support(snapshot)
    checks = []
    def add(identity, title, message, severity='warning'):
        checks.append(dict(id=identity, title=title, message=message, severity=severity))
    if not host_compatibility(snapshot)['compatible']:
        add('platform', 'This host needs a supported environment',
            support['platform_message'])
    elif platform.get('wsl'):
        add('platform_qualification', 'WSL inference has not been qualified', support['platform_message'])
    if gpu.get('driver_available') is True and type(gpu.get('gpu_count')) is int and gpu['gpu_count'] == 1:
        if support['detected_family'] != 'RDNA4':
            add('consumer_gpu_family', 'This GPU is not fully supported',
                'Paiton Studio currently focuses on RDNA4. The detected '+str(support['detected_family'] or gpu.get('architecture') or 'unknown GPU architecture')+
                ' is outside that consumer support target. Full inference operation is not guaranteed; exact package qualification remains required.')
        if support['memory_message']:
            add('consumer_gpu_memory', 'GPU memory limits available models' if support['detected_vram_gib'] is not None else 'GPU memory capacity is unknown', support['memory_message'])
    if not gpu.get('driver_available'):
        add('gpu_detection', 'Radeon compute is not detected',
            'GPU detection for native Windows inference is not implemented by these Studio adapters. This does not establish a GPU or driver failure. See the platform support message before changing drivers.' if platform.get('system') == 'Windows' else
            'Check that the GPU is visible to the host and the amdgpu driver is loaded. In a VM or container, check device passthrough. A missing reading does not prove the driver needs replacing.')
    elif gpu.get('gpu_count') != 1:
        add('gpu_count', 'GPU selection needs attention',
            'These Paiton adapters require one identifiable Radeon GPU. Multiple cards are not pooled or automatically enabled.')
    elif not any(compatibility(p['id'], gpu)['compatible'] for p in PACKAGES if p['integrated']):
        add('qualification', 'GPU detected; no Paiton package is qualified here',
            'Check the device architecture and memory requirements in System details. Installing a broader ROCm stack does not qualify this GPU for a Paiton model.')
    access = snapshot.get('device_access', {})
    if platform.get('system') == 'Linux' and access.get('kfd_exists') is False:
        add('kfd', 'GPU compute device is missing',
            'The /dev/kfd compute device is absent. Check the host driver and GPU passthrough before downloading models.')
    elif platform.get('system') == 'Linux' and access.get('kfd_read_write') is False:
        add('permissions', 'GPU device permissions need review',
            'The Studio user cannot read/write /dev/kfd. Ask the host administrator to check render/video group access and container device permissions; signing in again may be needed.')
    if platform.get('system') == 'Linux' and access.get('inaccessible_render_nodes'):
        add('render_access', 'A Radeon render device is inaccessible',
            'Check permissions for the detected Radeon render device. Do not make GPU devices world-writable.')
    if not docker.get('available'):
        add('docker', 'Local model runtime is unavailable',
            docker.get('message') or 'Install or start the local Docker Engine and check Studio access.')
    if not (snapshot.get('driver') or {}).get('version'):
        add('driver_version', 'Driver version is not reported',
            'Some kernel-provided drivers do not expose a version. This alone is not a driver failure or evidence that an upgrade is required.', 'info')
    supported_os = platform.get('system') == 'Linux' and platform.get('distribution_id') == 'ubuntu' and platform.get('distribution_version') in ('24.04', '26.04')
    return dict(schema_version=1, sampled_at=snapshot.get('sampled_at'),
                needs_attention=any(c['severity']=='warning' for c in checks), checks=checks,
                consumer_support=support,
                host=platform, driver=snapshot.get('driver', {}),
                source={**SOURCE, 'os_matches_documentation':supported_os,
                        'os_message':'This Ubuntu version is listed by the installer; GPU and Paiton compatibility still need review.' if supported_os else 'The referenced installer documents Ubuntu 24.04 and 26.04 only. Do not run it on this detected OS.'},
                official_url=OFFICIAL_URL,
                update_status='unverified',
                driver_policy='Studio does not require one exact host driver version. Model runtimes stay pinned for reproducibility; driver compatibility and Paiton test evidence are evaluated separately.',
                note='Host amdgpu and container ROCm are separate. Studio keeps each model’s tested runtime pinned.')

class SourceCheck:
    """One fixed GitHub endpoint; bounded response, no redirects or shell."""
    def __init__(self):
        self.lock = threading.Lock()
        self.cached = None
        self.next_check = 0

    def check(self):
        with self.lock:
            if self.cached and time.monotonic() < self.next_check:
                return {**self.cached, 'cached':True}
            checked = datetime.now(timezone.utc).isoformat()
            try:
                class NoRedirect(urllib.request.HTTPRedirectHandler):
                    def redirect_request(self, *args, **kwargs):
                        return None
                request = urllib.request.Request(
                    'https://api.github.com/repos/'+REPOSITORY+'/commits/main',
                    headers={'User-Agent':'Paiton-Studio-source-check', 'Accept':'application/vnd.github+json'})
                with urllib.request.build_opener(NoRedirect).open(request, timeout=8) as response:
                    raw = response.read(262145)
                if len(raw)>262144: raise ValueError('Response too large')
                sha = json.loads(raw)['sha']
                if not isinstance(sha,str) or not re.fullmatch('[a-f0-9]{40}',sha):
                    raise ValueError('Invalid revision')
                result = dict(state='source_changed' if sha != REVIEWED_COMMIT else 'reviewed_revision',
                              commit=sha, checked_at=checked, cached=False,
                              url=REPO_URL+'/tree/'+sha,
                              message='Community source changed since review. This is not a verified newer or compatible driver.' if sha != REVIEWED_COMMIT else 'The community source matches Studio’s reviewed revision. Driver upgrade eligibility is still unverified.')
                self.next_check = time.monotonic()+1800
            except (OSError, ValueError, KeyError, TypeError):
                result = dict(state='unavailable', checked_at=checked, cached=False,
                              message='Online source check unavailable. Your local creation tools are unaffected. Try again later or open the source manually.')
                self.next_check = time.monotonic()+60
            self.cached = result
            return dict(result)
