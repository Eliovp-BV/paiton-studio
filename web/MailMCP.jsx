// SPDX-License-Identifier: AGPL-3.0-or-later
import React, { useEffect, useState } from "react";
import {
  Plug,
  ShieldCheck,
  ArrowRight,
  Download,
  Server,
  Mail,
  Check,
} from "lucide-react";
import { ModelChoice } from "./WorkspaceExtras";

export default function MailMCP({ project, tools, api }) {
  const [data, setData] = useState(null),
    [profile, setProfile] = useState("auto"),
    [config, setConfig] = useState(null);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [smtp, setSMTP] = useState({
    host: "",
    port: 587,
    security: "starttls",
    sender: "",
    username: "",
    password: "",
  });
  const base = `/projects/${project.id}/mcp`;
  const load = async () => {
    const d = await api(base);
    setData(d);
    return d;
  };
  useEffect(() => {
    let live = true;
    api(base)
      .then((d) => {
        if (live) {
          setData(d);
          setProfile(d.profile_id);
          if (d.smtp.settings) setSMTP({ ...d.smtp.settings, password: "" });
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [project.id, api]);
  const run = async (fn) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const changeConnection = (enabled) =>
    run(async () => {
      await api(base, { enabled, profile_id: profile });
      setConfig(null);
      setNotice(
        enabled
          ? "Connection enabled. Download the new client configuration."
          : "Connection revoked. Previous tokens no longer work. Already queued jobs remain manageable in Queue.",
      );
    });
  return (
    <section className="mcp-connections">
      <div className="section-heading">
        <div>
          <span className="eyebrow">YOUR APPS. YOUR LOCAL INTELLIGENCE.</span>
          <h1>Mail MCP server</h1>
          <p className="lead">
            Keep your mail app. Give it the power of your GPU.
          </p>
        </div>
        <span className={"mcp-state " + (data?.enabled ? "on" : "")}>
          <span className="status-dot" />
          {data?.enabled ? "MCP enabled" : "MCP disabled"}
        </span>
      </div>
      <div className="mcp-flow">
        <span>
          <Mail size={23} /> Your mail app
        </span>
        <ArrowRight size={18} />
        <span>
          <Plug size={23} /> MCP connection
        </span>
        <ArrowRight size={18} />
        <span>
          <Server size={23} /> Local Paiton model
        </span>
      </div>
      <p className="mcp-intro">
        An MCP-capable app or add-on sends selected text to Studio for a
        summary, a rewrite or a reply. Results return to your app for review.
        Studio keeps the request and result in <strong>{project.name}</strong>.
      </p>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="mcp-success" role="status">
          <Check size={17} />
          {notice}
        </p>
      )}
      <div className="mcp-layout">
        <article className="panel mcp-primary">
          <span className="eyebrow">01 · LOCAL INTELLIGENCE</span>
          <h2>Local model for Mail</h2>
          <ModelChoice
            tools={tools}
            task="chat"
            label="Connected app model"
            value={profile}
            onChange={setProfile}
            details
          />
          <p className="helper">
            MiniCPM5 offers quicker responses with lower quality on complex
            work. Loading and generation share Studio’s GPU queue. Clients
            receive progress and retrieve the result when it is ready.
          </p>
          <div className="actions">
            <button
              className="primary"
              disabled={busy || !data}
              onClick={() => changeConnection(true)}
            >
              <Plug size={16} />
              {data?.enabled
                ? "Apply model & rotate token"
                : "Enable MCP server"}
            </button>
            {data?.enabled && (
              <button disabled={busy} onClick={() => changeConnection(false)}>
                Disable connection
              </button>
            )}
          </div>
          {data?.enabled && (
            <div className="mcp-client-config">
              <h3>Connect your app</h3>
              <label>
                MCP endpoint
                <input readOnly value={`${location.origin}/mcp/`} />
              </label>
              <p className="helper">
                Streamable HTTP · use the bearer token from your client
                configuration. The address works from another computer on this
                trusted network. Your mail app needs MCP support or a compatible
                add-on; SMTP settings alone do not provide that integration.
              </p>
              <div className="actions">
                <a className="button" href={`/api${base}/config`} download>
                  <Download size={16} /> Download client configuration
                </a>
                <button
                  disabled={busy}
                  onClick={() =>
                    run(async () => setConfig(await api(base + "/config")))
                  }
                >
                  Show configuration
                </button>
              </div>
              {config && (
                <>
                  <p className="helper">
                    This contains a connection token. Share it only with your
                    intended client.
                  </p>
                  <pre>{JSON.stringify(config, null, 2)}</pre>
                  <button onClick={() => setConfig(null)}>Hide token</button>
                </>
              )}
            </div>
          )}
        </article>
        <aside className="panel mcp-capabilities">
          <span className="eyebrow">A SMALL, CLEAR TOOLSET</span>
          <h2>What connected apps can do</h2>
          <ul>
            <li>Summarize selected email text.</li>
            <li>Draft a reply or refine existing writing.</li>
            <li>Check progress and cancel their requests.</li>
            <li>Prepare an SMTP message for owner review.</li>
          </ul>
          <div className="mcp-privacy">
            <ShieldCheck size={22} />
            <p>
              Inference stays on the Studio host. No inbox is copied or
              synchronized. SMTP only contacts the provider when you explicitly
              test the connector or an owner-approved send runs.
            </p>
          </div>
          <p className="helper">
            Use this HTTP endpoint on a trusted LAN. Use a properly configured
            HTTPS connection before sending tokens or mail text over an
            untrusted network. A client’s own AI services remain under that
            client’s control.
          </p>
        </aside>
      </div>
      <article className="panel mcp-smtp">
        <div>
          <span className="eyebrow">02 · MAIL CONNECTORS</span>
          <h2>SMTP first</h2>
          <p>
            Use your provider’s SMTP settings for outgoing mail. No inbox,
            mailbox password sharing with the model, or mail-client replacement.
          </p>
        </div>
        <span className="mcp-state">
          {data?.smtp.configured ? "SMTP configured" : "Not configured"}
        </span>
        <details>
          <summary>Configure SMTP</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await api(base + "/smtp", { ...smtp, port: Number(smtp.port) });
                setSMTP((s) => ({ ...s, password: "" }));
                setNotice(
                  "SMTP settings saved on the host. No connection test or email send was performed.",
                );
              });
            }}
          >
            <div className="mcp-fields">
              <label>
                SMTP server
                <input
                  required
                  value={smtp.host}
                  placeholder="smtp.example.com"
                  onChange={(e) => setSMTP({ ...smtp, host: e.target.value })}
                />
              </label>
              <label>
                Port
                <input
                  type="number"
                  min="1"
                  max="65535"
                  required
                  value={smtp.port}
                  onChange={(e) => setSMTP({ ...smtp, port: e.target.value })}
                />
              </label>
              <label>
                Security
                <select
                  value={smtp.security}
                  onChange={(e) =>
                    setSMTP({
                      ...smtp,
                      security: e.target.value,
                      port: e.target.value === "tls" ? 465 : 587,
                    })
                  }
                >
                  <option value="starttls">STARTTLS</option>
                  <option value="tls">TLS</option>
                </select>
              </label>
              <label>
                From address
                <input
                  type="email"
                  required
                  value={smtp.sender}
                  onChange={(e) => setSMTP({ ...smtp, sender: e.target.value })}
                />
              </label>
              <label>
                Username
                <input
                  required
                  autoComplete="off"
                  value={smtp.username}
                  onChange={(e) =>
                    setSMTP({ ...smtp, username: e.target.value })
                  }
                />
              </label>
              <label>
                App password
                <input
                  type="password"
                  autoComplete="new-password"
                  required={!data?.smtp.configured}
                  value={smtp.password}
                  placeholder={
                    data?.smtp.configured
                      ? "Leave blank to keep saved password"
                      : ""
                  }
                  onChange={(e) =>
                    setSMTP({ ...smtp, password: e.target.value })
                  }
                />
              </label>
            </div>
            <p className="helper">
              Credentials are stored in an owner-only host file outside model
              mounts and project exports. This is not an encrypted vault. Only
              configure an account you intend to use in this shared Studio
              project.
            </p>
            <button
              className="primary"
              disabled={busy || !data?.smtp.credential_storage_available}
            >
              Save SMTP settings
            </button>
          </form>
        </details>
        {data?.smtp.configured && (
          <button
            disabled={busy}
            onClick={() =>
              run(async () =>
                setNotice((await api(base + "/smtp/test", {})).message),
              )
            }
          >
            Test connection · no email sent
          </button>
        )}
        {data?.smtp.configured && (
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api(base + "/smtp", undefined, "DELETE");
                setSMTP({
                  host: "",
                  port: 587,
                  security: "starttls",
                  sender: "",
                  username: "",
                  password: "",
                });
                setNotice(
                  "SMTP disconnected. Stored credentials removed and pending delivery requests cancelled.",
                );
              })
            }
          >
            Disconnect SMTP
          </button>
        )}
        <p className="notice">{data?.smtp.message}</p>
        <details>
          <summary>SMTP tool flow &amp; owner approval</summary>
          <p className="helper">
            The app calls assist_email, polls get_result, then calls
            prepare_email with the recipient, subject and reviewed body. The
            returned draft_eml can open in a mail app. No MCP tool approves or
            sends automatically.
          </p>
          <p className="helper">
            On a host with native verification, the owner can review the
            delivery with the command below. Linux direct sending is currently
            unavailable; use the returned draft in your mail app.
          </p>
          <code>python scripts/smtp_owner.py &lt;delivery-id&gt;</code>
        </details>
        <div className="mcp-future">
          <span>Microsoft 365 · planned</span>
          <span>Google · planned</span>
        </div>
      </article>
      <details className="mcp-legal">
        <summary>License &amp; source</summary>
        <p>
          Retained Gigamail components are © 2026 Adecubed, AGPL-3.0-or-later,
          with Paiton modifications. No warranty is provided; covered code may
          be modified and redistributed under the license.
        </p>
        <a href="/api/mcp/license" target="_blank" rel="noreferrer">
          Read license
        </a>
        {" · "}
        <a href="/api/mcp/source" download>
          Download this version’s source
        </a>
      </details>
    </section>
  );
}
