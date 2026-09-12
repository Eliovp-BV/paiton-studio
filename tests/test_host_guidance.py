import io
import json
from copy import deepcopy
import pytest
from studio.host_guidance import guidance, consumer_support, SourceCheck, REVIEWED_COMMIT
from studio.registry import compatibility
from studio.system_info import SystemInfo

def healthy():
    return dict(platform=dict(system='Linux',machine='x86_64',distribution_id='ubuntu',distribution_version='24.04'),
                gpu=dict(driver_available=True,gpu_count=1,name='AMD Radeon AI PRO R9700',architecture='gfx1201',total=32*1024**3,available=False),
                driver=dict(version='6.19.14'),docker=dict(available=True),
                device_access=dict(kfd_exists=True,kfd_read_write=True,inaccessible_render_nodes=[]))

def test_busy_and_unknown_driver_version_are_not_failures():
    host=healthy();host['driver']['version']=None
    result=guidance(host)
    assert not result['needs_attention']
    assert result['checks'][0]['id']=='driver_version'
    assert result['source']['install_enabled'] is False
    assert result['update_status']=='unverified'

def test_missing_driver_devices_and_docker_have_actionable_messages():
    host=healthy()
    host.update(gpu=dict(driver_available=False),docker=dict(available=False),
                device_access=dict(kfd_exists=False,kfd_read_write=False))
    result=guidance(host)
    assert result['needs_attention']
    assert {c['id'] for c in result['checks']}=={'gpu_detection','kfd','docker'}
    assert 'replacing' in result['checks'][0]['message']

def test_unsupported_gpu_does_not_become_qualified_by_installer():
    host=healthy();host['gpu'].update(architecture='gfx1030',name='RDNA2 device')
    host['platform']['distribution_version']='22.04'
    result=guidance(host)
    assert any(c['id']=='qualification' for c in result['checks'])
    assert not result['source']['os_matches_documentation']

def test_device_permissions_and_multiple_gpus_are_distinct():
    host=healthy();host['gpu']['gpu_count']=2
    host['device_access'].update(kfd_read_write=False,inaccessible_render_nodes=['/dev/dri/renderD128'])
    assert {c['id'] for c in guidance(host)['checks']}=={'gpu_count','permissions','render_access'}


def test_consumer_rdna3_is_explicitly_outside_rdna4_target():
    host = healthy()
    host['gpu'].update(architecture='gfx1100', name='AMD Radeon RX 7900 XTX', total=24*1024**3)
    result = guidance(host)
    support = result['consumer_support']
    assert support['target_family'] == 'RDNA4'
    assert support['detected_family'] == 'RDNA3'
    assert support['status'] == 'unqualified_hardware'
    assert support['qualified_package_ids'] == []
    assert result['checks'][0]['id'] == 'consumer_gpu_family'
    assert 'not guaranteed' in result['checks'][0]['message']
    assert any(check['id'] == 'qualification' for check in result['checks'])


@pytest.mark.parametrize('architecture', ['gfx1200', 'gfx1201'])
def test_consumer_rdna4_16gb_reports_capacity_and_separate_card_qualification(architecture):
    host = healthy()
    host['gpu'].update(architecture=architecture, name='A different Radeon card', total=16*1024**3)
    result = guidance(host)
    support = result['consumer_support']
    assert support['detected_family'] == 'RDNA4'
    assert support['detected_vram_gib'] == 16
    assert support['status'] == 'unqualified_hardware'
    assert support['qualified_package_ids'] == []
    assert {'h3', 'qwen38', 'qwen-coder'} <= set(support['memory_limited_package_ids'])
    assert 'minicpm5-2b' not in support['memory_limited_package_ids']
    assert 'System RAM and disk caches do not replace' in support['memory_message']
    assert result['checks'][0]['id'] == 'consumer_gpu_memory'
    # Passing one requirement never turns an untested board into a qualified one.
    assert compatibility('minicpm5-2b', host['gpu'])['compatible'] is False


def test_consumer_qualified_busy_gpu_is_not_downgraded_or_called_installed():
    host = healthy()
    host['gpu'].update(available=False, supported=True, pids=[1234], used=29*1024**3)
    support = consumer_support(host)
    assert support['status'] == 'qualified_hardware'
    assert support['severity'] == 'info'
    assert {'minicpm5-2b', 'flux', 'qwen38'} <= set(support['qualified_package_ids'])
    assert support['memory_limited_package_ids'] == []
    assert support['memory_message'] is None
    assert 'not installation' in support['qualification_scope']
    idle = deepcopy(host)
    idle['gpu'].update(available=True, pids=[], used=0)
    assert consumer_support(idle) == support
    assert guidance(host)['needs_attention'] is False


def test_consumer_missing_gpu_does_not_invent_family_or_memory():
    host = healthy()
    host['gpu'] = dict(driver_available=False, gpu_count=0)
    support = consumer_support(host)
    assert support['status'] == 'gpu_not_detected'
    assert support['detected_family'] is None
    assert support['detected_vram_gib'] is None
    assert support['memory_message'] is None
    assert support['qualified_package_ids'] == []
    assert support['memory_limited_package_ids'] == []


@pytest.mark.parametrize('count', [None, True, 0, 2])
def test_consumer_cannot_claim_qualification_without_one_identified_gpu(count):
    host = healthy()
    host['gpu']['gpu_count'] = count
    support = consumer_support(host)
    assert support['status'] == 'gpu_selection_required'
    assert support['qualified_package_ids'] == []
    assert support['memory_limited_package_ids'] == []
    assert support['memory_message'] is None


def test_consumer_windows_message_does_not_instruct_linux_device_repair():
    host = healthy()
    host['platform'].update(system='Windows', machine='AMD64')
    host['gpu'] = dict(driver_available=False, gpu_count=0)
    host['device_access'].update(kfd_exists=False, kfd_read_write=False,
                                 inaccessible_render_nodes=['/dev/dri/renderD128'])
    result = guidance(host)
    support = result['consumer_support']
    assert support['status'] == 'environment_required'
    assert 'Native Windows inference is not supported' in support['platform_message']
    assert not {'kfd', 'permissions', 'render_access'} & {check['id'] for check in result['checks']}
    assert 'not implemented' in next(check['message'] for check in result['checks'] if check['id'] == 'gpu_detection')
    assert result['source']['os_matches_documentation'] is False
    assert result['source']['install_enabled'] is False


@pytest.mark.parametrize('capacity', [None, 0, -1, True, float('nan'), float('inf')])
def test_unknown_memory_is_not_treated_as_smaller_qualified_card(capacity):
    host = healthy()
    host['gpu']['total'] = capacity
    support = consumer_support(host)
    assert support['detected_vram_gib'] is None
    assert support['memory_limited_package_ids'] == []
    assert support['status'] == 'unqualified_hardware'
    assert 'could not be read' in support['memory_message']


def test_future_targets_are_not_inferred_from_marketing_name_or_memory():
    host = healthy()
    host['gpu'].update(architecture='gfx1300', name='Future RDNA4 compatible card', total=64*1024**3)
    support = consumer_support(host)
    assert support['detected_family'] is None
    assert support['qualified_package_ids'] == []
    assert support['status'] == 'unqualified_hardware'


def test_memory_guidance_tracks_registry_policy_instead_of_fixed_card_size(monkeypatch):
    # A future package with a qualified smaller-card contract can be admitted
    # without changing product guidance or pretending every 16 GB GPU is eligible.
    from studio.registry import PACKAGES
    candidate = deepcopy(next(package for package in PACKAGES if package['id'] == 'minicpm5-2b'))
    candidate['hardware']['required_device_names'] = ['Test qualified small card']
    monkeypatch.setattr('studio.host_guidance.PACKAGES', [candidate])
    monkeypatch.setattr('studio.host_guidance.compatibility', lambda identity, gpu: compatibility(candidate, gpu))
    host = healthy()
    host['gpu'].update(name='Test qualified small card', total=16*1024**3)
    support = consumer_support(host)
    assert support['status'] == 'qualified_hardware'
    assert support['qualified_package_ids'] == ['minicpm5-2b']
    assert support['memory_message'] is None
    assert support['severity'] == 'info'


def test_wsl_does_not_inherit_native_linux_validation():
    host = healthy()
    host['platform']['wsl'] = True
    result = guidance(host)
    assert result['needs_attention'] is True
    assert result['consumer_support']['severity'] == 'warning'
    assert result['checks'][0]['id'] == 'platform_qualification'
    assert 'have not been qualified' in result['consumer_support']['platform_message']

@pytest.mark.parametrize('sha,state', [(REVIEWED_COMMIT,'reviewed_revision'),('f'*40,'source_changed'),('bad','unavailable')])
def test_explicit_source_check_bounded_cached_and_not_driver_update(monkeypatch,sha,state):
    calls=[]
    class Opener:
        def open(self,req,timeout):
            calls.append(req.full_url)
            assert timeout==8
            assert req.full_url.startswith('https://api.github.com/repos/JoergR75/')
            return io.BytesIO(json.dumps({'sha':sha}).encode())
    monkeypatch.setattr('studio.host_guidance.urllib.request.build_opener',lambda *args:Opener())
    checker=SourceCheck()
    assert calls==[]
    result=checker.check()
    assert result['state']==state
    assert checker.check()['cached']
    assert len(calls)==1
    assert 'install' not in result

def test_offline_does_not_report_no_updates(monkeypatch):
    class Opener:
        def open(self,*args,**kwargs):raise OSError('Offline')
    monkeypatch.setattr('studio.host_guidance.urllib.request.build_opener',lambda *args:Opener())
    assert SourceCheck().check()['state']=='unavailable'
