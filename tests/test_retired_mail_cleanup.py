"""Removing the mail stack leaves no orphaned credentials or connection tokens behind."""
import json

from studio.app import create_app, retire_mail_data
from studio.store import Store


def seed(tmp_path):
    store = Store(tmp_path)
    project = store.create_project('Legacy mail')['id']
    credentials = tmp_path / 'smtp-private'
    credentials.mkdir(mode=0o700)
    (credentials / (project + '.json')).write_text(json.dumps({'host': 'smtp.example.org', 'username': 'studio', 'password': 'app-password'}))
    with store.connect() as db:
        db.execute('CREATE TABLE mcp_connections(project TEXT PRIMARY KEY REFERENCES projects(id),enabled INTEGER NOT NULL,token TEXT NOT NULL,profile TEXT NOT NULL,generation TEXT NOT NULL,updated REAL NOT NULL)')
        db.execute('INSERT INTO mcp_connections VALUES(?,?,?,?,?,?)', (project, 1, 'legacy-bearer-token', 'auto', 'generation-1', 0.0))
        db.execute('CREATE TABLE smtp_deliveries(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),snapshot TEXT NOT NULL,state TEXT NOT NULL)')
        db.execute('INSERT INTO smtp_deliveries VALUES(?,?,?,?)', ('delivery-1', project, json.dumps({'recipient': 'someone@example.org', 'body': 'Draft text'}), 'awaiting_owner'))
        db.executemany('INSERT INTO preferences VALUES(?,?)', [
            ('mail-mcp:' + project, json.dumps({'enabled': True, 'token': 'legacy-bearer-token'})),
            ('synthetic-preference', json.dumps({'kept': True})),
        ])
    return store, project, credentials


def tables(store):
    return {row['name'] for row in store.rows("SELECT name FROM sqlite_master WHERE type='table'")}


def test_startup_removes_orphaned_mail_credentials_tokens_and_tables(tmp_path):
    store, project, credentials = seed(tmp_path)
    create_app(tmp_path, {}, worker_enabled=False)
    assert not credentials.exists()
    assert not tables(store) & {'mcp_connections', 'smtp_deliveries'}
    remaining = {row['key']: json.loads(row['value']) for row in store.rows('SELECT key,value FROM preferences')}
    assert remaining['synthetic-preference'] == {'kept': True}
    assert not [key for key in remaining if key.startswith('mail-mcp:')]
    assert store.project(project)['name'] == 'Legacy mail'
    # A later start finds nothing left to remove and does not fail.
    retire_mail_data(store)
    assert remaining.keys() == {row['key'] for row in store.rows('SELECT key FROM preferences')}


def test_cleanup_ignores_a_linked_credential_folder(tmp_path):
    store = Store(tmp_path)
    outside = tmp_path.parent / (tmp_path.name + '-outside')
    outside.mkdir()
    (outside / 'keep.json').write_text('{}')
    (tmp_path / 'smtp-private').symlink_to(outside, target_is_directory=True)
    retire_mail_data(store)
    assert (outside / 'keep.json').exists()


MAIL_TABLES = ('mail_accounts', 'mail_messages', 'mail_drafts', 'mail_outbox', 'mail_sync', 'mail_audit')


def seed_mail_client(tmp_path):
    """The older built-in mail client kept IMAP/SMTP passwords in an owner-only file."""
    store = Store(tmp_path)
    private = tmp_path / 'mail-private'
    private.mkdir(mode=0o700)
    accounts = private / 'accounts.json'
    accounts.write_text(json.dumps([{'imap_host': 'imap.example.org', 'username': 'studio', 'password': 'imap-secret', 'smtp_password': 'smtp-secret'}]))
    accounts.chmod(0o600)
    with store.connect() as db:
        for table in MAIL_TABLES:
            db.execute(f'CREATE TABLE {table}(id TEXT PRIMARY KEY,body TEXT NOT NULL)')
            db.execute(f'INSERT INTO {table} VALUES(?,?)', (table + '-1', 'Only copy of a draft'))
    return store, private, accounts


def mail_rows(store):
    return {table: [row['body'] for row in store.rows(f'SELECT body FROM {table}')] for table in MAIL_TABLES}


def test_startup_removes_the_mail_client_credentials_but_keeps_mail_tables(tmp_path):
    store, private, accounts = seed_mail_client(tmp_path)
    create_app(tmp_path, {}, worker_enabled=False)
    assert not accounts.exists()
    assert not private.exists(), 'an emptied mail-private folder is removed'
    assert set(MAIL_TABLES) <= tables(store)
    assert mail_rows(store) == {table: ['Only copy of a draft'] for table in MAIL_TABLES}
    # A later start finds nothing left to remove and does not fail.
    retire_mail_data(store)
    assert not private.exists()
    assert mail_rows(store) == {table: ['Only copy of a draft'] for table in MAIL_TABLES}


def test_cleanup_keeps_a_mail_private_folder_that_still_holds_other_files(tmp_path):
    store, private, accounts = seed_mail_client(tmp_path)
    (private / 'notes.txt').write_text('keep')
    retire_mail_data(store)
    assert not accounts.exists()
    assert (private / 'notes.txt').read_text() == 'keep'


def test_cleanup_ignores_a_linked_mail_private_folder(tmp_path):
    store = Store(tmp_path)
    outside = tmp_path.parent / (tmp_path.name + '-mail-outside')
    outside.mkdir()
    (outside / 'accounts.json').write_text('{}')
    (tmp_path / 'mail-private').symlink_to(outside, target_is_directory=True)
    retire_mail_data(store)
    assert (outside / 'accounts.json').exists()
    assert (tmp_path / 'mail-private').is_symlink()


def test_cleanup_ignores_a_linked_accounts_file(tmp_path):
    store = Store(tmp_path)
    outside = tmp_path.parent / (tmp_path.name + '-accounts-outside')
    outside.mkdir()
    target = outside / 'accounts.json'
    target.write_text('{}')
    private = tmp_path / 'mail-private'
    private.mkdir()
    (private / 'accounts.json').symlink_to(target)
    retire_mail_data(store)
    assert target.exists()
    assert (private / 'accounts.json').is_symlink()
    assert private.is_dir()
