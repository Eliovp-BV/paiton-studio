"""Selective website revisions use CPU fixtures here, never simulated inference claims."""
import copy
import json

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from studio.app import create_app
from studio.queue import Worker
from studio.runtime import Runtime
from studio.store import Store
from studio.websites import RegenerateInput, WebsiteInput, Websites


@pytest.fixture
def workflow(tmp_path, monkeypatch):
    monkeypatch.setattr(Runtime, 'preflight', lambda self, request: 'installed-test-package')
    store = Store(tmp_path)
    runtime = Runtime(store, {})
    work = Websites(store, runtime, Worker(store, runtime))
    project = store.create_project()['id']
    image = store.add_asset(project, 'image', 'Original artwork', b'original fixture', '.png', {})
    video = store.add_asset(project, 'video', 'Original video', b'video fixture', '.mp4', {})
    site = work.save(project, {'title': 'Owner supplied company', 'theme': 'dark', 'pages': [
        {'slug': 'index', 'title': 'Home', 'description': 'Owner supplied introduction', 'sections': [
            {'heading': 'Welcome', 'body': 'A real supplied claim', 'asset_ids': [image['id'], video['id'], image['id']]},
            {'heading': 'Details', 'body': 'Keep [Contact email] unknown', 'asset_ids': [image['id']]}]},
        {'slug': 'about', 'title': 'About', 'description': 'Keep this description', 'sections': [
            {'heading': 'Owner history', 'body': 'Keep this text exactly', 'asset_ids': [image['id']]}]}]})
    return work, project, site, image, video


def body(site, **changes):
    return RegenerateInput(kind='page-copy', page_slug='index', instructions='Make this page more concise.',
                           revision=site['revision']).model_copy(update=changes)


def copy_result():
    return {'title': 'A clearer home', 'description': 'A shorter introduction', 'sections': [
        {'heading': 'Hello', 'body': 'A concise supplied claim'},
        {'heading': 'Contact', 'body': 'Keep [Contact email] unknown'}]}


def complete(work, run, content=None, kind='text'):
    job_id = run['jobs'][0]
    raw = json.dumps(copy_result() if content is None else content).encode() if kind == 'text' else b'new image fixture'
    asset = work.store.add_asset(run['project'], kind, 'CPU fixture output', raw,
                                 '.md' if kind == 'text' else '.png', {'job': job_id})
    work.store.status(job_id, 'completed', 'CPU fixture completed', asset=asset['id'])
    return asset


def test_page_replacement_preserves_every_unrelated_output_and_survives_restart(workflow):
    work, project, site, image, video = workflow
    run = work.regenerate(project, body(site))
    assert len(work.store.rows('SELECT id FROM jobs')) == 1
    assert run['request']['base_site'] == site
    assert run['request']['base_revision'] == site['revision']
    assert run['progress'] == {'completed': 0, 'total': 1}
    assert run['job_details'][0]['task'] == 'write'
    job = work.store.job(run['jobs'][0])
    assert job['request']['purpose'] == 'website-page-copy'
    assert job['request']['profile']['id'] == 'qwen38-mxfp4-website'
    complete(work, run)
    restarted = Websites(work.store, work.runtime, work.worker)
    restarted.tick()
    restarted.tick()
    result = restarted.get_run(run['id'])
    assert result['state'] == 'completed'
    assert result['progress'] == {'completed': 1, 'total': 1}
    assert restarted.site(project) == site  # Review is never an automatic overwrite.
    expected = copy.deepcopy(site)
    expected['pages'][0].update(title=copy_result()['title'], description=copy_result()['description'])
    for section, revision in zip(expected['pages'][0]['sections'], copy_result()['sections']):
        section.update(revision)
    assert result['result'] == expected
    assert len(work.store.rows('SELECT id FROM jobs')) == 1
    applied = restarted.apply(run['id'], site['revision'])
    assert applied == {**expected, 'revision': site['revision'] + 1}
    assert restarted.get_run(run['id'])['state'] == 'applied'
    for asset in (image, video):
        assert work.store.file(asset).is_file()
    with pytest.raises(ValueError):
        restarted.apply(run['id'], applied['revision'])


@pytest.mark.parametrize('replace', [True, False])
def test_artwork_changes_one_occurrence_or_appends_without_rewriting_copy(workflow, replace):
    work, project, site, image, video = workflow
    run = work.regenerate(project, body(site, kind='section-artwork', section_index=0,
                                       asset_id=image['id'] if replace else None))
    assert run['state'] == 'artwork'
    assert run['job_details'][0]['task'] == 'image'
    assert work.store.job(run['jobs'][0])['request']['profile']['task'] == 'image'
    artwork = complete(work, run, kind='image')
    work.tick()
    result = work.get_run(run['id'])['result']
    expected = copy.deepcopy(site)
    ids = expected['pages'][0]['sections'][0]['asset_ids']
    if replace:
        ids[0] = artwork['id']
    else:
        ids.append(artwork['id'])
    assert result == expected
    assert work.site(project) == site
    assert work.store.asset(image['id'], project)
    assert len(work.store.rows('SELECT id FROM jobs')) == 1


@pytest.mark.parametrize('use_new_revision', [False, True])
def test_snapshot_guard_rejects_later_edits_even_with_current_revision(workflow, use_new_revision):
    work, project, site, _, _ = workflow
    run = work.regenerate(project, body(site))
    complete(work, run)
    work.tick()
    newer = work.save(project, {**site, 'title': 'An edit in another window'})
    with pytest.raises(ValueError, match='changed after this replacement'):
        work.apply(run['id'], newer['revision'] if use_new_revision else site['revision'])
    assert work.site(project) == newer
    assert work.get_run(run['id'])['state'] == 'completed'


def test_missing_site_stale_revision_and_invalid_targets_enqueue_nothing(workflow):
    work, project, site, image, video = workflow
    foreign_project = work.store.create_project()['id']
    foreign = work.store.add_asset(foreign_project, 'image', 'Foreign', b'foreign', '.png', {})
    cases = [
        (foreign_project, body(site)),
        (project, body(site, revision=0)),
        (project, body(site, page_slug='missing')),
        (project, body(site, kind='section-artwork', section_index=7)),
        (project, body(site, kind='section-artwork', section_index=0, asset_id=foreign['id'])),
        (project, body(site, kind='section-artwork', section_index=0, asset_id=video['id'])),
    ]
    for selected_project, request in cases:
        with pytest.raises(ValueError):
            work.regenerate(selected_project, request)
    assert work.store.rows('SELECT id FROM jobs') == []
    assert work.runs(project) == []
    assert work.site(project) == site


@pytest.mark.parametrize('changes', [
    {'kind': 'anything'}, {'page_slug': '../other'}, {'revision': True}, {'revision': '1'},
    {'instructions': ' ' * 10}, {'unknown': 1}, {'section_index': 0}, {'asset_id': 'x'},
    {'kind': 'section-artwork'}, {'kind': 'section-artwork', 'section_index': -1},
    {'kind': 'section-artwork', 'section_index': True}, {'kind': 'section-artwork', 'section_index': 0, 'asset_id': ''},
])
def test_strict_request_schema(changes):
    with pytest.raises(ValidationError):
        RegenerateInput.model_validate({'kind': 'page-copy', 'page_slug': 'index', 'instructions': 'Rewrite this page.', 'revision': 1, **changes})


@pytest.mark.parametrize('change', ['extra_page', 'media', 'section_count', 'wrong_type', 'invalid_json'])
def test_malformed_copy_never_changes_saved_site(workflow, change):
    work, project, site, _, _ = workflow
    run = work.regenerate(project, body(site))
    result = copy_result()
    if change == 'extra_page':
        result['pages'] = []
    elif change == 'media':
        result['sections'][0]['asset_ids'] = ['new-media']
    elif change == 'section_count':
        result['sections'].pop()
    elif change == 'wrong_type':
        result['title'] = 42
    else:
        result = 'not a JSON object'
    complete(work, run, result)
    work.tick()
    assert work.get_run(run['id'])['state'] == 'failed'
    assert work.site(project) == site
    assert len(work.store.assets(project)) == 3


def test_failure_retry_uses_frozen_snapshot_and_only_one_new_job(workflow):
    work, project, site, _, _ = workflow
    run = work.regenerate(project, body(site))
    original_request = work.store.job(run['jobs'][0])['request']
    work.store.status(run['jobs'][0], 'failed', 'CPU failure fixture')
    work.tick()
    retried = work.retry(run['id'])
    assert retried['request']['retry_of'] == run['id']
    assert retried['request']['base_site'] == site
    retried_request = work.store.job(retried['jobs'][0])['request']
    assert retried_request == {**original_request, 'website_run': retried['id']}
    assert len(work.store.rows('SELECT id FROM jobs')) == 2
    assert work.get_run(run['id'])['state'] == 'failed'
    complete(work, retried)
    work.tick()
    assert work.get_run(retried['id'])['state'] == 'completed'


def test_cancellation_and_late_completion_preserve_original_site(workflow):
    work, project, site, _, _ = workflow
    run = work.regenerate(project, body(site))
    cancelled = work.cancel(run['id'])
    assert cancelled['state'] == 'cancelled'
    asset = complete(work, run)
    work.tick()
    assert work.get_run(run['id'])['state'] == 'cancelled'
    assert work.store.file(asset).is_file()
    assert work.site(project) == site
    assert work.retry(run['id'])['state'] == 'planning'


def test_discard_is_idempotent_keeps_assets_and_prevents_apply(workflow):
    work, project, site, _, _ = workflow
    run = work.regenerate(project, body(site))
    with pytest.raises(ValueError, match='completed'):
        work.discard(run['id'])
    asset = complete(work, run)
    work.tick()
    assert work.discard(run['id'])['state'] == 'discarded'
    assert work.discard(run['id'])['state'] == 'discarded'
    with pytest.raises(ValueError):
        work.apply(run['id'], site['revision'])
    assert work.store.file(asset).is_file()
    assert work.site(project) == site


def test_retry_requires_unchanged_site_and_qualified_model(workflow, monkeypatch):
    work, project, site, _, _ = workflow
    run = work.regenerate(project, body(site))
    work.cancel(run['id'])
    monkeypatch.setattr(work.runtime, 'preflight', lambda request: (_ for _ in ()).throw(ValueError('Model missing')))
    with pytest.raises(ValueError, match='Model missing'):
        work.retry(run['id'])
    work.save(project, {**site, 'title': 'New title'})
    with pytest.raises(ValueError, match='changed after this replacement'):
        work.retry(run['id'])
    assert len(work.store.rows('SELECT id FROM jobs')) == 1


def test_missing_or_wrong_role_model_rejected_before_enqueue(workflow, monkeypatch):
    work, project, site, _, _ = workflow
    with pytest.raises(ValueError, match='supports this creation task'):
        work.regenerate(project, body(site, writing_profile_id='flux-image'))
    monkeypatch.setattr(work.runtime, 'preflight', lambda request: (_ for _ in ()).throw(ValueError('Model missing')))
    with pytest.raises(ValueError, match='No installed compatible model'):
        work.regenerate(project, body(site))
    assert work.store.rows('SELECT id FROM jobs') == []


def test_enqueue_rolls_back_parent_and_child_together(workflow, monkeypatch):
    work, project, site, _, _ = workflow
    enqueue = work._enqueue
    def fail_after_enqueue(db, selected_project, request):
        enqueue(db, selected_project, request)
        raise ValueError('Fixture transaction failure')
    monkeypatch.setattr(work, '_enqueue', fail_after_enqueue)
    with pytest.raises(ValueError, match='transaction failure'):
        work.regenerate(project, body(site))
    assert work.store.rows('SELECT id FROM jobs') == []
    assert work.runs(project) == []


def test_edit_during_model_preflight_rechecked_before_enqueue(workflow, monkeypatch):
    work, project, site, _, _ = workflow
    monkeypatch.setattr(work.runtime, 'preflight', lambda request: work.save(project, {**site, 'title': 'Edit during check'}))
    with pytest.raises(ValueError, match='changed after this replacement'):
        work.regenerate(project, body(site))
    assert work.store.rows('SELECT id FROM jobs') == []


def test_active_full_or_selective_run_excludes_second_run(workflow):
    work, project, site, _, _ = workflow
    selective = work.regenerate(project, body(site))
    with pytest.raises(ValueError, match='Finish or cancel'):
        work.generate(project, WebsiteInput(brief='Create an owner supplied website'))
    with pytest.raises(ValueError, match='Finish or cancel'):
        work.regenerate(project, body(site))
    work.cancel(selective['id'])
    full = work.generate(project, WebsiteInput(brief='Create an owner supplied website'))
    with pytest.raises(ValueError, match='Finish or cancel'):
        work.regenerate(project, body(site))
    work.cancel(full['id'])
    assert work.site(project) == site


def test_api_routes_use_real_queue_revision_guard_and_retry_guidance(tmp_path, monkeypatch):
    monkeypatch.setattr(Runtime, 'preflight', lambda self, request: 'installed-test-package')
    app = create_app(tmp_path, config={}, worker_enabled=False)
    with TestClient(app) as client:
        client.headers['X-Studio-Token'] = client.get('/api/session').json()['token']
        project = client.post('/api/projects', json={}).json()['id']
        site = client.put(f'/api/projects/{project}/website', json={'title': 'Test', 'pages': [
            {'slug': 'index', 'title': 'Home', 'sections': [{'body': 'Approved text'}]},
            {'slug': 'about', 'title': 'About', 'sections': [{'body': 'Approved text'}]}]}).json()
        response = client.post(f'/api/projects/{project}/website/regenerate', json=body(site).model_dump())
        assert response.status_code == 200
        run = response.json()
        assert client.post('/api/website-runs/' + run['id'] + '/cancel').json()['state'] == 'cancelled'
        generic = client.post('/api/jobs/' + run['jobs'][0] + '/retry', json={})
        assert generic.status_code == 400 and 'individual output in Build Page' in generic.json()['error']
        retried = client.post('/api/website-runs/' + run['id'] + '/retry').json()
        assert retried['request']['retry_of'] == run['id']
        client.post('/api/website-runs/' + retried['id'] + '/cancel')
        assert client.post('/api/website-runs/' + retried['id'] + '/discard').status_code == 400
        assert client.get(f'/api/projects/{project}/website').json()['site'] == site


def full_plan():
    return {'title': 'Approved site', 'pages': [
        {'slug': 'index' if index == 0 else 'about', 'title': f'Page {index}', 'description': 'Approved copy',
         'sections': [{'heading': 'Heading', 'body': 'Supplied facts', 'image_prompt': 'A decorative forest'}]}
        for index in range(2)]}


def complete_child(work, run, index, kind='image'):
    selected = {**run, 'jobs': [run['jobs'][index]]}
    return complete(work, selected, full_plan(), kind)


def test_full_retry_reuses_plan_and_completed_artwork_without_loading_writing(workflow, monkeypatch):
    work, project, site, _, _ = workflow
    run = work.generate(project, WebsiteInput(brief='Create an approved forest website', page_count=2, artwork_count=3))
    plan = complete_child(work, run, 0, 'text')
    work.tick()
    run = work.get_run(run['id'])
    retained_image = complete_child(work, run, 1)
    work.store.status(run['jobs'][2], 'failed', 'CPU fixture artwork failure')
    work.tick()  # Cancels only the unfinished third artwork job.
    assert work.store.job(run['jobs'][3])['state'] == 'cancelled'
    checked = []
    def only_image_preflight(request):
        checked.append(request['profile']['task'])
        assert request['profile']['task'] == 'image', 'Retry must not require the completed writing model.'
        return 'installed-image-fixture'
    monkeypatch.setattr(work.runtime, 'preflight', only_image_preflight)
    retried = work.retry(run['id'])
    assert retried['state'] == 'artwork'
    assert retried['request']['retry_of'] == run['id']
    assert retried['request']['reused_job_ids'] == run['jobs'][:2]
    assert retried['jobs'][:2] == run['jobs'][:2]
    assert retried['progress'] == {'completed': 2, 'total': 4}
    assert len(work.store.rows('SELECT id FROM jobs')) == 6  # Four originals, two replacements.
    assert checked == ['image']
    fresh = [complete_child(work, retried, index) for index in (2, 3)]
    restarted = Websites(work.store, work.runtime, work.worker)
    restarted.tick()
    finished = restarted.get_run(retried['id'])
    assert finished['state'] == 'completed'
    assert finished['progress'] == {'completed': 4, 'total': 4}
    actual_ids = [identity for page in finished['result']['pages'] for section in page['sections'] for identity in section['asset_ids']]
    assert set(actual_ids) == {retained_image['id'], *(asset['id'] for asset in fresh)}
    assert len(actual_ids) == 3
    assert work.store.file(plan).is_file()
    assert work.store.file(retained_image).is_file()
    assert work.site(project) == site
    assert work.get_run(run['id'])['state'] == 'failed'


def test_full_retry_replaces_completed_but_malformed_plan(workflow):
    work, project, site, _, _ = workflow
    run = work.generate(project, WebsiteInput(brief='Create an approved forest website', page_count=2, artwork_count=0))
    original = complete(work, run, {'pages': 'invalid'})
    work.tick()
    assert work.get_run(run['id'])['state'] == 'failed'
    retried = work.retry(run['id'])
    assert retried['state'] == 'planning'
    assert retried['jobs'][0] != run['jobs'][0]
    assert retried['request']['reused_job_ids'] == []
    complete_child(work, retried, 0, 'text')
    work.tick()
    assert work.get_run(retried['id'])['state'] == 'completed'
    assert work.store.file(original).is_file()
    assert work.site(project) == site


def test_full_retry_after_completed_plan_cancellation_does_not_rewrite(workflow, monkeypatch):
    work, project, _, _, _ = workflow
    run = work.generate(project, WebsiteInput(brief='Create an approved forest website', page_count=2, artwork_count=1))
    complete_child(work, run, 0, 'text')
    work.cancel(run['id'])
    checked = []
    def image_only(request):
        checked.append(request['profile']['task'])
        assert request['profile']['task'] == 'image', 'Completed plan should be reused.'
        return 'installed-image-fixture'
    monkeypatch.setattr(work.runtime, 'preflight', image_only)
    retried = work.retry(run['id'])
    assert retried['jobs'] == run['jobs']
    assert checked == ['image']
    work.tick()
    retried = work.get_run(retried['id'])
    assert retried['state'] == 'artwork' and len(retried['jobs']) == 2
    assert len(work.store.rows('SELECT id FROM jobs')) == 2


def test_retry_waits_for_cancellation_to_finish(workflow):
    work, project, site, _, _ = workflow
    run = work.regenerate(project, body(site))
    work._state(run['id'], 'cancelled', 'CPU cancellation fixture')
    work.store.status(run['jobs'][0], 'cancelling', 'CPU cancellation fixture')
    with pytest.raises(ValueError, match='still stopping'):
        work.retry(run['id'])
    assert len(work.store.rows('SELECT id FROM jobs')) == 1


def test_full_retry_still_checks_active_run_before_atomic_enqueue(workflow):
    work, project, site, _, _ = workflow
    run = work.generate(project, WebsiteInput(brief='Create an approved forest website', page_count=2, artwork_count=1))
    work.cancel(run['id'])
    work.regenerate(project, body(site))
    with pytest.raises(ValueError, match='Finish or cancel'):
        work.retry(run['id'])
    assert len(work.store.rows('SELECT id FROM jobs')) == 2


def test_repeated_artwork_retry_preserves_each_completed_asset_exactly_once(workflow):
    work, project, _, _, _ = workflow
    run = work.generate(project, WebsiteInput(brief='Create an approved forest website', page_count=2, artwork_count=3))
    complete_child(work, run, 0, 'text')
    work.tick()
    run = work.get_run(run['id'])
    first = complete_child(work, run, 1)
    work.store.status(run['jobs'][2], 'failed', 'First image failure')
    work.tick()
    retried = work.retry(run['id'])
    second = complete_child(work, retried, 2)
    work.store.status(retried['jobs'][3], 'failed', 'Second image failure')
    work.tick()
    final = work.retry(retried['id'])
    assert final['jobs'][:3] == retried['jobs'][:3]
    assert final['progress'] == {'completed': 3, 'total': 4}
    third = complete_child(work, final, 3)
    work.tick()
    work.tick()
    finished = work.get_run(final['id'])
    assert finished['state'] == 'completed'
    ids = [identity for page in finished['result']['pages'] for section in page['sections'] for identity in section['asset_ids']]
    assert sorted(ids) == sorted([first['id'], second['id'], third['id']])
    assert len(work.store.rows('SELECT id FROM jobs')) == 7  # 4 originals + 2 retries + 1 retry.


@pytest.mark.parametrize('reason', [
    'This request and its source text exceed the selected model’s context budget. Shorten the page or notes. Nothing was truncated and no generation was started.',
    'The selected local image package is missing. Open Creation tools to install it.',
])
def test_replacement_failure_surfaces_actionable_child_error_without_changing_site(workflow, reason):
    work, project, site, _, _ = workflow
    run = work.regenerate(project, body(site))
    work.store.status(run['jobs'][0], 'failed', reason)
    work.tick()
    failed = work.get_run(run['id'])
    assert failed['state'] == 'failed'
    assert failed['message'].startswith(reason)
    assert 'saved website and original assets are unchanged' in failed['message']
    assert 'retry this output' in failed['message']
    assert work.site(project) == site


def test_full_failure_prefers_failed_child_over_cancelled_sibling_and_bounds_message(workflow):
    work, project, site, _, _ = workflow
    run = work.generate(project, WebsiteInput(brief='Create an approved forest website', page_count=2, artwork_count=2))
    complete_child(work, run, 0, 'text')
    work.tick()
    run = work.get_run(run['id'])
    work.store.status(run['jobs'][1], 'cancelled', 'A sibling was cancelled.')
    reason = 'Required model is unavailable.\n\x00' + 'x' * 1000
    work.store.status(run['jobs'][2], 'failed', reason)
    work.tick()
    message = work.get_run(run['id'])['message']
    assert message.startswith('Required model is unavailable. ')
    assert 'A sibling was cancelled.' not in message
    assert '\n' not in message and '\x00' not in message
    assert 'Retry unfinished steps' in message
    assert len(message) < 750
    assert work.site(project) == site
