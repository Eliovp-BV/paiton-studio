"""Opt-in project-scoped text API over the existing durable Studio queue."""
import asyncio
import hashlib
import json
import secrets
import time
import threading
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .preferences import get_settings, resolve_profile
from .registry import compatible_profiles
from .store import uid

TERMINAL = {'completed', 'failed', 'cancelled'}
MAX_INPUT = 24000


class APISettings(BaseModel):
    model_config = ConfigDict(extra='forbid')
    enabled: bool
    rotate: bool = False
    revision: int = Field(ge=0)


class Message(BaseModel):
    model_config = ConfigDict(extra='forbid')
    role: Literal['system', 'user', 'assistant']
    content: str = Field(max_length=MAX_INPUT)


class StreamOptions(BaseModel):
    model_config = ConfigDict(extra='forbid')
    include_usage: bool = False


class CompletionInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    model: str = Field(min_length=1, max_length=100)
    messages: list[Message] = Field(min_length=1, max_length=64)
    stream: bool = False
    stream_options: StreamOptions | None = None
    max_tokens: int | None = Field(default=None, ge=1, le=2048)
    temperature: float | None = Field(default=None, ge=0, le=2, allow_inf_nan=False)
    n: Literal[1] = 1
    @model_validator(mode='after')
    def validate_messages(self):
        if self.stream_options is not None and not self.stream:
            raise ValueError('stream_options requires stream=true.')
        if sum(len(message.content) for message in self.messages) > MAX_INPUT:
            raise ValueError('Keep the full conversation below 24,000 characters. No text was truncated.')
        if not any(message.role == 'user' and message.content.strip() for message in self.messages):
            raise ValueError('Include a non-empty user message.')
        return self


def error(message, status=400, code='invalid_request_error'):
    return JSONResponse({'error': {'message': message, 'type': code, 'code': code}}, status_code=status)


class ModelAPI:
    def __init__(self, store, runtime, worker):
        self.store, self.runtime, self.worker = store, runtime, worker
        self.timeout_seconds = 900
        self.poll_seconds = .2
        self.waiters = {}
        self.waiters_lock = threading.Lock()
        with store.connect() as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS model_api_connections(
                project TEXT PRIMARY KEY REFERENCES projects(id), enabled INTEGER NOT NULL,
                token_hash TEXT NOT NULL, revision INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS model_api_requests(
                id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id), generation INTEGER NOT NULL,
                client_id TEXT NOT NULL, fingerprint TEXT NOT NULL, job TEXT NOT NULL REFERENCES jobs(id),
                created REAL NOT NULL, UNIQUE(project,generation,client_id));''')

    def settings(self, project):
        self.store.project(project)
        rows = self.store.rows('SELECT enabled,revision FROM model_api_connections WHERE project=?', (project,))
        return {'enabled': bool(rows[0]['enabled']) if rows else False,
                'revision': rows[0]['revision'] if rows else 0,
                'execution_paused': self.worker.diagnostics()['state'] == 'stopped',
                'capabilities': {'text_chat': True, 'streaming': True, 'tool_calling': False, 'vision': False, 'embeddings': False},
                'max_input_characters': MAX_INPUT}

    def configure(self, project, body):
        self.store.project(project)
        token = None
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM model_api_connections WHERE project=?', (project,)).fetchone()
            revision = row['revision'] if row else 0
            if revision != body.revision:
                raise HTTPException(409, 'This API connection changed in another window. Reload its settings.')
            if bool(row['enabled'] if row else False) == body.enabled and not body.rotate:
                return self.settings(project)
            token_hash = row['token_hash'] if row else ''
            if body.enabled and (not row or not row['enabled'] or body.rotate):
                token = 'paiton_' + secrets.token_urlsafe(32)
                token_hash = hashlib.sha256(token.encode()).hexdigest()
            if not body.enabled:
                token_hash = ''
            db.execute('INSERT INTO model_api_connections VALUES(?,?,?,?) ON CONFLICT(project) DO UPDATE SET enabled=excluded.enabled,token_hash=excluded.token_hash,revision=excluded.revision',
                       (project, int(body.enabled), token_hash, revision + 1))
        # Revocation also stops this connection's pending work, never unrelated jobs.
        if not body.enabled or token is not None:
            for row in self.store.rows("SELECT r.job FROM model_api_requests r JOIN jobs j ON j.id=r.job WHERE r.project=? AND r.generation<=? AND j.state NOT IN ('completed','failed','cancelled')", (project, revision)):
                self.worker.cancel(row['job'])
        return {**self.settings(project), **({'token': token} if token else {})}

    def authorize(self, authorization):
        if not isinstance(authorization, str) or authorization[:7].lower() != 'bearer ' or len(authorization) > 200:
            raise HTTPException(401, 'A valid Model API token is required.')
        digest = hashlib.sha256(authorization[7:].encode()).hexdigest()
        for row in self.store.rows('SELECT * FROM model_api_connections WHERE enabled=1'):
            if row['token_hash'] and secrets.compare_digest(row['token_hash'], digest):
                return row
        raise HTTPException(401, 'This Model API token is invalid or revoked.')

    def models(self):
        models = []
        for profile in compatible_profiles('chat'):
            try:
                selected = resolve_profile(self.store, self.runtime, 'chat', profile['id'])
            except (ValueError, OSError, RuntimeError):
                continue
            models.append({'id': selected['id'], 'object': 'model', 'created': 0, 'owned_by': 'paiton-studio'})
        return {'object': 'list', 'data': models}

    def submit(self, grant, body, client_id):
        fingerprint = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
        if client_id is None:
            client_id = uid()
        elif not 16 <= len(client_id) <= 100 or not all(char.isalnum() or char in '-_' for char in client_id):
            raise HTTPException(400, 'Use an Idempotency-Key of 16–100 letters, digits, hyphens or underscores.')
        with self.store.connect() as db:
            current = db.execute('SELECT * FROM model_api_connections WHERE project=?', (grant['project'],)).fetchone()
            if not current or not current['enabled'] or current['revision'] != grant['revision']:
                raise HTTPException(401, 'This connection changed. Use its current API token.')
            previous = db.execute('SELECT * FROM model_api_requests WHERE project=? AND generation=? AND client_id=?', (grant['project'], grant['revision'], client_id)).fetchone()
            if previous:
                if previous['fingerprint'] != fingerprint:
                    raise HTTPException(409, 'This Idempotency-Key was already used for a different request.')
                return self.store.job(previous['job'])
        if self.worker.diagnostics()['state'] == 'stopped':
            raise HTTPException(503, 'Local AI execution is paused. No request was queued.')
        try:
            selected = resolve_profile(self.store, self.runtime, 'chat', body.model)
        except (ValueError, OSError, RuntimeError):
            raise HTTPException(400, 'That model is not available for text chat. List installed models with GET /v1/models.') from None
        if body.max_tokens is not None and body.max_tokens > selected['max_tokens']:
            raise HTTPException(400, f'This model supports at most {selected["max_tokens"]} output tokens.')
        request = dict(task='write', profile=selected, purpose='chat', format='API conversation',
                       prompt=next(message.content for message in reversed(body.messages) if message.role == 'user'),
                       messages=[message.model_dump() for message in body.messages],
                       seed=get_settings(self.store)['generation']['seed'], reasoning_effort='low',
                       model_api=True)
        if body.max_tokens is not None:
            request['api_max_tokens'] = body.max_tokens
        if body.temperature is not None:
            request['api_temperature'] = body.temperature
        now, job, identity = time.time(), uid(), uid()
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            current = db.execute('SELECT * FROM model_api_connections WHERE project=?', (grant['project'],)).fetchone()
            if not current or not current['enabled'] or current['revision'] != grant['revision']:
                raise HTTPException(401, 'This connection changed. Use its current API token.')
            previous = db.execute('SELECT * FROM model_api_requests WHERE project=? AND generation=? AND client_id=?', (grant['project'], grant['revision'], client_id)).fetchone()
            if previous:
                if previous['fingerprint'] != fingerprint:
                    raise HTTPException(409, 'This Idempotency-Key was already used for a different request.')
                return self.store.job(previous['job'])
            pending = db.execute("SELECT COUNT(*) FROM model_api_requests r JOIN jobs j ON r.job=j.id WHERE r.project=? AND j.state NOT IN ('completed','failed','cancelled')", (grant['project'],)).fetchone()[0]
            if pending >= 2:
                raise HTTPException(429, 'This project already has two API requests pending. Wait for one to finish.')
            if hasattr(self.store, 'prepare_request'):
                try:
                    request = self.store.prepare_request(request)
                except (ValueError, OSError, RuntimeError):
                    raise HTTPException(503, 'The local runtime could not prepare this request. Review model readiness in Studio. No request was queued.') from None
            db.execute('INSERT INTO jobs(id,project,request,state,message,created,updated) VALUES(?,?,?,?,?,?,?)',
                       (job, grant['project'], json.dumps(request), 'queued', 'API request saved in the local queue.', now, now))
            db.execute('INSERT INTO model_api_requests VALUES(?,?,?,?,?,?,?)',
                       (identity, grant['project'], grant['revision'], client_id, fingerprint, job, now))
        return self.store.job(job)

    def result(self, job):
        if job['state'] == 'failed':
            raise HTTPException(500, 'Local generation failed. Review this request in Studio’s queue.')
        if job['state'] == 'cancelled':
            raise HTTPException(409, 'This request was cancelled.')
        if not job.get('asset'):
            raise HTTPException(500, 'The completed request has no text result.')
        asset = self.store.asset(job['asset'], job['project'])
        if asset['kind'] != 'text':
            raise HTTPException(500, 'The request did not produce a text result.')
        return self.store.file(asset).read_text()

    def finish_reason(self, job):
        reason = self.store.asset(job['asset'], job['project']).get('metadata', {}).get('finish_reason')
        return reason if reason in ('stop', 'length', 'content_filter') else None

    def usage(self, job):
        value = self.store.asset(job['asset'], job['project']).get('metadata', {}).get('usage')
        keys = ('prompt_tokens', 'completion_tokens', 'total_tokens')
        if isinstance(value, dict) and all(type(value.get(key)) is int and value[key] >= 0 for key in keys):
            return {key: value[key] for key in keys}
        return None

    async def wait(self, request, grant, job, stream=False, include_usage=False):
        started, heartbeat, sent = time.monotonic(), time.monotonic(), ''
        with self.waiters_lock:
            self.waiters[job['id']] = self.waiters.get(job['id'], 0) + 1
        def chunk(delta, finish=None):
            return {'id': 'chatcmpl-' + job['id'], 'object': 'chat.completion.chunk', 'created': int(job['created']),
                    'model': job['request']['profile']['id'], 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
        try:
            if stream:
                yield chunk({'role': 'assistant'})
            while True:
                if await request.is_disconnected():
                    raise asyncio.CancelledError()
                await run_in_threadpool(self.authorize, request.headers.get('authorization', ''))
                latest = await run_in_threadpool(self.store.job, job['id'])
                if latest['state'] in TERMINAL:
                    answer = await run_in_threadpool(self.result, latest)
                    finish = await run_in_threadpool(self.finish_reason, latest)
                    usage = await run_in_threadpool(self.usage, latest)
                    if stream:
                        if not answer.startswith(sent):
                            raise HTTPException(500, 'The generated text changed while streaming. Retrieve a fresh non-streaming response.')
                        if answer[len(sent):]:
                            yield chunk({'content': answer[len(sent):]})
                        yield chunk({}, finish)
                        if include_usage:
                            yield {**chunk({}), 'choices': [], 'usage': usage}
                    else:
                        yield {'id': 'chatcmpl-' + job['id'], 'object': 'chat.completion', 'created': int(job['created']),
                               'model': job['request']['profile']['id'], 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': answer}, 'finish_reason': finish}], **({'usage': usage} if usage is not None else {})}
                    return
                partial = (latest.get('progress') or {}).get('text', '')
                if stream and partial.startswith(sent) and len(partial) > len(sent):
                    yield chunk({'content': partial[len(sent):]})
                    sent = partial
                if time.monotonic() - started > self.timeout_seconds:
                    raise HTTPException(504, 'This connection timed out waiting for the model. Its work is cancelled unless another client is still waiting for the same request.')
                if stream and time.monotonic() - heartbeat > 10:
                    yield None
                    heartbeat = time.monotonic()
                await asyncio.sleep(self.poll_seconds)
        except BaseException:
            with self.waiters_lock:
                last = self.waiters.get(job['id'], 0) <= 1
            if last and self.store.job(job['id'])['state'] not in TERMINAL:
                await run_in_threadpool(self.worker.cancel, job['id'])
            raise
        finally:
            with self.waiters_lock:
                count = self.waiters.get(job['id'], 1) - 1
                if count: self.waiters[job['id']] = count
                else: self.waiters.pop(job['id'], None)

    def router(self):
        router = APIRouter()
        @router.get('/api/projects/{project}/model-api')
        def settings(project: str):
            return self.settings(project)
        @router.put('/api/projects/{project}/model-api')
        def configure(project: str, body: APISettings):
            return self.configure(project, body)
        @router.get('/v1/models')
        def models():
            return self.models()
        @router.post('/v1/chat/completions')
        async def complete(request: Request):
            try:
                content = bytearray()
                async for part in request.stream():
                    if len(content) + len(part) > 150000:
                        return error('Keep the request body below 150 KB.', 413)
                    content.extend(part)
                body = CompletionInput.model_validate_json(content)
                grant = await run_in_threadpool(self.authorize, request.headers.get('authorization', ''))
                job = await run_in_threadpool(self.submit, grant, body, request.headers.get('idempotency-key'))
                if body.stream:
                    async def events():
                        try:
                            async for value in self.wait(request, grant, job, True, bool(body.stream_options and body.stream_options.include_usage)):
                                yield ': waiting for local model\n\n' if value is None else 'data: ' + json.dumps(value) + '\n\n'
                        except HTTPException as failure:
                            yield 'data: ' + json.dumps({'error': {'message': failure.detail, 'type': 'api_error'}}) + '\n\n'
                        yield 'data: [DONE]\n\n'
                    return StreamingResponse(events(), media_type='text/event-stream', headers={'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'})
                async for value in self.wait(request, grant, job):
                    return JSONResponse(value)
            except ValidationError:
                return error('Use text messages with system/user/assistant roles, a model ID, and supported options: stream, max_tokens, temperature, n=1. Tools, images, embeddings and other options are not supported.')
            except HTTPException as failure:
                return error(failure.detail, failure.status_code, 'authentication_error' if failure.status_code == 401 else 'api_error')
        return router
