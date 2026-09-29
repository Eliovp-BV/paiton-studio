"""Deterministic CPU measurements; synthetic timings are not benchmarks."""
from copy import deepcopy
import json

import pytest

from scripts.stream_protocol import StreamResponse
from studio.performance import (
    attach_job_performance, contract_identity, history_estimates,
    inference_breakdown, normalize_performance, response_performance,
)
from studio.store import Store


def response(tokens=12, first=2, output=4, total=6, content='Synthetic answer'):
    return dict(choices=[dict(message=dict(role='assistant', content=content), finish_reason='stop')],
                usage=dict(completion_tokens=tokens),
                timing=dict(first_token_seconds=first, decode_seconds=output, total_seconds=total))


def test_stream_counts_reasoning_and_tool_deltas_and_ignores_late_usage():
    clock = [0.0]
    stream = StreamResponse(True, clock=lambda: clock[0], wall_clock=lambda: 1000 + clock[0])
    # Starting at zero is valid. A role-only event is not a generated token.
    stream.feed({'choices': [{'delta': {'role': 'assistant'}}]})
    clock[0] = 2
    stream.feed({'choices': [{'delta': {'reasoning_content': 'Consider this'}}]})
    clock[0] = 4
    stream.feed({'choices': [{'delta': {'tool_calls': [dict(index=0, id='call-1', function=dict(name='read', arguments='{}'))]}}]})
    clock[0] = 6
    stream.feed({'choices': [{'delta': {'content': 'Read the source'}, 'finish_reason': 'tool_calls'}]})
    clock[0] = 20
    stream.feed({'choices': [], 'usage': {'completion_tokens': 12}})
    value = stream.result()
    assert value['reasoning_observed']
    assert value['timing'] == dict(request_started_at=1000, first_output_at=1002,
                                 first_token_seconds=2, decode_seconds=4, total_seconds=6)
    measured = response_performance(value)
    assert measured['output_tokens'] == 12 and measured['tokens_per_second'] == 3


def test_one_burst_and_missing_usage_have_no_invented_rate():
    clock = [0.0]
    stream = StreamResponse(clock=lambda: clock[0], wall_clock=lambda: 0)
    stream.feed({'choices': [{'delta': {'content': 'Many speculative tokens at once'}, 'finish_reason': 'stop'}]})
    stream.feed({'choices': [], 'usage': {'completion_tokens': 8}})
    value = stream.result()
    assert value['timing']['first_token_seconds'] == 0
    assert value['timing']['decode_seconds'] == 0
    assert response_performance(value)['tokens_per_second'] is None
    assert response_performance({})['output_tokens'] is None
    assert response_performance(response(tokens=None))['tokens_per_second'] is None


@pytest.mark.parametrize('value', [True, -1, '12', float('nan'), float('inf'), 10**400, [], {}])
def test_invalid_measurements_remain_unavailable(value):
    measured = normalize_performance(dict(output_tokens=value, first_token_seconds=value,
        output_seconds=value, request_seconds=value, load_seconds=value, turn_seconds=value,
        rate_scope='client_observed_stream', tokens_per_second=9000))
    assert all(measured[key] is None for key in (
        'output_tokens', 'first_token_seconds', 'output_seconds', 'request_seconds',
        'load_seconds', 'turn_seconds', 'tokens_per_second'))


def test_inconsistent_or_replayed_timing_never_claims_a_current_rate():
    assert response_performance(response(first=7))['first_token_seconds'] is None
    assert response_performance(response(output=5))['output_seconds'] is None
    assert normalize_performance(dict(output_tokens=12, output_seconds=4,
        rate_scope='engine_benchmark', tokens_per_second=9000))['tokens_per_second'] is None
    replay = response_performance(response(), replayed=True)
    assert replay['output_tokens'] == 12 and replay['response_replayed']
    assert all(replay[key] is None for key in ('tokens_per_second', 'first_token_seconds', 'request_seconds', 'output_seconds'))


def test_inference_totals_are_weighted_and_missing_values_do_not_become_partial_sums():
    calls = [dict(execution='fresh', phase='tool', response=response(tokens=8, output=2, total=4)),
             dict(execution='fresh', phase='tool', response=response(tokens=30, output=3, total=5)),
             dict(execution='fresh', phase='summary', response=response(tokens=None)),
             dict(execution='replayed', phase='final', response=response())]
    totals = inference_breakdown(calls)
    assert totals['fresh']['tool'] == dict(calls=2, output_tokens=38, output_seconds=5, request_seconds=9)
    assert totals['fresh']['summary']['output_tokens'] is None
    assert totals['fresh']['final']['calls'] == 0
    assert totals['replayed']['final']['output_tokens'] == 12


def contract():
    return dict(task='image', runtime_image='ghcr.io/example/image@sha256:' + 'a'*64,
                profile=dict(id='image-quality', revision='release-one', precision='exact',
                             width=2048, height=2048, steps=40, weights='mxfp4'))


def historical(index, seconds, request=None):
    request = deepcopy(request or contract())
    job = dict(id=f'job-{index}', asset=f'asset-{index}', project='project', state='completed',
               request=request, updated=index, message='Saved on this computer.')
    asset = dict(id=job['asset'], project='project', kind='image', metadata=dict(
        job=job['id'], request=deepcopy(request), origin='generated', generation_seconds=seconds))
    return job, asset


def test_history_median_uses_recent_successes_without_duplicate_or_incomplete_samples():
    pairs = [historical(index, seconds) for index, seconds in enumerate((10, 100, 20), 1)]
    jobs, assets = map(list, zip(*pairs))
    pending = dict(id='next', state='queued', request=contract())
    assert history_estimates(jobs + [jobs[0], pending], assets)['next'] == dict(
        seconds=20, samples=3, scope='same_contract_median')
    assert history_estimates(jobs + [pending], assets, limit=2)['next']['seconds'] == 60
    jobs[0]['state'] = 'failed'
    assets[1]['metadata']['recovered'] = True
    assets[2]['metadata']['generation_seconds'] = float('nan')
    assert history_estimates(jobs + [pending], assets) == {}


@pytest.mark.parametrize('change', [
    {'profile': {'id': 'another-profile'}}, {'profile': {'revision': 'release-two'}},
    {'profile': {'precision': 'draft'}}, {'profile': {'weights': 'w3a4'}},
    {'profile': {'width': 1024}}, {'profile': {'steps': 20}},
    {'profile': {'conversation_options': {'context_mode': 'long'}}},
    {'runtime_image': 'another-image'}, {'weights_choice': 'w3a4'}, {'sampling': {'temperature': 1}},
])
def test_estimate_contracts_never_mix_quality_releases_or_weights(change):
    job, asset = historical(1, 10)
    different = contract()
    for key, value in change.items():
        if key == 'profile': different[key].update(value)
        else: different[key] = value
    assert history_estimates([job, dict(id='next', state='queued', request=different)], [asset]) == {}
    assert contract_identity({**contract(), 'seed': 99, 'prompt': 'Other user content'}) == contract_identity(contract())


def test_history_rejects_unknown_or_tampered_asset_provenance():
    job, asset = historical(1, 10)
    pending = dict(id='next', state='queued', request=contract())
    asset['metadata']['request']['runtime_image'] = 'other-image'
    assert history_estimates([job, pending], [asset]) == {}
    assert contract_identity({'profile': {'id': 'legacy', 'revision': 'old'}}) is None


def test_resumed_tool_work_does_not_shorten_fresh_turn_estimates():
    job, asset = historical(1, 10)
    pending = dict(id='next', state='queued', request=contract())
    asset['metadata']['inference'] = {'replayed': {'tool': {'calls': 1}}}
    assert history_estimates([job, pending], [asset]) == {}


def test_attaching_metrics_uses_one_bounded_join_and_does_not_mutate_stored_requests(tmp_path, monkeypatch):
    store = Store(tmp_path)
    project = store.create_project()
    request = contract()
    done = store.enqueue(project['id'], request)
    asset = store.add_asset(project['id'], 'image', 'Synthetic result', b'fixture', '.txt', dict(
        origin='generated', job=done['id'], request=request, generation_seconds=12,
        usage={'completion_tokens': 7}, timing={'decode_seconds': 1, 'first_token_seconds': 1}))
    store.status(done['id'], 'completed', 'Saved', asset=asset['id'])
    pending = store.enqueue(project['id'], request)
    jobs = [store.job(done['id']), pending]
    before = deepcopy(jobs)
    calls = []
    rows = store.rows
    def observe(query, params=()):
        calls.append(query)
        return rows(query, params)
    monkeypatch.setattr(store, 'rows', observe)
    payload = attach_job_performance(store, jobs)
    assert len(calls) == 1 and 'JOIN assets' in calls[0] and 'LIMIT 500' in calls[0]
    assert jobs == before
    assert payload[0]['performance']['output_tokens'] == 7
    assert payload[0]['performance']['tokens_per_second'] is None
    assert payload[0]['performance']['first_token_seconds'] is None
    assert payload[0]['result'] == dict(kind='image', metadata=dict(request=dict(task='image'), generation_seconds=12))
    assert payload[1]['estimate'] == dict(seconds=12, samples=1, scope='same_contract_median')


def test_real_conversation_loop_separates_summaries_tools_and_replayed_calls(tmp_path, monkeypatch):
    from studio.conversation_runner import run
    from studio.registry import profile
    store = Store(tmp_path)
    project = store.create_project()
    request = dict(task='write', profile=profile('qwen38-mxfp4-chat', 'write'), tools_enabled=True)
    job = store.enqueue(project['id'], request)
    directory = store.root / 'jobs' / job['id']
    directory.mkdir(parents=True)
    tool = dict(id='call-1', type='function', function=dict(name='save_code_draft',
        arguments=json.dumps(dict(name='sample.py', content='print(1)'))))
    tool_response = response(tokens=4, first=1, output=1, total=2, content='')
    tool_response['choices'][0] = dict(message=dict(role='assistant', content='', tool_calls=[tool]), finish_reason='tool_calls')
    replies = [response(tokens=6, total=6), tool_response, response(tokens=12)]
    streamed = []
    class Fake:
        def __init__(self): self.store = store
        def check_cancel(self, job): pass
        def http(self, *args, **kwargs): return {'count': 20}
        def stream(self, job, command, limit):
            streamed.append(command)
            (directory / 'calls' / command[-1].split('/')[-1] / 'writing-result.json').write_text(json.dumps(replies.pop(0)))
    def select(store, identity, original, ceiling, tokenize, summarize, checks):
        if not any(message['role'] == 'tool' for message in original['messages']):
            summarize(dict(model='fixture', messages=[dict(role='user', content='Summarize')]))
        return deepcopy(original), {'input_tokens': 20}
    monkeypatch.setattr('studio.conversation_runner.select_context', select)
    body = dict(model='fixture', messages=[dict(role='user', content='Save a draft')], max_tokens=100)
    final, metadata = run(Fake(), job, 'owned-fixture', 8000, body, directory)
    assert len(streamed) == 3 and metadata['tool_rounds'] == 1
    assert final['usage']['completion_tokens'] == 12
    assert metadata['inference']['fresh']['summary']['output_tokens'] == 6
    assert metadata['inference']['fresh']['tool']['output_tokens'] == 4
    assert metadata['inference']['fresh']['final']['output_tokens'] == 12
    assert not metadata['response_replayed']
    _, replayed = run(Fake(), job, 'owned-fixture', 8000, body, directory)
    assert len(streamed) == 3 and replayed['response_replayed']
    assert all(bucket['calls'] == 0 for bucket in replayed['inference']['fresh'].values())
    assert all(bucket['calls'] == 1 for bucket in replayed['inference']['replayed'].values())
