import React, { useState } from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
  Download,
  Laptop,
  Monitor,
  Plug,
  X,
} from "lucide-react";
import { copyText, downloadText, ideConfiguration } from "./codeWorkspace";

export default function CodeConnections({
  workspace,
  project,
  onClose,
  onMCP,
  onModelAPI,
}) {
  const [mode, setMode] = useState(
    ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)
      ? "local"
      : "remote",
  );
  const [host, setHost] = useState(location.hostname);
  const [shell, setShell] = useState("posix");
  const [notice, setNotice] = useState("");
  let connection, error;
  try {
    connection = ideConfiguration(workspace.root, mode, host, shell);
  } catch (failure) {
    error = failure.message;
  }
  async function copy(value) {
    try {
      await copyText(value);
      setNotice("Copied.");
    } catch (failure) {
      setNotice(failure.message);
    }
  }
  return (
    <section className="code-connect panel" aria-label="Connect VS Code">
      <div className="section-heading">
        <div>
          <span className="eyebrow">ONE PROJECT · TWO WAYS TO WORK</span>
          <h2>Continue in VS Code</h2>
        </div>
        <button aria-label="Close VS Code setup" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <p>
        Edit the same saved files in Studio and your IDE. Save in one, then
        refresh in the other. Studio checks for conflicting changes before
        saving.
      </p>
      <div
        className="code-connect-modes"
        role="group"
        aria-label="Where VS Code runs"
      >
        <button
          aria-pressed={mode === "remote"}
          onClick={() => setMode("remote")}
        >
          <Laptop size={21} />
          <strong>On another computer</strong>
          <small>Connect to this Studio host over SSH</small>
        </button>
        <button
          aria-pressed={mode === "local"}
          onClick={() => setMode("local")}
        >
          <Monitor size={21} />
          <strong>On the Studio computer</strong>
          <small>Open the project folder directly</small>
        </button>
      </div>
      <label>
        Project folder on the Studio host
        <input readOnly value={workspace.root || ""} />
      </label>
      {mode === "remote" && (
        <>
          <label>
            SSH host alias or user@hostname
            <input
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="paiton-host"
              autoComplete="off"
            />
          </label>
          <p className="helper">
            Use the host you already connect to in VS Code’s Remote–SSH. This
            needs SSH access and the Remote–SSH extension.{" "}
            <a
              href="https://code.visualstudio.com/docs/remote/ssh"
              target="_blank"
              rel="noreferrer"
            >
              Connection guide <ArrowUpRight size={12} />
            </a>
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {connection && (
        <>
          <div className="actions">
            {connection.url && (
              <a className="button primary" href={connection.url}>
                Open in VS Code <ArrowUpRight size={15} />
              </a>
            )}
            <button
              className={mode === "remote" ? "primary" : ""}
              onClick={() =>
                downloadText(
                  "paiton.code-workspace",
                  JSON.stringify(connection.workspace, null, 2),
                  "application/json",
                )
              }
            >
              <Download size={15} /> Download VS Code workspace
            </button>
            <button onClick={() => copy(workspace.root)}>
              <Copy size={15} /> Copy folder path
            </button>
          </div>
          <p className="helper">
            {mode === "remote"
              ? "Open the downloaded workspace in VS Code to use your configured SSH connection."
              : "If the browser cannot open VS Code, open the downloaded workspace from File → Open Workspace from File."}{" "}
            Files stay on the Studio host. Unsaved browser drafts are not
            included.
          </p>
          <details>
            <summary>Connect from a terminal</summary>
            <label>
              Terminal style
              <select
                value={shell}
                onChange={(event) => setShell(event.target.value)}
              >
                <option value="posix">macOS / Linux shell</option>
                <option value="powershell">Windows PowerShell</option>
              </select>
            </label>
            <pre>{connection.command}</pre>
            <button onClick={() => copy(connection.command)}>
              <Copy size={14} /> Copy command
            </button>
            <p className="helper">
              Run this on the computer where VS Code is installed.{" "}
              <a
                href="https://code.visualstudio.com/docs/remote/troubleshooting#_connect-to-a-remote-host-from-the-terminal"
                target="_blank"
                rel="noreferrer"
              >
                VS Code command help
              </a>
            </p>
          </details>
        </>
      )}
      {onModelAPI && (
        <div className="code-mcp-handoff">
          <Plug size={23} />
          <div>
            <strong>Use Paiton as your IDE’s chat model</strong>
            <p>
              Connect VS Code or Continue to the local text model API. Setup
              does not load a model.
            </p>
          </div>
          <button onClick={onModelAPI}>
            Connect a model <ArrowUpRight size={14} />
          </button>
        </div>
      )}
      <div className="code-mcp-handoff">
        <Plug size={23} />
        <div>
          <strong>Use a Studio agent inside your IDE</strong>
          <p>
            MCP connects VS Code’s chat tools to a project agent. File editing
            and agent access are configured separately.
          </p>
        </div>
        <button onClick={onMCP}>
          Connect an agent <ArrowUpRight size={14} />
        </button>
      </div>
      {notice && (
        <p role="status" className="helper">
          <Check size={14} /> {notice}
        </p>
      )}
    </section>
  );
}
