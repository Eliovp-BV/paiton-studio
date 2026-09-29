"""Measured response statistics and conservative estimates from local history."""
import json
import math
from statistics import median


RATE_SCOPE = 'client_observed_stream'


def _seconds(value):
    try:
        return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None
    except OverflowError:
        return None


def _tokens(value):
    return value if type(value) is int and 0 <= value <= 2**53-1 else None


def normalize_performance(value):
    """Allowlist measured fields; never infer usage or trust a saved rate."""
    value = value if isinstance(value, dict) else {}
    result = {key: _seconds(value.get(key)) for key in (
        'first_token_seconds', 'output_seconds', 'request_seconds', 'load_seconds', 'turn_seconds')}
    result['output_tokens'] = _tokens(value.get('output_tokens'))
    result['model_state'] = value.get('model_state') if value.get('model_state') in ('warm', 'cold') else None
    result['response_replayed'] = value.get('response_replayed') is True
    result['rate_scope'] = RATE_SCOPE if value.get('rate_scope') == RATE_SCOPE else None
    first, output, total = (result[key] for key in ('first_token_seconds', 'output_seconds', 'request_seconds'))
    if total is not None and first is not None and first > total:
        result['first_token_seconds'] = None
    if total is not None and output is not None and (output > total or (first is not None and first + output > total + 1e-6)):
        result['output_seconds'] = None
    if result['response_replayed']:
        # Historical call timings remain in the explicitly replayed breakdown.
        for key in ('first_token_seconds', 'output_seconds', 'request_seconds', 'model_state'):
            result[key] = None
    tokens, duration = result['output_tokens'], result['output_seconds']
    rate = tokens / duration if result['rate_scope'] and tokens is not None and duration and tokens else None
    result['tokens_per_second'] = rate if rate is not None and math.isfinite(rate) else None
    return result


def response_performance(response, *, replayed=False):
    """Final-round server token usage over client-observed output deltas.

    Speculative runtimes can emit many tokens in one burst. This rate is not
    engine decode throughput and is unavailable for a single instantaneous burst.
    """
    response = response if isinstance(response, dict) else {}
    usage = response.get('usage') if isinstance(response.get('usage'), dict) else {}
    timing = response.get('timing') if isinstance(response.get('timing'), dict) else {}
    return normalize_performance(dict(
        output_tokens=usage.get('completion_tokens'), first_token_seconds=timing.get('first_token_seconds'),
        output_seconds=timing.get('decode_seconds'), request_seconds=timing.get('total_seconds'),
        rate_scope=RATE_SCOPE, response_replayed=replayed))


def inference_breakdown(calls):
    """Keep actual calls and replayed receipts separate, with no partial sums."""
    result = {}
    for execution in ('fresh', 'replayed'):
        result[execution] = {}
        for phase in ('final', 'tool', 'summary'):
            selected = [response_performance(call['response']) for call in calls
                        if call['execution'] == execution and call['phase'] == phase]
            bucket = {'calls': len(selected)}
            for key in ('output_tokens', 'request_seconds', 'output_seconds'):
                values = [entry[key] for entry in selected]
                bucket[key] = sum(values) if all(value is not None for value in values) else None
            result[execution][phase] = bucket
    return result


def contract_identity(request):
    """Exact saved execution contract, excluding user content and random seeds."""
    if not isinstance(request, dict) or not isinstance(request.get('profile'), dict):
        return None
    profile = request['profile']
    image = request.get('runtime_image')
    if not profile.get('id') or not profile.get('revision') or not isinstance(image, str) or not image:
        return None
    contract = {'task': request.get('task'), 'profile': profile, 'runtime_image': image}
    # Current settings live in the profile; explicit request choices are also
    # included so future quantization/sampling overrides cannot mix histories.
    for key in ('weights', 'weights_choice', 'precision', 'precision_profile', 'sampling',
                'temperature', 'top_p', 'top_k', 'reasoning_effort', 'api_max_tokens',
                'api_temperature', 'tools_enabled'):
        if key in request:
            contract[key] = request[key]
    try:
        return json.dumps(contract, sort_keys=True, separators=(',', ':'), allow_nan=False)
    except (ValueError, TypeError):
        return None


def history_estimates(jobs, assets, *, limit=30):
    """Per-job typical runtime medians, never queue-wait predictions.

    Callers supply completed history as well as pending jobs. Each asset is used
    once, only when linked to its completed job and an identical pinned contract.
    Durations include runtime loading/checks; they exclude time waiting for GPU
    admission. Unknown or recovered durations do not become samples.
    """
    by_id = {asset.get('id'): asset for asset in assets if isinstance(asset, dict) and asset.get('id')}
    history, used = {}, set()
    ordered = sorted(jobs, key=lambda job: _seconds(job.get('updated')) or 0, reverse=True)
    for job in ordered:
        asset = by_id.get(job.get('asset'))
        if job.get('state') != 'completed' or not asset or asset['id'] in used:
            continue
        metadata = asset.get('metadata') or {}
        if not isinstance(metadata, dict) or metadata.get('origin') != 'generated' or metadata.get('job') != job.get('id'):
            continue
        if asset.get('project') != job.get('project') or metadata.get('recovered') or str(job.get('message', '')).startswith('Recovered the completed video.'):
            continue
        performance = metadata.get('performance')
        if isinstance(performance, dict) and performance.get('response_replayed'):
            continue
        inference = metadata.get('inference')
        replayed = inference.get('replayed') if isinstance(inference, dict) else None
        if isinstance(replayed, dict) and any(isinstance(part, dict) and (_tokens(part.get('calls')) or 0) > 0 for part in replayed.values()):
            # A resumed reply did less work than a complete new turn, even if
            # its final synthesis was newly generated.
            continue
        identity = contract_identity(job.get('request'))
        if identity is None or identity != contract_identity(metadata.get('request')):
            continue
        duration = _seconds(metadata.get('generation_seconds'))
        if duration is None or duration <= 0:
            continue
        used.add(asset['id'])
        values = history.setdefault(identity, [])
        if len(values) < limit:
            values.append(duration)
    estimates = {}
    for job in jobs:
        values = history.get(contract_identity(job.get('request')))
        if values and job.get('state') in ('queued', 'preparing', 'loading', 'warming', 'generating', 'processing', 'saving'):
            estimates[job['id']] = dict(seconds=median(values), samples=len(values), scope='same_contract_median')
    return estimates


def attach_job_performance(store, jobs):
    """Add bounded display metadata with one joined history read, no execution."""
    jobs = list(jobs)
    completed = [job['id'] for job in jobs if job.get('state') == 'completed' and job.get('asset')][-500:]
    pending = any(job.get('state') in ('queued', 'preparing', 'loading', 'warming', 'generating', 'processing', 'saving') for job in jobs)
    if not pending and not completed:
        return [dict(job) for job in jobs]
    selected = 'VALUES ' + ','.join('(?)' for _ in completed) if completed else 'SELECT NULL WHERE 0'
    rows = store.rows(
        f'WITH selected(id) AS ({selected}) '
        'SELECT j.*,a.id AS result_id,a.project AS result_project,a.kind,a.metadata '
        f'FROM jobs j JOIN assets a ON a.id=j.asset AND a.project=j.project '
        "WHERE j.state='completed' AND (? OR j.id IN (SELECT id FROM selected)) "
        'ORDER BY (j.id IN (SELECT id FROM selected)) DESC,j.updated DESC LIMIT 500',
        (*completed, pending))
    assets = [dict(id=row['result_id'], project=row['result_project'], kind=row['kind'], metadata=row['metadata']) for row in rows]
    assets_by_job = {row['id']: asset for row, asset in zip(rows, assets)}
    # Pass requested jobs only once; history rows can include those same jobs.
    requested = {job['id']: job for job in jobs}
    estimates = history_estimates([row for row in rows if row['id'] not in requested] + jobs, assets) if pending else {}
    result = []
    for job in jobs:
        displayed = dict(job)
        if job['id'] in estimates:
            displayed['estimate'] = estimates[job['id']]
        asset = assets_by_job.get(job['id'])
        if asset and job.get('state') == 'completed':
            metadata = asset['metadata'] if isinstance(asset['metadata'], dict) else {}
            request = metadata.get('request') if isinstance(metadata.get('request'), dict) else {}
            # Older stored stream timing did not include reasoning deltas. Only
            # server-reported token counts can be safely displayed for those.
            displayed['performance'] = (normalize_performance(metadata['performance'])
                if isinstance(metadata.get('performance'), dict)
                else response_performance({'usage': metadata.get('usage')}))
            displayed['result'] = dict(kind=asset['kind'], metadata={
                'request': {'task': request.get('task')},
                'generation_seconds': _seconds(metadata.get('generation_seconds'))})
        result.append(displayed)
    return result
