import { technicalModel, weightsLabel, kvCacheLabel } from "./modelSelection";
import Reply from "./ReplyMarkdown";
import Diagnostics from "./Diagnostics";
import React, { useEffect, useRef, useState } from "react";
import {
  MessageSquare,
  Plus,
  Paperclip,
  ArrowUp,
  Square,
  FileText,
  X,
  Copy,
  Sparkles,
  Search,
  Download,
  Pin,
  PinOff,
  Pencil,
  Archive,
  ArchiveRestore,
  Check,
  Settings2,
  RefreshCw,
} from "lucide-react";
import { ModelChoice, selectedProfile } from "./WorkspaceExtras";
import ModelStatus, { modelReadiness } from "./ModelStatus";
import ProjectBrief from "./ProjectBrief";
import ResultActions from "./ResultActions";
import { appendDraft } from "./workspaceLinks";
import { imagePromptLimit } from "./imageRecipe";
import ContextInspector from "./ContextInspector";
import { stageForJob } from "./creationFeedback";
import "./gptpaiton.css";
import ConversationControls, {
  defaultConversation,
} from "./ConversationControls";
import {
  PerformanceSummary,
  PerformanceDetails,
  ImageTime,
  QueueEstimate,
} from "./Performance";
const terminal = ["completed", "failed", "cancelled"];
const markdownLabel = (value) =>
  String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\`*_{}\[\]<>()#!|]/g, "\\$&");
const sourceName = (value) =>
  String(value || "Document")
    .split(/[\\/]/)
    .at(-1);
const relativeSource = (value) =>
  typeof value === "string" &&
  !/^[\/~]|[\\:\u0000-\u001f]/.test(value) &&
  value.split("/").every((part) => part && part !== "." && part !== "..");

export function conversationMarkdown(chat, exportedAt = new Date()) {
  const lines = [
    `# ${markdownLabel(chat.title || "Conversation")}`,
    "",
    `Exported from Paiton Studio · ${exportedAt.toISOString()}`,
    "",
    "Turn states reflect this saved snapshot. Media, separately attached file contents and saved response instructions are not included.",
  ];
  for (const [index, turn] of (chat.turns || []).entries()) {
    const job = turn.job || {},
      request = job.request || {},
      profile = request.profile || {},
      state =
        {
          completed: "Completed",
          failed: "Failed — no completed reply",
          cancelled: "Stopped — no completed reply",
          queued: "Queued — reply pending",
          loading: "Loading — reply pending",
          running: "Running — reply incomplete",
        }[job.state] || "In progress — no completed reply",
      code = turn.coding_context ?? request.coding_context ?? [];
    lines.push(
      "",
      "---",
      "",
      `## Turn ${index + 1}`,
      "",
      "### You",
      "",
      turn.prompt || "",
      "",
      "### Assistant",
      "",
      `Status: ${state}`,
    );
    if (profile.model || profile.label)
      lines.push(
        `Model: ${markdownLabel(technicalModel({ id: profile.package, model: profile.model }, profile.conversation_options) || profile.label)}${profile.id ? ` · Profile: ${markdownLabel(profile.id)}` : ""}`,
      );
    if (turn.superseded)
      lines.push(
        "",
        "Earlier reply kept; a newer reply is used for future conversation context.",
      );
    if (turn.answer && job.state === "completed") lines.push("", turn.answer);
    else if (job.state === "completed" && turn.asset?.kind === "image")
      lines.push(
        "",
        `Generated image: ${markdownLabel(sourceName(turn.asset.name || "Saved image"))}. Download the image separately from Studio.`,
      );
    else if (turn.partial)
      lines.push("", "**Partial reply — incomplete:**", "", turn.partial);
    else
      lines.push(
        "",
        job.state === "completed"
          ? "No text reply is available in this snapshot."
          : "No completed reply is available in this snapshot.",
      );
    if (turn.asset?.metadata?.finish_reason === "length")
      lines.push(
        "",
        "Response budget reached; the reply may need a continuation.",
      );
    if (request.history_excerpted)
      lines.push(
        "",
        "Earlier conversation text was excerpted in this turn's model context.",
      );
    if (request.sources?.length) {
      lines.push("", "Document sources:");
      for (const source of request.sources)
        lines.push(
          `- ${markdownLabel(sourceName(source.name))}: ${/^[a-f0-9]{64}$/.test(source.version || source.sha256) ? `saved version ${(source.version || source.sha256).slice(0, 8)}` : source.excerpts?.length ? `excerpts ${source.excerpts.filter(Number.isInteger).join(", ")}` : "not included in this turn's model context"}`,
        );
    }
    const codeSources = code.filter((source) => relativeSource(source.path));
    if (codeSources.length) {
      lines.push("", "Supporting code files (saved revision metadata only):");
      for (const source of codeSources)
        lines.push(
          `- ${markdownLabel(source.path)}${/^[a-f0-9]{64}$/.test(source.version) ? ` · SHA-256: ${source.version}` : ""}`,
        );
    }
  }
  return lines.join("\n") + "\n";
}

function exportConversation(chat) {
  const file =
    (chat.title || "conversation")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 70) || "conversation";
  const url = URL.createObjectURL(
    new Blob([conversationMarkdown(chat)], {
      type: "text/markdown;charset=utf-8",
    }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `paiton-${file}.md`;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  try {
    if (!document.execCommand("copy"))
      throw Error(
        "Copy is unavailable in this browser. Select and copy the text.",
      );
  } finally {
    field.remove();
  }
}
const PRESETS = [
  {
    id: "general",
    label: "General",
    description: "Natural, practical help for everyday questions.",
  },
  {
    id: "concise",
    label: "Concise",
    description: "Direct answers with the essential details and caveats.",
  },
  {
    id: "explain",
    label: "Explain",
    description: "Step-by-step explanations, examples and clear assumptions.",
  },
  {
    id: "review",
    label: "Review",
    description: "Find concrete errors and risks in material you provide.",
  },
  {
    id: "custom",
    label: "Custom",
    description: "Follow the response instructions you write below.",
  },
];
const defaultSetup = () => ({
  preset: "general",
  instructions: "",
  profile_id: "auto",
});
const settingsOf = (chat) => ({ ...defaultSetup(), ...chat?.settings });
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const metadata = (chat) =>
  Object.fromEntries(
    ["title", "pinned", "archived", "revision", "settings", "updated"].map(
      (key) => [key, chat[key]],
    ),
  );
const conversationDrafts = new Map();
const incomingProjectTasks = new Map();
const imageRequest = (mode, prompt) =>
  mode === "image" ||
  (mode === "auto" &&
    /^\s*(\/image\b|(?:please\s+)?(?:generate|create|draw|make)\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|illustration|photo)\b)/i.test(
      prompt,
    ));

export default function GPTPaiton({
  project,
  api,
  tools = [],
  assets = [],
  report,
  onSetup,
  initialIntent,
  onIntentConsumed,
  onHandoff,
  defaultProfile = "auto",
  defaultCodeProfile = "auto",
  defaultConversationOptions,
  defaultImageProfile = "auto",
  worker,
}) {
  const [incomingTasks, setIncomingTasks] = useState(
    () => incomingProjectTasks.get(project.id) || [],
  );
  const incomingTask = incomingTasks[0] || null;
  const [focusTurn, setFocusTurn] = useState(null);
  const [failedNavigation, setFailedNavigation] = useState(null);
  const [navigationRetry, setNavigationRetry] = useState(0);
  const navigationAttempt = useRef(null);
  const recovery = useRef({
    fresh: conversationDrafts.get(`${project.id}:new`),
    last: conversationDrafts.get(`${project.id}:last`),
  }).current;
  const [optionsDraft, setOptionsDraft] = useState(null);
  const optionsVersion = useRef(0);
  const [chats, setChats] = useState([]),
    [chat, setChat] = useState(null);
  const [historyQuery, setHistoryQuery] = useState(""),
    [historyView, setHistoryView] = useState("active"),
    [historyLoading, setHistoryLoading] = useState(true),
    [historyError, setHistoryError] = useState("");
  const [opening, setOpening] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [prompt, setPrompt] = useState(""),
    [mode, setMode] = useState("chat"),
    [imageProfile, setImageProfile] = useState("auto"),
    [effort, setEffort] = useState("low"),
    [files, setFiles] = useState([]);
  const [briefRevision, setBriefRevision] = useState(null),
    [briefBusy, setBriefBusy] = useState(false),
    [contextBusy, setContextBusy] = useState(false),
    [previewSelection, setPreviewSelection] = useState(null);
  const [setup, setSetup] = useState(defaultSetup),
    [setupBase, setSetupBase] = useState({
      settings: defaultSetup(),
      revision: null,
    });
  const [sending, setSending] = useState(false),
    [uploading, setUploading] = useState(false),
    [metadataBusy, setMetadataBusy] = useState("");
  const [editReply, setEditReply] = useState(null);
  const regenerationNonce = useRef(null);
  const [renaming, setRenaming] = useState(false),
    [titleDraft, setTitleDraft] = useState("");
  const selected = useRef(null),
    current = useRef(null),
    alive = useRef(true),
    requestSequence = useRef(0),
    historySequence = useRef(0),
    pendingMetadata = useRef(new Set()),
    operation = useRef(false),
    nonce = useRef(null);
  const upload = useRef(null),
    bottom = useRef(null),
    nearBottom = useRef(true),
    composer = useRef(null),
    setupDetails = useRef(null);
  current.current = chat;
  const busy = chat?.turns?.find((turn) => !terminal.includes(turn.job.state));
  const useImage = imageRequest(mode, prompt);
  const replyRole = mode === "code" ? "code" : "chat";
  const replyDefault = mode === "code" ? defaultCodeProfile : defaultProfile;
  const activeRole = useImage ? "image" : replyRole;
  const setupDirty = !same(setup, setupBase.settings);
  const newWeightsDefault =
    tools
      .find((tool) => tool.id === "qwen38-mxfp4")
      ?.optional_components?.find((item) => item.id === "w3a4")
      ?.enabled_default === true;
  const conversation = optionsDraft?.conversation ||
    chat?.options?.conversation || {
      ...defaultConversation,
      ...defaultConversationOptions,
      weights: newWeightsDefault ? "w3a4" : "mxfp4",
    };
  const readiness = modelReadiness({
    tools,
    task: activeRole,
    value: useImage ? imageProfile : setup.profile_id,
    defaultId: useImage ? defaultImageProfile : replyDefault,
    worker,
    conversation,
  });
  const adjustableReasoning =
    (readiness.selected?.package.reasoning_efforts || []).length > 0;
  const promptLimit = useImage ? imagePromptLimit(readiness.selected) : 200000;
  const replyModel = selectedProfile(
    tools,
    replyRole,
    setup.profile_id,
    replyDefault,
    conversation,
  );
  const memoryCapable = replyModel?.package?.id === "qwen38-mxfp4";
  const outputLimit = replyModel?.max_tokens;
  const samplingInvalid = [
    ["temperature", 0, 2, false],
    ["top_p", Number.MIN_VALUE, 1, false],
    ["seed", 0, Number.MAX_SAFE_INTEGER, true],
    ["max_output_tokens", 1, outputLimit || 200000, true],
  ].some(([key, min, max, integer]) => {
    const value = setup[key];
    return (
      value != null &&
      (!Number.isFinite(value) ||
        value < min ||
        value > max ||
        (integer && !Number.isInteger(value)))
    );
  });
  const replacementBlocked =
    sending ||
    uploading ||
    opening ||
    Boolean(metadataBusy) ||
    Boolean(busy) ||
    Boolean(chat?.archived) ||
    setupDirty ||
    samplingInvalid ||
    Boolean(optionsDraft) ||
    !replyModel ||
    replyModel.state !== "ready" ||
    replyModel.compatibility?.compatible === false ||
    worker?.state === "stopped";
  function samplingField(key, raw) {
    setSetup((previous) => {
      const next = { ...previous };
      if (raw === "") delete next[key];
      else next[key] = key === "system_role" ? raw : Number(raw);
      return next;
    });
    clearIdentity();
  }

  const promptLength = useImage ? Array.from(prompt).length : prompt.length;
  const promptOverLimit = promptLength > promptLimit;
  const blocked =
    sending ||
    uploading ||
    opening ||
    Boolean(metadataBusy) ||
    Boolean(busy) ||
    Boolean(chat?.archived) ||
    !readiness.canRun ||
    setupDirty ||
    samplingInvalid ||
    (!useImage && briefBusy) ||
    contextBusy ||
    promptOverLimit;
  const requestBody = {
    prompt,
    mode,
    image_profile_id: imageProfile,
    reasoning_effort: adjustableReasoning ? effort : "low",
    document_ids: useImage ? [] : files.map((file) => file.id),
    inherit_documents: false,
    project_brief_revision: useImage ? null : briefRevision,
  };
  const contextVersion = JSON.stringify({
    project: project.id,
    chat: chat?.id,
    revision: chat?.revision,
    settings: setupBase.settings,
    options: conversation,
    defaults: [replyDefault, defaultImageProfile],
    turns: chat?.turns?.map((turn) => [
      turn.id,
      turn.job.state,
      turn.job.updated,
    ]),
  });
  const contextIdentity = JSON.stringify([contextVersion, requestBody]);
  const contextFingerprint =
    previewSelection?.identity === contextIdentity
      ? previewSelection.fingerprint
      : null;
  const selectedChats = chats
    .filter((item) => Boolean(item.archived) === (historyView === "archived"))
    .sort(
      (a, b) =>
        Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
        (b.updated || b.created || 0) - (a.updated || a.created || 0),
    );
  const matchingChats = selectedChats.filter((item) =>
    item.title
      .toLocaleLowerCase()
      .includes(historyQuery.trim().toLocaleLowerCase()),
  );
  const projectDocuments = assets.filter(
    (asset) =>
      ["document", "text"].includes(asset.kind) &&
      (!asset.project || asset.project === project.id),
  );
  const fail = (failure) => {
    if (alive.current) setError(failure.message || String(failure));
  };
  const draftKey = (id) => `${project.id}:${id || "new"}`;
  useEffect(() => {
    if (incomingTasks.length)
      incomingProjectTasks.set(project.id, incomingTasks);
    else incomingProjectTasks.delete(project.id);
  }, [project.id, incomingTasks]);
  function queueIncoming(task) {
    setIncomingTasks((tasks) =>
      tasks.includes(task) ? tasks : [...tasks, task],
    );
  }
  function dismissIncoming(task) {
    setIncomingTasks((tasks) => tasks.filter((item) => item !== task));
  }
  const stash = () => {
    conversationDrafts.set(`${project.id}:last`, selected.current);
    conversationDrafts.set(draftKey(selected.current), {
      prompt,
      mode,
      imageProfile,
      effort,
      files,
      setup,
      setupBase,
      briefRevision,
    });
    if (conversationDrafts.size > 60)
      conversationDrafts.delete(conversationDrafts.keys().next().value);
  };
  useEffect(() => {
    if (!opening) stash();
  }, [
    prompt,
    mode,
    imageProfile,
    effort,
    files,
    setup,
    setupBase,
    briefRevision,
    chat?.id,
    opening,
  ]);
  const clearIdentity = () => {
    nonce.current = null;
    setNotice("");
  };
  const applyServer = (value) => {
    if (
      !alive.current ||
      selected.current !== value.id ||
      value.project !== project.id
    )
      return;
    setChat((previous) => {
      if (
        previous?.id === value.id &&
        (pendingMetadata.current.has(value.id) ||
          (previous.revision || 1) > (value.revision || 1))
      )
        return { ...value, ...metadata(previous) };
      return value;
    });
  };
  async function refresh() {
    const attempt = ++historySequence.current;
    setHistoryLoading(true);
    try {
      const list = await api(`/projects/${project.id}/chats?archived=all`);
      if (!alive.current || attempt !== historySequence.current) return;
      setChats(list);
      setHistoryError("");
      return list;
    } catch (failure) {
      if (alive.current && attempt === historySequence.current)
        setHistoryError("Conversation history could not be loaded.");
      throw failure;
    } finally {
      if (alive.current && attempt === historySequence.current)
        setHistoryLoading(false);
    }
  }
  async function open(id, keepIntent = false) {
    if (operation.current || pendingMetadata.current.size) return false;
    stash();
    const previous = current.current,
      previousId = selected.current;
    const attempt = ++requestSequence.current;
    selected.current = id;
    setOpening(true);
    setEditReply(null);
    setChat(null);
    setError("");
    setRenaming(false);
    nonce.current = null;
    try {
      const value = await api(`/chats/${id}?compact=true`);
      if (
        !alive.current ||
        attempt !== requestSequence.current ||
        selected.current !== id
      )
        return false;
      if (value.project !== project.id)
        throw Error("This conversation belongs to another project.");
      setChat(value);
      setHistoryView(value.archived ? "archived" : "active");
      const draft = conversationDrafts.get(draftKey(id));
      const last = value.turns?.at(-1);
      setPrompt(draft?.prompt || (keepIntent ? initialIntent?.text || "" : ""));
      setMode(draft?.mode || (last?.mode === "code" ? "code" : "chat"));
      setImageProfile(draft?.imageProfile || "auto");
      setEffort(draft?.effort || "low");
      setBriefRevision(draft?.briefRevision ?? null);
      setPreviewSelection(null);
      setFiles(
        draft?.files ||
          (last?.documents || []).map((identity) => ({
            id: identity,
            name:
              last.job?.request?.sources?.find(
                (source) => source.id === identity,
              )?.name ||
              assets.find((asset) => asset.id === identity)?.name ||
              "Selected document",
          })),
      );
      setSetup(draft?.setup || settingsOf(value));
      setSetupBase(
        draft?.setupBase || {
          settings: settingsOf(value),
          revision: value.revision || 1,
        },
      );
      nearBottom.current = !initialIntent?.turnId;
      return true;
    } catch (failure) {
      if (alive.current && attempt === requestSequence.current) {
        selected.current = previousId;
        setChat(previous);
        fail(failure);
      }
      return false;
    } finally {
      if (alive.current && attempt === requestSequence.current)
        setOpening(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    const fresh = recovery.fresh;
    if (fresh) {
      setPrompt(fresh.prompt);
      setMode(fresh.mode);
      setFiles(fresh.files);
      setSetup(fresh.setup);
      setSetupBase(fresh.setupBase);
      setImageProfile(fresh.imageProfile);
      setEffort(fresh.effort);
      setBriefRevision(fresh.briefRevision ?? null);
    }
    refresh()
      .then((list) => {
        if (
          !alive.current ||
          selected.current ||
          initialIntent?.text ||
          initialIntent?.profile ||
          initialIntent?.chatId ||
          initialIntent?.task
        )
          return;
        if (!recovery.last && fresh?.prompt) return;
        const first =
          list?.find((item) => item.id === recovery.last) ||
          list?.find((item) => !item.archived);
        if (first) return open(first.id);
      })
      .catch(fail);
    return () => {
      alive.current = false;
      ++requestSequence.current;
      ++historySequence.current;
    };
  }, [project.id]);
  useEffect(() => {
    if (!initialIntent) return;
    if (initialIntent.project && initialIntent.project !== project.id) return;
    if (initialIntent.task) {
      if (
        !prompt &&
        !incomingTasks.length &&
        !recovery.fresh?.prompt &&
        !opening &&
        !sending &&
        (!initialIntent.task.document ||
          files.length < 8 ||
          files.some((file) => file.id === initialIntent.task.document.id))
      )
        applyIncoming(initialIntent.task);
      else queueIncoming(initialIntent.task);
      onIntentConsumed?.(initialIntent.id);
    } else if (initialIntent.text || initialIntent.profile) {
      if (initialIntent.text) setPrompt(initialIntent.text);
      if (initialIntent.profile)
        setSetup((old) => ({ ...old, profile_id: initialIntent.profile }));
      onIntentConsumed?.(initialIntent.id);
    }
  }, [initialIntent?.id]);
  useEffect(() => {
    if (
      !initialIntent?.chatId ||
      initialIntent.project !== project.id ||
      metadataBusy ||
      sending ||
      opening ||
      navigationAttempt.current === initialIntent.id
    )
      return;
    const intent = initialIntent;
    navigationAttempt.current = intent.id;
    setFailedNavigation(null);
    setFocusTurn(intent.turnId || null);
    nearBottom.current = !intent.turnId;
    open(intent.chatId, true).then((opened) => {
      if (!alive.current || navigationAttempt.current !== intent.id) return;
      if (opened) onIntentConsumed?.(intent.id);
      else setFailedNavigation(intent.id);
    });
  }, [initialIntent?.id, metadataBusy, sending, opening, navigationRetry]);
  useEffect(() => {
    if (!chat?.id || pendingMetadata.current.has(chat.id)) return;
    const saved = settingsOf(chat);
    if (!setupDirty) setSetup(saved);
    if (!setupDirty || same(saved, setupBase.settings))
      setSetupBase({ settings: saved, revision: chat.revision || 1 });
  }, [chat?.id, chat?.revision]);
  useEffect(() => {
    if (!chat?.id) return;
    let stopped = false,
      inFlight = false,
      timer;
    const id = chat.id;
    const poll = async () => {
      clearTimeout(timer);
      if (stopped || document.hidden || inFlight) return;
      inFlight = true;
      let delay = 15000;
      try {
        const generation = optionsVersion.current;
        const value = await api(`/chats/${id}?compact=true`);
        if (!stopped && generation === optionsVersion.current)
          applyServer(value);
        if (value.turns?.some((turn) => !terminal.includes(turn.job.state)))
          delay = 1500;
      } catch (failure) {
        if (!stopped) fail(failure);
      } finally {
        inFlight = false;
        if (!stopped) timer = setTimeout(poll, delay);
      }
    };
    const visible = () => {
      clearTimeout(timer);
      if (!document.hidden) poll();
    };
    timer = setTimeout(poll, busy ? 1500 : 15000);
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [chat?.id, Boolean(busy), sending]);
  useEffect(() => {
    let stopped = false,
      pending = false;
    const presence = async () => {
      if (stopped || pending || document.hidden || worker?.state === "stopped")
        return;
      pending = true;
      try {
        await api("/chat-presence", {});
      } catch {
        /* Presence is best effort and never starts a model. */
      } finally {
        pending = false;
      }
    };
    presence();
    const timer = setInterval(presence, 30000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [worker?.state]);
  useEffect(() => {
    if (nearBottom.current)
      bottom.current?.scrollIntoView({ block: "nearest" });
  }, [chat?.turns]);
  async function createConversation(reuse = false) {
    if (operation.current || metadataBusy || uploading || opening) return;
    operation.current = true;
    setSending(true);
    setError("");
    stash();
    const copiedOptions =
      reuse && chat?.options ? structuredClone(chat.options) : null;
    try {
      let value = await api(`/projects/${project.id}/chats`, {});
      if (!alive.current) return;
      selected.current = value.id;
      setChat(value);
      setChats((list) => [value, ...list]);
      setPrompt("");
      setEditReply(null);
      setFiles([]);
      setBriefRevision(null);
      setPreviewSelection(null);
      setMode("chat");
      setHistoryView("active");
      setHistoryQuery("");
      setSetup(reuse ? { ...setup } : settingsOf(value));
      setSetupBase({
        settings: settingsOf(value),
        revision: value.revision || 1,
      });
      setRenaming(false);
      nonce.current = null;
      if (reuse) {
        value = await api(
          `/chats/${value.id}`,
          { expected_revision: value.revision || 1, settings: { ...setup } },
          "PATCH",
        );
        if (copiedOptions) {
          await api(`/chats/${value.id}/options`, copiedOptions, "PUT");
          value = await api(`/chats/${value.id}?compact=true`);
        }
        if (!alive.current) return;
        setChat(value);
        setSetup(settingsOf(value));
        setSetupBase({ settings: settingsOf(value), revision: value.revision });
      }
      await refresh();
    } catch (failure) {
      fail(failure);
    } finally {
      operation.current = false;
      if (alive.current) setSending(false);
    }
  }
  async function updateConversation(target, changes, savingSetup = false) {
    if (pendingMetadata.current.size || operation.current) return;
    const before = metadata(target),
      oldView = historyView;
    pendingMetadata.current.add(target.id);
    ++historySequence.current;
    setMetadataBusy(target.id);
    setError("");
    setChats((list) =>
      list.map((item) =>
        item.id === target.id ? { ...item, ...changes } : item,
      ),
    );
    if (selected.current === target.id)
      setChat((value) =>
        value?.id === target.id ? { ...value, ...changes } : value,
      );
    if ("archived" in changes)
      setHistoryView(changes.archived ? "archived" : "active");
    try {
      const value = await api(
        `/chats/${target.id}`,
        {
          expected_revision: savingSetup
            ? setupBase.revision
            : target.revision || 1,
          ...changes,
        },
        "PATCH",
      );
      if (!alive.current) return;
      pendingMetadata.current.delete(target.id);
      if (selected.current === target.id) {
        applyServer(value);
        if (savingSetup) {
          setSetup(settingsOf(value));
          setSetupBase({
            settings: settingsOf(value),
            revision: value.revision,
          });
        }
      }
      setChats((list) =>
        list.map((item) =>
          item.id === value.id ? { ...item, ...metadata(value) } : item,
        ),
      );
      if (changes.title) setRenaming(false);
      setNotice(
        savingSetup
          ? "Reply setup saved for this conversation."
          : changes.archived === true
            ? "Conversation archived. Its messages are kept."
            : changes.archived === false
              ? "Conversation restored."
              : "Conversation updated.",
      );
      nonce.current = null;
    } catch (failure) {
      if (!alive.current) return;
      setChats((list) =>
        list.map((item) =>
          item.id === target.id ? { ...item, ...before } : item,
        ),
      );
      if (selected.current === target.id)
        setChat((value) =>
          value?.id === target.id ? { ...value, ...before } : value,
        );
      if ("archived" in changes) setHistoryView(oldView);
      fail(failure);
    } finally {
      pendingMetadata.current.delete(target.id);
      if (alive.current) setMetadataBusy("");
    }
  }
  async function saveSetup() {
    if (samplingInvalid) return;
    if (chat) return updateConversation(chat, { settings: setup }, true);
    if (operation.current || metadataBusy) return;
    operation.current = true;
    setSending(true);
    setError("");
    try {
      let value = await api(`/projects/${project.id}/chats`, {});
      selected.current = value.id;
      setChat(value);
      setSetupBase({
        settings: settingsOf(value),
        revision: value.revision || 1,
      });
      value = await api(
        `/chats/${value.id}`,
        { expected_revision: value.revision || 1, settings: setup },
        "PATCH",
      );
      if (!alive.current) return;
      setChat(value);
      setSetup(settingsOf(value));
      setSetupBase({ settings: settingsOf(value), revision: value.revision });
      setNotice("Reply setup saved for this conversation.");
      await refresh();
    } catch (failure) {
      fail(failure);
    } finally {
      operation.current = false;
      if (alive.current) setSending(false);
    }
  }
  async function reloadConversation() {
    if (!chat || metadataBusy || sending) return;
    setOpening(true);
    setError("");
    const id = chat.id,
      attempt = ++requestSequence.current;
    try {
      const value = await api(`/chats/${id}?compact=true`);
      if (
        !alive.current ||
        selected.current !== id ||
        attempt !== requestSequence.current
      )
        return;
      applyServer(value);
      setSetup(settingsOf(value));
      setSetupBase({ settings: settingsOf(value), revision: value.revision });
      setNotice(
        "Saved conversation setup reloaded. Your message draft is kept.",
      );
      await refresh();
    } catch (failure) {
      fail(failure);
    } finally {
      if (alive.current && attempt === requestSequence.current)
        setOpening(false);
    }
  }
  async function saveOptions(patch) {
    if (optionsDraft || operation.current || metadataBusy || opening) return;
    operation.current = true;
    setOptionsDraft({ ...(current.current?.options || {}), ...patch });
    optionsVersion.current += 1;
    setSending(true);
    setError("");
    try {
      let value = current.current;
      if (!value) {
        value = await api(`/projects/${project.id}/chats`, {});
        if (!alive.current) return;
        selected.current = value.id;
        setChat(value);
        setSetupBase({
          settings: settingsOf(value),
          revision: value.revision || 1,
        });
      }
      await api(
        `/chats/${value.id}/options`,
        {
          conversation:
            value.options?.conversation || defaultConversationOptions,
          tools_enabled: Boolean(value.options?.tools_enabled),
          ...patch,
        },
        "PUT",
      );
      if (!alive.current || selected.current !== value.id) return;
      applyServer(await api(`/chats/${value.id}?compact=true`));
      setNotice(
        "conversation" in patch
          ? "Conversation memory saved for this conversation. Queued work keeps its original settings."
          : patch.tools_enabled
            ? "Project code tools enabled for this conversation."
            : "Project code tools disabled for this conversation.",
      );
      await refresh();
    } catch (failure) {
      fail(failure);
    } finally {
      optionsVersion.current += 1;
      operation.current = false;
      if (alive.current) {
        setOptionsDraft(null);
        setSending(false);
      }
    }
  }
  async function retryReply(job) {
    if (operation.current || !current.current) return;
    operation.current = true;
    setSending(true);
    setError("");
    const id = current.current.id;
    try {
      await api(`/chats/${id}/retry/${job.id}`, {});
      if (!alive.current || selected.current !== id) return;
      applyServer(await api(`/chats/${id}?compact=true`));
      setNotice("Retry queued with the same saved context and tool receipts.");
    } catch (failure) {
      fail(failure);
    } finally {
      operation.current = false;
      if (alive.current) setSending(false);
    }
  }
  async function replaceReply(turn, editedPrompt = null) {
    if (
      operation.current ||
      replacementBlocked ||
      !current.current ||
      (editedPrompt !== null && !editedPrompt.trim())
    )
      return;
    operation.current = true;
    setSending(true);
    setError("");
    const id = current.current.id;
    const body = editedPrompt === null ? {} : { prompt: editedPrompt };
    const signature = JSON.stringify({ id, job: turn.job.id, ...body });
    if (regenerationNonce.current?.signature !== signature) {
      regenerationNonce.current = {
        signature,
        id: Array.from(crypto.getRandomValues(new Uint8Array(16)), (number) =>
          number.toString(16).padStart(2, "0"),
        ).join(""),
      };
    }
    try {
      await api(`/chats/${id}/regenerate/${turn.job.id}`, {
        ...body,
        client_id: regenerationNonce.current.id,
      });
      if (!alive.current || selected.current !== id) return;
      const updated = await api(`/chats/${id}?compact=true`);
      if (!alive.current || selected.current !== id) return;
      applyServer(updated);
      setEditReply(null);
      regenerationNonce.current = null;
      setNotice(
        "New reply queued with the saved sources and current reply setup. The earlier reply is kept.",
      );
      await refresh();
    } catch (failure) {
      fail(failure);
    } finally {
      operation.current = false;
      if (alive.current) setSending(false);
    }
  }
  async function send(event) {
    event.preventDefault();
    if (operation.current || blocked || !prompt.trim()) return;
    operation.current = true;
    setSending(true);
    setError("");
    const sentPrompt = prompt;
    try {
      let value = current.current;
      if (!value) {
        value = await api(`/projects/${project.id}/chats`, {});
        if (!alive.current) return;
        selected.current = value.id;
        setChat(value);
        setSetupBase({
          settings: settingsOf(value),
          revision: value.revision || 1,
        });
      }
      const body = { ...requestBody, context_fingerprint: contextFingerprint };
      const signature = JSON.stringify({
        id: value.id,
        ...body,
        settings: setupBase.settings,
        effectiveDefault: replyDefault,
      });
      if (nonce.current?.signature !== signature)
        nonce.current = {
          signature,
          id: Array.from(crypto.getRandomValues(new Uint8Array(16)), (number) =>
            number.toString(16).padStart(2, "0"),
          ).join(""),
        };
      await api(`/chats/${value.id}/messages`, {
        ...body,
        client_id: nonce.current.id,
      });
      if (!alive.current || selected.current !== value.id) return;
      nonce.current = null;
      setPrompt((text) => (text === sentPrompt ? "" : text));
      setNotice("");
      applyServer(await api(`/chats/${value.id}?compact=true`));
      await refresh();
    } catch (failure) {
      fail(failure);
    } finally {
      operation.current = false;
      if (alive.current) setSending(false);
    }
  }
  async function attach(event) {
    const chosen = [...event.target.files];
    event.target.value = "";
    if (!chosen.length) return;
    if (chosen.length + files.length > 8) {
      fail(
        Error(
          "Select up to 8 documents in total. Remove one before attaching more.",
        ),
      );
      return;
    }
    const at = selected.current;
    setUploading(true);
    clearIdentity();
    try {
      for (const file of chosen) {
        if (file.size > 8 * 1024 * 1024)
          throw Error("Choose documents smaller than 8 MB.");
        const body = new FormData();
        body.append("file", file);
        const saved = await api(`/projects/${project.id}/attachments`, body);
        if (alive.current && selected.current === at)
          setFiles((old) =>
            old.some((item) => item.id === saved.id) ? old : [...old, saved],
          );
      }
    } catch (failure) {
      fail(failure);
    } finally {
      if (alive.current) setUploading(false);
    }
  }
  useEffect(() => {
    if (!focusTurn || !chat?.turns?.some((turn) => turn.id === focusTurn))
      return;
    const frame = requestAnimationFrame(() =>
      document
        .getElementById(`chat-turn-${focusTurn}`)
        ?.scrollIntoView({ block: "center" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [focusTurn, chat?.id, opening]);
  function applyIncoming(task) {
    try {
      const combined = appendDraft(prompt, task.text);
      const nextFiles =
        task.document && !files.some((file) => file.id === task.document.id)
          ? [...files, task.document]
          : files;
      if (nextFiles.length > 8)
        throw Error(
          "Remove a selected document before attaching this result. Your draft is kept.",
        );
      setPrompt(combined);
      setFiles(nextFiles);
      setMode("chat");
      dismissIncoming(task);
      clearIdentity();
      setNotice(
        `Added ${task.source || "the incoming task"} to this Chat draft. Review its context before sending.`,
      );
    } catch (failure) {
      queueIncoming(task);
      fail(failure);
    }
  }
  const editPrompt = (value) => {
    setPrompt(value);
    clearIdentity();
  };
  const useExample = (value, nextMode) => {
    editPrompt(value);
    setMode(nextMode);
    composer.current?.focus();
  };

  return (
    <section className="gpt-studio chat-workspace" aria-label="Chat workspace">
      <aside className="gpt-history" aria-label="Conversation history">
        <div className="gpt-history-title">
          <MessageSquare size={18} />
          <strong>Conversations</strong>
        </div>
        <button
          onClick={() => createConversation()}
          disabled={sending || opening || uploading || Boolean(metadataBusy)}
        >
          <Plus size={16} />
          New conversation
        </button>
        <div
          className="chat-history-tabs"
          role="group"
          aria-label="Conversation collection"
        >
          {["active", "archived"].map((view) => (
            <button
              key={view}
              aria-pressed={historyView === view}
              onClick={() => setHistoryView(view)}
            >
              {view === "active" ? "Active" : "Archived"}
            </button>
          ))}
        </div>
        <div className="gpt-history-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search conversations"
            placeholder="Search titles…"
            value={historyQuery}
            onChange={(event) => setHistoryQuery(event.target.value)}
          />
          {historyQuery && (
            <button
              aria-label="Clear conversation search"
              onClick={() => setHistoryQuery("")}
            >
              <X size={14} />
            </button>
          )}
        </div>
        {historyError ? (
          <div className="gpt-history-empty" role="status">
            <p>{historyError}</p>
            <button onClick={() => refresh().catch(fail)}>Retry history</button>
          </div>
        ) : (
          <p className="gpt-history-count" role="status">
            {historyLoading && !chats.length
              ? "Loading conversations…"
              : historyQuery.trim()
                ? `${matchingChats.length} of ${selectedChats.length} conversations`
                : `${selectedChats.length} conversation${selectedChats.length === 1 ? "" : "s"}`}
          </p>
        )}
        <div className="gpt-chat-list" aria-label="Saved conversations">
          {matchingChats.map((item) => (
            <div
              key={item.id}
              className={`chat-history-row ${chat?.id === item.id ? "selected" : ""}`}
            >
              <button
                className="chat-history-open"
                onClick={() => open(item.id)}
                disabled={sending || uploading || Boolean(metadataBusy)}
                aria-current={chat?.id === item.id ? "true" : undefined}
              >
                {item.pinned && <Pin size={12} />}
                <span>{item.title}</span>
              </button>
              <button
                className="chat-pin"
                aria-label={`${item.pinned ? "Unpin" : "Pin"} ${item.title}`}
                disabled={sending || opening || Boolean(metadataBusy)}
                onClick={() =>
                  updateConversation(item, { pinned: !item.pinned })
                }
              >
                {item.pinned ? <PinOff size={13} /> : <Pin size={13} />}
              </button>
            </div>
          ))}
          {!historyLoading && !historyError && !matchingChats.length && (
            <p className="gpt-history-empty">
              {historyQuery.trim()
                ? "No matching titles. Try another search or clear it."
                : historyView === "archived"
                  ? "No archived conversations. Archive a conversation to keep it here."
                  : "No conversations yet. Start one to save your ideas here."}
            </p>
          )}
        </div>
        <small>
          Saved in {project.name}.<br />
          Inference stays on your Studio host.
        </small>
      </aside>
      <div className="gpt-conversation">
        <header>
          <div>
            <span className="eyebrow">YOUR LOCAL ASSISTANT</span>
            <h1>Chat</h1>
          </div>
          <div className="gpt-header-actions">
            <button
              disabled={!chat?.turns?.length}
              title="Download visible messages, reply states and source references as Markdown"
              onClick={() => {
                try {
                  exportConversation(chat);
                } catch (failure) {
                  fail(failure);
                }
              }}
            >
              <Download size={15} />
              Export conversation
            </button>
          </div>
        </header>
        {(error || failedNavigation === initialIntent?.id) && (
          <div className="notice chat-error" role="alert">
            <span>
              {error ||
                "This conversation has not opened yet. Your draft is kept."}
            </span>
            {failedNavigation && failedNavigation === initialIntent?.id && (
              <button
                disabled={sending || opening || Boolean(metadataBusy)}
                onClick={() => {
                  navigationAttempt.current = null;
                  setNavigationRetry((value) => value + 1);
                }}
              >
                Retry opening conversation
              </button>
            )}
            {chat && (
              <button
                disabled={sending || opening || Boolean(metadataBusy)}
                onClick={reloadConversation}
              >
                Reload saved conversation
              </button>
            )}
            <button
              aria-label="Dismiss chat error"
              onClick={() => setError("")}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {notice && (
          <p className="chat-notice" role="status">
            <Check size={14} />
            {notice}
          </p>
        )}
        {chat && (
          <div className="chat-title-bar">
            {renaming ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (titleDraft.trim())
                    updateConversation(chat, { title: titleDraft.trim() });
                }}
              >
                <label className="chat-title-field">
                  Conversation title
                  <input
                    autoFocus
                    value={titleDraft}
                    maxLength={150}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    disabled={Boolean(metadataBusy)}
                  />
                </label>
                <button disabled={Boolean(metadataBusy) || !titleDraft.trim()}>
                  <Check size={14} />
                  Save title
                </button>
                <button
                  type="button"
                  onClick={() => setRenaming(false)}
                  disabled={Boolean(metadataBusy)}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <h2>{chat.title}</h2>
                <button
                  aria-label="Rename conversation"
                  disabled={sending || opening || Boolean(metadataBusy)}
                  onClick={() => {
                    setTitleDraft(chat.title);
                    setRenaming(true);
                  }}
                >
                  <Pencil size={14} />
                </button>
                {chat.archived ? (
                  <button
                    disabled={sending || opening || Boolean(metadataBusy)}
                    onClick={() =>
                      updateConversation(chat, { archived: false })
                    }
                  >
                    <ArchiveRestore size={14} />
                    Restore conversation
                  </button>
                ) : (
                  <button
                    disabled={sending || Boolean(metadataBusy) || Boolean(busy)}
                    title={
                      busy
                        ? "Stop or wait for the current reply before archiving"
                        : "Keep this conversation in the archive"
                    }
                    onClick={() => updateConversation(chat, { archived: true })}
                  >
                    <Archive size={14} />
                    Archive
                  </button>
                )}
              </>
            )}
          </div>
        )}
        {chat?.archived && (
          <p className="notice">
            This conversation is archived. Restore it to continue chatting; its
            messages and setup are kept.
          </p>
        )}
        <div className="chat-configuration">
          <ModelStatus
            tools={tools}
            task={activeRole}
            value={useImage ? imageProfile : setup.profile_id}
            defaultId={useImage ? defaultImageProfile : replyDefault}
            worker={worker}
            conversation={conversation}
            onModels={() => {
              stash();
              onSetup?.();
            }}
          />
          <details className="chat-reply-setup" ref={setupDetails}>
            <summary>
              <Settings2 size={14} />
              Reply setup ·{" "}
              {PRESETS.find((preset) => preset.id === setup.preset)?.label ||
                "General"}
              {setupDirty
                ? " · unsaved changes"
                : " · applies to your next reply"}
            </summary>
            <div className="chat-setup-body">
              <label>
                Response preset
                <select
                  aria-label="Response preset"
                  disabled={sending || opening || Boolean(metadataBusy)}
                  value={setup.preset}
                  onChange={(event) => {
                    setSetup({ ...setup, preset: event.target.value });
                    clearIdentity();
                  }}
                >
                  {PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="helper">
                {
                  PRESETS.find((preset) => preset.id === setup.preset)
                    ?.description
                }
              </p>
              <label>
                Custom response instructions
                <textarea
                  aria-label="Custom response instructions"
                  rows={3}
                  maxLength={2000}
                  value={setup.instructions}
                  disabled={sending || opening || Boolean(metadataBusy)}
                  onChange={(event) => {
                    setSetup({ ...setup, instructions: event.target.value });
                    clearIdentity();
                  }}
                  placeholder="For example: write for a beginner, use metric units, and ask when key facts are missing."
                />
              </label>
              <details className="chat-sampling">
                <summary>Sampling & role</summary>
                <p className="helper">
                  Leave a field blank to use the model default. These settings
                  apply to text replies and are saved with each request.
                </p>
                <label>
                  System role
                  <textarea
                    aria-label="System role"
                    rows={2}
                    maxLength={2000}
                    value={setup.system_role || ""}
                    disabled={sending || opening || Boolean(metadataBusy)}
                    onChange={(event) =>
                      samplingField("system_role", event.target.value)
                    }
                    placeholder="For example: act as a patient maths tutor."
                  />
                </label>
                <p className="helper">
                  Sets the role and style within Studio’s existing tool
                  permissions and source rules.
                </p>
                <div className="chat-sampling-grid">
                  {[
                    ["temperature", "Temperature", 0, 2, 0.05, "Model default"],
                    ["top_p", "Top p", 0.01, 1, 0.01, "Runtime default"],
                    [
                      "seed",
                      "Seed",
                      0,
                      Number.MAX_SAFE_INTEGER,
                      1,
                      "Studio default",
                    ],
                    [
                      "max_output_tokens",
                      "Maximum output tokens",
                      1,
                      outputLimit || 200000,
                      1,
                      outputLimit
                        ? `Model default (${outputLimit})`
                        : "Model default",
                    ],
                  ].map(([key, label, min, max, step, placeholder]) => (
                    <label key={key}>
                      {label}
                      <input
                        type="number"
                        aria-label={label}
                        min={min}
                        max={max}
                        step={step}
                        placeholder={placeholder}
                        value={setup[key] ?? ""}
                        disabled={sending || opening || Boolean(metadataBusy)}
                        onChange={(event) =>
                          samplingField(key, event.target.value)
                        }
                      />
                    </label>
                  ))}
                </div>
                {samplingInvalid && (
                  <p role="alert">
                    Use the displayed sampling ranges and a whole-number seed
                    and output limit.
                  </p>
                )}
                <button
                  type="button"
                  disabled={sending || opening || Boolean(metadataBusy)}
                  onClick={() => {
                    setSetup((previous) => {
                      const next = { ...previous };
                      for (const key of [
                        "system_role",
                        "temperature",
                        "top_p",
                        "seed",
                        "max_output_tokens",
                      ])
                        delete next[key];
                      return next;
                    });
                    clearIdentity();
                  }}
                >
                  Reset sampling & role
                </button>
              </details>
              <ModelChoice
                tools={tools}
                task={replyRole}
                value={setup.profile_id}
                defaultId={replyDefault}
                disabled={sending || opening || Boolean(metadataBusy)}
                label="Conversation model"
                conversation={conversation}
                onChange={(profile_id) => {
                  setSetup({ ...setup, profile_id });
                  clearIdentity();
                }}
              />
              <p className="helper">
                Saved with this conversation and used for future text replies.
                Image requests use the image model and prompt only.
              </p>
              {memoryCapable && (
                <ConversationControls
                  value={conversation}
                  disabled={
                    Boolean(optionsDraft) ||
                    sending ||
                    opening ||
                    Boolean(metadataBusy) ||
                    Boolean(chat?.archived)
                  }
                  onChange={(conversation) => saveOptions({ conversation })}
                  pending={chat?.profile_change_pending}
                  component={replyModel?.package?.optional_components?.find(
                    (item) => item.id === "w3a4",
                  )}
                  technical={chat?.conversation_details}
                />
              )}
              <label className="conversation-option">
                <span>
                  <strong>Project code tools</strong>
                  <small>
                    Allow reading selected source documents and saving new
                    drafts. No code execution, arbitrary files or sending
                    messages. Requires Qwen3.8 MXFP4 + DFlash2. Saved
                    immediately for this conversation.
                  </small>
                </span>
                <input
                  type="checkbox"
                  checked={
                    optionsDraft?.tools_enabled ??
                    chat?.options?.tools_enabled ??
                    false
                  }
                  disabled={
                    Boolean(optionsDraft) ||
                    sending ||
                    opening ||
                    Boolean(metadataBusy) ||
                    Boolean(chat?.archived) ||
                    (!memoryCapable && !chat?.options?.tools_enabled)
                  }
                  onChange={(e) =>
                    saveOptions({ tools_enabled: e.target.checked })
                  }
                />
              </label>
              <div className="actions">
                <button
                  type="button"
                  className="primary"
                  disabled={
                    !setupDirty ||
                    samplingInvalid ||
                    sending ||
                    Boolean(metadataBusy) ||
                    opening
                  }
                  onClick={saveSetup}
                >
                  Save reply setup
                </button>
                {setupDirty && (
                  <button
                    type="button"
                    disabled={sending || opening || Boolean(metadataBusy)}
                    onClick={() => {
                      setSetup(setupBase.settings);
                      clearIdentity();
                    }}
                  >
                    Discard setup changes
                  </button>
                )}
                <button
                  type="button"
                  disabled={
                    setupDirty ||
                    sending ||
                    opening ||
                    uploading ||
                    Boolean(metadataBusy)
                  }
                  onClick={() => createConversation(true)}
                >
                  <Plus size={14} />
                  New with this setup
                </button>
              </div>
            </div>
          </details>
        </div>
        <div
          className="gpt-transcript"
          onScroll={(event) => {
            const box = event.currentTarget;
            nearBottom.current =
              box.scrollHeight - box.scrollTop - box.clientHeight < 120;
          }}
        >
          {opening ? (
            <p role="status">Opening conversation…</p>
          ) : (
            !chat?.turns?.length && (
              <div className="gpt-welcome">
                <Sparkles size={28} />
                <h2>What shall we work on?</h2>
                <p>
                  Ask a question, explore a document, draft code or create an
                  image.
                </p>
                <div>
                  {[
                    [
                      "Explain something",
                      "Explain how solar panels work in plain language, with one everyday example.",
                      "chat",
                    ],
                    [
                      "Analyze a document",
                      "Summarize my selected documents. List the key decisions, open questions and source excerpts.",
                      "chat",
                    ],
                    [
                      "Create an image",
                      "Generate an image of a peaceful mountain cabin at sunrise.",
                      "image",
                    ],
                    [
                      "Help with code",
                      "Write a Python function that removes duplicates while preserving order. Explain its edge cases.",
                      "code",
                    ],
                  ].map(([label, text, nextMode]) => (
                    <button
                      key={label}
                      onClick={() => useExample(text, nextMode)}
                      disabled={sending}
                    >
                      {label}
                      <ArrowUp size={15} />
                    </button>
                  ))}
                </div>
              </div>
            )
          )}
          {chat?.turns?.map((turn) => (
            <article
              key={turn.id}
              id={`chat-turn-${turn.id}`}
              className={`gpt-turn${focusTurn === turn.id ? " search-destination" : ""}`}
            >
              <div className="gpt-user">{turn.prompt}</div>
              {turn.superseded && (
                <p className="helper">
                  Earlier reply kept · a newer reply is used for future context.
                </p>
              )}
              {editReply?.job === turn.job.id && (
                <form
                  className="chat-edit-reply"
                  onSubmit={(event) => {
                    event.preventDefault();
                    replaceReply(turn, editReply.prompt);
                  }}
                >
                  <label>
                    Edit latest prompt
                    <textarea
                      aria-label="Edit latest prompt"
                      rows={4}
                      maxLength={200000}
                      value={editReply.prompt}
                      disabled={sending}
                      onChange={(event) =>
                        setEditReply({
                          job: turn.job.id,
                          prompt: event.target.value,
                        })
                      }
                    />
                  </label>
                  <p className="helper">
                    Uses this turn’s saved documents, project brief and code
                    context with your current reply setup. The earlier reply
                    stays saved.
                  </p>
                  <div className="chat-replacement-actions">
                    <button
                      type="submit"
                      className="primary"
                      disabled={replacementBlocked || !editReply.prompt.trim()}
                    >
                      Send edited prompt
                    </button>
                    <button
                      type="button"
                      disabled={sending}
                      onClick={() => setEditReply(null)}
                    >
                      Cancel edit
                    </button>
                  </div>
                </form>
              )}
              {turn.documents?.length > 0 && (
                <p className="gpt-doc-count">
                  <FileText size={13} />
                  {turn.documents.length} local document
                  {turn.documents.length > 1 ? "s" : ""}
                </p>
              )}
              <div className="gpt-assistant">
                <div className="gpt-avatar">✦</div>
                <div className="gpt-response">
                  {turn.answer ? (
                    <>
                      <Reply
                        text={turn.answer}
                        report={fail}
                        onCode={
                          onHandoff
                            ? (text, language) =>
                                onHandoff({
                                  kind: "code",
                                  target: "coding",
                                  text,
                                  language,
                                  project_id: project.id,
                                  title: `Chat: ${chat.title}`,
                                  asset_id: turn.asset?.id,
                                })
                            : undefined
                        }
                      />
                      <ResultActions
                        source={{
                          kind: "text",
                          text: turn.answer,
                          project_id: project.id,
                          title: `Chat: ${chat.title}`,
                          asset_id: turn.asset?.id,
                        }}
                        onHandoff={onHandoff}
                      />
                    </>
                  ) : turn.asset?.kind === "image" ? (
                    <figure>
                      <img
                        src={`/api/assets/${turn.asset.id}`}
                        alt={turn.prompt}
                      />
                      <figcaption>
                        Created locally · saved in your project{" "}
                        <a href={`/api/assets/${turn.asset.id}?download=true`}>
                          Download
                        </a>
                      </figcaption>
                      <ResultActions
                        source={{
                          kind: "image",
                          project_id: project.id,
                          title: turn.asset.name || "Chat image",
                          asset_id: turn.asset.id,
                        }}
                        onHandoff={onHandoff}
                      />
                    </figure>
                  ) : !terminal.includes(turn.job.state) ? (
                    <>
                      <p className="gpt-stage" role="status">
                        {stageForJob(turn.job).title}
                      </p>
                      <QueueEstimate estimate={turn.job.estimate} />
                      {turn.partial ? (
                        <Reply text={turn.partial} report={fail} />
                      ) : (
                        <p className="helper">{turn.job.message}</p>
                      )}
                    </>
                  ) : (
                    <div role="status">
                      {turn.job.state === "cancelled" && (
                        <span className="badge" aria-label="Reply stopped">
                          {turn.partial
                            ? "Stopped · partial reply saved"
                            : "Stopped"}
                        </span>
                      )}
                      <p>{turn.job.message}</p>
                      {turn.partial && (
                        <Reply text={turn.partial} report={fail} />
                      )}
                      {chat.turns.at(-1)?.id === turn.id && (
                        <button
                          disabled={sending || Boolean(chat.archived)}
                          onClick={() => retryReply(turn.job)}
                        >
                          Retry saved request
                        </button>
                      )}
                      {chat.turns.at(-1)?.id !== turn.id && (
                        <button
                          disabled={sending || Boolean(chat.archived)}
                          onClick={() => {
                            useExample(turn.prompt, turn.mode);
                            setNotice(
                              "Message restored. Review the current setup and document context before sending.",
                            );
                          }}
                        >
                          Edit and retry
                        </button>
                      )}
                    </div>
                  )}
                  <div className="gpt-meta">
                    <span>
                      {technicalModel(
                        {
                          id: turn.job.request?.profile?.package,
                          model: turn.job.request?.profile?.model,
                        },
                        turn.job.request?.profile?.conversation_options,
                      ) || "Local model"}
                    </span>
                    {turn.answer && (
                      <button
                        aria-label="Copy reply"
                        onClick={() => copyText(turn.answer).catch(fail)}
                      >
                        <Copy size={13} />
                      </button>
                    )}
                    {turn.asset?.metadata?.finish_reason === "length" && (
                      <strong>Response budget reached; ask to continue.</strong>
                    )}
                  </div>
                  {chat.turns.at(-1)?.id === turn.id &&
                    turn.mode !== "image" &&
                    terminal.includes(turn.job.state) && (
                      <div className="chat-replacement-actions">
                        {turn.job.state === "completed" && (
                          <button
                            type="button"
                            disabled={replacementBlocked}
                            onClick={() => replaceReply(turn)}
                          >
                            <RefreshCw size={13} /> Regenerate
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={replacementBlocked}
                          onClick={() =>
                            setEditReply({
                              job: turn.job.id,
                              prompt: turn.prompt,
                            })
                          }
                        >
                          <Pencil size={13} /> Edit and resend
                        </button>
                        {setupDirty && (
                          <span className="helper">
                            Save reply setup before generating a new reply.
                          </span>
                        )}
                      </div>
                    )}
                  {turn.job.request?.profile?.package === "qwen38-mxfp4" && (
                    <details className="gpt-sources chat-runtime-receipt">
                      <summary>Technical details</summary>
                      <dl>
                        <div>
                          <dt>Weights</dt>
                          <dd>
                            {weightsLabel(
                              turn.job.request.profile.conversation_options,
                            )}
                          </dd>
                        </div>
                        {turn.asset?.metadata?.conversation &&
                          (() => {
                            const saved = turn.asset.metadata.conversation;
                            return (
                              <>
                                <div>
                                  <dt>Context ceiling</dt>
                                  <dd>
                                    {Number(saved.context).toLocaleString()}{" "}
                                    tokens, including the reply
                                  </dd>
                                </div>
                                {kvCacheLabel(saved) && (
                                  <div>
                                    <dt>KV cache precision</dt>
                                    <dd>{kvCacheLabel(saved)}</dd>
                                  </div>
                                )}
                                {typeof saved.prefix_caching === "boolean" && (
                                  <div>
                                    <dt>Conversation cache reuse</dt>
                                    <dd>
                                      {saved.prefix_caching ? "On" : "Off"}
                                    </dd>
                                  </div>
                                )}
                                <div>
                                  <dt>Reserved KV cache</dt>
                                  <dd>
                                    {Number(saved.kv_cache_gib).toLocaleString(
                                      undefined,
                                      { maximumFractionDigits: 2 },
                                    )}{" "}
                                    GiB
                                  </dd>
                                </div>
                                {saved.aggregate_kv_tokens != null && (
                                  <div>
                                    <dt>Total KV capacity</dt>
                                    <dd>
                                      {Number(
                                        saved.aggregate_kv_tokens,
                                      ).toLocaleString()}{" "}
                                      tokens; separate from the per-request
                                      ceiling
                                    </dd>
                                  </div>
                                )}
                                <div>
                                  <dt>Tool parser</dt>
                                  <dd>{saved.tool_parser}</dd>
                                </div>
                              </>
                            );
                          })()}
                      </dl>
                    </details>
                  )}
                  {(turn.sampling || turn.job.request?.sampling) && (
                    <details className="gpt-sources chat-sampling-receipt">
                      <summary>Sampling used</summary>
                      <dl>
                        {(() => {
                          const sampling =
                            turn.sampling || turn.job.request.sampling;
                          return [
                            ["Temperature", sampling.temperature],
                            [
                              "Top p",
                              sampling.top_p == null
                                ? "Runtime default"
                                : sampling.top_p,
                            ],
                            ["Seed", sampling.seed],
                            [
                              "Maximum output tokens",
                              sampling.max_output_tokens,
                            ],
                            [
                              "System role",
                              sampling.system_role || "Studio default",
                            ],
                          ].map(([label, value]) => (
                            <div key={label}>
                              <dt>{label}</dt>
                              <dd>{String(value)}</dd>
                            </div>
                          ));
                        })()}
                      </dl>
                    </details>
                  )}
                  {["failed", "interrupted"].includes(turn.job.state) && (
                    <Diagnostics
                      api={api}
                      endpoint={`/jobs/${turn.job.id}/diagnostics`}
                    />
                  )}
                  {turn.job.state === "completed" && (
                    <>
                      <PerformanceSummary
                        metrics={
                          turn.asset?.metadata?.performance || {
                            output_tokens:
                              turn.asset?.metadata?.usage?.completion_tokens,
                          }
                        }
                      />
                      <ImageTime asset={turn.asset} />
                      <PerformanceDetails metadata={turn.asset?.metadata} />
                    </>
                  )}
                  {turn.job.request?.history_excerpted && (
                    <p className="helper">
                      Earlier conversation text was excerpted for this reply.
                      Full messages remain saved here.
                    </p>
                  )}
                  {turn.context && (
                    <div className="gpt-context-note">
                      {turn.context.summarized
                        ? "Older material summarized locally. Original messages remain saved."
                        : "Saved conversation context included."}{" "}
                      {turn.context.input_tokens?.toLocaleString()} input tokens
                      · {turn.context.output_reserved?.toLocaleString()}{" "}
                      reserved for the reply.{" "}
                      <a
                        href={`/api/chats/${chat.id}/context/${turn.job.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View submitted context
                      </a>
                    </div>
                  )}
                  {turn.asset?.metadata?.tool_artifacts?.length > 0 && (
                    <p className="gpt-context-note">
                      {turn.asset.metadata.tool_artifacts.length} code draft(s)
                      saved in the project Library for review. Nothing executed.
                    </p>
                  )}
                  {(turn.project_brief || turn.job.request?.project_brief) && (
                    <p className="helper">
                      Project brief saved with this reply.
                    </p>
                  )}
                  {(turn.job.request?.context_snapshot ||
                    turn.job.request?.messages ||
                    turn.job.request?.project_brief ||
                    turn.job.request?.task === "image") && (
                    <ContextInspector
                      snapshot={
                        turn.job.request.context_snapshot || turn.job.request
                      }
                      load={() =>
                        api(`/chats/${chat.id}/snapshot/${turn.job.id}`)
                      }
                    />
                  )}
                  {turn.job.request?.sources?.length > 0 && (
                    <details className="gpt-sources">
                      <summary>Saved document sources</summary>
                      <p>
                        Source versions are preserved with this conversation.
                        Older material may be summarized to fit the selected
                        context.
                      </p>
                      {turn.job.request.sources.map((source) => (
                        <p key={source.id}>
                          {sourceName(source.name)} ·{" "}
                          {source.sha256
                            ? `saved version ${source.sha256.slice(0, 8)}`
                            : source.excerpts?.length
                              ? `excerpts ${source.excerpts.join(", ")}`
                              : "not included in this answer context"}
                        </p>
                      ))}
                    </details>
                  )}
                  {(
                    turn.coding_context ||
                    turn.job.request?.coding_context ||
                    []
                  ).some((source) => relativeSource(source.path)) && (
                    <details className="gpt-sources">
                      <summary>Supporting code files · saved snapshots</summary>
                      {(turn.coding_context || turn.job.request.coding_context)
                        .filter((source) => relativeSource(source.path))
                        .map((source) => (
                          <p
                            key={source.path}
                            title={source.version || undefined}
                          >
                            {source.path} · saved with this reply
                          </p>
                        ))}
                    </details>
                  )}
                  {(turn.chat_settings || turn.job.request?.chat_settings) && (
                    <details className="gpt-sources">
                      <summary>Reply setup used</summary>
                      <p>
                        {PRESETS.find(
                          (preset) =>
                            preset.id ===
                            (
                              turn.chat_settings ||
                              turn.job.request.chat_settings
                            ).preset,
                        )?.label || "General"}
                        {(turn.chat_settings_applied ??
                          turn.job.request.chat_settings_applied) === false
                          ? " · not used · image requests ignore reply setup"
                          : " · used for this reply"}
                      </p>
                      {(turn.chat_settings || turn.job.request.chat_settings)
                        .instructions && (
                        <p className="chat-instruction-snapshot">
                          {
                            (
                              turn.chat_settings ||
                              turn.job.request.chat_settings
                            ).instructions
                          }
                        </p>
                      )}
                    </details>
                  )}
                </div>
              </div>
            </article>
          ))}
          <div ref={bottom} />
        </div>
        {incomingTask && (
          <section
            className="workspace-incoming"
            aria-label="Incoming Chat task"
          >
            <strong>{incomingTask.source || "Incoming task"}</strong>
            <p>Your current draft is kept. Add this task when ready.</p>
            {incomingTasks.length > 1 && (
              <p>{incomingTasks.length} incoming tasks waiting for review.</p>
            )}
            <details>
              <summary>Preview incoming task</summary>
              <pre>{incomingTask.text}</pre>
            </details>
            <div className="actions">
              <button
                type="button"
                disabled={sending || opening || uploading}
                onClick={() => applyIncoming(incomingTask)}
              >
                Add to my draft
              </button>
              <button
                type="button"
                onClick={() => dismissIncoming(incomingTask)}
              >
                Keep my draft
              </button>
            </div>
          </section>
        )}
        <form className="gpt-composer" onSubmit={send}>
          <div className="chat-context-heading">
            <span>
              <FileText size={13} />
              {useImage
                ? "Image request · prompt only"
                : files.length
                  ? `${files.length} document${files.length === 1 ? "" : "s"} selected for the next reply`
                  : "No documents selected"}
            </span>
            {files.length > 0 && (
              <button
                type="button"
                disabled={uploading || sending}
                onClick={() => {
                  setFiles([]);
                  clearIdentity();
                  setNotice(
                    "Document selection cleared. Earlier messages remain part of the conversation.",
                  );
                }}
              >
                Clear documents
              </button>
            )}
          </div>
          {files.length > 0 && (
            <div className="gpt-files">
              {files.map((file) => (
                <span key={file.id}>
                  <FileText size={13} />
                  {sourceName(file.name)}
                  <button
                    type="button"
                    aria-label={`Remove ${sourceName(file.name)}`}
                    disabled={sending || uploading}
                    onClick={() => {
                      setFiles((old) =>
                        old.filter((item) => item.id !== file.id),
                      );
                      clearIdentity();
                    }}
                  >
                    <X size={13} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={composer}
            aria-label="Message Chat"
            placeholder="Message Chat…"
            value={prompt}
            disabled={opening || Boolean(chat?.archived)}
            onChange={(event) => editPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                send(event);
              }
            }}
            maxLength={useImage ? promptLimit * 2 : promptLimit}
            aria-describedby={useImage ? "chat-image-prompt-limit" : undefined}
            aria-invalid={promptOverLimit || undefined}
          />
          {useImage && (
            <p
              id="chat-image-prompt-limit"
              className="helper prompt-limit"
              role={promptOverLimit ? "alert" : undefined}
            >
              {readiness.selected?.label && `${readiness.selected.label} · `}
              {readiness.selected?.steps &&
                `${readiness.selected.steps} steps · `}
              {promptLength} / {promptLimit} characters
              {promptOverLimit &&
                " · Shorten your prompt or choose another image profile. Your draft is kept."}
            </p>
          )}
          <div className="gpt-compose-actions">
            <input
              ref={upload}
              type="file"
              multiple
              hidden
              accept=".pdf,.docx,.txt,.md,.csv,.json,.py,.js,.ts,.html,.css,.log"
              onChange={attach}
            />
            <button
              type="button"
              aria-label="Attach documents"
              disabled={
                uploading ||
                sending ||
                files.length >= 8 ||
                useImage ||
                Boolean(chat?.archived)
              }
              onClick={() => upload.current.click()}
            >
              <Paperclip size={17} />
              {uploading ? "Reading…" : "Attach"}
            </button>
            <select
              aria-label="Conversation mode"
              value={mode}
              disabled={sending || opening || Boolean(metadataBusy)}
              onChange={(event) => {
                setMode(event.target.value);
                clearIdentity();
              }}
            >
              <option value="chat">Chat</option>
              <option value="code">Code</option>
              <option value="image">Create image</option>
              <option value="auto">Auto</option>
            </select>
            {busy ? (
              <button
                type="button"
                onClick={() =>
                  api(`/jobs/${busy.job.id}/cancel`, {})
                    .then(async () =>
                      applyServer(await api(`/chats/${chat.id}?compact=true`)),
                    )
                    .catch(fail)
                }
              >
                <Square size={15} />
                Stop
              </button>
            ) : (
              <button
                className="primary gpt-send"
                disabled={blocked || !prompt.trim()}
                aria-label="Send message"
              >
                <ArrowUp size={19} />
              </button>
            )}
          </div>
          {setupDirty && (
            <p className="chat-setup-warning">
              Save your reply setup before sending.{" "}
              <button
                type="button"
                onClick={() => {
                  if (setupDetails.current) setupDetails.current.open = true;
                  setupDetails.current?.scrollIntoView({ block: "nearest" });
                }}
              >
                Review setup
              </button>
            </p>
          )}
          <details className="chat-context-details">
            <summary>Choose project documents &amp; reply options</summary>
            <p>
              Selected documents are saved as complete snapshots with the reply;
              unchanged versions are not resent. Clearing them does not erase
              earlier messages or answers. Keep up to 8 documents selected
              across replies, or remove them when your topic changes.
            </p>
            {projectDocuments.length > 0 && (
              <label>
                Add a project document
                <select
                  aria-label="Add a project document"
                  value=""
                  disabled={
                    sending ||
                    uploading ||
                    files.length >= 8 ||
                    useImage ||
                    Boolean(chat?.archived)
                  }
                  onChange={(event) => {
                    const file = projectDocuments.find(
                      (item) => item.id === event.target.value,
                    );
                    if (file) setFiles((old) => [...old, file]);
                    clearIdentity();
                  }}
                >
                  <option value="">Choose a saved document…</option>
                  {projectDocuments
                    .filter(
                      (document) =>
                        !files.some((file) => file.id === document.id),
                    )
                    .map((document) => (
                      <option key={document.id} value={document.id}>
                        {sourceName(document.name)}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {!useImage && (
              <ProjectBrief
                key={`${project.id}:${chat?.id || "new"}`}
                project={project}
                api={api}
                value={briefRevision}
                disabled={sending || opening || Boolean(metadataBusy)}
                onBusyChange={setBriefBusy}
                onChange={(revision) => {
                  setBriefRevision(revision);
                  setPreviewSelection(null);
                  clearIdentity();
                }}
              />
            )}
            {useImage ? (
              <>
                <ModelChoice
                  tools={tools}
                  task="image"
                  value={imageProfile}
                  defaultId={defaultImageProfile}
                  onChange={(value) => {
                    setImageProfile(value);
                    clearIdentity();
                  }}
                  label="Image model"
                  disabled={sending}
                  details
                />
                <p>
                  Images use your prompt only. The document selection is kept
                  for your next text reply, and the text model cannot see
                  generated image pixels.
                </p>
              </>
            ) : (
              <label>
                Reasoning effort
                <select
                  aria-label="Reasoning effort"
                  value={adjustableReasoning ? effort : "low"}
                  disabled={sending || !adjustableReasoning}
                  onChange={(event) => {
                    setEffort(event.target.value);
                    clearIdentity();
                  }}
                >
                  <option value="low">
                    {adjustableReasoning ? "Quick reasoning" : "Direct answers"}
                  </option>
                  <option value="medium">Balanced reasoning</option>
                  <option value="high">Deeper reasoning</option>
                </select>
              </label>
            )}
            <p>
              PDF, DOCX or UTF-8 files, up to 8 MB each. Scanned PDFs need OCR
              first. The complete saved conversation is submitted; older
              material is summarized locally only when it exceeds the selected
              context, and the full conversation stays saved. Auto recognizes
              direct image requests such as “create an image”.
            </p>
          </details>
          <ContextInspector
            key={contextVersion}
            api={api}
            endpoint={
              chat
                ? `/chats/${chat.id}/context`
                : `/projects/${project.id}/chat-context`
            }
            body={{ ...requestBody, client_id: "0".repeat(32) }}
            disabled={
              !prompt.trim() ||
              promptOverLimit ||
              sending ||
              uploading ||
              opening ||
              Boolean(metadataBusy) ||
              setupDirty ||
              (!useImage && briefBusy)
            }
            onBusyChange={setContextBusy}
            onChange={(fingerprint) =>
              setPreviewSelection(
                fingerprint ? { identity: contextIdentity, fingerprint } : null,
              )
            }
          />
          <p className="gpt-disclaimer">
            Local processing. Review facts and code. Loading a model can take
            several minutes.
          </p>
        </form>
      </div>
    </section>
  );
}
