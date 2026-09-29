from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from studio.recipes import RecipeManager, RecipeInput, variables
from studio.store import Store


@pytest.fixture
def setup(tmp_path):
    store = Store(tmp_path)
    manager = RecipeManager(store)
    return store, manager


def create(manager, **changes):
    return manager.create(dict(name='Explain a topic', description='For a chosen audience', target='chat',
                               template='Explain {{topic}} to {{audience}}. Return to {{topic}} in the example.') | changes)


def update_body(recipe, **changes):
    return {key: recipe[key] for key in ('name', 'description', 'target', 'template')} | {'expected_revision': recipe['revision']} | changes


def test_crud_duplicate_and_restart_global_scope(setup):
    store, manager = setup
    first = store.create_project('First')
    store.create_project('Second')
    recipe = create(manager)
    assert recipe['variables'] == ['topic', 'audience']
    assert recipe['prompt_limit'] == 8000
    updated = manager.update(recipe['id'], update_body(recipe, name='Clear explanation'))
    assert updated['revision'] == 2
    copy = manager.duplicate(updated['id'], {'expected_revision': 2})
    assert copy['id'] != recipe['id'] and copy['revision'] == 1
    assert copy['name'] == 'Clear explanation copy'
    assert copy['template'] == recipe['template']
    reopened = RecipeManager(Store(store.root))
    assert {item['id'] for item in reopened.list()} == {recipe['id'], copy['id']}
    assert all('project' not in item for item in reopened.list())
    assert reopened.delete(copy['id'], {'expected_revision': 1}) == {'deleted': copy['id']}
    assert store.project(first['id'])
    assert store.rows('SELECT * FROM jobs') == []
    assert store.rows('SELECT * FROM assets') == []


def test_compare_and_swap_update_duplicate_delete_and_render(setup):
    _, manager = setup
    recipe = create(manager)
    current = manager.update(recipe['id'], update_body(recipe, description='Changed elsewhere'))
    operations = [lambda: manager.update(recipe['id'], update_body(recipe)),
                  lambda: manager.delete(recipe['id'], {'expected_revision': 1}),
                  lambda: manager.duplicate(recipe['id'], {'expected_revision': 1}),
                  lambda: manager.render(recipe['id'], {'expected_revision': 1, 'values': {'topic': 'a', 'audience': 'b'}})]
    for operation in operations:
        with pytest.raises(HTTPException) as error:
            operation()
        assert error.value.status_code == 409
    assert manager.get(recipe['id']) == current
    manager.delete(recipe['id'], {'expected_revision': 2})
    with pytest.raises(HTTPException) as error:
        manager.get(recipe['id'])
    assert error.value.status_code == 404


def test_concurrent_save_has_one_winner(setup):
    _, manager = setup
    recipe = create(manager)
    def save(name):
        try:
            return manager.update(recipe['id'], update_body(recipe, name=name))
        except HTTPException as error:
            return error.status_code
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(save, ['First edit', 'Second edit']))
    assert sum(isinstance(item, dict) for item in results) == 1
    assert 409 in results
    assert manager.get(recipe['id'])['revision'] == 2


def test_render_is_literal_and_never_recursive_or_executed(setup):
    store, manager = setup
    recipe = create(manager, template='Topic {{topic}}; JSON {"safe": true}; {{ topic }}; {{constructor}}')
    rendered = manager.render(recipe['id'], {'expected_revision': 1, 'values': {'topic': '{{constructor}} $(touch secret) <script>evil()</script> 😀', 'constructor': 'literal'}})
    assert rendered['prompt'].count('{{constructor}}') == 2
    assert rendered['prompt'].endswith('; literal')
    assert '<script>evil()</script>' in rendered['prompt']
    assert not (store.root / 'secret').exists()
    assert store.rows('SELECT * FROM jobs') == []


@pytest.mark.parametrize('template', ['{{bad-name}}', '{{ topic', 'topic }}', '{{a.b}}', '{{__proto__}}', '{{a{{b}}}}', '{{' + 'a'*33 + '}}', ' '.join('{{v%d}}' % index for index in range(9))])
def test_invalid_placeholders_rejected(template):
    with pytest.raises(ValidationError):
        RecipeInput(name='Test', target='chat', template=template)


def test_literals_repetition_input_errors_and_limits(setup):
    _, manager = setup
    assert variables('A {plain brace}; {{x}} and {{ x }}') == ['x']
    recipe = create(manager, target='image', template='Image of {{subject}}')
    for values in [{}, {'subject': 'bird', 'extra': 'no'}, {'subject': ''}, {'subject': 'x'*2500}, {'subject': 7}, {'subject': '\x00'}]:
        with pytest.raises((HTTPException, ValidationError)):
            manager.render(recipe['id'], {'expected_revision': 1, 'values': values})
    assert manager.render(recipe['id'], {'expected_revision': 1, 'values': {'subject': '😀'*2491}})['prompt'] == 'Image of ' + '😀'*2491
    for target in ('write', 'image', 'page'):
        with pytest.raises(ValidationError):
            create(manager, target=target, template='x'*2501)
    assert create(manager, target='coding', template='x'*1200)
    with pytest.raises(ValidationError):
        create(manager, target='coding', template='x'*1201)
    assert create(manager, target='chat', template='x'*8000)
    literal = create(manager, template='A complete literal task.')
    assert manager.render(literal['id'], {'expected_revision': 1})['prompt'] == 'A complete literal task.'
    repeated = create(manager, template='{{topic}}' * 800)
    with pytest.raises(HTTPException) as too_large:
        manager.render(repeated['id'], {'expected_revision': 1, 'values': {'topic': 'x' * 8000}})
    assert too_large.value.status_code == 422


def test_http_validation_and_no_runtime_needed(setup):
    store, manager = setup
    app = FastAPI(); app.include_router(manager.router())
    with TestClient(app) as client:
        assert client.get('/api/recipes').json() == []
        created = client.post('/api/recipes', json={'name': 'Draft', 'target': 'write', 'template': 'Write about {{topic}}'} )
        assert created.status_code == 201
        recipe = created.json()
        assert client.post(f'/api/recipes/{recipe["id"]}/render', json={'expected_revision': 1, 'values': {'topic': 'local parks'}}).json()['prompt'] == 'Write about local parks'
        assert client.patch(f'/api/recipes/{recipe["id"]}', json=update_body(recipe, template='New template')).status_code == 200
        assert client.request('DELETE', f'/api/recipes/{recipe["id"]}', json={'expected_revision': 1}).status_code == 409
        assert client.request('DELETE', f'/api/recipes/{recipe["id"]}', json={'expected_revision': 2}).status_code == 200
        assert client.get('/api/recipes/not-a-real-recipe').status_code == 404
        for bad in [{'name': ' ', 'target': 'chat', 'template': 'Task'}, {'name': 'X', 'target': 'video', 'template': 'Task'}, {'name': 'X', 'target': 'chat', 'template': 'Task', 'project': 'unexpected'}]:
            assert client.post('/api/recipes', json=bad).status_code == 422
    assert store.rows('SELECT * FROM jobs') == []
