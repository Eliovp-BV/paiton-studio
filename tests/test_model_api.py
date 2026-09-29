"""Authenticated text API over synthetic durable jobs; no GPU or model processes."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import threading
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from studio import model_api
from studio.app import create_app
from studio.chat_adapters import writing_body
from studio.model_api import APISettings, CompletionInput, ModelAPI
from studio.registry import profile
from studio.runtime import RuntimeFailure
from studio.store import Store


class FakeWorker:
    def __init__(self, store):
        self.store, self.state, self.cancelled = store, 'idle', []

    def diagnostics(self):
        return {'state': self.state, 'thread_alive': self.state == 'idle'}

    def cancel(self, identity):
        if self.store.job(identity)['state'] not in model_api.TERMINAL:
            self.cancelled.append(identity)
            self.store.status(identity, 'cancelled', 'Synthetic cancellation', cancel=1)


@pytest.fixture
def connection(tmp_path, monkeypatch):
    store = Store(tmp_path / 'data')
    worker = FakeWorker(store)
    selected = profile('gptoss-chat', 'write', 'chat')
    calls = []
    def resolve(store, runtime, role, identity):
        calls.append((role, identity))
        if role != 'chat' or identity != selected['id']:
            raise ValueError('Unavailable synthetic model')
        return dict(selected)
    monkeypatch.setattr(model_api, 'resolve_profile', resolve)
    monkeypatch.setattr(model_api, 'compatible_profiles', lambda role: [dict(selected)])
    api = ModelAPI(store, object(), worker)
    api.poll_seconds = .001
    project = store.create_project('Synthetic API project')['id']
    enabled = api.configure(project, APISettings(enabled=True, revision=0))
    auth = 'Bearer ' + enabled['token']
    prepared = []
    def prepare(request):
        prepared.append(request.copy())
        return {**request, 'runtime_image': 'sha256:' + 'a' * 64, 'runtime_ref': 'synthetic-approved-runtime'}
    store.prepare_request = prepare
    return SimpleNamespace(store=store, worker=worker, api=api, project=project,
                           auth=auth, token=enabled['token'], grant=api.authorize(auth),
                           calls=calls, prepared=prepared, profile=selected)


def body(**changes):
    return CompletionInput.model_validate({'model': 'gptoss-chat', 'messages': [{'role': 'user', 'content': 'Explain a synthetic teapot.'}], **changes})


def submit(connection, key='synthetic-request-0001', **changes):
    return connection.api.submit(connection.grant, body(**changes), key)


def complete(connection, job, answer='A synthetic answer.', finish='stop'):
    asset = connection.store.add_asset(job['project'], 'text', 'Synthetic reply', answer.encode(), '.md', {'finish_reason': finish})
    connection.store.status(job['id'], 'completed', 'Synthetic completion', asset=asset['id'])
    return connection.store.job(job['id'])


class FakeRequest:
    def __init__(self, authorization, disconnected=False):
        self.headers = {'authorization': authorization}
        self.disconnected = disconnected

    async def is_disconnected(self):
        return self.disconnected


def test_connection_defaults_disabled_tokens_are_one_time_hashes_and_rotation_revokes(connection):
    p = connection
    other = p.store.create_project()['id']
    assert p.api.settings(other)['enabled'] is False
    assert p.api.settings(other)['revision'] == 0
    assert 'token' not in p.api.settings(p.project)
    saved = p.store.rows('SELECT * FROM model_api_connections WHERE project=?', (p.project,))[0]
    assert saved['token_hash'] == hashlib.sha256(p.token.encode()).hexdigest()
    assert p.token not in json.dumps(p.store.rows('SELECT * FROM model_api_connections'))
    unchanged = p.api.configure(p.project, APISettings(enabled=True, revision=1))
    assert 'token' not in unchanged
    assert p.api.authorize(p.auth)['project'] == p.project
    rotated = p.api.configure(p.project, APISettings(enabled=True, rotate=True, revision=unchanged['revision']))
    assert rotated['token'] != p.token
    with pytest.raises(HTTPException) as denied:
        p.api.authorize(p.auth)
    assert denied.value.status_code == 401
    assert p.api.authorize('Bearer ' + rotated['token'])['project'] == p.project
    disabled = p.api.configure(p.project, APISettings(enabled=False, revision=rotated['revision']))
    assert not disabled['enabled'] and 'token' not in disabled
    with pytest.raises(HTTPException):
        p.api.authorize('Bearer ' + rotated['token'])
    assert p.store.rows('SELECT token_hash FROM model_api_connections WHERE project=?', (p.project,))[0]['token_hash'] == ''


@pytest.mark.parametrize('authorization', ['', 'Basic abc', 'Bearer wrong', 'Bearer ' + 'x' * 201, None])
def test_malformed_or_unknown_tokens_are_rejected(connection, authorization):
    with pytest.raises(HTTPException) as denied:
        connection.api.authorize(authorization)
    assert denied.value.status_code == 401


def test_connection_revision_conflict_preserves_valid_token(connection):
    p = connection
    with pytest.raises(HTTPException) as conflict:
        p.api.configure(p.project, APISettings(enabled=False, revision=0))
    assert conflict.value.status_code == 409
    assert p.api.authorize(p.auth)['revision'] == 1


def test_paused_worker_never_enqueues_or_preflights_new_requests(connection):
    p = connection
    p.worker.state = 'stopped'
    with pytest.raises(HTTPException) as paused:
        submit(p)
    assert paused.value.status_code == 503
    assert not p.store.rows('SELECT * FROM jobs') and p.calls == [] and p.prepared == []


def test_request_options_and_runtime_snapshot_are_persisted_exactly(connection):
    p = connection
    messages = [{'role': 'system', 'content': 'Use plain language.'}, {'role': 'user', 'content': 'Explain a teapot.'}]
    job = submit(p, messages=messages, max_tokens=128, temperature=.35)
    request = job['request']
    assert job['project'] == p.project and job['state'] == 'queued'
    assert request['messages'] == messages and request['prompt'] == 'Explain a teapot.'
    assert request['api_max_tokens'] == 128 and request['api_temperature'] == .35
    assert request['runtime_image'] == 'sha256:' + 'a' * 64 and len(p.prepared) == 1
    runtime = writing_body(request)
    assert runtime['max_tokens'] == 128 and runtime['temperature'] == .35
    assert 'tools' not in runtime


def test_idempotency_is_durable_conflict_checked_and_project_scoped(connection):
    p = connection
    first = submit(p)
    assert submit(p)['id'] == first['id'] and len(p.prepared) == 1
    with pytest.raises(HTTPException) as conflict:
        submit(p, temperature=1)
    assert conflict.value.status_code == 409
    other = p.store.create_project()['id']
    token = p.api.configure(other, APISettings(enabled=True, revision=0))['token']
    grant = p.api.authorize('Bearer ' + token)
    second = p.api.submit(grant, body(), 'synthetic-request-0001')
    assert second['id'] != first['id'] and second['project'] == other
    reopened = ModelAPI(Store(p.store.root), object(), p.worker)
    assert reopened.submit(p.grant, body(), 'synthetic-request-0001')['id'] == first['id']


def test_completed_idempotent_retry_does_not_need_current_model_or_active_worker(connection, monkeypatch):
    p = connection
    first = complete(p, submit(p))
    p.worker.state = 'stopped'
    monkeypatch.setattr(model_api, 'resolve_profile', lambda *args: pytest.fail('An accepted durable retry must not reselect a model.'))
    assert submit(p)['id'] == first['id']


def test_pending_limit_and_concurrent_same_key_create_only_one_job(connection):
    p = connection
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda _: submit(p), range(2)))
    assert results[0]['id'] == results[1]['id']
    second = submit(p, key='synthetic-request-0002')
    with pytest.raises(HTTPException) as full:
        submit(p, key='synthetic-request-0003')
    assert full.value.status_code == 429
    complete(p, second)
    assert submit(p, key='synthetic-request-0003')['state'] == 'queued'


@pytest.mark.parametrize('changes', [
    {'tools': []}, {'tool_choice': 'auto'}, {'response_format': {'type': 'json_object'}},
    {'messages': [{'role': 'tool', 'content': 'result'}]},
    {'messages': [{'role': 'user', 'content': [{'type': 'image_url', 'image_url': {'url': 'https://invalid.example'}}]}]},
    {'messages': [{'role': 'user', 'content': 'x' * 24001}]},
    {'messages': [{'role': 'system', 'content': 'No user message'}]},
    {'messages': [{'role': 'user', 'content': 'x' * 12001}] * 2},
    {'messages': [{'role': 'user', 'content': 'x'}] * 65},
    {'stream': False, 'stream_options': {'include_usage': True}},
    {'max_tokens': 2049}, {'max_tokens': 0}, {'temperature': 3}, {'temperature': float('nan')}, {'n': 2},
])
def test_unsupported_or_oversized_requests_fail_schema_without_execution(changes):
    with pytest.raises(ValidationError):
        body(**changes)


def test_revocation_cancels_only_api_jobs_of_that_project(connection):
    p = connection
    own = submit(p)
    regular = p.store.enqueue(p.project, {'task': 'write', 'profile': p.profile, 'prompt': 'Ordinary Studio request'})
    other_project = p.store.create_project()['id']
    other_token = p.api.configure(other_project, APISettings(enabled=True, revision=0))['token']
    other = p.api.submit(p.api.authorize('Bearer ' + other_token), body(), 'synthetic-other-0001')
    p.api.configure(p.project, APISettings(enabled=False, revision=1))
    assert p.worker.cancelled == [own['id']]
    assert p.store.job(regular['id'])['state'] == 'queued'
    assert p.store.job(other['id'])['state'] == 'queued'


def test_rotating_token_does_not_cancel_a_request_accepted_under_the_new_token(connection, monkeypatch):
    p = connection
    old = submit(p)
    monkeypatch.setattr(model_api.secrets, 'token_urlsafe', lambda size: 'new-synthetic-token')
    original_rows, accepted = p.store.rows, []
    def before_revocation_query(sql, params=()):
        if 'model_api_requests r JOIN jobs' in sql and 'r.project=?' in sql and not accepted:
            accepted.append(None)
            grant = p.api.authorize('Bearer paiton_new-synthetic-token')
            accepted[0] = p.api.submit(grant, body(), 'new-generation-request')
        return original_rows(sql, params)
    monkeypatch.setattr(p.store, 'rows', before_revocation_query)
    p.api.configure(p.project, APISettings(enabled=True, rotate=True, revision=1))
    assert accepted and accepted[0]
    assert p.worker.cancelled == [old['id']]
    assert p.store.job(accepted[0]['id'])['state'] == 'queued'


def test_stale_grant_cannot_enqueue_after_revocation(connection):
    p = connection
    p.api.configure(p.project, APISettings(enabled=False, revision=1))
    with pytest.raises(HTTPException) as denied:
        submit(p)
    assert denied.value.status_code == 401 and not p.store.rows('SELECT * FROM jobs')


def test_nonstream_result_preserves_finish_reason_and_text(connection):
    p = connection
    job = complete(p, submit(p), 'Exact generated text.', finish='length')
    async def collect():
        return [item async for item in p.api.wait(FakeRequest(p.auth), p.grant, job)]
    output = asyncio.run(collect())[0]
    assert output['choices'][0]['message'] == {'role': 'assistant', 'content': 'Exact generated text.'}
    assert output['choices'][0]['finish_reason'] == 'length'


def test_streaming_deltas_form_exact_final_result_and_report_finish_reason(connection):
    p = connection
    job = submit(p, stream=True)
    async def collect():
        stream = p.api.wait(FakeRequest(p.auth), p.grant, job, True)
        chunks = [await anext(stream)]
        p.store.status(job['id'], 'running', 'Synthetic', progress={'text': 'Hello'})
        chunks.append(await anext(stream))
        p.store.status(job['id'], 'running', 'Synthetic', progress={'text': 'Hello world'})
        chunks.append(await anext(stream))
        complete(p, job, 'Hello world!', finish='length')
        chunks.extend([item async for item in stream])
        return chunks
    chunks = asyncio.run(collect())
    assert chunks[0]['choices'][0]['delta'] == {'role': 'assistant'}
    assert ''.join(item['choices'][0]['delta'].get('content', '') for item in chunks) == 'Hello world!'
    assert chunks[-1]['choices'][0]['finish_reason'] == 'length'
    assert p.worker.cancelled == []


@pytest.mark.parametrize('reason', ['timeout', 'disconnect', 'cancelled_task'])
def test_abandoned_wait_cancels_only_its_owned_pending_job(connection, reason):
    p = connection
    job = submit(p)
    other = submit(p, key='synthetic-request-0002')
    request = FakeRequest(p.auth, disconnected=reason == 'disconnect')
    if reason == 'timeout': p.api.timeout_seconds = -1
    async def collect():
        if reason == 'cancelled_task':
            waiter = asyncio.create_task(anext(p.api.wait(request, p.grant, job)))
            await asyncio.sleep(.01)
            waiter.cancel()
            await waiter
        else:
            async for _ in p.api.wait(request, p.grant, job): pass
    with pytest.raises((HTTPException, asyncio.CancelledError)):
        asyncio.run(collect())
    assert p.worker.cancelled == [job['id']]
    assert p.store.job(other['id'])['state'] == 'queued'


def test_revoked_token_cannot_retrieve_a_completed_response(connection):
    p = connection
    job = complete(p, submit(p), 'Project private reply.')
    p.api.configure(p.project, APISettings(enabled=False, revision=1))
    async def collect():
        return [item async for item in p.api.wait(FakeRequest(p.auth), p.grant, job)]
    with pytest.raises(HTTPException) as denied:
        asyncio.run(collect())
    assert denied.value.status_code == 401 and p.worker.cancelled == []


def test_failed_result_redacts_backend_diagnostics(connection):
    p = connection
    job = submit(p)
    p.store.status(job['id'], 'failed', 'Private /srv/internal/model path token=PRIVATE')
    with pytest.raises(HTTPException) as failed:
        p.api.result(p.store.job(job['id']))
    assert failed.value.status_code == 500
    assert 'PRIVATE' not in failed.value.detail and '/srv/' not in failed.value.detail


def test_http_api_authentication_settings_scope_pause_and_unsupported_options(tmp_path, monkeypatch):
    monkeypatch.setattr(model_api, 'compatible_profiles', lambda role: [profile('gptoss-chat', 'write', 'chat')])
    monkeypatch.setattr(model_api, 'resolve_profile', lambda *args: profile('gptoss-chat', 'write', 'chat'))
    app = create_app(data=tmp_path, config={}, worker_enabled=False)
    with TestClient(app) as client:
        assert client.get('/v1/models').status_code == 401
        session = client.get('/api/session').json()['token']
        project = app.state.store.create_project()['id']
        endpoint = '/api/projects/' + project + '/model-api'
        assert client.get(endpoint).json()['enabled'] is False
        assert client.put(endpoint, json={'enabled': True, 'revision': 0}).status_code == 403
        enabled = client.put(endpoint, json={'enabled': True, 'revision': 0}, headers={'x-studio-token': session})
        assert enabled.status_code == 200
        token = enabled.json()['token']
        headers = {'authorization': 'Bearer ' + token}
        assert token not in client.get(endpoint).text
        models = client.get('/v1/models', headers=headers)
        assert models.status_code == 200 and models.json()['data'][0]['id'] == 'gptoss-chat'
        assert client.get('/v1/models', headers={**headers, 'origin': 'https://untrusted.example'}).status_code == 403
        paused = client.post('/v1/chat/completions', headers=headers, json=body().model_dump())
        assert paused.status_code == 503 and paused.json()['error']['message']
        unsupported = client.post('/v1/chat/completions', headers=headers, json={**body().model_dump(), 'tools': []})
        assert unsupported.status_code == 400 and 'not supported' in unsupported.json()['error']['message']
        assert not app.state.store.rows('SELECT * FROM model_api_requests')
        client.cookies.clear()
        assert client.get(endpoint, headers=headers).status_code == 401, 'API tokens cannot read Studio settings or other project data.'
        assert client.get('/v1/models', headers=headers).status_code == 200, 'External clients need only the API token.'


def test_http_stream_and_nonstream_use_openai_shapes_without_loading_a_model(connection, monkeypatch):
    p = connection
    original_submit = p.api.submit
    def completed_submit(*args):
        return complete(p, original_submit(*args), 'Ready fixture.', finish='length')
    monkeypatch.setattr(p.api, 'submit', completed_submit)
    app = FastAPI()
    app.include_router(p.api.router())
    with TestClient(app) as client:
        headers = {'authorization': p.auth}
        response = client.post('/v1/chat/completions', headers=headers, json=body().model_dump())
        assert response.status_code == 200
        assert response.json()['object'] == 'chat.completion'
        assert response.json()['choices'][0]['finish_reason'] == 'length'
        stream = client.post('/v1/chat/completions', headers=headers, json=body(stream=True).model_dump())
        assert stream.status_code == 200 and stream.headers['content-type'].startswith('text/event-stream')
        assert stream.text.endswith('data: [DONE]\n\n')
        chunks = [json.loads(line[6:]) for line in stream.text.splitlines() if line.startswith('data: ') and line != 'data: [DONE]']
        assert ''.join(item['choices'][0]['delta'].get('content', '') for item in chunks) == 'Ready fixture.'
        assert chunks[-1]['choices'][0]['finish_reason'] == 'length'


def test_saving_unchanged_connection_does_not_split_durable_idempotency(connection):
    p = connection
    first = submit(p)
    settings = p.api.configure(p.project, APISettings(enabled=True, revision=1))
    assert 'token' not in settings
    fresh_grant = p.api.authorize(p.auth)
    assert p.api.submit(fresh_grant, body(), 'synthetic-request-0001')['id'] == first['id']
    assert len(p.store.rows('SELECT * FROM jobs')) == 1


def test_streaming_body_size_guard_stops_reading_before_enqueue(connection):
    p = connection
    endpoint = next(route.endpoint for route in p.api.router().routes if route.path == '/v1/chat/completions')
    class ChunkedRequest:
        headers = {'authorization': p.auth}
        reads = 0
        async def stream(self):
            for _ in range(3):
                self.reads += 1
                yield b'x' * 100000
        async def body(self):
            pytest.fail('The API must bound streamed input before buffering the complete body.')
    request = ChunkedRequest()
    response = asyncio.run(endpoint(request))
    assert response.status_code == 413 and request.reads == 2
    assert '150 KB' in json.loads(response.body)['error']['message']
    assert not p.store.rows('SELECT * FROM jobs') and p.calls == []


def test_disconnect_of_one_retry_keeps_other_waiter_and_last_disconnect_cancels(connection):
    p = connection
    job = submit(p, stream=True)
    async def simulate():
        first_request, second_request = FakeRequest(p.auth), FakeRequest(p.auth)
        first = p.api.wait(first_request, p.grant, job, True)
        second = p.api.wait(second_request, p.grant, job, True)
        await anext(first)
        await anext(second)
        first_request.disconnected = True
        with pytest.raises(asyncio.CancelledError):
            await anext(first)
        assert p.store.job(job['id'])['state'] == 'queued' and p.worker.cancelled == []
        second_request.disconnected = True
        with pytest.raises(asyncio.CancelledError):
            await anext(second)
    asyncio.run(simulate())
    assert p.worker.cancelled == [job['id']]
    assert p.api.waiters == {}


def test_stalled_resolver_does_not_run_on_request_event_loop(connection, monkeypatch):
    p = connection
    endpoint = next(route.endpoint for route in p.api.router().routes if route.path == '/v1/chat/completions')
    request_thread = threading.get_ident()
    original_submit = p.api.submit
    def complete_in_worker(*args):
        assert threading.get_ident() != request_thread, 'Model preflight and SQLite submission must run outside the request event loop.'
        return complete(p, original_submit(*args))
    monkeypatch.setattr(p.api, 'submit', complete_in_worker)
    class Request(FakeRequest):
        async def stream(self):
            yield body().model_dump_json().encode()
    response = asyncio.run(endpoint(Request(p.auth)))
    assert response.status_code == 200


def test_usage_metadata_is_reported_only_when_real_counts_are_present(connection):
    p = connection
    job = complete(p, submit(p))
    assert p.api.usage(job) is None
    asset = p.store.asset(job['asset'])
    counts = {'prompt_tokens': 20, 'completion_tokens': 10, 'total_tokens': 30}
    metadata = {**asset['metadata'], 'usage': {**counts, 'private_metadata': 'not exported'}}
    with p.store.connect() as db:
        db.execute('UPDATE assets SET metadata=? WHERE id=?', (json.dumps(metadata), asset['id']))
    assert p.api.usage(job) == counts
    async def collect():
        return [item async for item in p.api.wait(FakeRequest(p.auth), p.grant, job, True, include_usage=True)]
    chunks = asyncio.run(collect())
    assert chunks[-1]['choices'] == [] and chunks[-1]['usage'] == counts
    assert 'private_metadata' not in json.dumps(chunks)


def test_unknown_models_are_rejected_without_persisting_internal_errors(connection):
    p = connection
    with pytest.raises(HTTPException) as failure:
        submit(p, model='unregistered-model')
    assert failure.value.status_code == 400 and '/v1/models' in failure.value.detail
    assert not p.store.rows('SELECT * FROM jobs')


@pytest.mark.parametrize('key', ['short', 'x' * 101, 'contains spaces in key', 'path/with/slashes'])
def test_invalid_retry_keys_do_not_enqueue(connection, key):
    with pytest.raises(HTTPException) as failure:
        submit(connection, key=key)
    assert failure.value.status_code == 400
    assert not connection.store.rows('SELECT * FROM jobs')


def test_available_model_list_omits_unavailable_profiles_without_leaking_diagnostics(connection, monkeypatch):
    p = connection
    assert p.api.models()['data'] == [{'id': 'gptoss-chat', 'object': 'model', 'created': 0, 'owned_by': 'paiton-studio'}]
    def unavailable(*args):
        raise RuntimeError('PRIVATE /srv/internal/runtime path')
    monkeypatch.setattr(model_api, 'resolve_profile', unavailable)
    assert p.api.models() == {'object': 'list', 'data': []}


def test_rejected_runtime_snapshot_rolls_back_api_request_and_job(connection):
    p = connection
    def unavailable(request):
        raise ValueError('Synthetic immutable runtime is unavailable')
    p.store.prepare_request = unavailable
    with pytest.raises(HTTPException) as failure:
        submit(p)
    assert failure.value.status_code == 503
    assert not p.store.rows('SELECT * FROM model_api_requests')
    assert not p.store.rows('SELECT * FROM jobs')


@pytest.mark.parametrize('failure', [
    RuntimeFailure('Synthetic preparation failed: /srv/private/runtime key=PRIVATE'),
    ValueError('Synthetic invalid snapshot: /srv/private/runtime key=PRIVATE'),
    OSError('Synthetic filesystem failure: /srv/private/runtime key=PRIVATE'),
])
def test_preparation_errors_have_sanitized_api_shape_without_queued_work(connection, failure):
    p = connection
    def reject(request):
        raise failure
    p.store.prepare_request = reject
    app = FastAPI()
    app.include_router(p.api.router())
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.post('/v1/chat/completions', headers={'authorization': p.auth}, json=body().model_dump())
    assert response.status_code == 503
    assert isinstance(response.json()['error'], dict)
    assert response.json()['error']['message']
    assert '/srv/' not in response.text and 'PRIVATE' not in response.text
    assert not p.store.rows('SELECT * FROM jobs')
    assert not p.store.rows('SELECT * FROM model_api_requests')
