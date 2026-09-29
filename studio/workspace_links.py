"""Read-only destinations for project search, inbox and reviewed result handoffs."""
import hashlib
import json
import os
import re
import stat

from fastapi import APIRouter, HTTPException
from .coding import CodeFileInput, CodingWorkspace, code_path, _content_bytes


class WorkspaceLinks:
    def __init__(self, store, agents, websites):
        self.store, self.agents, self.websites = store, agents, websites
        self.coding = CodingWorkspace(store)

    def _text(self, project, source):
        if source['kind'] != 'text':
            raise ValueError('Choose a saved text result or a document with extracted text.')
        if source['project'] != project or not re.fullmatch(r'[a-f0-9]{32}', source['id']):
            raise ValueError('This text result is outside the project.')
        expected = rf'projects/{re.escape(project)}/assets/{source["id"]}\.[a-zA-Z0-9]{{1,10}}'
        if not re.fullmatch(expected, source['path']):
            raise ValueError('This text result is outside the project asset folder.')
        path = self.store.root / source['path']
        try:
            self.coding._check(path, allow_missing=False)
            descriptor = self.coding.access.read(path)
            with os.fdopen(descriptor, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ValueError('Linked or special files cannot be opened as saved text.')
                if info.st_size > 800000:
                    raise ValueError('This result is too large to open here. Download the original file.')
                self.coding._check(path, allow_missing=False)
                content = stream.read(800001)
        except FileNotFoundError:
            raise HTTPException(404, 'The saved text file is no longer available.') from None
        except OSError:
            raise ValueError('This saved text could not be read. Check the file in your project.') from None
        if len(content) > 800000:
            raise ValueError('This result is too large to open here. Download the original file.')
        checksum = source['metadata'].get('sha256')
        if checksum and hashlib.sha256(content).hexdigest() != checksum:
            raise HTTPException(409, 'This saved text changed on disk. Import it again to review the current contents.')
        try:
            text = content.decode('utf-8')
        except UnicodeError:
            raise ValueError('This saved result is not valid UTF-8 text.') from None
        if len(text) > 200000:
            raise ValueError('This result is too large to open here. Download the original file.')
        if any(ord(char) < 32 and char not in '\n\r\t' or char == '\x7f' for char in text):
            raise ValueError('This saved result contains binary data instead of plain text.')
        return text

    def text(self, project, identity):
        asset = self.store.asset(identity, project)
        source = asset
        if asset['kind'] == 'document':
            source = self.store.asset(asset['metadata'].get('extracted_text'), project)
        text = self._text(project, source)
        return {'id': asset['id'], 'project_id': project, 'name': asset['name'],
                'kind': asset['kind'], 'text': text, 'text_asset_id': source['id']}

    def _jobs(self, project, identities):
        jobs = [self.store.job(identity) for identity in identities]
        if any(job['project'] != project for job in jobs):
            raise HTTPException(409, 'This saved run references a task outside its project.')
        return jobs

    def agent_run(self, project, identity):
        self.store.project(project)
        rows = self.store.rows('''SELECT r.* FROM agent_runs r JOIN agents a ON a.id=r.agent
            WHERE r.id=? AND a.project=?''', (identity, project))
        if not rows:
            raise HTTPException(404, 'Agent result not found in this project.')
        run = rows[0]
        run['jobs'] = self._jobs(project, json.loads(run['jobs']))
        snapshot = json.loads(run.pop('snapshot'))
        run['definition'] = snapshot['definition']
        run['instruction'] = snapshot['request']['prompt']
        run['project_brief'] = snapshot['request'].get('project_brief')
        draft = run['jobs'][0] if run['jobs'] else None
        run['draft_text'] = self._text(project, self.store.asset(draft['asset'], project)) if draft and draft.get('asset') else None
        run['text'] = self._text(project, self.store.asset(run['asset'], project)) if run.get('asset') else None
        return run

    def website_run(self, project, identity):
        self.store.project(project)
        rows = self.store.rows('SELECT * FROM website_runs WHERE id=? AND project=?', (identity, project))
        if not rows:
            raise HTTPException(404, 'Website result not found in this project.')
        run = rows[0]
        run['result'] = json.loads(run['result']) if run['result'] else None
        run['jobs'] = json.loads(run['jobs'])
        jobs = self._jobs(project, run['jobs'])
        total = 1 if run['request'].get('kind') in ('page-copy', 'section-artwork') else 1 + run['request']['artwork_count']
        run['progress'] = {'completed': sum(job['state'] == 'completed' for job in jobs), 'total': total}
        run['job_details'] = [{'id': job['id'], 'state': job['state'], 'message': job['message'],
                               'task': job['request'].get('task'), 'purpose': job['request'].get('purpose')} for job in jobs]
        return run

    def check_draft(self, project, body):
        path, language = code_path(body.path)
        _content_bytes(body.content)
        if body.version is not None:
            raise ValueError('Result handoffs create a new draft. Choose an unused file name.')
        try:
            self.coding.read(project, path)
        except HTTPException as error:
            if error.status_code != 404:
                raise
        else:
            raise HTTPException(409, 'A saved file already uses this name. Choose another name; no file was changed.')
        return {'path': path, 'language': language, 'version': None}

    def router(self):
        router = APIRouter()

        @router.get('/api/projects/{project}/assets/{identity}/text')
        def text(project: str, identity: str):
            return self.text(project, identity)

        @router.post('/api/projects/{project}/code/check-draft')
        def check_draft(project: str, body: CodeFileInput):
            return self.check_draft(project, body)

        @router.get('/api/projects/{project}/agent-runs/{identity}')
        def agent_run(project: str, identity: str):
            return self.agent_run(project, identity)

        @router.get('/api/projects/{project}/website-runs/{identity}')
        def website_run(project: str, identity: str):
            return self.website_run(project, identity)

        @router.get('/api/projects/{project}/jobs/{identity}')
        def job(project: str, identity: str):
            self.store.project(project)
            job = self.store.job(identity)
            if job['project'] != project:
                raise HTTPException(404, 'Task not found in this project.')
            return job

        return router
