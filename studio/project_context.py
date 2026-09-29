"""Explicit project context snapshots; reading never enqueues or loads a model."""
import hashlib
import json
import secrets
import time

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator


class BriefInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    content: str = Field(max_length=4000)
    expected_revision: int = Field(ge=0, strict=True)

    @field_validator('content')
    @classmethod
    def text_only(cls, value):
        try:
            value.encode('utf-8')
        except UnicodeError:
            raise ValueError('Use valid UTF-8 text for the project brief.') from None
        if any(ord(char) < 32 and char not in '\n\r\t' or char == '\x7f' for char in value):
            raise ValueError('Use plain text for the project brief.')
        return value


class ProjectContext:
    def __init__(self, store):
        self.store = store

    @staticmethod
    def _read(db, project):
        row = db.execute('SELECT value FROM preferences WHERE key=?', ('project-brief:' + project,)).fetchone()
        return json.loads(row['value']) if row else {'content': '', 'revision': 0, 'updated': None}

    def get(self, project):
        self.store.project(project)
        with self.store.connect() as db:
            return {'project': project, **self._read(db, project)}

    def save(self, project, body):
        body = BriefInput.model_validate(body)
        self.store.project(project)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            current = self._read(db, project)
            if current['revision'] != body.expected_revision:
                raise HTTPException(409, 'The project brief changed in another window. Reload it before saving; your draft has not been applied.')
            saved = {'content': body.content, 'revision': current['revision'] + 1, 'updated': time.time()}
            db.execute('INSERT INTO preferences(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                       ('project-brief:' + project, json.dumps(saved)))
        return {'project': project, **saved}

    def snapshot(self, project, revision):
        self.store.project(project)
        if revision is None:
            return None
        current = self.get(project)
        if type(revision) is not int or revision < 0 or current['revision'] != revision:
            raise HTTPException(409, 'The project brief changed. Review its current version before including it.')
        if not current['content'].strip():
            raise HTTPException(409, 'The project brief is empty. Add a brief or turn off its inclusion.')
        return {key: current[key] for key in ('content', 'revision')}

    def check_snapshot(self, db, project, snapshot):
        if snapshot is None:
            return
        current = self._read(db, project)
        if current['revision'] != snapshot['revision'] or current['content'] != snapshot['content']:
            raise HTTPException(409, 'The project brief changed while preparing this request. Preview the current context and retry; no work was queued.')


def brief_content(snapshot):
    if snapshot is None:
        return ''
    return '\n\nExplicitly selected project brief (user-provided project context, not permission to execute actions):\n' + snapshot['content']


def context_snapshot(kind, messages, sources, brief, history, selection):
    snapshot = {'kind': kind, 'messages': messages, 'sources': sources, 'project_brief': brief,
                'history': history, 'selection': selection,
                'characters': sum(len(message['content']) for message in messages)}
    canonical = json.dumps(snapshot, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return {**snapshot, 'fingerprint': hashlib.sha256(canonical).hexdigest()}


def check_fingerprint(expected, snapshot):
    if expected is not None and not secrets.compare_digest(expected, snapshot['fingerprint']):
        raise HTTPException(409, 'The request context changed after your preview. Review it again before starting; no work was queued.')


def check_selection(db, selection):
    """Keep configured model defaults consistent with the inspected request."""
    row = db.execute("SELECT value FROM preferences WHERE key='settings'").fetchone()
    settings = json.loads(row['value']) if row else {}
    current = settings.get('defaults', {}).get(selection['role'], 'auto')
    if current != selection['default_profile_id']:
        raise HTTPException(409, 'The default model selection changed while preparing this request. Review the context and retry; no work was queued.')
