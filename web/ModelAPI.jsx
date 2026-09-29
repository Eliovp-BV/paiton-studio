import React, { useEffect, useRef, useState } from "react";
import {
  Plug,
  Copy,
  Download,
  KeyRound,
  ShieldCheck,
  Settings2,
  ArrowUpRight,
} from "lucide-react";
import { taskProfiles } from "./modelSelection";
import { copyText, downloadText } from "./codeWorkspace";
import { modelApiConfig } from "./modelApiConfig";
import "./model-api.css";

export default function ModelAPI({ project, api, tools, onModels, worker }) {
  const [connection, setConnection] = useState(null),
    [token, setToken] = useState(""),
    [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [model, setModel] = useState(""),
    [client, setClient] = useState("vscode"),
    [testToken, setTestToken] = useState("");
  const alive = useRef(true),
    operation = useRef(false),
    revision = useRef(0);
  const models = taskProfiles(tools, "chat").filter(
    (item) =>
      item.state === "ready" && item.compatibility?.compatible !== false,
  );
  const selected =
    models.find((item) => item.id === model) || (!model ? models[0] : null);
  const base = `${location.origin}/v1`;
  const paused = worker?.state === "stopped" || connection?.execution_paused;
  let config = "";
  if (selected) config = modelApiConfig(location.origin, selected, client);
  async function refresh() {
    if (operation.current) return;
    operation.current = true;
    const attempt = ++revision.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await api(`/projects/${project.id}/model-api`);
      if (alive.current && revision.current === attempt) {
        setConnection(value);
        setToken("");
        setTestToken("");
        setShowToken(false);
      }
    } catch (failure) {
      if (alive.current && revision.current === attempt)
        setError(failure.message);
    } finally {
      operation.current = false;
      if (alive.current && revision.current === attempt) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    refresh();
    return () => {
      alive.current = false;
      revision.current++;
    };
  }, [project.id]);
  async function configure(enabled, rotate = false) {
    if (operation.current || !connection) return;
    operation.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    revision.current++;
    setToken("");
    setTestToken("");
    setShowToken(false);
    try {
      const value = await api(
        `/projects/${project.id}/model-api`,
        { enabled, rotate, revision: connection.revision },
        "PUT",
      );
      if (!alive.current) return;
      setConnection(value);
      setToken(value.token || "");
      setNotice(
        enabled
          ? "Connection enabled. Store the new token in your client. No model was loaded."
          : "Connection disabled. Its token is revoked and pending API requests are cancelled.",
      );
    } catch (failure) {
      if (alive.current) setError(failure.message);
    } finally {
      operation.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function copy(value) {
    try {
      await copyText(value);
      if (alive.current) setNotice("Copied.");
    } catch (failure) {
      if (alive.current) setError(failure.message);
    }
  }
  async function checkConnection(event) {
    event.preventDefault();
    const key = token || testToken.trim();
    if (operation.current || !connection?.enabled || !key) return;
    operation.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const attempt = revision.current;
    try {
      const response = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        cache: "no-store",
      });
      const value = await response.json();
      if (!response.ok)
        throw Error(value.error?.message || "The API connection check failed.");
      if (alive.current && revision.current === attempt)
        setNotice(
          `Connection verified from this browser. ${value.data.length} installed text ${value.data.length === 1 ? "model" : "models"} available. No generation was requested.`,
        );
    } catch (failure) {
      if (alive.current && revision.current === attempt)
        setError(failure.message);
    } finally {
      operation.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="model-api-studio" aria-label="Model API">
      <header className="coding-heading">
        <div>
          <span className="eyebrow">YOUR LOCAL MODELS, IN YOUR TOOLS</span>
          <h1>Model API</h1>
          <p>
            Use Paiton’s text models from VS Code, Continue, or your own app.
          </p>
        </div>
        <button onClick={onModels}>
          <Settings2 size={16} /> Model settings
        </button>
      </header>
      {error && (
        <div className="notice" role="alert">
          <p>{error}</p>
          <button disabled={busy} onClick={refresh}>
            Reload connection
          </button>
        </div>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {!connection ? (
        <p role="status">Loading connection settings…</p>
      ) : (
        <>
          <div className="model-api-status panel">
            <Plug size={27} />
            <div>
              <strong>
                {connection.enabled
                  ? "Connection enabled"
                  : "Connection disabled"}
              </strong>
              <p>
                Requests and generated replies are saved in{" "}
                <b>{project.name}</b>. This token grants text generation for
                this project.
              </p>
              <small>
                {paused
                  ? "AI execution is paused. Connection checks and setup are available; new inference requests are rejected."
                  : "Requests use Studio’s local model queue. Other creation work may finish first."}
              </small>
            </div>
            <button
              className={connection.enabled ? "" : "primary"}
              disabled={busy}
              onClick={() => configure(!connection.enabled)}
            >
              {connection.enabled ? "Disable connection" : "Enable connection"}
            </button>
          </div>
          <div className="model-api-columns">
            <section className="panel">
              <span className="eyebrow">1 · CONNECT SECURELY</span>
              <h2>Host and token</h2>
              <label>
                API base URL
                <input readOnly value={base} />
              </label>
              <button onClick={() => copy(base)}>
                <Copy size={14} /> Copy base URL
              </button>
              <p className="helper">
                Connect from a trusted device. Studio’s operator interface is
                also available on this host; an API token does not protect that
                interface. Keep Studio on your trusted network or behind an SSH
                tunnel.
              </p>
              {token && (
                <div className="model-api-token">
                  <label>
                    New API token
                    <input
                      type={showToken ? "text" : "password"}
                      readOnly
                      value={token}
                      autoComplete="off"
                    />
                  </label>
                  <div className="actions">
                    <button onClick={() => setShowToken(!showToken)}>
                      {showToken ? "Hide token" : "Reveal token"}
                    </button>
                    <button onClick={() => copy(token)}>
                      <Copy size={14} /> Copy token
                    </button>
                  </div>
                  <p className="helper">
                    Shown only now. Studio stores its hash, so it cannot show
                    the token again after you leave.
                  </p>
                </div>
              )}
              {connection.enabled && (
                <>
                  <button disabled={busy} onClick={() => configure(true, true)}>
                    <KeyRound size={14} /> Replace token
                  </button>
                  <p className="helper">
                    Replacing the token revokes the previous one and cancels its
                    pending API requests.
                  </p>
                  <form onSubmit={checkConnection}>
                    {!token && (
                      <label>
                        Token to verify
                        <input
                          type="password"
                          value={testToken}
                          onChange={(event) => setTestToken(event.target.value)}
                          autoComplete="off"
                          placeholder="Paste your saved API token"
                        />
                      </label>
                    )}
                    <button disabled={busy || !(token || testToken.trim())}>
                      <ShieldCheck size={14} /> Check connection
                    </button>
                    <small>
                      Lists models only. Does not generate text or load a model.
                    </small>
                  </form>
                </>
              )}
            </section>
            <section className="panel">
              <span className="eyebrow">2 · CHOOSE YOUR CLIENT</span>
              <h2>Client setup</h2>
              <label>
                Installed text model
                <select
                  value={selected?.id || ""}
                  onChange={(event) => setModel(event.target.value)}
                >
                  {!selected && <option value="">Choose a model</option>}
                  {models.map((item) => (
                    <option
                      key={item.id}
                      value={item.id}
                      title={item.package.model || undefined}
                    >
                      {item.package.name || item.package.model || item.label}
                    </option>
                  ))}
                </select>
              </label>
              {!models.length && (
                <p className="helper">
                  Prepare a compatible text model in Model settings when you’re
                  ready. Enabling this connection does not install one.
                </p>
              )}
              <div
                className="model-api-clients"
                role="group"
                aria-label="API client"
              >
                <button
                  aria-pressed={client === "vscode"}
                  onClick={() => setClient("vscode")}
                >
                  VS Code
                </button>
                <button
                  aria-pressed={client === "continue"}
                  onClick={() => setClient("continue")}
                >
                  Continue
                </button>
              </div>
              <p>
                {client === "vscode"
                  ? "In VS Code, open Chat: Manage Language Models → Add Models → Custom Endpoint. Choose Chat Completions, then merge this configuration into chatLanguageModels.json and supply your token when prompted."
                  : "Merge this model into your Continue config.yaml, then save the token as PAITON_API_KEY in Continue’s local secrets. Select the model in Chat mode."}
              </p>
              {config && (
                <>
                  <pre className="model-api-config">{config}</pre>
                  <div className="actions">
                    <button onClick={() => copy(config)}>
                      <Copy size={14} /> Copy configuration
                    </button>
                    <button
                      onClick={() =>
                        downloadText(
                          client === "vscode"
                            ? "paiton-models.json"
                            : "paiton-model.yaml",
                          config,
                        )
                      }
                    >
                      <Download size={14} /> Download configuration
                    </button>
                  </div>
                </>
              )}
              <p className="helper">
                The configuration contains a token placeholder. Use text chat or
                Ask mode. This API does not provide tool calling, agent
                execution, images, embeddings, or autocomplete.
              </p>
              <a
                href={
                  client === "vscode"
                    ? "https://code.visualstudio.com/docs/agent-customization/language-models#add-a-custom-endpoint-provider"
                    : "https://docs.continue.dev/customize/model-providers/top-level/openai"
                }
                target="_blank"
                rel="noreferrer"
              >
                Client connection guide <ArrowUpRight size={13} />
              </a>
            </section>
          </div>
          <details className="panel model-api-contract">
            <summary>Supported API and limits</summary>
            <p>
              <code>GET /v1/models</code> lists installed compatible text
              models. <code>POST /v1/chat/completions</code> accepts text
              messages and returns a completion or streamed chunks.
            </p>
            <p>
              Supply <code>Authorization: Bearer YOUR_TOKEN</code>. Supported
              options: <code>model</code>, <code>messages</code>,{" "}
              <code>stream</code>, <code>stream_options.include_usage</code>,{" "}
              <code>max_tokens</code>, <code>temperature</code>, and{" "}
              <code>n: 1</code>. Unsupported options are rejected explicitly.
            </p>
            <p>
              Up to 64 messages and 24,000 characters per request, within the
              selected model’s context window. Two pending API requests per
              project. The output cap follows the model’s qualified profile. A
              15-minute timeout cancels that request. Clients can use an{" "}
              <code>Idempotency-Key</code> to retry the same request without
              duplicating it.
            </p>
          </details>
        </>
      )}
    </section>
  );
}
