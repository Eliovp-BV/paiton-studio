import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Bot,
  Check,
  Code2,
  Copy,
  Download,
  FileText,
  Layers,
  PenLine,
  Play,
  Plus,
  Search,
  Settings2,
  Square,
  RotateCcw,
  X,
} from "lucide-react";
import { ModelChoice, taskProfiles } from "./WorkspaceExtras";
import ModelStatus, { modelReadiness } from "./ModelStatus";
import ProjectBrief from "./ProjectBrief";
import ResultActions from "./ResultActions";
import ContextInspector from "./ContextInspector";
import ConversationControls from "./ConversationControls";
import { stateLabel as sharedStateLabel } from "./jobStates";
import "./agents-studio.css";

const TERMINAL = ["completed", "failed", "cancelled"];
// Preserve unfinished setup and instructions while visiting Model settings.
// Drafts stay in memory, scoped to the project; they are never sent as runs.
const workspaceDrafts = new Map();
const roleOf = (definition) =>
  definition?.template === "code" ? "code" : "chat";
const toolsCapable = (profile_id) =>
  ["auto", "qwen38-mxfp4-chat"].includes(profile_id || "auto");
const emptyDraft = (conversation) => ({
  name: "",
  purpose: "",
  template: "custom",
  profile_id: "auto",
  document_ids: [],
  conversation,
  tools_enabled: false,
});
const definitionInput = (definition = {}, conversation) => ({
  name: definition.name || "",
  purpose: definition.purpose || "",
  template: definition.template || "custom",
  profile_id: definition.profile_id || "auto",
  document_ids: [...(definition.document_ids || [])],
  conversation: definition.conversation || conversation,
  tools_enabled: Boolean(definition.tools_enabled),
});
const descriptions = {
  code: "Turn selected requirements and source files into a code draft.",
  brief: "Find the facts, decisions and open questions in your documents.",
  content: "Turn approved facts into a headline, draft and caption.",
  plan: "Shape an idea into a creative brief and proposed media prompts.",
  "code-review": "Review supplied code for bugs, risks and useful fixes.",
  custom: "Give your agent a purpose of its own.",
};
const examples = {
  code: "Draft the module described in my selected requirements. Keep the public API stable and list open questions.",
  brief:
    "Summarise the key decisions in my selected documents. List anything that still needs an answer.",
  content:
    "Draft a short announcement using my selected documents. Include a headline and a social caption.",
  plan: "Plan a 15-second product story. Suggest three shots and the image prompts I could use.",
  "code-review":
    "Review this code or diff for concrete bugs. Explain the impact and suggest a fix:\n\n",
  custom:
    "Create a concise first draft for my project. Ask about any missing facts.",
};
const stateLabel = (state) =>
  sharedStateLabel(state, {
    completed: "Ready to review",
    failed: "Needs attention",
  });

export default function AgentsStudio({
  project,
  assets = [],
  tools = [],
  api,
  initialIntent,
  onIntentConsumed,
  onMCPServer,
  defaultConversationOptions,
  onCoding,
  onHandoff,
  onModels,
  defaultProfile = "auto",
  worker,
}) {
  const restored = useRef(workspaceDrafts.get(project.id)).current;
  const [templates, setTemplates] = useState([]);
  const [agents, setAgents] = useState([]);
  const [chosen, setChosen] = useState(restored?.chosen || null);
  const [search, setSearch] = useState("");
  const [builder, setBuilder] = useState(restored?.builder || null);
  const [draft, setDraft] = useState(
    restored?.draft || (() => emptyDraft(defaultConversationOptions)),
  );
  const [mcpMode, setMcpMode] = useState(restored?.mcpMode || false);
  const [serverCreated, setServerCreated] = useState(null);
  const [instructions, setInstructions] = useState(
    restored?.instructions || {},
  );
  const [briefRevisions, setBriefRevisions] = useState(
    restored?.briefRevisions || {},
  );
  const [briefBusy, setBriefBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [contextPreview, setContextPreview] = useState(null);
  const [runId, setRunId] = useState(null);
  const [openedRun, setOpenedRun] = useState(null);
  const [resultView, setResultView] = useState("result");
  const [error, setError] = useState("");
  const [errorHint, setErrorHint] = useState("");
  const [savedNotice, setSavedNotice] = useState("");
  const [reusedTask, setReusedTask] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const pending = useRef({});
  const sequence = useRef(0);
  const scheduleRefresh = useRef(null);
  const mounted = useRef(false);
  const selected = agents.find((agent) => agent.id === chosen);
  const documents = assets.filter((asset) =>
    ["document", "text"].includes(asset.kind),
  );
  const activeRun = selected?.runs?.find(
    (run) => !TERMINAL.includes(run.state),
  );
  const run =
    selected?.runs?.find((item) => item.id === runId) ||
    (openedRun?.agent === chosen && openedRun.id === runId
      ? openedRun
      : null) ||
    selected?.runs?.[0];
  const instruction = instructions[chosen] || "";
  const briefRevision = briefRevisions[chosen] ?? null;
  const previewBody = {
    instruction,
    client_id: "context-preview-00000000",
    project_brief_revision: briefRevision,
  };
  const contextIdentity = JSON.stringify({
    agent: chosen,
    definition: selected?.definition,
    defaultProfile,
    body: previewBody,
  });
  const readiness = modelReadiness({
    tools,
    task: roleOf(selected?.definition),
    value: selected?.definition.profile_id || "auto",
    defaultId: defaultProfile,
    worker,
  });
  const missingDocuments =
    selected?.definition.document_ids.filter(
      (id) => !documents.some((document) => document.id === id),
    ) || [];
  const runRequest = run?.jobs?.[0]?.request;
  const runInstruction = run?.instruction || runRequest?.prompt || "";
  const runProfile = runRequest?.profile;
  const actualRunModel = runProfile
    ? `${runProfile.model || tools.find((tool) => tool.id === runProfile.package)?.model || runProfile.package || runProfile.id}${runProfile.label ? ` · ${runProfile.label}` : ""}`
    : "Model details unavailable for this older run";
  const runDocumentIds =
    run?.definition?.document_ids || runRequest?.context_ids || [];
  const runDocumentNames = runDocumentIds.map(
    (id) =>
      runRequest?.sources?.find((source) => source.id === id)?.name ||
      documents.find((document) => document.id === id)?.name ||
      "Unavailable document",
  );
  useEffect(() => {
    workspaceDrafts.delete(project.id);
    workspaceDrafts.set(project.id, {
      chosen,
      builder,
      draft,
      mcpMode,
      instructions,
      briefRevisions,
    });
    if (workspaceDrafts.size > 20)
      workspaceDrafts.delete(workspaceDrafts.keys().next().value);
  }, [
    project.id,
    chosen,
    builder,
    draft,
    mcpMode,
    instructions,
    briefRevisions,
  ]);
  const modelName = (definition) => {
    if (!definition?.profile_id || definition.profile_id === "auto") {
      const choice = modelReadiness({
        tools,
        task: roleOf(definition),
        value: "auto",
        defaultId: defaultProfile,
        worker,
      }).selected;
      return choice
        ? `Automatic · ${choice.package.model || choice.package.name}`
        : "Automatic · no model ready";
    }
    const profile = taskProfiles(tools, "chat").find(
      (item) => item.id === definition.profile_id,
    );
    return profile
      ? `${profile.package.model || profile.package.name} · ${profile.label}`
      : definition.profile_id;
  };
  const loadAgents = useCallback(async () => {
    const request = ++sequence.current;
    const list = await api(`/projects/${project.id}/agents`);
    if (mounted.current && request === sequence.current) {
      setAgents(list);
      setChosen((id) => id || list[0]?.id || null);
      setLoading(false);
    }
    return list;
  }, [api, project.id]);
  useEffect(() => {
    mounted.current = true;
    let timer,
      cancelled = false,
      fetching = false;
    const load = async () => {
      clearTimeout(timer);
      if (cancelled || fetching || document.hidden) return;
      fetching = true;
      let delay = 15000;
      try {
        const list = await loadAgents();
        if (
          list.some((agent) =>
            agent.runs?.some((run) => !TERMINAL.includes(run.state)),
          )
        )
          delay = 3000;
      } catch (e) {
        if (!cancelled) {
          setError(e.message);
          setErrorHint("");
          setLoading(false);
        }
      } finally {
        fetching = false;
        if (!cancelled) scheduleRefresh.current?.(delay);
      }
    };
    scheduleRefresh.current = (delay) => {
      clearTimeout(timer);
      if (!cancelled) timer = setTimeout(load, delay);
    };
    const visibility = () => {
      clearTimeout(timer);
      if (!document.hidden) load();
    };
    api("/agent-templates")
      .then((list) => {
        if (!cancelled) setTemplates(list);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    load();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancelled = true;
      mounted.current = false;
      scheduleRefresh.current = null;
      ++sequence.current;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [api, loadAgents]);
  useEffect(() => {
    if (!initialIntent) return;
    setError("");
    setSavedNotice("");
    setReusedTask(null);
    setRunId(null);
    if (initialIntent.run) {
      setOpenedRun(initialIntent.run);
      setRunId(initialIntent.run.id);
      setResultView("result");
    }
    if (initialIntent.agent) {
      setChosen(initialIntent.agent);
      setBuilder(null);
      setMcpMode(false);
    }
    if (initialIntent.mcp) {
      setMcpMode(true);
      setBuilder({ kind: "create" });
      setDraft({
        ...definitionInput(initialIntent.starter, defaultConversationOptions),
        profile_id: "auto",
        document_ids: [],
        tools_enabled: false,
      });
    }
    onIntentConsumed?.();
  }, [initialIntent]);
  useEffect(() => {
    setCopied(false);
  }, [run?.id, resultView]);
  const action = async (fn, hint = "") => {
    setBusy(true);
    setError("");
    setErrorHint("");
    try {
      await fn();
      const list = await loadAgents();
      scheduleRefresh.current?.(
        list.some((agent) =>
          agent.runs?.some((run) => !TERMINAL.includes(run.state)),
        )
          ? 3000
          : 15000,
      );
    } catch (e) {
      if (mounted.current) {
        setError(e.message);
        setErrorHint(hint);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const choose = (identity) => {
    setChosen(identity);
    setBuilder(null);
    setMcpMode(false);
    setRunId(null);
    setResultView("result");
    setError("");
    setSavedNotice("");
    setReusedTask(null);
  };
  const begin = (template) => {
    setBuilder({ kind: "create" });
    setMcpMode(false);
    setError("");
    setSavedNotice("");
    setReusedTask(null);
    setDraft({
      ...emptyDraft(defaultConversationOptions),
      ...(template
        ? {
            template: template.id,
            name: template.id === "custom" ? "" : template.name,
            purpose: template.purpose,
          }
        : {}),
    });
  };
  const updateInstruction = (value) => {
    delete pending.current[chosen];
    setInstructions((all) => ({ ...all, [chosen]: value }));
    setReusedTask(null);
  };
  const prepareTask = (value, message) => {
    const previous = instruction;
    updateInstruction(value);
    setReusedTask({ agent: chosen, previous, message });
    requestAnimationFrame(() => {
      const composer = document.getElementById("agent-instruction");
      composer?.focus({ preventScroll: true });
      composer?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };
  const editSelected = () => {
    setBuilder({
      kind: "edit",
      id: selected.id,
      version: selected.definition.version || 1,
    });
    setDraft(definitionInput(selected.definition, defaultConversationOptions));
    setError("");
    setSavedNotice("");
  };
  const output = resultView === "draft" ? run?.draft_text : run?.text;
  const visibleAgents = agents.filter((agent) =>
    `${agent.definition.name} ${agent.definition.purpose} ${modelName(agent.definition)}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const starterCards = (compact = false) => (
    <div className={`agent-starters ${compact ? "compact" : ""}`}>
      {templates
        .filter((template) => template.id !== "custom")
        .map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => begin(template)}
            disabled={busy}
          >
            <span className="agent-role-icon">
              {template.id === "code-review" ? (
                <Code2 size={20} />
              ) : template.id === "brief" ? (
                <FileText size={20} />
              ) : template.id === "plan" ? (
                <Layers size={20} />
              ) : (
                <PenLine size={20} />
              )}
            </span>
            <strong>{template.name}</strong>
            <span>{descriptions[template.id] || template.purpose}</span>
            <small>
              Use this starter <ArrowRight size={13} />
            </small>
          </button>
        ))}
    </div>
  );

  return (
    <section className="agents-studio agents-workbench">
      <div className="section-heading agents-heading">
        <div>
          <span className="eyebrow">LOCAL TEXT ASSISTANTS</span>
          <h1>{mcpMode ? "Create your MCP server" : "Your agents"}</h1>
          <p className="lead">
            Save a useful role. Give it a task. Review what it writes.
          </p>
        </div>
        <button onClick={() => begin()} disabled={busy}>
          <Plus size={16} /> New agent
        </button>
      </div>
      <div className="agents-boundary">
        <span>
          <Bot size={16} /> Two local steps: draft, then review. You decide what
          happens next.
        </span>
        {onCoding && (
          <button className="text-button" onClick={onCoding}>
            <Code2 size={16} /> Open coding workspace <ArrowRight size={14} />
          </button>
        )}
      </div>
      {error && (
        <div className="notice agent-feedback" role="alert">
          <div>
            <span>{error}</span>
            {errorHint && <p className="helper">{errorHint}</p>}
          </div>
          {selected && (
            <button disabled={busy} onClick={() => action(async () => {})}>
              Refresh saved agents
            </button>
          )}
          <button aria-label="Dismiss agent error" onClick={() => setError("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {serverCreated?.agent === chosen && (
        <div className="mcp-builder-handoff panel">
          <div>
            <strong>Your MCP server is ready to configure.</strong>
            <p>It starts disabled. Review access before connecting an app.</p>
          </div>
          {onMCPServer && (
            <button
              className="primary"
              onClick={() => onMCPServer(serverCreated.id)}
            >
              Configure MCP server <ArrowRight size={16} />
            </button>
          )}
        </div>
      )}
      <div className="agents-layout">
        <aside className="agents-saved panel" aria-label="Saved agents">
          <div className="agents-list-heading">
            <h2>Saved agents</h2>
            <span>{agents.length}</span>
          </div>
          <label className="agents-search">
            <Search size={16} />
            <input
              aria-label="Search saved agents"
              placeholder="Search this project…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                aria-label="Clear agent search"
                onClick={() => setSearch("")}
              >
                <X size={14} />
              </button>
            )}
          </label>
          <p className="helper">In {project.name || "this project"}</p>
          <div className="agents-saved-list">
            {visibleAgents.map((agent) => (
              <button
                key={agent.id}
                className={chosen === agent.id && !builder ? "chosen" : ""}
                aria-pressed={chosen === agent.id && !builder}
                disabled={busy}
                onClick={() => choose(agent.id)}
              >
                <Bot size={18} />
                <span>
                  <strong>{agent.definition.name}</strong>
                  <small>{agent.definition.purpose}</small>
                  <em>
                    {agent.runs?.[0]
                      ? stateLabel(agent.runs[0].state)
                      : "Ready for its first task"}
                  </em>
                </span>
              </button>
            ))}
          </div>
          {!visibleAgents.length && (
            <p className="agents-list-empty">
              {loading
                ? "Loading your agents…"
                : search
                  ? "No agents match this search."
                  : "Your saved roles will appear here."}
            </p>
          )}
          {search && !visibleAgents.length && (
            <button onClick={() => setSearch("")}>Show all agents</button>
          )}
          <button
            className="agents-add"
            onClick={() => begin()}
            disabled={busy}
          >
            <Plus size={15} /> Create a role
          </button>
        </aside>
        <div className="agents-main">
          {builder ? (
            <form
              className="agent-setup panel"
              aria-label="Agent setup"
              onSubmit={(e) => {
                e.preventDefault();
                action(async () => {
                  const saved =
                    builder.kind === "edit"
                      ? await api(
                          `/agents/${builder.id}`,
                          { ...draft, expected_version: builder.version },
                          "PUT",
                        )
                      : await api(`/projects/${project.id}/agents`, draft);
                  // Show the saved agent even if the optional MCP registration fails;
                  // retrying configuration then reuses this agent instead of duplicating it.
                  setChosen(saved.id);
                  setAgents((list) => [
                    saved,
                    ...list.filter((item) => item.id !== saved.id),
                  ]);
                  setBuilder(null);
                  setRunId(null);
                  if (mcpMode) {
                    setMcpMode(false);
                    const server = await api(
                      `/projects/${project.id}/mcp-servers`,
                      { agent_id: saved.id },
                    );
                    setServerCreated({ id: server.id, agent: saved.id });
                  }
                });
              }}
            >
              <div>
                <span className="eyebrow">
                  {builder.kind === "edit"
                    ? "REFINE YOUR ROLE"
                    : "MAKE IT YOURS"}
                </span>
                <h2>
                  {builder.kind === "edit"
                    ? "Agent settings"
                    : mcpMode
                      ? "A purpose for connected apps"
                      : "Create a useful assistant"}
                </h2>
                <p className="helper">
                  {builder.kind === "edit"
                    ? "Changes apply to future runs. Existing runs keep their original purpose, model and context."
                    : "Choose a purpose and the context it may use. You can change these later."}
                </p>
              </div>
              <div className="agent-setup-row">
                <label>
                  Agent name
                  <input
                    required
                    maxLength={100}
                    value={draft.name}
                    onChange={(e) =>
                      setDraft({ ...draft, name: e.target.value })
                    }
                    placeholder="e.g. Launch copy partner"
                  />
                </label>
                <label>
                  Starting role
                  <select
                    value={draft.template}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        template: e.target.value,
                        tools_enabled: false,
                      })
                    }
                  >
                    {templates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                Purpose
                <textarea
                  aria-label="Purpose"
                  required
                  rows={3}
                  maxLength={1200}
                  value={draft.purpose}
                  onChange={(e) =>
                    setDraft({ ...draft, purpose: e.target.value })
                  }
                  placeholder="Describe the kind of help you want and what a useful answer looks like…"
                />
              </label>
              <fieldset className="agent-context-picker">
                <legend>
                  Approved context{" "}
                  <span>{draft.document_ids.length}/8 documents</span>
                </legend>
                <p className="helper">
                  These project documents are included as complete saved
                  snapshots; the runtime summarizes older material only when a
                  request exceeds the selected context. You can also supply
                  facts in each task. Other project files and previous runs are
                  not included automatically.
                </p>
                <div>
                  {documents.length ? (
                    documents.map((document) => (
                      <label key={document.id}>
                        <input
                          type="checkbox"
                          checked={draft.document_ids.includes(document.id)}
                          disabled={
                            !draft.document_ids.includes(document.id) &&
                            draft.document_ids.length >= 8
                          }
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              document_ids: e.target.checked
                                ? [...draft.document_ids, document.id]
                                : draft.document_ids.filter(
                                    (id) => id !== document.id,
                                  ),
                            })
                          }
                        />
                        <FileText size={15} />
                        <span>{document.name}</span>
                      </label>
                    ))
                  ) : (
                    <p className="helper">
                      No documents in this project yet. Start with instructions
                      alone, or import documents in Library.
                    </p>
                  )}
                </div>
              </fieldset>
              <ModelChoice
                tools={tools}
                task={roleOf(draft)}
                value={draft.profile_id}
                defaultId={defaultProfile}
                onChange={(profile_id) =>
                  setDraft({ ...draft, profile_id, tools_enabled: false })
                }
                label="Agent model"
                details
              />
              <ModelStatus
                tools={tools}
                task={roleOf(draft)}
                value={draft.profile_id}
                defaultId={defaultProfile}
                worker={worker}
                onModels={onModels}
              />
              <p className="helper">
                The model choice is saved with this agent. Automatic follows
                your {roleOf(draft) === "code" ? "coding" : "chat"} default in
                Model settings. You can save the role before its model is ready.
              </p>
              <details className="agent-conversation-memory">
                <summary>Conversation memory · Qwen3.8</summary>
                <ConversationControls
                  value={draft.conversation || defaultConversationOptions}
                  disabled={!toolsCapable(draft.profile_id)}
                  onChange={(conversation) =>
                    setDraft({ ...draft, conversation })
                  }
                />
              </details>
              {draft.template === "code" && (
                <label className="conversation-option">
                  <span>
                    <strong>Enable project code tools</strong>
                    <small>
                      Allow this agent and its connected MCP clients to read
                      only selected source documents and save new code drafts.
                      Qwen3.8 MXFP4 + DFlash2 required. Nothing is executed or
                      overwritten.
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    checked={draft.tools_enabled || false}
                    disabled={!toolsCapable(draft.profile_id)}
                    onChange={(e) =>
                      setDraft({ ...draft, tools_enabled: e.target.checked })
                    }
                  />
                </label>
              )}
              {mcpMode && (
                <p className="notice">
                  Connected apps can request this agent's text work using the
                  approved documents. The MCP server starts disabled until you
                  enable access.
                </p>
              )}
              <p className="helper">
                This role writes and reviews text. With the coding template,
                optional project tools can read selected sources and save new
                drafts, using up to five tool rounds before review. It cannot
                run commands, browse, send messages or publish work.
              </p>
              <div className="actions">
                <button
                  className="primary"
                  disabled={busy || !draft.name.trim() || !draft.purpose.trim()}
                >
                  {busy
                    ? "Saving…"
                    : builder.kind === "edit"
                      ? "Save changes"
                      : mcpMode
                        ? "Create MCP server"
                        : "Create agent"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setBuilder(null);
                    setMcpMode(false);
                    setError("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : selected ? (
            <>
              <section className="agent-overview panel">
                <div className="agent-overview-heading">
                  <span className="agent-role-icon">
                    <Bot size={25} />
                  </span>
                  <div>
                    <span className="eyebrow">SAVED ROLE · MANUAL RUNS</span>
                    <h2>{selected.definition.name}</h2>
                  </div>
                  <div className="agent-overview-actions">
                    <button disabled={busy} onClick={editSelected}>
                      <Settings2 size={15} /> Edit agent
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => {
                        setBuilder({ kind: "create" });
                        setDraft({
                          ...definitionInput(
                            selected.definition,
                            defaultConversationOptions,
                          ),
                          name: `${selected.definition.name.slice(0, 94)} copy`,
                        });
                        setMcpMode(false);
                        setError("");
                      }}
                    >
                      <Copy size={15} /> Duplicate
                    </button>
                  </div>
                </div>
                <p className="agent-purpose">{selected.definition.purpose}</p>
                <fieldset className="agent-model-picker" disabled={busy}>
                  <ModelChoice
                    tools={tools}
                    task={roleOf(selected.definition)}
                    value={selected.definition.profile_id}
                    defaultId={defaultProfile}
                    label="Agent model"
                    onChange={(profile_id) =>
                      action(async () => {
                        const saved = await api(
                          `/agents/${selected.id}`,
                          {
                            ...definitionInput(
                              selected.definition,
                              defaultConversationOptions,
                            ),
                            profile_id,
                            tools_enabled:
                              toolsCapable(profile_id) &&
                              Boolean(selected.definition.tools_enabled),
                            expected_version: selected.definition.version || 1,
                          },
                          "PUT",
                        );
                        setAgents((list) =>
                          list.map((agent) =>
                            agent.id === saved.id ? saved : agent,
                          ),
                        );
                        setSavedNotice(
                          "Model saved for future runs. Existing results keep the model they used.",
                        );
                      }, "Refresh saved agents to check which model was saved before trying again.")
                    }
                  />
                </fieldset>
                <ModelStatus
                  tools={tools}
                  task={roleOf(selected.definition)}
                  value={selected.definition.profile_id}
                  defaultId={defaultProfile}
                  worker={worker}
                  onModels={onModels}
                />
                <p className="helper">
                  Choose once for this agent. Automatic follows your chat
                  default in Model settings.
                </p>
                {savedNotice && (
                  <p className="agent-saved-notice" role="status">
                    <Check size={14} />
                    {savedNotice}
                  </p>
                )}
                <dl className="agent-facts">
                  <div>
                    <dt>Approved project documents</dt>
                    <dd>
                      {selected.definition.document_ids.length
                        ? selected.definition.document_ids
                            .map(
                              (id) =>
                                documents.find((item) => item.id === id)
                                  ?.name || "Unavailable document",
                            )
                            .join(", ")
                        : "Instructions only"}
                    </dd>
                  </div>
                  <div>
                    <dt>How context works</dt>
                    <dd>
                      Each run starts fresh with your purpose, instruction and
                      the complete saved snapshots of its approved documents,
                      plus the project brief when you include it below. Earlier
                      answers and other project files are not carried over.
                    </dd>
                  </div>
                </dl>
                {missingDocuments.length > 0 && (
                  <div className="notice agent-missing-context">
                    <p>
                      {missingDocuments.length} selected document
                      {missingDocuments.length === 1 ? " is" : "s are"} no
                      longer available in this project. Update the selection
                      before running.
                    </p>
                    <button disabled={busy} onClick={editSelected}>
                      Edit approved context
                    </button>
                  </div>
                )}
                {onMCPServer && (
                  <button
                    className="text-button"
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
                    Use from another app with MCP <ArrowRight size={14} />
                  </button>
                )}
              </section>
              <form
                className="agent-composer panel"
                aria-label="Run agent"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (
                    !readiness.canRun ||
                    missingDocuments.length ||
                    activeRun ||
                    briefBusy ||
                    previewBusy ||
                    busy
                  )
                    return;
                  action(async () => {
                    const current = await api(`/agents/${selected.id}/runs`, {
                      instruction,
                      project_brief_revision: briefRevision,
                      ...(contextPreview?.identity === contextIdentity
                        ? { context_fingerprint: contextPreview.fingerprint }
                        : {}),
                      client_id: (pending.current[selected.id] ||=
                        crypto.randomUUID()),
                    });
                    delete pending.current[selected.id];
                    setRunId(current.id);
                    setResultView("plan");
                    setReusedTask(null);
                    setSavedNotice("");
                  }, "Your instructions are preserved. Check the model status, then choose Run agent to try again.");
                }}
              >
                <div className="section-heading">
                  <h2>Give it a task</h2>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      prepareTask(
                        examples[selected.definition.template] ||
                          examples.custom,
                        "Example copied. Add your own facts before running.",
                      )
                    }
                    disabled={busy}
                  >
                    Use an example
                  </button>
                </div>
                <label htmlFor="agent-instruction">
                  What should this agent work on?
                </label>
                <textarea
                  id="agent-instruction"
                  required
                  rows={4}
                  maxLength={2000}
                  value={instruction}
                  onChange={(e) => updateInstruction(e.target.value)}
                  placeholder={
                    selected.definition.template === "code-review"
                      ? "Paste a focused code snippet or diff. Explain what it should do…"
                      : "Describe the result you want. Include the audience, format and any facts that matter…"
                  }
                />
                {reusedTask?.agent === chosen && (
                  <div className="agent-reuse-notice" role="status">
                    <span>{reusedTask.message}</span>
                    <button
                      type="button"
                      onClick={() => updateInstruction(reusedTask.previous)}
                    >
                      Undo
                    </button>
                  </div>
                )}
                <ProjectBrief
                  key={`brief-${chosen}`}
                  project={project}
                  api={api}
                  value={briefRevision}
                  disabled={busy}
                  onBusyChange={setBriefBusy}
                  onChange={(revision) => {
                    delete pending.current[chosen];
                    setBriefRevisions((previous) => ({
                      ...previous,
                      [chosen]: revision,
                    }));
                  }}
                />
                <ContextInspector
                  key={`context-${chosen}-${selected.definition.version || 1}-${defaultProfile}`}
                  api={api}
                  endpoint={`/agents/${selected.id}/context`}
                  body={previewBody}
                  disabled={
                    busy ||
                    briefBusy ||
                    !instruction.trim() ||
                    missingDocuments.length > 0
                  }
                  onBusyChange={setPreviewBusy}
                  onChange={(fingerprint) =>
                    setContextPreview(
                      fingerprint
                        ? { identity: contextIdentity, fingerprint }
                        : null,
                    )
                  }
                />
                {activeRun && (
                  <p className="helper agent-active-hint">
                    A run is already in progress.{" "}
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        setRunId(activeRun.id);
                        setResultView("plan");
                      }}
                    >
                      View active run <ArrowRight size={13} />
                    </button>
                  </p>
                )}
                <div className="agent-composer-footer">
                  <span className="helper">
                    Draft → review → saved text · {instruction.length}/2000
                  </span>
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      briefBusy ||
                      previewBusy ||
                      Boolean(activeRun) ||
                      !readiness.canRun ||
                      missingDocuments.length > 0 ||
                      !instruction.trim()
                    }
                  >
                    <Play size={15} /> Run agent
                  </button>
                </div>
              </form>
              {run ? (
                <section className="agent-run panel" aria-label="Agent run">
                  <div className="section-heading">
                    <div>
                      <span className="eyebrow">
                        {run.id === selected.runs[0]?.id
                          ? "LATEST RUN"
                          : "EARLIER RUN"}
                      </span>
                      <h2>{stateLabel(run.state)}</h2>
                    </div>
                    <span className={`agent-status ${run.state}`} role="status">
                      {stateLabel(run.state)}
                    </span>
                  </div>
                  <p className="helper">{run.message}</p>
                  {TERMINAL.includes(run.state) && runInstruction && (
                    <div className="agent-run-recovery">
                      <button
                        disabled={busy}
                        onClick={() =>
                          prepareTask(
                            runInstruction,
                            "Task copied. Review it with this agent's current model and context, then choose Run agent.",
                          )
                        }
                      >
                        <RotateCcw size={14} />
                        {run.state === "failed" || run.state === "cancelled"
                          ? "Prepare another attempt"
                          : "Reuse task"}
                      </button>
                      <span className="helper">
                        {run.state === "failed" || run.state === "cancelled"
                          ? "Your saved draft and run history are kept. A new attempt starts with the draft step."
                          : "Use these instructions again with the current agent settings."}
                      </span>
                    </div>
                  )}
                  {!TERMINAL.includes(run.state) && (
                    <button
                      disabled={busy || run.state === "cancelling"}
                      onClick={() =>
                        action(() => api(`/agent-runs/${run.id}/cancel`, {}))
                      }
                    >
                      <Square size={14} /> Stop run
                    </button>
                  )}
                  <div
                    className="agent-result-tabs"
                    role="tablist"
                    aria-label="Run details"
                  >
                    {[
                      ["plan", "Run plan"],
                      ["draft", "Draft"],
                      ["result", "Final result"],
                    ].map(([id, label]) => (
                      <button
                        key={id}
                        id={`agent-tab-${id}`}
                        type="button"
                        role="tab"
                        aria-selected={resultView === id}
                        aria-controls="agent-result-panel"
                        tabIndex={resultView === id ? 0 : -1}
                        onClick={() => setResultView(id)}
                        onKeyDown={(event) => {
                          const tabs = ["plan", "draft", "result"];
                          const index = tabs.indexOf(id);
                          const next =
                            event.key === "ArrowRight"
                              ? (index + 1) % 3
                              : event.key === "ArrowLeft"
                                ? (index + 2) % 3
                                : event.key === "Home"
                                  ? 0
                                  : event.key === "End"
                                    ? 2
                                    : null;
                          if (next === null) return;
                          event.preventDefault();
                          setResultView(tabs[next]);
                          document
                            .getElementById(`agent-tab-${tabs[next]}`)
                            ?.focus();
                        }}
                      >
                        {label}
                        {id === "draft" && run.draft_text && (
                          <Check size={13} />
                        )}
                        {id === "result" && run.text && <Check size={13} />}
                      </button>
                    ))}
                  </div>
                  <div
                    id="agent-result-panel"
                    role="tabpanel"
                    aria-labelledby={`agent-tab-${resultView}`}
                  >
                    {resultView === "plan" ? (
                      <div className="agent-run-plan">
                        <h3>Your instruction</h3>
                        <p className="agent-request">
                          {run.instruction ||
                            run.jobs?.[0]?.request?.prompt ||
                            "Instruction saved with this run."}
                        </p>
                        <dl className="agent-facts">
                          <div>
                            <dt>Purpose at start</dt>
                            <dd>
                              {run.definition?.purpose ||
                                selected.definition.purpose}
                            </dd>
                          </div>
                          <div>
                            <dt>Model used</dt>
                            <dd>{actualRunModel}</dd>
                          </div>
                          <div>
                            <dt>Approved documents at start</dt>
                            <dd>
                              {runDocumentNames.length
                                ? runDocumentNames.join(", ")
                                : "Instructions only"}
                            </dd>
                          </div>
                          <div>
                            <dt>Project brief at start</dt>
                            <dd>
                              {runRequest?.project_brief
                                ? `Included · revision ${runRequest.project_brief.revision}`
                                : "Not included"}
                            </dd>
                          </div>
                        </dl>
                        {runDocumentNames.length > 0 && (
                          <p className="helper">
                            The model receives limited excerpts selected for
                            this instruction. Full documents may not fit, and
                            selected documents may contribute no excerpt.
                          </p>
                        )}
                        <ol className="agent-run-steps">
                          {[
                            "Draft from your instruction and approved context",
                            "Review the draft and save the revised answer",
                          ].map((label, index) => (
                            <li key={label}>
                              <span>{index + 1}</span>
                              <div>
                                <strong>{label}</strong>
                                <small>
                                  {run.jobs?.[index]?.message ||
                                    (TERMINAL.includes(run.state)
                                      ? "Not run"
                                      : "Waiting for the previous step")}
                                </small>
                                {run.jobs?.[index]?.request?.messages && (
                                  <ContextInspector
                                    snapshot={
                                      run.jobs[index].request
                                        .context_snapshot || {
                                        kind: "text",
                                        messages:
                                          run.jobs[index].request.messages,
                                        sources:
                                          run.jobs[index].request.sources || [],
                                        project_brief:
                                          run.jobs[index].request
                                            .project_brief || null,
                                        history:
                                          run.jobs[index].request
                                            .context_history,
                                        characters:
                                          run.jobs[index].request
                                            .context_characters,
                                      }
                                    }
                                  />
                                )}
                              </div>
                              <em>
                                {run.jobs?.[index]?.state ||
                                  (TERMINAL.includes(run.state)
                                    ? "not run"
                                    : "waiting")}
                              </em>
                            </li>
                          ))}
                        </ol>
                        <small className="helper">
                          This is the fixed two-step workflow, not an extra
                          model request. AI review is not independent
                          fact-checking.
                        </small>
                      </div>
                    ) : output ? (
                      <>
                        <div className="agent-output-actions">
                          <span className="helper">
                            {resultView === "draft"
                              ? "First draft"
                              : "Reviewed answer"}
                          </span>
                          <button
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(output);
                                setCopied(true);
                              } catch {
                                setError(
                                  "Copy is unavailable in this browser. Download the result instead.",
                                );
                              }
                            }}
                          >
                            {copied ? <Check size={14} /> : <Copy size={14} />}
                            {copied ? "Copied" : "Copy text"}
                          </button>
                          <button
                            onClick={() => {
                              const url = URL.createObjectURL(
                                new Blob([output], {
                                  type: "text/markdown;charset=utf-8",
                                }),
                              );
                              const link = document.createElement("a");
                              link.href = url;
                              link.download = `${(run.definition?.name || selected.definition.name).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 70) || "agent"}-${resultView}.md`;
                              link.click();
                              setTimeout(() => URL.revokeObjectURL(url), 1000);
                            }}
                          >
                            <Download size={14} /> Download
                          </button>
                        </div>
                        <div className="agent-output">{output}</div>
                        <ResultActions
                          source={{
                            kind: "text",
                            project_id: project.id,
                            text: output,
                            title: `${run.definition?.name || selected.definition.name} · ${resultView === "draft" ? "First draft" : "Reviewed answer"}`,
                            asset_id:
                              resultView === "draft"
                                ? run.jobs?.[0]?.asset
                                : run.asset,
                          }}
                          onHandoff={onHandoff}
                        />
                        <p className="helper">
                          Review before using. Saved text is also available in
                          this project's Library.
                        </p>
                      </>
                    ) : (
                      <div className="agent-result-empty">
                        <FileText size={25} />
                        <h3>
                          {resultView === "draft"
                            ? "The first draft will appear here"
                            : "The reviewed answer will appear here"}
                        </h3>
                        <p>
                          {run.state === "failed" || run.state === "cancelled"
                            ? "This run stopped before this output was saved. Any completed draft remains available in the Draft tab."
                            : "You can follow each step in Run plan and keep working elsewhere in Studio."}
                        </p>
                      </div>
                    )}
                  </div>
                </section>
              ) : (
                <div className="agent-first-run">
                  <FileText size={24} />
                  <div>
                    <strong>Your first result starts here.</strong>
                    <p>
                      Give this role a specific task. Its draft and reviewed
                      answer will stay together in run history.
                    </p>
                  </div>
                </div>
              )}
              {!!selected.runs?.length && (
                <section
                  className="agent-history panel"
                  aria-label="Run history"
                >
                  <div className="section-heading">
                    <h2>Run history</h2>
                    <span className="helper">
                      Latest {selected.runs.length} runs
                    </span>
                  </div>
                  <div>
                    {selected.runs.map((item) => (
                      <button
                        key={item.id}
                        aria-pressed={run?.id === item.id}
                        onClick={() => {
                          setRunId(item.id);
                          setResultView(
                            item.text
                              ? "result"
                              : item.draft_text
                                ? "draft"
                                : "plan",
                          );
                        }}
                      >
                        <span>
                          <strong>
                            {item.instruction ||
                              item.jobs?.[0]?.request?.prompt ||
                              "Agent task"}
                          </strong>
                          <small>
                            {new Date(item.created * 1000).toLocaleString()}
                          </small>
                        </span>
                        <em>{stateLabel(item.state)}</em>
                        <ArrowRight size={15} />
                      </button>
                    ))}
                  </div>
                </section>
              )}
              <details className="agent-more-starters">
                <summary>Try another useful role</summary>
                {starterCards(true)}
              </details>
            </>
          ) : (
            <section className="agents-welcome">
              <span className="eyebrow">A GOOD STARTING POINT</span>
              <h2>What would you like help with?</h2>
              <p>
                Start with a role, then tailor its purpose and documents to your
                project.
              </p>
              {starterCards()}
              <button onClick={() => begin()}>
                <Plus size={15} /> Define my own role
              </button>
              <div className="agent-first-run">
                <Layers size={25} />
                <div>
                  <strong>Purpose + context + a clear task</strong>
                  <p>
                    A role remembers how you want help. Each run drafts an
                    answer, reviews it and saves both steps for you.
                  </p>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </section>
  );
}
