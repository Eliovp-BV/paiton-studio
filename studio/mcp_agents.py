"""Purpose-built MCP servers backed by bounded local Studio agents."""
import hashlib
import secrets
import time
from pydantic import BaseModel, ConfigDict, Field
from .agents import RunInput, TERMINAL
from .preferences import resolve_profile
from .store import uid


class ServerInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    agent_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class ServerToggle(BaseModel):
    model_config = ConfigDict(extra='forbid')
    enabled: bool


class AgentServers:
    def __init__(self, agents):
        self.agents, self.store = agents, agents.store
        with self.store.connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS mcp_agent_servers(
                id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id),
                agent TEXT NOT NULL UNIQUE REFERENCES agents(id), enabled INTEGER NOT NULL,
                token TEXT NOT NULL, generation TEXT NOT NULL, created REAL NOT NULL)''')

    def list(self, project):
        self.store.project(project)
        rows = self.store.rows('SELECT id,agent,enabled,created FROM mcp_agent_servers WHERE project=? ORDER BY created DESC', (project,))
        return [{**r, 'enabled': bool(r['enabled']), 'definition': self.agents.agent(r['agent'])['definition']} for r in rows]

    def create(self, project, agent_id):
        if self.agents.agent(agent_id)['project'] != project:
            raise ValueError('Choose an agent from this project.')
        with self.store.connect() as db:
            db.execute('INSERT INTO mcp_agent_servers VALUES(?,?,?,?,?,?,?) ON CONFLICT(agent) DO NOTHING',
                       (uid(), project, agent_id, 0, '', uid(), time.time()))
        return next(s for s in self.list(project) if s['agent'] == agent_id)

    def get(self, project, identity):
        rows = self.store.rows('SELECT * FROM mcp_agent_servers WHERE id=? AND project=?', (identity, project))
        if not rows: raise ValueError('MCP server not found in this project.')
        return rows[0]

    def configure(self, project, identity, enabled):
        with self.agents.lock:
            row = self.get(project, identity)
            if enabled:
                definition = self.agents.agent(row['agent'])['definition']
                selected=resolve_profile(self.store, self.agents.runtime, 'code' if definition['template']=='code' else 'chat', definition['profile_id'], options=definition.get('conversation'))
                if definition.get('tools_enabled') and selected['package']!='qwen38-mxfp4':
                    raise ValueError('Project coding tools require Qwen3.8 MXFP4 + DFlash2.')
            with self.store.connect() as db:
                db.execute('UPDATE mcp_agent_servers SET enabled=?,token=?,generation=? WHERE id=?',
                           (int(enabled), secrets.token_urlsafe(32) if enabled else '', uid(), identity))
        return next(s for s in self.list(project) if s['id'] == identity)

    def configuration(self, project, identity, base):
        row = self.get(project, identity)
        if not row['enabled']: raise ValueError('Enable this MCP server first.')
        return {'mcpServers': {'paiton-'+identity: {'url': base.rstrip('/')+'/mcp/agents/',
                'headers': {'Authorization': 'Bearer '+row['token']}}}}

    def authorize(self, authorization):
        token = authorization[7:] if authorization.startswith('Bearer ') else ''
        if 20 <= len(token) <= 128:
            for row in self.store.rows('SELECT * FROM mcp_agent_servers WHERE enabled=1'):
                if secrets.compare_digest(row['token'], token): return row
        raise ValueError('This MCP server is disabled or its token has expired.')

    @staticmethod
    def _key(grant, client_id):
        # A deterministic run identity makes retries survive a controller restart.
        # The generation binds results to one grant, including after token rotation.
        RunInput(instruction='validate', client_id=client_id)
        return hashlib.sha256((grant['id']+':'+grant['generation']+':'+client_id).encode()).hexdigest()

    def info(self, auth):
        grant = self.authorize(auth)
        definition = self.agents.agent(grant['agent'])['definition']
        return dict(name=definition['name'], purpose=definition['purpose'],
                    selected_document_count=len(definition['document_ids']), local_inference=True,
                    project_code_tools=bool(definition.get('tools_enabled')),
                    workflow='Draft, review, save. Coding tools can read selected sources and save new drafts when explicitly enabled. No shell, mailbox, browsing or automatic publishing.')

    def submit(self, auth, body):
        with self.agents.lock:
            grant = self.authorize(auth)
            def guard(db):
                current = db.execute('SELECT enabled,generation FROM mcp_agent_servers WHERE id=?', (grant['id'],)).fetchone()
                if not current or not current['enabled'] or current['generation'] != grant['generation']:
                    raise ValueError('This MCP server was revoked.')
                count = db.execute("SELECT count(*) FROM agent_runs r JOIN agents a ON a.id=r.agent WHERE a.project=? AND r.state NOT IN ('completed','failed','cancelled')", (grant['project'],)).fetchone()[0]
                if count >= 3: raise ValueError('Three agents are already active in this project. Wait or cancel a run.')
            self.agents.start(grant['agent'], RunInput(instruction=body.instruction, client_id=self._key(grant, body.client_id)), guard=guard)
            return self.result(auth, body.client_id)

    def _run(self, grant, request_id):
        rows = self.store.rows('SELECT id FROM agent_runs WHERE agent=? AND client_id=?', (grant['agent'], self._key(grant, request_id)))
        if not rows: raise ValueError('Request not found for this MCP server.')
        return self.agents.get_run(rows[0]['id'])

    def result(self, auth, request_id):
        run = self._run(self.authorize(auth), request_id)
        active = run['jobs'][-1] if run['jobs'] else None
        return dict(request_id=request_id, state=run['state'], message=run['message'],
                    step_state=active['state'] if active else None, step_message=active['message'] if active else None,
                    text=run['text'][:30000] if run['text'] else None,
                    text_truncated=bool(run['text'] and len(run['text'])>30000), saved_asset=run['asset'],
                    elapsed_seconds=round((run['updated'] if run['state'] in TERMINAL else time.time())-run['created'], 1),
                    poll_after_seconds=None if run['state'] in TERMINAL else 3)

    def cancel(self, auth, request_id):
        with self.agents.lock:
            self.agents.cancel(self._run(self.authorize(auth), request_id)['id'])
            return self.result(auth, request_id)


def server_app(bridge, authorities):
    from mcp.server import MCPServer
    from mcp.server.mcpserver import Context
    from mcp.server.mcpserver.exceptions import ToolError
    from mcp.server.transport_security import TransportSecuritySettings
    from mcp.types import ToolAnnotations
    server = MCPServer('Paiton local agent server', version='0.1.0', instructions=
        'Call server_info for this server purpose. run_agent queues two local text steps; reuse client_id on retries. '
        'Poll get_result every three seconds. Models may take minutes to load. '
        'Only owner-selected project documents are used; their excerpts and generated results may be returned to this client. '
        'No shell, arbitrary files, mail sending, network browsing or generated code execution is available.')
    def invoke(ctx, fn, *args):
        try: return fn(ctx.request_context.request.headers.get('authorization', ''), *args)
        except ValueError as error: raise ToolError(str(error)) from None
        except Exception: raise ToolError('Studio could not complete this request. Check its queue and creation tools.') from None
    read = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False)
    write = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True, open_world_hint=False)
    @server.tool(annotations=read)
    def server_info(ctx: Context) -> dict:
        """Describe only the purpose and scope of the server authorized by this token."""
        return invoke(ctx, bridge.info)
    @server.tool(annotations=write)
    def run_agent(ctx: Context, instruction: str, client_id: str) -> dict:
        """Submit a request (up to 2000 characters). Unique client_id: 16–64 letters, digits or hyphens. Returns queue progress, not an immediate answer."""
        def submit(auth): return bridge.submit(auth, RunInput(instruction=instruction, client_id=client_id))
        return invoke(ctx, submit)
    @server.tool(annotations=read)
    def get_result(ctx: Context, request_id: str) -> dict:
        """Read this server's request progress and final locally generated text."""
        return invoke(ctx, bridge.result, request_id)
    @server.tool(annotations=write)
    def cancel_request(ctx: Context, request_id: str) -> dict:
        """Cancel only this server's request, preserving completed drafts."""
        return invoke(ctx, bridge.cancel, request_id)
    return server.streamable_http_app(streamable_http_path='/', stateless_http=True, json_response=True,
        max_request_body_size=128*1024,
        transport_security=TransportSecuritySettings(allowed_hosts=list(authorities), allowed_origins=[f'{s}://{h}' for h in authorities for s in ('http', 'https')]))
