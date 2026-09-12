from fastapi.testclient import TestClient

from studio import app as app_module


def test_only_fingerprinted_public_ui_can_be_cached(tmp_path, monkeypatch):
    public = tmp_path / 'public'
    assets = public / 'dist' / 'assets'
    assets.mkdir(parents=True)
    (public / 'dist' / 'index.html').write_text('<html>Studio</html>')
    (assets / 'index-0123AbCd.js').write_text('/* bundled application */')
    (assets / 'theme.css').write_text('/* unhashed */')
    monkeypatch.setattr(app_module, 'ROOT', public)
    application = app_module.create_app(tmp_path / 'data', config={}, worker_enabled=False)
    with TestClient(application) as client:
        session = client.get('/api/session')
        client.headers['X-Studio-Token'] = session.json()['token']
        bundled = client.get('/assets/index-0123AbCd.js')
        assert bundled.status_code == 200
        assert bundled.headers['cache-control'] == 'public, max-age=31536000, immutable'
        conditional = client.get('/assets/index-0123AbCd.js', headers={'If-None-Match': bundled.headers['etag']})
        assert conditional.status_code == 304
        assert 'immutable' in conditional.headers['cache-control']
        for path in ('/', '/assets/theme.css', '/assets/missing-0123AbCd.js', '/api/session', '/api/projects'):
            assert client.get(path).headers['cache-control'] == 'no-store'
        project = client.post('/api/projects', json={}).json()
        document = client.post(f'/api/projects/{project["id"]}/documents', json={'text': 'Private writing'}).json()
        assert client.get('/api/assets/' + document['id']).headers['cache-control'] == 'no-store'
        assert client.post(f'/api/projects/{project["id"]}/export', json={}).headers['cache-control'] == 'no-store'
