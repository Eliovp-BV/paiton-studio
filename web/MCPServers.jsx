import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Plus,
  FileText,
  Brain,
  PenLine,
  Cpu,
  Plug,
  ShieldCheck,
  Download,
  Bot,
  Code2,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  CircleHelp,
} from "lucide-react";
import "./mcp-connections.css";

const CLIENTS = [
  {
    id: "vscode",
    name: "VS Code",
    file: ".vscode/mcp.json",
    docs: "https://code.visualstudio.com/docs/agent-customization/mcp-servers",
  },
  {
    id: "cursor",
    name: "Cursor",
    file: ".cursor/mcp.json",
    docs: "https://cursor.com/docs/mcp",
  },
  {
    id: "generic",
    name: "Other MCP app",
    file: "your app’s MCP configuration",
    docs: "https://modelcontextprotocol.io/docs/develop/connect-remote-servers",
  },
];

async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Clipboard permissions can be denied, including on a Studio HTTP LAN URL.
  }
  const previous = document.activeElement;
  const field = document.createElement("textarea");
  field.value = value;
  field.readOnly = true;
  field.style.position = "fixed";
  field.style.left = "-9999px";
  document.body.appendChild(field);
  try {
    field.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
    previous?.focus();
  }
}

function ClientConnection({ server, api, base, disabled, issuedToken }) {
  const [client, setClient] = useState("vscode");
  const [credential, setCredential] = useState("prompt");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [manual, setManual] = useState(null);
  const active = useRef(true);
  const allowed = useRef(false);
  allowed.current = server.enabled && !disabled;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const chosen = CLIENTS.find((item) => item.id === client);
  const name = `paiton-${server.id}`;
  const inputId = `paiton_${server.id}_token`;
  const envName = `PAITON_MCP_${server.id.toUpperCase()}_TOKEN`;
  const endpoint = `${location.origin}/mcp/agents/`;
  const usePrompt = client === "vscode" && credential === "prompt";
  const reference = usePrompt
    ? "${input:" + inputId + "}"
    : client === "generic"
      ? "PASTE_SERVER_TOKEN"
      : "${env:" + envName + "}";
  const entry = {
    ...(client === "vscode" ? { type: "http" } : {}),
    url: endpoint,
    headers: { Authorization: `Bearer ${reference}` },
  };
  const configuration =
    client === "vscode"
      ? {
          servers: { [name]: entry },
          ...(usePrompt
            ? {
                inputs: [
                  {
                    id: inputId,
                    type: "promptString",
                    description: `Access token for ${server.definition.name}`,
                    password: true,
                  },
                ],
              }
            : {}),
        }
      : { mcpServers: { [name]: entry } };
  const json = JSON.stringify(configuration, null, 2);
  const blocked = !server.enabled || disabled || busy;

  async function copy(value, label, secret = false) {
    if (!allowed.current) return;
    setManual(null);
    if (secret) setToken("");
    const copied = await copyText(value);
    if (!active.current || !allowed.current) return;
    setNotice(
      copied
        ? `${label} copied.`
        : "Your browser blocked clipboard access. Select the text below and copy it manually.",
    );
    if (!copied) setManual({ value, label, secret });
  }
  async function accessToken(reveal) {
    if (!allowed.current || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setManual(null);
    try {
      if (!issuedToken)
        throw Error(
          "This token is no longer visible. Choose Rotate server token to create one for this app.",
        );
      const data = {
        mcpServers: {
          [name]: { headers: { Authorization: "Bearer " + issuedToken } },
        },
      };
      if (!active.current || !allowed.current) return;
      const authorization = data?.mcpServers?.[name]?.headers?.Authorization;
      if (
        typeof authorization !== "string" ||
        !authorization.startsWith("Bearer ") ||
        authorization.length <= 7
      )
        throw Error(
          "Studio did not return a valid server token. Enable the server and try again.",
        );
      const value = authorization.slice(7);
      if (reveal) setToken(value);
      else await copy(value, "Server token", true);
    } catch (failure) {
      if (active.current) setError(failure.message);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  function download() {
    if (!allowed.current) return;
    const url = URL.createObjectURL(
      new Blob([json + "\n"], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download =
      client === "vscode"
        ? "paiton-vscode-mcp.json"
        : client === "cursor"
          ? "paiton-cursor-mcp.json"
          : "paiton-agent-mcp.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(
      "Configuration downloaded. It contains a token placeholder, not your access token.",
    );
  }

  return (
    <section
      className="mcp-client-config mcp-connect-guide"
      aria-label="Connect an editor"
    >
      <span className="eyebrow">CONNECT YOUR EDITOR</span>
      <h3>Use this server where you work</h3>
      <div className="mcp-client-choices" role="group" aria-label="MCP client">
        {CLIENTS.map((item) => (
          <button
            key={item.id}
            aria-pressed={client === item.id}
            onClick={() => {
              setClient(item.id);
              setNotice("");
              setManual(null);
              setToken("");
            }}
          >
            {item.name}
          </button>
        ))}
      </div>
      <p className="mcp-client-status">
        <CircleHelp size={14} />
        {server.enabled
          ? "Client connection unverified"
          : "Enable this server to connect an editor"}
      </p>
      {client === "vscode" && (
        <label className="mcp-credential-choice">
          Token setup
          <select
            aria-label="Token setup"
            value={credential}
            onChange={(event) => {
              setCredential(event.target.value);
              setManual(null);
              setNotice("");
            }}
          >
            <option value="prompt">Secure prompt · VS Code Chat</option>
            <option value="environment">
              Environment variable · remote / Agent Host
            </option>
          </select>
        </label>
      )}
      <ol className="mcp-connect-steps">
        <li>
          <strong>Add the configuration</strong>
          <p>
            {client === "generic" ? (
              <>
                Add a Streamable HTTP server in your app using this endpoint and
                an Authorization header. JSON support varies by client.
              </>
            ) : (
              <>
                Merge this configuration into <code>{chosen.file}</code> in your
                project. Keep any existing servers.
              </>
            )}
          </p>
        </li>
        <li>
          <strong>
            {usePrompt
              ? "Paste your token when VS Code asks"
              : client === "generic"
                ? "Add the server token"
                : "Set the token in your editor’s environment"}
          </strong>
          <p>
            {usePrompt ? (
              <>
                Copy the token below. VS Code prompts for it when the server
                starts and stores it securely.
              </>
            ) : client === "generic" ? (
              <>
                Replace <code>PASTE_SERVER_TOKEN</code> in your private
                configuration with the copied token.
              </>
            ) : (
              <>
                Set <code>{envName}</code> in the environment where{" "}
                {chosen.name} runs, then restart its MCP connection. For
                Remote-SSH, use the remote environment.
              </>
            )}
          </p>
        </li>
        <li>
          <strong>Check the connection in {chosen.name}</strong>
          <p>
            {client === "vscode" ? (
              <>
                Run <code>MCP: List Servers</code>, select <code>{name}</code>,
                then start it and check its output. A successful tool listing
                confirms the connection.
              </>
            ) : (
              <>
                Open your app’s MCP settings and verify that the server’s tools
                are listed. Studio cannot confirm your client’s connection from
                this page.
              </>
            )}
          </p>
        </li>
      </ol>
      <label>
        MCP endpoint
        <input readOnly value={endpoint} />
      </label>
      <div className="actions mcp-config-actions">
        <button
          className="primary"
          disabled={blocked}
          onClick={() => copy(json, "Configuration")}
        >
          <Copy size={16} /> Copy configuration
        </button>
        <button disabled={blocked} onClick={download}>
          <Download size={16} /> Download JSON
        </button>
      </div>
      <details className="mcp-config-preview">
        <summary>View {chosen.name} configuration</summary>
        <pre>{json}</pre>
      </details>
      <p className="helper">
        Tokens are shown only after enabling or rotating this server. Rotation
        revokes the previous token; update connected apps.
      </p>
      <div className="mcp-token-actions">
        <div>
          <strong>Server token</strong>
          <span>
            {token
              ? "Visible until hidden or you leave this server"
              : "Hidden · copied separately from configuration"}
          </span>
        </div>
        <button disabled={blocked} onClick={() => accessToken(false)}>
          <Copy size={15} /> Copy token
        </button>
        <button
          disabled={blocked}
          onClick={() => (token ? setToken("") : accessToken(true))}
        >
          {token ? <EyeOff size={15} /> : <Eye size={15} />}
          {token ? "Hide token" : "Show token"}
        </button>
      </div>
      {token && (
        <label className="mcp-visible-token">
          Access token
          <input
            autoComplete="off"
            readOnly
            value={token}
            onFocus={(event) => event.target.select()}
          />
        </label>
      )}
      {manual && (
        <div className="mcp-manual-copy">
          <label>
            {manual.label} · manual copy
            <textarea
              aria-label={`${manual.label} · manual copy`}
              readOnly
              autoFocus
              value={manual.value}
              onFocus={(event) => event.target.select()}
              rows={manual.secret ? 2 : 8}
              spellCheck={false}
            />
          </label>
          <button onClick={() => setManual(null)}>
            {manual.secret ? "Hide token" : "Close manual copy"}
          </button>
        </div>
      )}
      {notice && (
        <p className="mcp-copy-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <p className="helper">
        Downloaded configurations use token placeholders. Rotating the server
        token means updating it in your editor.
      </p>
      {client === "vscode" && (
        <details className="mcp-remote-help">
          <summary>Using Remote-SSH or Agent Host?</summary>
          <p>
            Open the remote project first, then use its{" "}
            <code>.vscode/mcp.json</code> or{" "}
            <code>MCP: Open Remote User Configuration</code>. The endpoint must
            be reachable from that environment.
          </p>
          <p>
            Agent Host does not forward servers with interactive token prompts.
            Choose the environment-variable option above for those sessions.{" "}
            <code>localhost</code> refers to the machine running the MCP client.
          </p>
        </details>
      )}
      <a
        className="mcp-docs-link"
        href={chosen.docs}
        target="_blank"
        rel="noreferrer"
      >
        {chosen.name} setup guide <ExternalLink size={14} />
      </a>
    </section>
  );
}

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
  api,
  onCreate,
  onAgent,
  onCoding,
  initialServer,
}) {
  const [servers, setServers] = useState([]);
  const [issued, setIssued] = useState(null);
  const selectionVersion = useRef(0);
  const [selected, setSelected] = useState(initialServer || null),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    [configVersion, setConfigVersion] = useState(0);
  const base = `/projects/${project.id}/mcp-servers`;
  const load = async () => {
    setServers(await api(base));
  };
  useEffect(() => {
    let live = true;
    api(base)
      .then((list) => {
        if (live) setServers(list);
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
    selectionVersion.current++;
    setIssued(null);
    setConfigVersion((value) => value + 1);
    setError("");
  };
  const server = servers.find((s) => s.id === selected);
  return (
    <section className="mcp-connections mcp-catalog">
      {selected && (
        <button className="mcp-back" onClick={() => select(null)}>
          <ArrowLeft size={16} /> All MCP servers
        </button>
      )}
      <div className="section-heading">
        <div>
          <span className="eyebrow">LOCAL TOOLS FOR YOUR APPS</span>
          <h1>{server ? server.definition.name : "MCP Servers"}</h1>
          <p className="lead">
            Connect VS Code and other MCP apps to your project’s local tools.
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
              <Plug size={23} /> Your editor or app
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
                      const expected = selectionVersion.current;
                      const value = await api(`${base}/${server.id}`, {
                        enabled: true,
                      });
                      if (expected === selectionVersion.current)
                        setIssued({ id: server.id, token: value.token });
                      setConfigVersion((value) => value + 1);
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
                        setIssued(null);
                        setConfigVersion((value) => value + 1);
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
              <ClientConnection
                key={`${server.id}:${configVersion}:${server.enabled}`}
                server={server}
                issuedToken={issued?.id === server.id ? issued.token : null}
                api={api}
                base={base}
                disabled={busy}
              />
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
              {onCoding && (
                <button className="mcp-coding-handoff" onClick={onCoding}>
                  <Code2 size={17} /> Open coding workspace{" "}
                  <ArrowRight size={16} />
                </button>
              )}
            </aside>
          </div>
        </>
      ) : (
        <>
          <div className="mcp-local-banner">
            <Code2 size={24} />
            <div>
              <strong>Your project tools, inside VS Code.</strong>
              <p>
                Choose a server, enable access, then follow its editor setup.
                Enabling a server does not connect your editor or load a model.
              </p>
            </div>
            {onCoding && (
              <button onClick={onCoding}>
                Coding workspace <ArrowRight size={16} />
              </button>
            )}
          </div>
          <div className="section-heading mcp-catalog-heading">
            <div>
              <span className="eyebrow">IN {project.name}</span>
              <h2>Your servers</h2>
            </div>
            <small>Independent tokens · shared local compute</small>
          </div>
          <div className="mcp-server-grid">
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
            not make those apps local or private automatically.
          </p>
        </>
      )}
    </section>
  );
}
