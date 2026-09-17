import React, { useEffect, useState, useRef } from "react";
import { Bot, ArrowRight, Plus, Play, Square, FileText } from "lucide-react";
import ConversationControls from "./ConversationControls";
import { ModelChoice } from "./WorkspaceExtras";
const TERMINAL = ["completed", "failed", "cancelled"];
export default function AgentsStudio({
  project,
  assets,
  tools,
  api,
  initialIntent,
  onIntentConsumed,
  onMCPServer,
  defaultConversationOptions,
}) {
  const pending = useRef(null);
  const savedForServer = useRef(null);
  const [mcpMode, setMcpMode] = useState(false);
  const [serverCreated, setServerCreated] = useState(null);
  const [templates, setTemplates] = useState([]),
    [agents, setAgents] = useState([]),
    [chosen, setChosen] = useState(null);
  const [creating, setCreating] = useState(false),
    [draft, setDraft] = useState({
      name: "",
      purpose: "",
      template: "brief",
      profile_id: "auto",
      document_ids: [],
      conversation: defaultConversationOptions,
    });
  const [instruction, setInstruction] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true,
      timer;
    const load = async () => {
      try {
        const list = await api(`/projects/${project.id}/agents`);
        if (active) {
          setAgents(list);
          setChosen((id) => id || list[0]?.id || null);
        }
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) timer = setTimeout(load, 2500);
      }
    };
    api("/agent-templates")
      .then((t) => {
        if (active) setTemplates(t);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, project.id]);
  useEffect(() => {
    if (!initialIntent) return;
    if (initialIntent.agent) {
      setChosen(initialIntent.agent);
      setCreating(false);
    }
    if (initialIntent.mcp) {
      const starter = initialIntent.starter || {};
      setMcpMode(true);
      setCreating(true);
      savedForServer.current = null;
      setDraft({
        name: starter.name || "",
        purpose: starter.purpose || "",
        template: starter.template || "custom",
        profile_id: "auto",
        document_ids: [],
        conversation: defaultConversationOptions,
      });
    }
    onIntentConsumed?.();
  }, [initialIntent]);
  const selected = agents.find((a) => a.id === chosen),
    documents = assets.filter((a) => ["document", "text"].includes(a.kind));
  const run = selected?.runs?.[0],
    activeRun = run && !TERMINAL.includes(run.state);
  const action = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      setAgents(await api(`/projects/${project.id}/agents`));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="agents-studio">
      <span className="eyebrow">YOUR PURPOSE. YOUR LOCAL INTELLIGENCE.</span>
      <div className="section-heading">
        <div>
          <h1>{mcpMode ? "Create your MCP server" : "Your agents"}</h1>
          <p className="lead">
            {mcpMode
              ? "Define its purpose, choose its local model and decide what connected apps may use."
              : "Give an agent a purpose. Let it draft, review and save work on your machine."}
          </p>
        </div>
        <button
          onClick={() => {
            setCreating(true);
            setMcpMode(false);
            savedForServer.current = null;
          }}
        >
          <Plus size={16} /> New agent
        </button>
      </div>
      {serverCreated && (
        <div className="mcp-builder-handoff panel">
          <div>
            <strong>Your MCP server is ready to configure.</strong>
            <p>
              It is disabled until you enable access. Review the purpose and
              approved documents, then connect your app.
            </p>
          </div>
          <button
            className="primary"
            onClick={() => onMCPServer(serverCreated)}
          >
            Configure MCP server <ArrowRight size={16} />
          </button>
        </div>
      )}
      {mcpMode && (
        <p className="notice">
          Connected apps can request local text work using the documents you
          approve here. A server starts disabled and gets its own access token
          when enabled. This builds a purpose-based server, not executable code
          or unrestricted tools.
        </p>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {creating || agents.length === 0 ? (
        <form
          className="agent-builder panel"
          onSubmit={(e) => {
            e.preventDefault();
            action(async () => {
              const saved =
                savedForServer.current ||
                (await api(`/projects/${project.id}/agents`, draft));
              if (mcpMode) {
                savedForServer.current = saved;
                const server = await api(
                  `/projects/${project.id}/mcp-servers`,
                  { agent_id: saved.id },
                );
                savedForServer.current = null;
                setServerCreated(server.id);
                setMcpMode(false);
              }
              setChosen(saved.id);
              setCreating(false);
            });
          }}
        >
          <div>
            <span className="eyebrow">01 / PURPOSE</span>
            <h2>What is your purpose?</h2>
            <p className="helper">
              Start with a useful role. You can make the purpose your own.
            </p>
          </div>
          <div className="agent-templates">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                className={draft.template === t.id ? "chosen" : ""}
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    template: t.id,
                    tools_enabled: false,
                    purpose: t.purpose,
                    name: t.id === "custom" ? "" : t.name,
                  }))
                }
              >
                <Bot size={20} />
                <strong>{t.name}</strong>
                <small>{t.purpose || "Define a role for your project."}</small>
              </button>
            ))}
          </div>
          <label>
            Agent name
            <input
              required
              maxLength={100}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            Purpose
            <textarea
              required
              maxLength={1200}
              rows={3}
              placeholder="Help me turn my product notes into clear, accurate content…"
              value={draft.purpose}
              onChange={(e) => setDraft({ ...draft, purpose: e.target.value })}
            />
          </label>
          <div>
            <span className="eyebrow">02 / APPROVED CONTEXT</span>
            <p className="helper">
              Only the documents you select enter this agent's context. Relevant
              excerpts are used; it does not read your computer.
            </p>
            <div className="agent-documents">
              {documents.length ? (
                documents.map((d) => (
                  <label key={d.id}>
                    <input
                      type="checkbox"
                      checked={draft.document_ids.includes(d.id)}
                      disabled={
                        !draft.document_ids.includes(d.id) &&
                        draft.document_ids.length >= 8
                      }
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          document_ids: e.target.checked
                            ? [...draft.document_ids, d.id]
                            : draft.document_ids.filter((id) => id !== d.id),
                        })
                      }
                    />
                    <FileText size={14} />
                    {d.name}
                  </label>
                ))
              ) : (
                <p className="helper">
                  No project documents yet. You can give the agent facts in each
                  run's instructions.
                </p>
              )}
            </div>
          </div>
          <details>
            <summary>Model choice</summary>
            <ModelChoice
              tools={tools}
              task={draft.template === "code" ? "code" : "chat"}
              value={draft.profile_id}
              onChange={(profile_id) =>
                setDraft({ ...draft, profile_id, tools_enabled: false })
              }
              label="Agent model"
              details
            />
          </details>
          <details>
            <summary>Conversation memory · Qwen3.8</summary>
            <ConversationControls
              value={draft.conversation}
              disabled={
                !["auto", "qwen38-mxfp4-chat"].includes(draft.profile_id)
              }
              onChange={(conversation) => setDraft({ ...draft, conversation })}
            />
          </details>
          {draft.template === "code" && (
            <label className="conversation-option">
              <span>
                <strong>Enable project code tools</strong>
                <small>
                  Allow this agent and its connected MCP clients to read only
                  selected source documents and save new code drafts. Qwen3.8
                  MXFP4 + DFlash2 required. Nothing is executed or overwritten.
                </small>
              </span>
              <input
                type="checkbox"
                checked={draft.tools_enabled || false}
                disabled={
                  !["auto", "qwen38-mxfp4-chat"].includes(draft.profile_id)
                }
                onChange={(e) =>
                  setDraft({ ...draft, tools_enabled: e.target.checked })
                }
              />
            </label>
          )}
          <div className="agent-contract">
            <span className="eyebrow">03 / HOW IT WORKS</span>
            <h3>
              Draft <ArrowRight size={14} /> Review <ArrowRight size={14} />{" "}
              Save
            </h3>
            <p>
              Each run drafts and reviews. Optional coding tools use up to five
              tool rounds before review. Results stay in this project for you to
              review. No shell commands, external messages, background schedules
              or automatic publishing.
            </p>
            <small>
              Several agents can share a model. Studio currently runs their GPU
              steps one at a time.
            </small>
          </div>
          <div className="actions">
            <button className="primary" disabled={busy}>
              {mcpMode ? "Create MCP server" : "Create agent"}
            </button>
            {agents.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setMcpMode(false);
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      ) : (
        <div className="agent-workspace">
          <aside className="agent-list">
            {agents.map((a) => (
              <button
                key={a.id}
                className={a.id === chosen ? "chosen" : ""}
                onClick={() => {
                  pending.current = null;
                  setChosen(a.id);
                  setInstruction("");
                  setError("");
                }}
              >
                <Bot size={18} />
                <span>
                  <strong>{a.definition.name}</strong>
                  <small>{a.definition.purpose}</small>
                </span>
              </button>
            ))}
          </aside>
          <div className="agent-desk panel">
            {selected && (
              <>
                <span className="eyebrow">PROJECT AGENT · MANUAL RUNS</span>
                <h2>{selected.definition.name}</h2>
                <p>{selected.definition.purpose}</p>
                {onMCPServer && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      action(async () => {
                        const server = await api(
                          `/projects/${project.id}/mcp-servers`,
                          { agent_id: selected.id },
                        );
                        onMCPServer(server.id);
                      })
                    }
                  >
                    Configure as MCP server <ArrowRight size={15} />
                  </button>
                )}

                <small>
                  {selected.definition.document_ids.length} selected documents ·
                  Draft → review → save · two steps maximum
                </small>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    action(async () => {
                      await api(`/agents/${selected.id}/runs`, {
                        instruction,
                        client_id: (pending.current ||= Array.from(
                          crypto.getRandomValues(new Uint8Array(16)),
                          (v) => v.toString(16).padStart(2, "0"),
                        ).join("")),
                      });
                      pending.current = null;
                    });
                  }}
                >
                  <label>
                    What should this agent work on?
                    <textarea
                      rows={4}
                      required
                      maxLength={2000}
                      value={instruction}
                      onChange={(e) => {
                        pending.current = null;
                        setInstruction(e.target.value);
                      }}
                      placeholder="Describe the result you want and supply any important facts…"
                    />
                  </label>
                  <button className="primary" disabled={busy || activeRun}>
                    <Play size={15} /> Run agent
                  </button>
                </form>
                {run && (
                  <div className="agent-result" aria-live="polite">
                    <div className="section-heading">
                      <h3>
                        {run.state === "completed"
                          ? "Result ready for your review"
                          : run.state === "drafting"
                            ? "Drafting"
                            : run.state === "reviewing"
                              ? "Reviewing the draft"
                              : run.state}
                      </h3>
                      {activeRun && (
                        <button
                          disabled={busy || run.state === "cancelling"}
                          onClick={() =>
                            action(() =>
                              api(`/agent-runs/${run.id}/cancel`, {}),
                            )
                          }
                        >
                          <Square size={14} /> Stop run
                        </button>
                      )}
                    </div>
                    <p className="helper">{run.message}</p>
                    {run.jobs.map((j, i) => (
                      <div key={j.id} className="agent-step">
                        <span>
                          0{i + 1} {i === 0 ? "Draft" : "Review"}
                        </span>
                        <strong>{j.state}</strong>
                        <small>{j.message}</small>
                      </div>
                    ))}
                    {run.text && <div className="agent-output">{run.text}</div>}
                    <small>
                      AI review is not independent fact-checking. Saved outputs
                      are also in your project Library.
                    </small>
                  </div>
                )}
                {selected.runs.length > 1 && (
                  <details>
                    <summary>Earlier runs ({selected.runs.length - 1})</summary>
                    {selected.runs.slice(1).map((r) => (
                      <details key={r.id}>
                        <summary>
                          {new Date(r.created * 1000).toLocaleString()} ·{" "}
                          {r.state}
                        </summary>
                        <p>{r.message}</p>
                        {r.text && <div className="agent-output">{r.text}</div>}
                      </details>
                    ))}
                  </details>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
