"""Qwen API integration uses synthetic readiness and never launches Docker or a worker."""
import pytest
from fastapi.testclient import TestClient

from studio.app import create_app
from studio.runtime import Runtime, RuntimeFailure
from studio import qwen_mxfp4


@pytest.fixture
def application(tmp_path, monkeypatch):
    monkeypatch.setenv('PAITON_STUDIO_CONFIG', str(tmp_path / 'config.json'))
    monkeypatch.setattr(Runtime, 'command', lambda *a, **k: pytest.fail('Unexpected Docker call'))
    monkeypatch.setattr(Runtime, 'run', lambda *a, **k: pytest.fail('Unexpected generation'))
    return create_app(tmp_path / 'data', config={}, worker_enabled=False)


@pytest.mark.parametrize('available', ['long', 'extra_long'])
def test_tools_and_readiness_report_each_context_contract_without_starting_jobs(application, monkeypatch, available):
    calls=[]
    def preflight(self, request, *, verify_content=True):
        selected=request['profile']
        if selected['package']=='qwen38-mxfp4':
            assert verify_content is False
            mode=selected['conversation_options']['context_mode']
            calls.append(mode)
            assert selected['conversation_options']['weights']=='mxfp4'
            if mode != available:
                raise RuntimeFailure('Synthetic target is not installed')
        return 'synthetic-image'
    monkeypatch.setattr(Runtime, 'preflight', preflight)
    monkeypatch.setattr('studio.app.SystemInfo.snapshot', lambda self: {
        'platform': {'system':'Linux','machine':'x86_64'}, 'gpu':{}, 'sampled_at':'fixture'})
    with TestClient(application) as client:
        client.get('/api/session')
        for endpoint, key in [('/api/tools', None), ('/api/readiness', 'models')]:
            calls.clear()
            response=client.get(endpoint)
            assert response.status_code==200
            payload=response.json()
            tool=next(t for t in (payload[key] if key else payload) if t['id']=='qwen38-mxfp4')
            releases=tool['release_states']
            assert calls==['long','extra_long']
            assert releases['64k']['installed']==(available=='long')
            assert releases['200k']['installed']==(available=='extra_long')
            ready_release=releases['64k' if available=='long' else '200k']
            assert 'File hashes are checked before loading' in ready_release['message']
            assert releases['64k']['runtime_image']==qwen_mxfp4.IMAGE
            assert releases['200k']['runtime_image']==qwen_mxfp4.IMAGE
            assert tool['state']==('ready' if available=='long' else 'setup_required')
            assert tool['qualified'] is True
            assert tool['optional_components'][0]['verified'] is False
        assert application.state.setup.jobs()==[]
        assert client.get('/api/projects').json()==[]


def test_optional_component_routes_require_session_and_csrf(application, monkeypatch):
    calls=[]
    monkeypatch.setattr(application.state.setup, 'install', lambda *args: calls.append(args) or {'state':'queued'})
    route='/api/setup/qwen38-mxfp4/components/w3a4/install'
    with TestClient(application) as client:
        assert client.post(route).status_code==401
        token=client.get('/api/session').json()['token']
        assert client.post(route).status_code==403
        response=client.post(route, headers={'x-studio-token':token})
        assert response.status_code==200 and response.json()['state']=='queued'
        assert calls==[('qwen38-mxfp4','w3a4')]


@pytest.mark.parametrize('body', [{'enabled':'true'}, {'enabled':1}, {'enabled':None}, {}, {'enabled':True,'extra':1}])
def test_optional_default_requires_strict_boolean(application, body):
    with TestClient(application) as client:
        token=client.get('/api/session').json()['token']
        response=client.put('/api/setup/qwen38-mxfp4/components/w3a4', json=body, headers={'x-studio-token':token})
        assert response.status_code==422
        assert 'qwen38_w3a4_default' not in application.state.setup.config


def test_optional_default_cannot_enable_unverified_weights_and_can_disable(application):
    with TestClient(application) as client:
        token=client.get('/api/session').json()['token']
        headers={'x-studio-token':token}
        route='/api/setup/qwen38-mxfp4/components/w3a4'
        assert client.put(route,json={'enabled':True},headers=headers).status_code==400
        response=client.put(route,json={'enabled':False},headers=headers)
        assert response.status_code==200 and response.json()['enabled_default'] is False
        assert application.state.setup.config['qwen38_w3a4_default'] is False
        assert client.put('/api/setup/qwen38-mxfp4/components/unknown',json={'enabled':False},headers=headers).status_code==400
        assert client.post('/api/setup/unknown/components/w3a4/install',headers=headers).status_code==400
        assert client.post('/api/setup/qwen38-mxfp4/components/unknown/install',headers=headers).status_code==400
        assert application.state.setup.jobs()==[]
