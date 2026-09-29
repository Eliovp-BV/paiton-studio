"""Bounded, literal search of saved project content. Never invokes inference."""
import hashlib
import os
import re
import stat

from fastapi import APIRouter, Query

from .coding import CodingWorkspace

MAX_RESULTS = 80
MAX_ITEMS = 1000
MAX_CATEGORY_ITEMS = 300
MAX_TEXT_BYTES = 8 * 1024 * 1024
MAX_ASSET_BYTES = 1024 * 1024
MAX_QUERY = 200
MAX_FIELD_MATCHES = 3


class ProjectSearch:
    def __init__(self, store):
        self.store = store
        self.coding = CodingWorkspace(store)

    def _text(self, project, asset):
        """Only regular, immutable text assets in this project's own asset directory."""
        if asset['kind'] != 'text' or not re.fullmatch(r'[a-f0-9]{32}', asset['id']):
            raise ValueError('unsupported')
        expected = rf'projects/{project}/assets/{asset["id"]}\.[a-zA-Z0-9]{{1,10}}'
        if not re.fullmatch(expected, asset['path']):
            raise ValueError('private')
        path = self.store.root / asset['path']
        self.coding._check(path, allow_missing=False)
        descriptor = self.coding.access.read(path)
        with os.fdopen(descriptor, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError('private')
            if info.st_size > MAX_ASSET_BYTES:
                raise ValueError('oversized')
            self.coding._check(path, allow_missing=False)
            raw = stream.read(MAX_ASSET_BYTES + 1)
        if len(raw) > MAX_ASSET_BYTES:
            raise ValueError('oversized')
        if asset.get('sha256') and hashlib.sha256(raw).hexdigest() != asset['sha256']:
            raise ValueError('changed')
        text = raw.decode('utf-8')
        if any(ord(char) < 32 and char not in '\n\r\t' for char in text):
            raise ValueError('unreadable')
        return text

    def search(self, project, query):
        if not re.fullmatch(r'[a-f0-9]{32}', project):
            raise ValueError('Invalid project identity.')
        if not isinstance(query, str) or not query.strip() or len(query) > MAX_QUERY or any(ord(char) < 32 for char in query):
            raise ValueError('Search for 1–200 characters on a single line.')
        self.store.project(project)
        expression = re.compile(re.escape(query), re.IGNORECASE)
        searched = dict(chat=0, agent=0, document=0, asset=0, code=0)
        skipped = dict(unreadable=0, private=0, changed=0, oversized=0, excluded_code_items=0)
        results, reasons, visited_assets = [], set(), set()
        scanned_bytes = 0
        stop = False

        def rows(db, sql, parameters=()):
            found = [dict(row) for row in db.execute(sql + ' LIMIT ?', (*parameters, MAX_CATEGORY_ITEMS + 1))]
            if len(found) > MAX_CATEGORY_ITEMS:
                reasons.add('item_limit')
            return found[:MAX_CATEGORY_ITEMS]

        def add(source, identity, title, target, fields, archived=False):
            nonlocal scanned_bytes, stop
            if stop:
                return
            if sum(searched.values()) >= MAX_ITEMS:
                reasons.add('item_limit')
                stop = True
                return
            searched[source] += 1
            for field, content in fields:
                if not isinstance(content, str) or not content:
                    continue
                size = len(content.encode('utf-8'))
                if scanned_bytes + size > MAX_TEXT_BYTES:
                    reasons.add('text_limit')
                    stop = True
                    return
                scanned_bytes += size
                for index, match in enumerate(expression.finditer(content)):
                    if len(results) >= MAX_RESULTS:
                        reasons.add('result_limit')
                        stop = True
                        return
                    if index >= MAX_FIELD_MATCHES:
                        reasons.add('field_match_limit')
                        break
                    begin, end = max(0, match.start() - 70), min(len(content), match.end() + 130)
                    prefix = '…' if begin else ''
                    snippet = prefix + content[begin:end] + ('…' if end < len(content) else '')
                    highlight = len((prefix + content[begin:match.start()]).encode('utf-16-le')) // 2
                    length = len(match.group().encode('utf-16-le')) // 2
                    location = {**target, 'query': query}
                    if source == 'code':
                        location['line'] = content.count('\n', 0, match.start()) + 1
                    results.append(dict(id=f'{source}:{identity}:{field}:{match.start()}',
                                        title=title[:180], source=source, field=field,
                                        snippet=snippet, highlights=[[highlight, highlight + length]],
                                        archived=bool(archived), target=location))

        def read_asset(db, identity):
            row = db.execute("SELECT id,kind,path,json_extract(metadata,'$.sha256') AS sha256 FROM assets WHERE project=? AND id=?", (project, identity)).fetchone()
            if row is None:
                skipped['unreadable'] += 1
                return None
            if row['kind'] != 'text':
                return None
            try:
                return self._text(project, dict(row))
            except Exception as failure:
                reason = str(failure)
                skipped[reason if reason in skipped else 'unreadable'] += 1
                return None

        with self.store.connect() as db:
            # A read transaction keeps identities, ownership and completion states coherent.
            db.execute('BEGIN')
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if {'chats', 'chat_turns'} <= tables:
                turns = rows(db, '''SELECT c.id AS chat_id,c.title,c.archived,t.id,t.prompt,j.state,j.asset
                    FROM chat_turns t JOIN chats c ON c.id=t.chat JOIN jobs j ON j.id=t.job
                    WHERE c.project=? AND j.project=c.project ORDER BY t.created DESC,t.id DESC''', (project,))
                for turn in turns:
                    if stop:
                        break
                    fields = [('title', turn['title']), ('question', turn['prompt'])]
                    if turn['state'] == 'completed' and turn['asset']:
                        answer = read_asset(db, turn['asset'])
                        if answer is not None:
                            fields.append(('reply', answer))
                            visited_assets.add(turn['asset'])
                    add('chat', turn['id'], turn['title'], dict(kind='chat', chat_id=turn['chat_id'], turn_id=turn['id']), fields, turn['archived'])
            if {'agents', 'agent_runs'} <= tables and not stop:
                runs = rows(db, '''SELECT a.id AS agent_id,json_extract(a.definition,'$.name') AS name,r.id,r.asset
                    FROM agent_runs r JOIN agents a ON a.id=r.agent
                    WHERE a.project=? AND r.state='completed' ORDER BY r.updated DESC,r.id DESC''', (project,))
                for run in runs:
                    if stop:
                        break
                    output = read_asset(db, run['asset']) if run['asset'] else None
                    if output is not None:
                        visited_assets.add(run['asset'])
                    add('agent', run['id'], run['name'] or 'Agent result', dict(kind='agent', agent_id=run['agent_id'], run_id=run['id']), [('name', run['name']), ('output', output)])
            if not stop:
                # Chat/agent text is searched through its completed owner, not again as
                # an ordinary document (which could otherwise expose an unfinished draft).
                assets = rows(db, '''SELECT a.id,a.kind,a.name,json_extract(a.metadata,'$.extracted_text') AS extracted,
                    CASE WHEN json_type(a.metadata,'$.prompt')='text' THEN json_extract(a.metadata,'$.prompt') END AS prompt,
                    CASE WHEN a.kind IN ('image','video') AND json_type(a.metadata,'$.request.prompt')='text' THEN json_extract(a.metadata,'$.request.prompt') END AS creation_prompt,
                    COALESCE(CASE WHEN json_type(a.metadata,'$.model')='text' THEN json_extract(a.metadata,'$.model') END,
                             CASE WHEN json_type(a.metadata,'$.request.profile.model')='text' THEN json_extract(a.metadata,'$.request.profile.model') END) AS model
                    FROM assets a WHERE a.project=? AND NOT EXISTS (
                        SELECT 1 FROM jobs j WHERE j.project=a.project AND j.asset=a.id AND a.kind='text'
                        AND (json_extract(j.request,'$.chat_id') IS NOT NULL OR json_extract(j.request,'$.agent_run_id') IS NOT NULL))
                    ORDER BY CASE WHEN a.kind='document' THEN 0 ELSE 1 END,a.created DESC,a.id DESC''', (project,))
                for asset in assets:
                    if stop:
                        break
                    if asset['id'] in visited_assets:
                        continue
                    source = 'document' if asset['kind'] in ('text', 'document') else 'asset'
                    fields = [('name', asset['name'])]
                    text_id = asset['extracted'] if asset['kind'] == 'document' else asset['id'] if asset['kind'] == 'text' else None
                    if text_id:
                        text = read_asset(db, text_id)
                        if text is not None:
                            fields.append(('text', text))
                            visited_assets.add(text_id)
                    else:
                        fields.extend([('prompt', asset['prompt'] or asset['creation_prompt']), ('model', asset['model'])])
                    add(source, asset['id'], asset['name'], dict(kind='asset', asset_id=asset['id']), fields)

        if not stop:
            snapshot = self.coding.snapshot(project)
            if snapshot['truncated'] or snapshot['over_limit']:
                reasons.add('code_workspace_limit')
            if snapshot['skipped']:
                skipped['excluded_code_items'] += snapshot['skipped']
            for item in snapshot['files']:
                if stop:
                    break
                try:
                    current = self.coding.read(project, item['path'])
                    if current['version'] != item['version']:
                        skipped['changed'] += 1
                        continue
                except Exception:
                    skipped['unreadable'] += 1
                    continue
                add('code', item['path'], item['path'], dict(kind='code', path=item['path'], version=item['version']), [('path', item['path']), ('content', current['content'])])
        if any(skipped.values()):
            reasons.add('excluded_or_changed')
        return dict(project_id=project, query=query, results=results, searched=searched,
                    partial=bool(reasons), partial_reasons=sorted(reasons),
                    limit_reached='result_limit' in reasons, skipped=skipped, searched_bytes=scanned_bytes,
                    limits=dict(results=MAX_RESULTS, items=MAX_ITEMS, category_items=MAX_CATEGORY_ITEMS, text_bytes=MAX_TEXT_BYTES, matches_per_field=MAX_FIELD_MATCHES))

    def router(self):
        router = APIRouter()

        @router.get('/api/projects/{project_id}/search')
        def search(project_id: str, q: str = Query(min_length=1, max_length=MAX_QUERY)):
            return self.search(project_id, q)

        return router
