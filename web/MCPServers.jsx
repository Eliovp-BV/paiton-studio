import React, { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Plus,
  Mail,
  FileText,
  Brain,
  PenLine,
  Cpu,
  Plug,
  ShieldCheck,
  Download,
  Bot,
} from "lucide-react";
import MailMCP from "./MailMCP";

const STARTERS = [
  {
    id: "documents",
    icon: FileText,
    name: "Document briefing",
    template: "brief",
    purpose:
      "Turn my selected documents into a concise, accurate brief with sources, decisions and open questions.",
    description:
      "Let your apps request summaries and answers grounded in documents you select.",
    scope: "Selected project documents",
  },
  {
    id: "knowledge",
    icon: Brain,
    name: "Project knowledge",
    template: "custom",
    purpose:
      "Answer questions using my selected project notes. Distinguish documented facts from assumptions, name the sources and say when information is missing.",
    description:
      "Give connected apps a local expert on your project notes and decisions.",
    scope: "Selected notes · no automatic memory",
  },
  {
    id: "content",
    icon: PenLine,
    name: "Writing & rewriting",
    template: "content",
    purpose:
      "Rewrite supplied text and draft useful content in my preferred voice, using only the approved facts. Do not invent claims.",
    description:
      "Refine copy, turn notes into captions and adapt writing for different audiences.",
    scope: "Supplied text + approved context",
  },
];

function ServerCard({
  icon: Icon,
  name,
  description,
  status,
  action,
  onClick,
  children,
}) {
  return (
    <article className="mcp-server-card">
      <div className="mcp-card-top">
        <span className="mcp-server-icon">
          <Icon size={25} />
        </span>
        <span className="mcp-state">{status}</span>
      </div>
      <h3>{name}</h3>
      <p>{description}</p>
      {children}
      <button onClick={onClick}>
        {action}
        <ArrowRight size={16} />
      </button>
    </article>
  );
}

export default function MCPServers({
  project,
  tools,
  api,
  onCreate,
  onAgent,
  initialServer,
}) {
  const [servers, setServers] = useState([]),
    [mail, setMail] = useState(null);
  const [selected, setSelected] = useState(initialServer || null),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    [config, setConfig] = useState(null);
  const base = `/projects/${project.id}/mcp-servers`;
  const load = async () => {
    const [list, connection] = await Promise.all([
      api(base),
      api(`/projects/${project.id}/mcp`),
    ]);
    setServers(list);
    setMail(connection);
  };
  useEffect(() => {
    let live = true;
    Promise.all([api(base), api(`/projects/${project.id}/mcp`)])
      .then(([list, connection]) => {
        if (live) {
          setServers(list);
          setMail(connection);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [base, api, selected]);
  const run = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const select = (id) => {
    setSelected(id);
    setConfig(null);
    setError("");
  };
  const server = servers.find((s) => s.id === selected);
  if (selected === "mail")
    return (
      <div className="mcp-connections">
        <button className="mcp-back" onClick={() => select(null)}>
          <ArrowLeft size={16} /> All MCP servers
        </button>
        <MailMCP project={project} tools={tools} api={api} />
      </div>
    );
  return (
    <section className="mcp-connections mcp-catalog">
      {selected && (
        <button className="mcp-back" onClick={() => select(null)}>
          <ArrowLeft size={16} /> All MCP servers
        </button>
      )}
      <div className="section-heading">
        <div>
          <span className="eyebrow">YOUR GPU. CONNECTED TO YOUR APPS.</span>
          <h1>{server ? server.definition.name : "MCP Servers"}</h1>
          <p className="lead">
            Powered by local inference. Running on your machine.
          </p>
        </div>
        {!selected && (
          <button className="primary" onClick={() => onCreate({})}>
            <Plus size={17} /> Create your own MCP server
          </button>
        )}
      </div>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {server ? (
        <>
          <div className="mcp-flow">
            <span>
              <Plug size={23} /> Your connected app
            </span>
            <ArrowRight size={18} />
            <span>
              <Bot size={23} /> {server.definition.name}
            </span>
            <ArrowRight size={18} />
            <span>
              <Cpu size={23} /> Local Paiton model
            </span>
          </div>
          <div className="mcp-layout mcp-server-detail">
            <article className="panel mcp-primary">
              <span className="eyebrow">PURPOSE & ACCESS</span>
              <h2>What this server does</h2>
              <p>{server.definition.purpose}</p>
              <p className="helper">
                {server.definition.document_ids.length} approved documents ·{" "}
                {server.definition.profile_id === "auto"
                  ? "Studio’s default chat model"
                  : server.definition.profile_id}
              </p>
              <p className="helper">
                Enabling lets a token holder request work using these documents
                and receive the results. Requests and outputs stay saved in this
                project. Share only the context intended for this app.
              </p>
              <div className="actions">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await api(`${base}/${server.id}`, { enabled: true });
                      setConfig(null);
                    })
                  }
                >
                  {server.enabled ? "Rotate server token" : "Enable MCP server"}
                </button>
                {server.enabled && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await api(`${base}/${server.id}`, { enabled: false });
                        setConfig(null);
                      })
                    }
                  >
                    Disable server
                  </button>
                )}
                <button onClick={() => onAgent(server.agent)}>
                  Open agent
                </button>
              </div>
              <p
                className={"mcp-state " + (server.enabled ? "on" : "")}
                role="status"
              >
                <span className="status-dot" />
                {server.enabled ? "Server enabled" : "Server disabled"}
              </p>
              {!server.enabled && (
                <p className="helper">
                  Disabled servers accept no requests. Revoked tokens cannot
                  read previous results; existing runs remain in Agents and
                  Queue.
                </p>
              )}
              {server.enabled && (
                <div className="mcp-client-config">
                  <h3>Connect your app</h3>
                  <label>
                    MCP endpoint
                    <input readOnly value={`${location.origin}/mcp/agents/`} />
                  </label>
                  <p className="helper">
                    Each server has its own token and purpose. Servers share
                    this HTTP endpoint and the local GPU queue. Your app needs
                    MCP support or an add-on.
                  </p>
                  <div className="actions">
                    <a
                      className="button"
                      href={`/api${base}/${server.id}/config`}
                      download
                    >
                      <Download size={16} /> Download client configuration
                    </a>
                    <button
                      disabled={busy}
                      onClick={() =>
                        run(async () =>
                          setConfig(await api(`${base}/${server.id}/config`)),
                        )
                      }
                    >
                      Show configuration
                    </button>
                  </div>
                  {config && (
                    <>
                      <p className="helper">
                        Contains a private access token. Rotating it requires
                        updating your client configuration.
                      </p>
                      <pre>{JSON.stringify(config, null, 2)}</pre>
                      <button onClick={() => setConfig(null)}>
                        Hide token
                      </button>
                    </>
                  )}
                </div>
              )}
            </article>
            <aside className="panel mcp-capabilities">
              <span className="eyebrow">BOUNDED LOCAL WORK</span>
              <h2>Draft. Review. Return.</h2>
              <ul>
                <li>Describe the server’s purpose.</li>
                <li>Queue a request with a retry-safe ID.</li>
                <li>Follow loading and generation progress.</li>
                <li>Retrieve the result or cancel the request.</li>
              </ul>
              <div className="mcp-privacy">
                <ShieldCheck size={22} />
                <p>
                  Two local text steps per request. No shell, automatic
                  publishing, email sending or arbitrary file access.
                </p>
              </div>
              <p className="helper">
                One active request per agent; up to three active agents per
                project through MCP. Model loading can take a while. Other
                Studio tools share the same queue.
              </p>
              <p className="helper">
                Use a trusted LAN, or HTTPS for untrusted networks. A connected
                app’s own AI services remain under that app’s control.
              </p>
            </aside>
          </div>
        </>
      ) : (
        <>
          <div className="mcp-local-banner">
            <Cpu size={24} />
            <div>
              <strong>Local intelligence, wherever you work.</strong>
              <p>
                Connect an MCP-capable app to a purpose-built Paiton server.
                Models load when needed and share Studio’s GPU queue.
              </p>
            </div>
            <span>Local inference</span>
          </div>
          <div className="section-heading mcp-catalog-heading">
            <div>
              <span className="eyebrow">IN {project.name}</span>
              <h2>Your servers</h2>
            </div>
            <small>Independent tokens · shared local compute</small>
          </div>
          <div className="mcp-server-grid">
            <ServerCard
              icon={Mail}
              name="Mail MCP server"
              description="Summarize email, draft replies and prepare SMTP messages for review in your existing mail app."
              status={
                mail === null
                  ? "Checking…"
                  : mail.enabled
                    ? "Enabled"
                    : "Available · disabled"
              }
              action="Configure Mail"
              onClick={() => select("mail")}
            >
              <small>SMTP · local drafting · owner review</small>
            </ServerCard>
            {servers.map((s) => (
              <ServerCard
                key={s.id}
                icon={Bot}
                name={s.definition.name}
                description={s.definition.purpose}
                status={s.enabled ? "Enabled" : "Disabled"}
                action="Manage server"
                onClick={() => select(s.id)}
              >
                <small>
                  {s.definition.document_ids.length} approved documents · local
                  agent
                </small>
              </ServerCard>
            ))}
            <button className="mcp-create-tile" onClick={() => onCreate({})}>
              <Plus size={28} />
              <strong>Create your own MCP server</strong>
              <span>Start with a purpose in the agent builder.</span>
              <ArrowRight size={18} />
            </button>
          </div>
          <div className="section-heading mcp-catalog-heading">
            <div>
              <span className="eyebrow">START WITH A PURPOSE</span>
              <h2>Make one of these your own</h2>
            </div>
          </div>
          <p className="mcp-intro">
            Templates for local text assistance, inspired by common document and
            knowledge workflows. Choose one, select its context and model, then
            enable your server. Templates are not installed third-party servers.
          </p>
          <div className="mcp-server-grid mcp-starters">
            {STARTERS.map((t) => (
              <ServerCard
                key={t.id}
                icon={t.icon}
                name={t.name}
                description={t.description}
                status="Starter template"
                action="Build this server"
                onClick={() => onCreate(t)}
              >
                <small>{t.scope}</small>
              </ServerCard>
            ))}
          </div>
          <p className="helper mcp-catalog-footnote">
            Studio performs inference locally. MCP connects your apps; it does
            not make those apps local or private automatically. Mail keeps its
            existing SMTP settings and approval requirements.
          </p>
        </>
      )}
    </section>
  );
}
