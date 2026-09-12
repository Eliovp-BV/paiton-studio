import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import uuid


class ProjectConflict(ValueError):
    pass


def uid(): return uuid.uuid4().hex

def atomic(path, content):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uid() + '.tmp')
    with temporary.open('xb') as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def safe_path(root, relative):
    root = Path(root).resolve()
    candidate = root / relative
    if candidate.is_symlink() or not candidate.resolve().is_relative_to(root):
        raise ValueError('This file is outside the project.')
    return candidate.resolve()


class Store:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True,mode=0o700)
        with self.connect() as db:
            db.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS websites(project TEXT PRIMARY KEY REFERENCES projects(id), document TEXT NOT NULL, revision INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS website_runs(id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id), state TEXT NOT NULL, message TEXT NOT NULL, request TEXT NOT NULL, result TEXT, jobs TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS website_runs_project ON website_runs(project,created);
            CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL, updated REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, metadata TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS assets_project ON assets(project,created);
            CREATE UNIQUE INDEX IF NOT EXISTS assets_generated_job ON assets(json_extract(metadata,'$.job')) WHERE json_extract(metadata,'$.job') IS NOT NULL;
            CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id), request TEXT NOT NULL, state TEXT NOT NULL, message TEXT NOT NULL, progress TEXT, asset TEXT, container TEXT, cancel INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, updated REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS jobs_state_created ON jobs(state,created);
            CREATE TABLE IF NOT EXISTS job_events(id INTEGER PRIMARY KEY, job TEXT NOT NULL REFERENCES jobs(id), state TEXT NOT NULL, message TEXT NOT NULL, progress TEXT, created REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS job_events_job ON job_events(job,created);
            ''')
            if 'revision' not in {row['name'] for row in db.execute('PRAGMA table_info(projects)')}:
                db.execute('ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')

    def connect(self):
        db = sqlite3.connect(self.root / 'studio.sqlite', timeout=20)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        return db

    def rows(self, sql, params=()):
        with self.connect() as db: rows = [dict(r) for r in db.execute(sql, params)]
        for row in rows:
            for k in ('metadata', 'request', 'progress'):
                if row.get(k): row[k] = json.loads(row[k])
            if 'name' in row and 'state' in row: row['state'] = json.loads(row['state'])
        return rows

    def project(self, identity):
        rows = self.rows('SELECT * FROM projects WHERE id=?', (identity,))
        if not rows: raise ValueError('Project not found.')
        return rows[0]

    def create_project(self, name='Untitled project'):
        identity = uid()
        with self.connect() as db:
            db.execute('INSERT INTO projects(id,name,state,updated) VALUES(?,?,?,?)', (identity, name, '{}', time.time()))
        return self.project(identity)

    def update_project(self, identity, name, state, revision):
        with self.connect() as db:
            changed = db.execute('UPDATE projects SET name=?,state=?,updated=?,revision=revision+1 WHERE id=? AND revision=?', (name, json.dumps(state), time.time(), identity, revision))
            if not changed.rowcount:
                raise ProjectConflict('This project changed in another window. Your edits remain here; download your draft before loading the saved version.')
            result = dict(db.execute('SELECT * FROM projects WHERE id=?', (identity,)).fetchone())
        result['state'] = json.loads(result['state'])
        return result

    def assets(self, project): return self.rows('SELECT * FROM assets WHERE project=? ORDER BY created DESC', (project,))

    def asset(self, identity, project=None):
        rows = self.rows('SELECT * FROM assets WHERE id=?', (identity,))
        if not rows or (project and rows[0]['project'] != project): raise ValueError('Asset not found in this project.')
        return rows[0]

    def file(self, asset): return safe_path(self.root, asset['path'])

    def add_asset(self, project, kind, name, content, suffix, metadata, identity=None):
        self.project(project)
        identity = identity or uid()
        relative = f'projects/{project}/assets/{identity}{suffix}'
        metadata = {**metadata, 'sha256': hashlib.sha256(content).hexdigest()}
        atomic(safe_path(self.root, relative), content)
        with self.connect() as db:
            db.execute('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?)', (identity, project, kind, name, relative, json.dumps(metadata), 0, time.time()))
        return self.asset(identity)

    def enqueue(self, project, request):
        self.project(project)
        identity = uid(); now = time.time()
        with self.connect() as db:
            db.execute('INSERT INTO jobs(id,project,request,state,message,created,updated) VALUES(?,?,?,?,?,?,?)', (identity,project,json.dumps(request),'queued','Waiting for the creation tool.',now,now))
        return self.job(identity)

    def job(self, identity):
        rows = self.rows('SELECT * FROM jobs WHERE id=?', (identity,))
        if not rows: raise ValueError('Request not found.')
        return rows[0]

    def status(self, identity, state, message, progress=None, **fields):
        allowed = {'asset', 'container', 'cancel'}
        assert set(fields) <= allowed
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            current=db.execute('SELECT cancel FROM jobs WHERE id=?',(identity,)).fetchone()
            if current and current['cancel'] and state not in ('cancelling','cancelled','failed'):
                if state=='completed' and fields.get('asset'):
                    state='cancelled'
                    message='Stopped after the completed output was saved. The file is available.'
                else:
                    # Ownership must be persisted even when cancellation wins the launch race.
                    if fields.get('container'):
                        db.execute('UPDATE jobs SET container=? WHERE id=?',(fields['container'],identity))
                    return
            db.execute('UPDATE jobs SET state=?,message=?,progress=?,updated=?' + ''.join(f',{k}=?' for k in fields) + ' WHERE id=?', (state,message,json.dumps(progress) if progress else None,time.time(),*fields.values(),identity))
            db.execute('INSERT INTO job_events(job,state,message,progress,created) VALUES(?,?,?,?,?)',(identity,state,message,json.dumps(progress) if progress else None,time.time()))
