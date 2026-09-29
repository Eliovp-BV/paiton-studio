"""A bounded inbox derived from saved outcomes; reading never schedules work."""
import hashlib
import re
import time

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

MAX_EVENTS = 100
EVENT_ID = r'^(job|agent|website):[a-f0-9]{32}:[a-f0-9]{16}$'


class InboxReadInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    event_ids: list[str] = Field(min_length=1, max_length=MAX_EVENTS)


class CompletionInbox:
    def __init__(self, store):
        self.store = store
        with store.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS inbox_reads(event TEXT PRIMARY KEY, read_at REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS inbox_jobs_updated ON jobs(updated DESC);
                CREATE INDEX IF NOT EXISTS inbox_websites_updated ON website_runs(updated DESC);
            ''')

    @staticmethod
    def _queries(db):
        tables = {row['name'] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        has_chat = {'chats', 'chat_turns'} <= tables
        chat_join = (' LEFT JOIN chat_turns t ON t.job=j.id LEFT JOIN chats c ON c.id=t.chat AND c.project=j.project'
                     if has_chat else '')
        chat_fields = ('c.id AS chat_id, CASE WHEN c.id IS NOT NULL THEN t.id END AS turn_id,COALESCE(c.title,a.name) AS source_name'
                       if has_chat else 'NULL AS chat_id,NULL AS turn_id,a.name AS source_name')
        # Child results belong to one aggregate outcome, even when the aggregate
        # is still running or its older metadata did not tag the child request.
        excluded = []
        if {'agents', 'agent_runs'} <= tables:
            excluded.append("NOT EXISTS (SELECT 1 FROM agent_runs ar JOIN json_each(ar.jobs) child ON child.value=j.id)")
        excluded.append("NOT EXISTS (SELECT 1 FROM website_runs wr JOIN json_each(wr.jobs) child ON child.value=j.id)")
        for table in ('model_api_requests', 'mcp_requests'):
            if table in tables:
                excluded.append(f'NOT EXISTS (SELECT 1 FROM {table} external WHERE external.job=j.id)')
        for key in ('agent_run_id', 'website_run', 'model_api', 'mcp_request_id', 'mail_draft_id', 'internal', 'service', 'hidden'):
            excluded.append(f"COALESCE(json_extract(j.request,'$.{key}'),0) IN (0,'', 'false')")
        filters = ' AND '.join(excluded)
        queries = {
            'job': f'''SELECT j.id,j.project AS project_id,p.name AS project_name,j.state,j.updated,
                json_extract(j.request,'$.task') AS task,a.id AS asset_id,{chat_fields}
                FROM jobs j JOIN projects p ON p.id=j.project
                LEFT JOIN assets a ON a.id=j.asset AND a.project=j.project {chat_join}
                WHERE j.state IN ('completed','failed','cancelled')
                AND json_extract(j.request,'$.task') IN ('image','video','write','meeting') AND {filters}''',
            'website': '''SELECT wr.id,wr.project AS project_id,p.name AS project_name,wr.state,wr.updated,
                json_extract(wr.result,'$.title') AS source_name
                FROM website_runs wr JOIN projects p ON p.id=wr.project
                WHERE wr.state IN ('completed','failed','cancelled','applied','discarded','needs_attention')''',
        }
        if {'agents', 'agent_runs'} <= tables:
            queries['agent'] = '''SELECT ar.id,a.project AS project_id,p.name AS project_name,
                ar.state,ar.updated,ar.agent AS agent_id,
                COALESCE(json_extract(ar.snapshot,'$.definition.name'),json_extract(a.definition,'$.name')) AS source_name
                FROM agent_runs ar JOIN agents a ON a.id=ar.agent JOIN projects p ON p.id=a.project
                WHERE ar.state IN ('completed','failed','cancelled','needs_attention')'''
        return queries

    @staticmethod
    def _event(kind, row):
        row = dict(row)
        state = row['state']
        revision = hashlib.sha256(f'{state}:{row["updated"]}'.encode()).hexdigest()[:16]
        identity = f'{kind}:{row["id"]}:{revision}'
        project = row['project_id']
        target = {'kind': kind, 'project_id': project}
        if kind == 'job':
            name = {'image': 'Image', 'video': 'Video', 'write': 'Writing', 'meeting': 'Recording'}[row['task']]
            if row['chat_id']:
                name = 'Reply'
                target.update(kind='chat', chat_id=row['chat_id'], turn_id=row['turn_id'])
            elif state == 'completed' and row['asset_id']:
                target.update(kind='asset', asset_id=row['asset_id'])
            else:
                target['job_id'] = row['id']
        elif kind == 'agent':
            name = 'Agent run'
            target.update(agent_id=row['agent_id'], run_id=row['id'])
        else:
            name = 'Website draft'
            target['run_id'] = row['id']
        title = f'{name} ' + {'completed': 'ready', 'failed': 'failed', 'cancelled': 'stopped',
                              'applied': 'applied', 'discarded': 'discarded', 'needs_attention': 'needs attention'}[state]
        if kind == 'website' and state == 'completed':
            state = 'needs_attention'
            summary = 'Review and apply when ready. Your saved website is unchanged.'
        else:
            summary = {'completed': 'Your saved result is ready to review.',
                       'failed': 'Open to review the problem and available recovery options.',
                       'cancelled': 'Work stopped. Open to review any saved outputs.',
                       'applied': 'The draft was applied to your saved website.',
                       'discarded': 'The draft was discarded; generated assets are kept.',
                       'needs_attention': 'Open to review the next step.'}[state]
        # Use saved display names, never prompts, generated content, job messages,
        # logs or runtime metadata. Absolute asset names disclose only a basename.
        source_name = ''.join(char for char in str(row.get('source_name') or '') if char.isprintable()).strip()
        if source_name.startswith(('/', '\\')) or re.match(r'^[A-Za-z]:[\\/]', source_name):
            source_name = source_name.replace('\\', '/').rsplit('/', 1)[-1]
        source_name = source_name[:120]
        if source_name:
            summary = f'{source_name} · {summary}'
        project_name = ''.join(char for char in row['project_name'] if ord(char) >= 32)[:120]
        return {'id': identity, 'kind': target['kind'], 'state': state, 'title': title,
                'summary': summary, 'source_name': source_name, 'updated': row['updated'], 'project_id': project,
                'project_name': project_name, 'target': target}

    def list(self, project_id=None, limit=MAX_EVENTS):
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_EVENTS:
            raise ValueError('Show between 1 and 100 recent outcomes.')
        if project_id is not None:
            self.store.project(project_id)
        with self.store.connect() as db:
            db.execute('BEGIN')
            events = []
            for kind, query in self._queries(db).items():
                where = ' WHERE project_id=?' if project_id is not None else ''
                args = (project_id, limit + 1) if project_id is not None else (limit + 1,)
                for row in db.execute(f'SELECT * FROM ({query}){where} ORDER BY updated DESC,id DESC LIMIT ?', args):
                    events.append(self._event(kind, row))
            events.sort(key=lambda item: (item['updated'], item['id']), reverse=True)
            has_more = len(events) > limit
            events = events[:limit]
            if events:
                placeholders = ','.join('?' for _ in events)
                read = {row['event'] for row in db.execute(f'SELECT event FROM inbox_reads WHERE event IN ({placeholders})',
                                                          [event['id'] for event in events])}
            else:
                read = set()
            for event in events:
                event['read'] = event['id'] in read
        return {'events': events, 'unread': sum(not event['read'] for event in events),
                'has_more': has_more, 'limit': limit, 'project_id': project_id}

    def mark_read(self, body):
        body = InboxReadInput.model_validate(body)
        identities = list(dict.fromkeys(body.event_ids))
        if any(not re.fullmatch(EVENT_ID, identity) for identity in identities):
            raise HTTPException(422, 'Choose the exact outcomes shown in your inbox.')
        read, unavailable = [], []
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            queries = self._queries(db)
            for identity in identities:
                kind, source, _ = identity.split(':')
                query = queries.get(kind)
                row = db.execute(f'SELECT * FROM ({query}) WHERE id=?', (source,)).fetchone() if query else None
                if row is None or self._event(kind, row)['id'] != identity:
                    unavailable.append(identity)
                    continue
                db.execute('INSERT INTO inbox_reads(event,read_at) VALUES(?,?) ON CONFLICT(event) DO NOTHING',
                           (identity, time.time()))
                read.append(identity)
        return {'read_ids': read, 'unavailable_ids': unavailable}

    def router(self):
        router = APIRouter()

        @router.get('/api/inbox')
        def inbox(project_id: str | None = Query(default=None, pattern=r'^[a-f0-9]{32}$'),
                  limit: int = Query(default=MAX_EVENTS, ge=1, le=MAX_EVENTS)):
            return self.list(project_id, limit)

        @router.post('/api/inbox/read')
        def read(body: InboxReadInput):
            return self.mark_read(body)

        return router
