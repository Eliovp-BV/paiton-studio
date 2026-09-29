import React, { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Braces,
  Check,
  Code2,
  Cpu,
  Copy,
  Download,
  FileCode2,
  FilePlus2,
  FolderOpen,
  Laptop,
  MessageSquare,
  RefreshCw,
  Save,
  Search,
  Send,
  Sparkles,
  Square,
  Upload,
  WrapText,
  X,
} from "lucide-react";
import ModelStatus, { modelReadiness } from "./ModelStatus";
import CodeConnections from "./CodeConnections";
import CodeDiff from "./CodeDiff";
import ProjectBrief from "./ProjectBrief";
import ResultActions from "./ResultActions";
import { appendDraft } from "./workspaceLinks";
import ContextInspector from "./ContextInspector";
import {
  CODE_CONTEXT_LIMIT,
  codeBlocks,
  codeId,
  codingPrompt,
  copyText,
  downloadText,
  reviewedReplacement,
  sourceTextOffset,
  editorTextOffset,
} from "./codeWorkspace";
import "./coding-studio.css";

const TERMINAL = ["completed", "failed", "cancelled"];
const dirty = (buffer) => buffer.content !== buffer.baseContent;
const basename = (path) => path.split("/").at(-1);
function readCache(key) {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || "{}");
    return value.version === 1 ? value : {};
  } catch {
    return {};
  }
}
function Answer({ text, onReview, report }) {
  return codeBlocks(text).map((part, index) =>
    part.code !== undefined ? (
      <div className="coding-answer-code" key={index}>
        <div>
          <span>{part.language}</span>
          <button
            onClick={() =>
              copyText(part.code)
                .then(() => report("Code copied."))
                .catch((e) => report(e.message))
            }
          >
            <Copy size={13} /> Copy
          </button>
          {onReview && (
            <button onClick={() => onReview(part.code)}>
              Review change <ArrowRight size={13} />
            </button>
          )}
        </div>
        <pre>
          <code>{part.code}</code>
        </pre>
      </div>
    ) : (
      <p className="coding-answer-text" key={index}>
        {part.text}
      </p>
    ),
  );
}

export default function CodingStudio({
  project,
  api,
  tools,
  worker,
  onMCP,
  onAgents,
  onModelAPI,
  onModels,
  defaultProfile = "auto",
  initialPrompt = "",
  initialIntent,
  onIntentConsumed,
  onHandoff,
}) {
  const receivedIntent = useRef(null);
  const cacheKey = `paiton-code-drafts:${project.id}`;
  const cache = useRef(readCache(cacheKey));
  const [incomingTasks, setIncomingTasks] = useState(
    cache.current.incomingTasks || [],
  );
  const incomingTask = incomingTasks[0] || null;
  const [workspace, setWorkspace] = useState(null),
    [buffers, setBuffers] = useState(cache.current.buffers || {});
  const [active, setActive] = useState(cache.current.active || ""),
    [filter, setFilter] = useState("");
  const [searchMode, setSearchMode] = useState("files"),
    [searchQuery, setSearchQuery] = useState(""),
    [matchCase, setMatchCase] = useState(false),
    [searchResult, setSearchResult] = useState(null),
    [searchBusy, setSearchBusy] = useState(false),
    [searchError, setSearchError] = useState("");
  const [brief, setBrief] = useState(null),
    [briefBusy, setBriefBusy] = useState(false),
    [contextPreview, setContextPreview] = useState(null),
    [previewBusy, setPreviewBusy] = useState(false);
  const searchInput = useRef(null),
    searchSequence = useRef(0);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [newFile, setNewFile] = useState(false),
    [filename, setFilename] = useState("");
  const [connect, setConnect] = useState(false),
    [wrap, setWrap] = useState(false),
    [assistant, setAssistant] = useState(true);
  const [selection, setSelection] = useState(null),
    [contextMode, setContextMode] = useState("file"),
    [editorFocus, setEditorFocus] = useState(null);
  const [question, setQuestion] = useState(
      cache.current.question || initialPrompt,
    ),
    [profile, setProfile] = useState(
      cache.current.preferenceDraft?.profile_id || "auto",
    );
  const [preferences, setPreferences] = useState(null),
    [instructions, setInstructions] = useState(
      cache.current.preferenceDraft?.instructions || "",
    ),
    [preferencesError, setPreferencesError] = useState(""),
    [preferencesBusy, setPreferencesBusy] = useState(false);
  const [references, setReferences] = useState([]),
    [loadingFiles, setLoadingFiles] = useState({}),
    [contextBusy, setContextBusy] = useState(false),
    [history, setHistory] = useState([]),
    [historyBusy, setHistoryBusy] = useState(false),
    [historyError, setHistoryError] = useState("");
  const [chat, setChat] = useState(null),
    [chatId, setChatId] = useState(cache.current.chatId || ""),
    [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState(""),
    [chatAttempt, setChatAttempt] = useState(0);
  const [snapshots, setSnapshots] = useState(cache.current.snapshots || {}),
    [review, setReview] = useState(null),
    [cacheWarning, setCacheWarning] = useState("");
  const input = useRef(null),
    folderInput = useRef(null),
    editor = useRef(null),
    gutter = useRef(null);
  const reviewDialog = useRef(null);
  const bufferRef = useRef(buffers),
    activeRef = useRef(active),
    alive = useRef(true),
    operation = useRef(false),
    askOperation = useRef(false),
    nonce = useRef(null),
    chatRef = useRef(null);
  const reads = useRef({}),
    navigationSequence = useRef(0),
    refreshSequence = useRef(0);
  const contextModeRef = useRef(contextMode);
  contextModeRef.current = contextMode;
  bufferRef.current = buffers;
  activeRef.current = active;
  chatRef.current = chat;
  const base = `/projects/${project.id}/code`;
  const buffer = buffers[active];
  const changed = Object.values(buffers).filter(dirty);
  const files = [
    ...new Map(
      [...(workspace?.files || []), ...Object.values(buffers)].map((file) => [
        file.path,
        file,
      ]),
    ).values(),
  ].sort((a, b) => a.path.localeCompare(b.path));
  const visibleFiles = files.filter((file) =>
    file.path.toLowerCase().includes(filter.toLowerCase()),
  );
  const runningTurn = chat?.turns?.find(
    (turn) => !TERMINAL.includes(turn.job.state),
  );
  const paused = worker?.state === "stopped";
  const model = modelReadiness({
    tools,
    task: "code",
    value: profile,
    defaultId: defaultProfile,
    worker,
  });
  const preferenceDirty =
    preferences &&
    (profile !== preferences.profile_id ||
      instructions !== preferences.instructions);
  const referenceSize = references.reduce(
    (total, file) => total + file.content.length,
    0,
  );
  const restoringChat = Boolean(chatId && !chat);
  const chosenRange =
    contextMode === "selection" &&
    selection?.path === active &&
    selection.end > selection.start
      ? selection
      : null;
  const contextSize =
    contextMode === "none" || !buffer
      ? 0
      : chosenRange
        ? chosenRange.end - chosenRange.start
        : buffer.content.length;
  const invalidContext =
    (contextMode !== "none" && (!buffer || Boolean(loadingFiles[active]))) ||
    contextSize > CODE_CONTEXT_LIMIT ||
    (contextMode === "selection" && !chosenRange);
  const currentSnapshot =
    contextMode !== "none" && buffer
      ? {
          path: active,
          content: buffer.content,
          version: buffer.version,
          start: chosenRange?.start || 0,
          end: chosenRange?.end ?? buffer.content.length,
        }
      : null;
  let previewBody = null;
  if (!invalidContext && question.trim())
    previewBody = {
      prompt: codingPrompt(question, currentSnapshot),
      mode: "code",
      profile_id: profile,
      coding_context: references.map(({ path, version }) => ({
        path,
        version,
      })),
      coding_instructions: instructions,
      inherit_documents: false,
      project_brief_revision: brief,
    };
  const previewVersion = JSON.stringify({
    chat: chatId,
    settings: chat?.settings,
    history: chat?.turns?.map((turn) => [turn.id, turn.job.state, turn.answer]),
    defaultProfile,
    model: model.selected?.id,
  });
  const previewIdentity = JSON.stringify({
    version: previewVersion,
    body: previewBody,
  });
  const previewFingerprint =
    contextPreview?.identity === previewIdentity
      ? contextPreview.fingerprint
      : null;

  useEffect(() => {
    if (contextMode !== "none")
      setReferences((current) =>
        current.filter((file) => file.path !== active),
      );
  }, [active, contextMode]);

  async function loadPreferences(discardDraft = false) {
    setPreferencesBusy(true);
    setPreferencesError("");
    try {
      const value = await api(`${base}/preferences`);
      if (!alive.current) return;
      const draft = !discardDraft && cache.current.preferenceDraft;
      setPreferences(draft?.base || value);
      setProfile(draft ? draft.profile_id : value.profile_id);
      setInstructions(draft ? draft.instructions : value.instructions);
      if (draft && draft.base.version !== value.version)
        setPreferencesError(
          "AI setup changed in another window. Your draft is kept. Load the saved setup before changing it again.",
        );
      if (discardDraft) cache.current.preferenceDraft = null;
    } catch (failure) {
      if (alive.current) setPreferencesError(failure.message);
    } finally {
      if (alive.current) setPreferencesBusy(false);
    }
  }
  async function savePreferences() {
    if (!preferences || preferencesBusy) return;
    setPreferencesBusy(true);
    setPreferencesError("");
    const pending = {
      profile_id: profile,
      instructions,
      version: preferences.version,
    };
    try {
      const value = await api(`${base}/preferences`, pending, "PUT");
      if (!alive.current) return;
      setPreferences(value);
      cache.current.preferenceDraft = null;
      setNotice("AI setup saved for this project. No model was loaded.");
    } catch (failure) {
      if (alive.current) setPreferencesError(failure.message);
    } finally {
      if (alive.current) setPreferencesBusy(false);
    }
  }
  async function toggleReference(path) {
    if (contextBusy) return;
    if (references.some((file) => file.path === path)) {
      setReferences((old) => old.filter((file) => file.path !== path));
      return;
    }
    if (references.length >= 4) return;
    setContextBusy(true);
    setError("");
    try {
      const file = await api(`${base}/file?path=${encodeURIComponent(path)}`);
      if (referenceSize + file.content.length > 12000)
        throw Error(
          "Supporting files can contain up to 12,000 characters in total. Choose smaller files or use a selection in the editor.",
        );
      if (
        alive.current &&
        (contextModeRef.current === "none" || file.path !== activeRef.current)
      )
        setReferences((old) => [...old, file]);
    } catch (failure) {
      if (alive.current) setError(failure.message);
    } finally {
      if (alive.current) setContextBusy(false);
    }
  }
  async function refreshReferences() {
    if (contextBusy) return;
    setContextBusy(true);
    setError("");
    try {
      const files = await Promise.all(
        references.map((file) =>
          api(`${base}/file?path=${encodeURIComponent(file.path)}`),
        ),
      );
      if (files.reduce((total, file) => total + file.content.length, 0) > 12000)
        throw Error(
          "Supporting files now exceed 12,000 characters. Remove a file before continuing.",
        );
      if (alive.current) {
        setReferences(
          files.filter(
            (file) =>
              contextModeRef.current === "none" ||
              file.path !== activeRef.current,
          ),
        );
        setNotice("Supporting files refreshed from the Studio host.");
      }
    } catch (failure) {
      if (alive.current) setError(failure.message);
    } finally {
      if (alive.current) setContextBusy(false);
    }
  }
  async function loadHistory() {
    setHistoryBusy(true);
    setHistoryError("");
    try {
      const value = await api(`/projects/${project.id}/chats`);
      if (alive.current)
        setHistory(
          value.filter(
            (item) =>
              item.last_mode === "code" || item.title.startsWith("Code ·"),
          ),
        );
    } catch (failure) {
      if (alive.current) setHistoryError(failure.message);
    } finally {
      if (alive.current) setHistoryBusy(false);
    }
  }
  function resumeConversation(id) {
    if (runningTurn || sending || id === chatId) return;
    setChat(null);
    chatRef.current = null;
    setChatId(id);
    setChatError("");
    nonce.current = null;
    setNotice(
      "Conversation opened. Your current files and AI setup are kept; review the context before sending.",
    );
  }

  function changeBuffers(fn) {
    const next = fn(bufferRef.current);
    bufferRef.current = next;
    setBuffers(next);
  }
  function invalidateSearch() {
    searchSequence.current++;
    setSearchResult(null);
    setSearchError("");
    setSearchBusy(false);
  }
  async function searchContents(event) {
    event.preventDefault();
    if (!searchQuery) return;
    const request = ++searchSequence.current;
    setSearchBusy(true);
    setSearchResult(null);
    setSearchError("");
    try {
      const value = await api(
        `${base}/search?query=${encodeURIComponent(searchQuery)}&case_sensitive=${matchCase}`,
      );
      if (alive.current && request === searchSequence.current)
        setSearchResult(value);
    } catch (failure) {
      if (alive.current && request === searchSequence.current)
        setSearchError(failure.message);
    } finally {
      if (alive.current && request === searchSequence.current)
        setSearchBusy(false);
    }
  }
  async function openSearchMatch(match) {
    const navigation = navigationSequence.current + 1;
    if ((await loadFile(match.path)) === false) return;
    if (
      !alive.current ||
      activeRef.current !== match.path ||
      navigationSequence.current !== navigation
    )
      return;
    const file = bufferRef.current[match.path];
    if (
      !file ||
      file.version !== match.version ||
      dirty(file) ||
      file.content.slice(match.start, match.end) !== match.match
    ) {
      setNotice(
        "This result refers to an earlier saved file. Your draft is kept. Save or refresh the file, then search again.",
      );
      return;
    }
    setEditorFocus({
      navigation,
      path: match.path,
      file,
      start: match.start,
      end: match.end,
      line: match.line,
    });
  }
  async function reviewDraft() {
    const path = activeRef.current,
      original = bufferRef.current[path];
    if (!original) return;
    await action("Reading saved version…", async () => {
      let saved;
      try {
        saved = await api(`${base}/file?path=${encodeURIComponent(path)}`);
      } catch (failure) {
        if (failure.status !== 404) throw failure;
        saved = { content: "", version: null };
      }
      if (bufferRef.current[path] !== original)
        throw Error(
          "Your draft changed while opening the comparison. Open Review changes again.",
        );
      if (alive.current)
        setReview({
          type: "draft",
          path,
          before: saved.content,
          after: original.content,
          deleted: saved.version === null,
        });
    });
  }
  async function loadFile(path) {
    navigationSequence.current++;
    setActive(path);
    activeRef.current = path;
    setSelection(null);
    setError("");
    if (bufferRef.current[path] && dirty(bufferRef.current[path])) return;
    try {
      await readIntoBuffer(path);
    } catch (failure) {
      if (alive.current) setError(failure.message);
      return false;
    }
  }
  async function readIntoBuffer(path) {
    const original = bufferRef.current[path];
    const request = (reads.current[path] || 0) + 1;
    reads.current[path] = request;
    setLoadingFiles((old) => ({ ...old, [path]: true }));
    try {
      const file = await api(`${base}/file?path=${encodeURIComponent(path)}`);
      if (alive.current && reads.current[path] === request)
        changeBuffers((current) =>
          current[path] !== original || (current[path] && dirty(current[path]))
            ? current
            : { ...current, [path]: { ...file, baseContent: file.content } },
        );
    } finally {
      if (alive.current && reads.current[path] === request)
        setLoadingFiles((old) => ({ ...old, [path]: false }));
    }
  }
  async function refresh() {
    const request = ++refreshSequence.current;
    const originalBuffers = bufferRef.current;
    const value = await api(base);
    if (!alive.current || request !== refreshSequence.current) return;
    setWorkspace(value);
    if (!value.truncated && !value.over_limit) {
      const present = new Set(value.files.map((file) => file.path));
      changeBuffers((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([path, file]) =>
              present.has(path) ||
              dirty(file) ||
              originalBuffers[path] !== file,
          ),
        ),
      );
      if (
        !present.has(activeRef.current) &&
        !bufferRef.current[activeRef.current]
      ) {
        setActive("");
        activeRef.current = "";
      }
    }
    const path =
      activeRef.current ||
      ["index.html", "main.py", "main.js"].find((name) =>
        value.files.some((file) => file.path === name),
      ) ||
      value.files.find((file) => !file.path.startsWith("."))?.path ||
      value.files[0]?.path;
    if (!path) return;
    if (!activeRef.current) {
      setActive(path);
      activeRef.current = path;
    }
    const metadata = value.files.find((file) => file.path === path);
    const old = bufferRef.current[path];
    if (old && dirty(old)) {
      if (!metadata && !value.truncated && !value.over_limit)
        setNotice(
          "This file was removed on the Studio host. Your draft is kept. Save it to review recreating the file, or download your draft.",
        );
      if (metadata && metadata.version !== old.version)
        setNotice(
          "This file also changed on the Studio host. Your draft is kept; saving will let you review both versions.",
        );
      return;
    }
    if (!metadata) return;
    await readIntoBuffer(path);
  }
  useEffect(() => {
    alive.current = true;
    loadPreferences();
    refresh().catch((failure) => {
      if (alive.current) setError(failure.message);
    });
    const focus = () => {
      if (!operation.current) refresh().catch(() => {});
    };
    const warn = (event) => {
      if (Object.values(bufferRef.current).some(dirty)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const shortcuts = (event) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        (event.key.toLowerCase() === "p" ||
          (event.shiftKey && event.key.toLowerCase() === "f"))
      ) {
        if (reviewDialog.current) return;
        event.preventDefault();
        invalidateSearch();
        setSearchMode(event.shiftKey ? "contents" : "files");
        requestAnimationFrame(() => {
          searchInput.current?.focus();
          searchInput.current?.select();
        });
      }
    };
    window.addEventListener("focus", focus);
    window.addEventListener("beforeunload", warn);
    window.addEventListener("keydown", shortcuts);
    return () => {
      alive.current = false;
      window.removeEventListener("focus", focus);
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("keydown", shortcuts);
    };
  }, [project.id]);
  function queueIncoming(task) {
    setIncomingTasks((tasks) =>
      tasks.includes(task) ? tasks : [...tasks, task],
    );
  }
  function dismissIncoming(task) {
    setIncomingTasks((tasks) => tasks.filter((item) => item !== task));
  }
  function addIncomingTask(task) {
    try {
      const combined = appendDraft(question, task.text, 1200);
      setQuestion(combined);
      setAssistant(true);
      dismissIncoming(task);
      if (!bufferRef.current[activeRef.current]) setContextMode("none");
      nonce.current = null;
      setNotice(
        `Added ${task.source || "the incoming task"} to your question. Review the included files before asking.`,
      );
    } catch (failure) {
      queueIncoming(task);
      setError(failure.message);
    }
  }
  useEffect(() => {
    if (
      !initialIntent ||
      initialIntent.project !== project.id ||
      !workspace ||
      receivedIntent.current === initialIntent.id
    )
      return;
    receivedIntent.current = initialIntent.id;
    if (initialIntent.kind === "task") {
      if (question.trim() || incomingTasks.length) queueIncoming(initialIntent);
      else addIncomingTask(initialIntent);
      setAssistant(true);
      onIntentConsumed?.(initialIntent.id);
      return;
    }
    if (initialIntent.kind === "draft") {
      const path = initialIntent.path;
      if (
        bufferRef.current[path] ||
        workspace.files.some((file) => file.path === path)
      ) {
        setError(
          "A file or draft already uses the result's name. Open the original result again and choose another file name; your files are kept.",
        );
      } else {
        ++navigationSequence.current;
        changeBuffers((old) => ({
          ...old,
          [path]: {
            path,
            content: initialIntent.content,
            baseContent: null,
            version: null,
            language: initialIntent.language,
            origin: initialIntent.source,
          },
        }));
        activeRef.current = path;
        setActive(path);
        setSelection(null);
        setNotice(
          `Opened an unsaved draft from ${initialIntent.source || "a result"}. Review it and save when ready.`,
        );
      }
      onIntentConsumed?.(initialIntent.id);
      return;
    }
    if (initialIntent.kind === "open") {
      const expected = navigationSequence.current + 1;
      loadFile(initialIntent.path)
        .then((loaded) => {
          if (
            !alive.current ||
            loaded === false ||
            navigationSequence.current !== expected ||
            activeRef.current !== initialIntent.path
          )
            return;
          const opened = bufferRef.current[initialIntent.path];
          if (
            !opened ||
            dirty(opened) ||
            (initialIntent.version && opened.version !== initialIntent.version)
          ) {
            setNotice(
              "Search found the saved file. Your unsaved draft is kept; save or refresh before jumping to its saved lines.",
            );
            return;
          }
          const lines = opened.content.split("\n"),
            line = Math.max(1, Math.min(initialIntent.line || 1, lines.length));
          const start = lines
              .slice(0, line - 1)
              .reduce((n, value) => n + value.length + 1, 0),
            end = start + lines[line - 1].replace(/\r$/, "").length;
          setEditorFocus({
            navigation: expected,
            path: initialIntent.path,
            file: opened,
            start,
            end,
            line,
          });
        })
        .finally(() => onIntentConsumed?.(initialIntent.id));
    }
  }, [initialIntent?.id, workspace?.project_id]);
  useEffect(() => {
    if (!editorFocus) return;
    const { navigation, path, file, start, end, line } = editorFocus;
    if (
      !alive.current ||
      navigationSequence.current !== navigation ||
      activeRef.current !== path ||
      bufferRef.current[path] !== file
    ) {
      setEditorFocus(null);
      return;
    }
    // An async file read can finish before React commits its textarea. Apply
    // the jump only once the exact saved buffer has a rendered editor.
    if (active !== path || buffer !== file || !editor.current) return;
    setEditorFocus(null);
    editor.current.focus();
    editor.current.setSelectionRange(
      editorTextOffset(file.content, start),
      editorTextOffset(file.content, end),
    );
    editor.current.scrollTop = Math.max(
      0,
      (line - 4) *
        parseFloat(getComputedStyle(editor.current).lineHeight || "22"),
    );
  }, [editorFocus, active, buffer]);
  useEffect(() => {
    try {
      const data = JSON.stringify({
        version: 1,
        active,
        buffers: Object.fromEntries(
          Object.entries(buffers).filter(([, value]) => dirty(value)),
        ),
        question,
        incomingTasks,
        chatId,
        snapshots: Object.fromEntries(Object.entries(snapshots).slice(-8)),
        preferenceDraft: preferences
          ? preferenceDirty
            ? { profile_id: profile, instructions, base: preferences }
            : null
          : cache.current.preferenceDraft,
      });
      if (data.length > 2 * 1024 * 1024) throw Error();
      sessionStorage.setItem(cacheKey, data);
      setCacheWarning("");
    } catch {
      try {
        sessionStorage.removeItem(cacheKey);
      } catch {
        /* Storage may be disabled. */
      }
      setCacheWarning(
        "Browser draft recovery is unavailable. Save your changes to the Studio host before leaving this page.",
      );
    }
  }, [
    buffers,
    active,
    question,
    incomingTasks,
    chatId,
    snapshots,
    cacheKey,
    preferences,
    profile,
    instructions,
  ]);
  useEffect(() => {
    if (!chatId) return;
    let live = true,
      timer;
    const poll = async () => {
      try {
        const value = await api(`/chats/${chatId}`);
        if (!live) return;
        if (value.project !== project.id) {
          setChatId("");
          throw Error("This conversation belongs to another project.");
        }
        setChat(value);
        setChatError("");
        if (value.turns.some((turn) => !TERMINAL.includes(turn.job.state)))
          timer = setTimeout(poll, document.hidden ? 6000 : 1800);
      } catch (failure) {
        if (live) {
          setChatError(failure.message);
          timer = setTimeout(poll, 6000);
        }
      }
    };
    poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [chatId, sending, project.id, chatAttempt]);
  useEffect(() => {
    if (!review) return;
    const previous = document.activeElement;
    const dialog = reviewDialog.current;
    dialog?.querySelector("button")?.focus();
    const keyboard = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setReview(null);
      }
      if (event.key === "Tab") {
        const buttons = [...dialog.querySelectorAll("button:not(:disabled)")];
        const first = buttons[0],
          last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("keydown", keyboard);
      if (previous?.isConnected) previous.focus();
    };
  }, [review]);

  async function action(label, fn) {
    if (operation.current) return;
    operation.current = true;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (failure) {
      if (alive.current) setError(failure.message);
    } finally {
      operation.current = false;
      if (alive.current) setBusy("");
    }
  }
  async function saveFile(path) {
    const original = bufferRef.current[path];
    if (!original || !dirty(original)) return;
    try {
      const saved = await api(
        `${base}/file`,
        { path, content: original.content, version: original.version },
        "PUT",
      );
      if (!alive.current) return;
      changeBuffers((old) => ({
        ...old,
        [path]: {
          ...saved,
          content: old[path].content,
          baseContent: saved.content,
        },
      }));
      setNotice(`${basename(path)} saved to the Studio host.`);
    } catch (failure) {
      if (failure.status === 409) {
        let disk;
        try {
          disk = await api(`${base}/file?path=${encodeURIComponent(path)}`);
        } catch (readFailure) {
          if (readFailure.status !== 404) throw readFailure;
          if (alive.current)
            setReview({
              type: "conflict",
              deleted: true,
              path,
              before: "The file no longer exists on the Studio host.",
              after: bufferRef.current[path].content,
              disk: { version: null, content: null },
            });
          return;
        }
        if (alive.current)
          setReview({
            type: "conflict",
            path,
            before: disk.content,
            after: bufferRef.current[path].content,
            disk,
          });
      }
      throw failure;
    }
  }
  function saveCurrent() {
    return action("Saving…", async () => {
      await saveFile(activeRef.current);
      await refresh();
    });
  }
  function saveAll() {
    return action("Saving files…", async () => {
      for (const file of Object.values(bufferRef.current).filter(dirty))
        await saveFile(file.path);
      await refresh();
    });
  }
  async function starter(template) {
    await action("Creating workspace…", async () => {
      await api(`${base}/starter`, { template });
      await refresh();
      if (template === "empty") setNewFile(true);
    });
  }
  async function createFile(event) {
    event.preventDefault();
    const path = filename.trim();
    await action("Creating file…", async () => {
      const saved = await api(
        `${base}/file`,
        { path, content: "", version: null },
        "PUT",
      );
      if (!alive.current) return;
      changeBuffers((old) => ({
        ...old,
        [path]: { ...saved, baseContent: saved.content },
      }));
      setActive(path);
      activeRef.current = path;
      setFilename("");
      setNewFile(false);
      await refresh();
    });
  }
  async function importFiles(event, directory = false) {
    const incoming = Array.from(event.target.files || []);
    event.target.value = "";
    if (!incoming.length) return;
    await action("Importing source files…", async () => {
      const candidates = incoming.filter(
        (file) =>
          !(directory ? file.webkitRelativePath : file.name)
            .split("/")
            .some((part) =>
              ["node_modules", ".git", ".venv", "venv", "__pycache__"].includes(
                part.toLowerCase(),
              ),
            ),
      );
      if (candidates.length > 256)
        throw Error(
          "Choose up to 256 source files. For larger projects, use VS Code with the project folder.",
        );
      let count = 0;
      const failures = [];
      for (const file of candidates) {
        const path = directory
          ? file.webkitRelativePath.split("/").slice(1).join("/")
          : file.name;
        try {
          if (file.size > (workspace?.limits?.file_bytes || 512 * 1024))
            throw Error("File is larger than 512 KB.");
          const content = new TextDecoder("utf-8", { fatal: true }).decode(
            await file.arrayBuffer(),
          );
          await api(`${base}/file`, { path, content, version: null }, "PUT");
          count++;
        } catch (failure) {
          failures.push(`${path}: ${failure.message}`);
        }
      }
      if (!alive.current) return;
      await refresh();
      setNotice(
        `${count} ${count === 1 ? "file" : "files"} imported. Existing files are kept.${incoming.length > candidates.length ? " Dependency and Git folders were skipped." : ""}`,
      );
      if (failures.length)
        setError(
          failures.slice(0, 5).join("\n") +
            (failures.length > 5
              ? `\n${failures.length - 5} more files could not be imported.`
              : ""),
        );
    });
  }
  function edit(content) {
    const path = activeRef.current;
    changeBuffers((old) => ({ ...old, [path]: { ...old[path], content } }));
    setNotice("");
  }
  function editorKey(event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveCurrent();
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const text = bufferRef.current[activeRef.current].content;
      const start = sourceTextOffset(text, event.currentTarget.selectionStart),
        end = sourceTextOffset(text, event.currentTarget.selectionEnd);
      edit(text.slice(0, start) + "  " + text.slice(end));
      requestAnimationFrame(() =>
        editor.current?.setSelectionRange(
          editorTextOffset(text, start) + 2,
          editorTextOffset(text, start) + 2,
        ),
      );
    }
  }
  async function ask(event) {
    event.preventDefault();
    if (
      askOperation.current ||
      paused ||
      !model.canRun ||
      !preferences ||
      preferencesBusy ||
      briefBusy ||
      previewBusy ||
      contextBusy ||
      restoringChat ||
      runningTurn ||
      invalidContext ||
      !question.trim()
    )
      return;
    askOperation.current = true;
    setSending(true);
    setError("");
    const selected = bufferRef.current[activeRef.current];
    const snapshot =
      contextMode !== "none" && selected
        ? {
            path: activeRef.current,
            content: selected.content,
            version: selected.version,
            start: chosenRange?.start || 0,
            end: chosenRange?.end ?? selected.content.length,
          }
        : null;
    try {
      const body = previewBody;
      const prompt = body.prompt;
      let conversation = chatRef.current;
      if (!conversation) {
        conversation = await api(`/projects/${project.id}/chats`, {
          title: `Code · ${project.name}`.slice(0, 150),
        });
        if (!alive.current) return;
        chatRef.current = conversation;
        setChat(conversation);
        setChatId(conversation.id);
      }
      const coding_context = references.map(({ path, version }) => ({
        path,
        version,
      }));
      const signature = JSON.stringify({
        body,
        context_fingerprint: previewFingerprint,
        snapshot,
        coding_context,
        instructions,
      });
      const request =
        nonce.current?.signature === signature &&
        nonce.current?.chatId === conversation.id
          ? nonce.current
          : { id: codeId(), signature, chatId: conversation.id };
      nonce.current = request;
      setSnapshots((old) => ({
        ...old,
        [request.id]: { ...snapshot, question, attached: Boolean(snapshot) },
      }));
      await api(`/chats/${conversation.id}/messages`, {
        ...body,
        client_id: request.id,
        context_fingerprint: previewFingerprint,
      });
      if (!alive.current) return;
      setQuestion((current) => (current === question ? "" : current));
      nonce.current = null;
      setChat(await api(`/chats/${conversation.id}`));
    } catch (failure) {
      if (alive.current) setError(failure.message);
    } finally {
      askOperation.current = false;
      if (alive.current) setSending(false);
    }
  }
  function reviewSuggestion(turn, code) {
    try {
      const snapshot = snapshots[turn.client_id];
      const after = reviewedReplacement(
        snapshot,
        code,
        bufferRef.current[snapshot?.path],
      );
      setReview({
        type: "suggestion",
        path: snapshot.path,
        before: snapshot.content,
        after,
        snapshot,
      });
    } catch (failure) {
      setError(failure.message);
    }
  }
  function applyReview() {
    try {
      if (review.type === "suggestion") {
        reviewedReplacement(
          review.snapshot,
          "",
          bufferRef.current[review.path],
        );
        changeBuffers((old) => ({
          ...old,
          [review.path]: { ...old[review.path], content: review.after },
        }));
        setNotice(
          "Change applied to your draft. Save the file when you’re ready.",
        );
      } else {
        changeBuffers((old) => ({
          ...old,
          [review.path]: {
            ...old[review.path],
            version: review.disk.version,
            baseContent: review.disk.content,
          },
        }));
        setNotice(
          review.deleted
            ? "Your draft is ready to recreate this file. Save the file when you’re ready."
            : "Your draft is kept against the reviewed version. Save the file to write your changes.",
        );
      }
      setActive(review.path);
      activeRef.current = review.path;
      setReview(null);
      setError("");
    } catch (failure) {
      setError(failure.message);
    }
  }
  function useDiskVersion() {
    changeBuffers((old) => ({
      ...old,
      [review.path]: { ...review.disk, baseContent: review.disk.content },
    }));
    setReview(null);
    setError("");
    setNotice("Loaded the version saved on the Studio host.");
  }
  async function newConversation() {
    if (runningTurn || sending) return;
    setChat(null);
    chatRef.current = null;
    setChatId("");
    setChatError("");
    setSnapshots({});
    nonce.current = null;
    setNotice(
      "New coding conversation. Previous conversations remain in Chat.",
    );
  }

  return (
    <section className="coding-studio" aria-label="Coding workspace">
      <header className="coding-heading">
        <div>
          <span className="eyebrow">YOUR PROJECT, IN CODE</span>
          <h1>Coding</h1>
          <p>Write here. Continue in VS Code. Keep your work together.</p>
        </div>
        <div className="actions">
          <button
            onClick={() => setAssistant((value) => !value)}
            aria-pressed={assistant}
          >
            <MessageSquare size={16} /> Assistant
          </button>
          <button
            className="primary"
            disabled={!workspace?.exists}
            onClick={() => setConnect((value) => !value)}
          >
            <Laptop size={17} /> Connect VS Code
          </button>
        </div>
      </header>
      {connect && workspace && (
        <CodeConnections
          workspace={workspace}
          project={project}
          onClose={() => setConnect(false)}
          onMCP={onMCP}
          onModelAPI={onModelAPI}
        />
      )}
      {(error || cacheWarning) && (
        <p className="notice coding-error" role="alert">
          {error || cacheWarning}
        </p>
      )}
      {notice && (
        <p className="coding-notice" role="status">
          <Check size={14} /> {notice}
        </p>
      )}
      {!workspace && !error && <p role="status">Opening project files…</p>}
      {workspace &&
        files.length === 0 &&
        !newFile &&
        !question &&
        !incomingTask && (
          <div className="coding-start panel">
            <span className="coding-start-icon">
              <Code2 size={35} />
            </span>
            <h2>What would you like to build?</h2>
            <p>
              Start with a few files, or bring your own source code. Everything
              is saved in {project.name} on the Studio host.
            </p>
            <div className="coding-starters">
              <button disabled={!!busy} onClick={() => starter("static-web")}>
                <Braces size={25} />
                <strong>A web page</strong>
                <span>HTML, CSS and JavaScript. No dependencies.</span>
              </button>
              <button disabled={!!busy} onClick={() => starter("python")}>
                <FileCode2 size={25} />
                <strong>A Python project</strong>
                <span>A small script you can make your own.</span>
              </button>
              <button disabled={!!busy} onClick={() => starter("empty")}>
                <FilePlus2 size={25} />
                <strong>Start from scratch</strong>
                <span>Your own files, language and structure.</span>
              </button>
            </div>
            <div className="actions">
              <button disabled={!!busy} onClick={() => input.current.click()}>
                <Upload size={16} /> Import files
              </button>
              <button
                disabled={!!busy}
                onClick={() => folderInput.current.click()}
              >
                <FolderOpen size={16} /> Import a folder
              </button>
              <button onClick={onAgents}>
                Explore coding agents <ArrowRight size={15} />
              </button>
            </div>
          </div>
        )}
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(event) => importFiles(event)}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        webkitdirectory=""
        hidden
        onChange={(event) => importFiles(event, true)}
      />
      {newFile && (
        <form className="coding-new-file" onSubmit={createFile}>
          <label>
            New file path
            <input
              autoFocus
              required
              maxLength={240}
              placeholder="src/main.py"
              value={filename}
              onChange={(event) => setFilename(event.target.value)}
            />
          </label>
          <button className="primary" disabled={!!busy}>
            Create file
          </button>
          <button type="button" onClick={() => setNewFile(false)}>
            Cancel
          </button>
        </form>
      )}
      {workspace &&
        (files.length > 0 || newFile || question || incomingTask) && (
          <div
            className={`coding-layout${assistant ? "" : " coding-no-assistant"}`}
          >
            <aside className="coding-explorer" aria-label="Project files">
              <div className="coding-pane-title">
                <strong>Files</strong>
                <div>
                  <button
                    aria-label="New code file"
                    title="New file"
                    disabled={!!busy}
                    onClick={() => setNewFile(true)}
                  >
                    <FilePlus2 size={16} />
                  </button>
                  <button
                    aria-label="Refresh project files"
                    title="Refresh files from Studio host"
                    disabled={!!busy}
                    onClick={() => action("Refreshing…", refresh)}
                  >
                    <RefreshCw size={15} />
                  </button>
                </div>
              </div>
              <div
                className="coding-search-modes"
                role="group"
                aria-label="Search scope"
              >
                <button
                  aria-pressed={searchMode === "files"}
                  onClick={() => {
                    invalidateSearch();
                    setSearchMode("files");
                  }}
                >
                  Files
                </button>
                <button
                  aria-pressed={searchMode === "contents"}
                  onClick={() => {
                    invalidateSearch();
                    setSearchMode("contents");
                  }}
                >
                  Contents
                </button>
              </div>
              <label className="coding-search">
                <Search size={14} />
                <input
                  ref={searchInput}
                  aria-label={
                    searchMode === "files"
                      ? "Find a code file"
                      : "Find in saved files"
                  }
                  maxLength={searchMode === "contents" ? 200 : undefined}
                  value={searchMode === "files" ? filter : searchQuery}
                  onChange={(event) => {
                    if (searchMode === "files") setFilter(event.target.value);
                    else {
                      invalidateSearch();
                      setSearchQuery(event.target.value);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (searchMode === "contents" && event.key === "Enter")
                      searchContents(event);
                  }}
                  placeholder={
                    searchMode === "files"
                      ? "Find a file…"
                      : "Find in saved files…"
                  }
                />
              </label>
              {searchMode === "contents" && (
                <div className="coding-content-search">
                  <label>
                    <input
                      type="checkbox"
                      checked={matchCase}
                      onChange={(event) => {
                        invalidateSearch();
                        setMatchCase(event.target.checked);
                      }}
                    />{" "}
                    Match case
                  </label>
                  <button
                    disabled={searchBusy || !searchQuery}
                    onClick={searchContents}
                  >
                    {searchBusy ? "Searching…" : "Search saved files"}
                  </button>
                  <p className="helper">
                    Searches saved source files. Unsaved drafts are excluded.
                  </p>
                  {searchError && <p role="alert">{searchError}</p>}
                  {searchResult && (
                    <>
                      <p role="status">
                        {searchResult.matches.length}
                        {searchResult.limit_reached ? "+" : ""} matches in{" "}
                        {searchResult.searched_files} searched files.
                        {searchResult.partial
                          ? " Workspace limits reached; results are partial."
                          : ""}
                        {searchResult.limit_reached
                          ? " Refine your search to see more."
                          : ""}
                      </p>
                      <div
                        className="coding-search-results"
                        aria-label="Content search results"
                      >
                        {searchResult.matches.map((match, index) => (
                          <button
                            key={index}
                            onClick={() => openSearchMatch(match)}
                            title={match.preview}
                          >
                            <strong>
                              {match.path}:{match.line}
                            </strong>
                            <code>{match.preview}</code>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
              <nav hidden={searchMode !== "files"}>
                {visibleFiles.map((file) => (
                  <button
                    key={file.path}
                    title={file.path}
                    aria-current={active === file.path ? "page" : undefined}
                    onClick={() => loadFile(file.path)}
                  >
                    <FileCode2 size={15} />
                    <span>{file.path}</span>
                    {buffers[file.path] && dirty(buffers[file.path]) && (
                      <i aria-label="Unsaved changes" />
                    )}
                  </button>
                ))}
              </nav>
              {searchMode === "files" && !visibleFiles.length && (
                <p className="helper">No matching files.</p>
              )}
              <div className="coding-explorer-actions">
                <button disabled={!!busy} onClick={() => input.current.click()}>
                  <Upload size={14} /> Import files
                </button>
                <button
                  disabled={!!busy}
                  onClick={() => folderInput.current.click()}
                >
                  <FolderOpen size={14} /> Import folder
                </button>
                <a className="button" href={`/api${base}/export.zip`} download>
                  <Download size={14} /> Export saved files
                </a>
              </div>
              {!!workspace.skipped && (
                <p className="helper">
                  Some items are excluded from this text workspace, such as
                  dependencies, hidden files and binary files.
                </p>
              )}
            </aside>
            <section className="coding-editor-pane" aria-label="Code editor">
              <div
                className="coding-tabs"
                role="tablist"
                aria-label="Open code files"
              >
                {Object.values(buffers).map((file) => (
                  <button
                    role="tab"
                    aria-selected={active === file.path}
                    key={file.path}
                    onClick={() => loadFile(file.path)}
                  >
                    <FileCode2 size={14} />
                    {basename(file.path)}
                    {dirty(file) && <span aria-label="Unsaved">●</span>}
                  </button>
                ))}
              </div>
              {buffer ? (
                <>
                  <div className="coding-editor-toolbar">
                    <span title={active}>
                      {active}
                      {buffer.origin && (
                        <small className="workspace-source-note">
                          {" "}
                          · From {buffer.origin}
                        </small>
                      )}
                    </span>
                    <div>
                      <button
                        disabled={!!busy || !dirty(buffer)}
                        onClick={reviewDraft}
                        title="Compare your draft with the saved file"
                      >
                        Review changes
                      </button>
                      <button
                        title="Wrap long lines"
                        aria-label="Wrap long lines"
                        aria-pressed={wrap}
                        onClick={() => setWrap((value) => !value)}
                      >
                        <WrapText size={16} />
                      </button>
                      <button
                        aria-label="Download current code draft"
                        title="Download current draft"
                        onClick={() =>
                          downloadText(basename(active), buffer.content)
                        }
                      >
                        <Download size={15} />
                      </button>
                      <button
                        disabled={!!busy || !dirty(buffer)}
                        onClick={saveCurrent}
                      >
                        <Save size={15} /> Save file
                      </button>
                    </div>
                  </div>
                  <div className="coding-text-editor">
                    {!wrap && (
                      <pre ref={gutter} aria-hidden="true">
                        {buffer.content
                          .split("\n")
                          .map((_, index) => index + 1)
                          .join("\n")}
                      </pre>
                    )}
                    <textarea
                      ref={editor}
                      aria-label={`Edit ${active}`}
                      value={buffer.content}
                      spellCheck={false}
                      autoCapitalize="off"
                      autoComplete="off"
                      autoCorrect="off"
                      wrap={wrap ? "soft" : "off"}
                      onChange={(event) => edit(event.target.value)}
                      onKeyDown={editorKey}
                      onScroll={(event) => {
                        if (gutter.current)
                          gutter.current.scrollTop =
                            event.currentTarget.scrollTop;
                      }}
                      onSelect={(event) =>
                        setSelection({
                          path: active,
                          start: sourceTextOffset(
                            buffer.content,
                            event.currentTarget.selectionStart,
                          ),
                          end: sourceTextOffset(
                            buffer.content,
                            event.currentTarget.selectionEnd,
                          ),
                        })
                      }
                    />
                  </div>
                  <footer className="coding-editor-status">
                    <span>
                      {buffer.language || active.split(".").at(-1)} · UTF-8
                    </span>
                    <span>
                      {buffer.content.split("\n").length} lines ·{" "}
                      {dirty(buffer)
                        ? "Unsaved draft"
                        : "Saved on this computer"}
                    </span>
                  </footer>
                </>
              ) : (
                <div className="coding-pick-file">
                  <FileCode2 size={30} />
                  <p>Choose a file to start editing.</p>
                </div>
              )}
            </section>
            {assistant && (
              <aside className="coding-assistant" aria-label="Code assistant">
                {incomingTask && (
                  <section
                    className="workspace-incoming"
                    aria-label="Incoming Coding task"
                  >
                    <strong>{incomingTask.source || "Incoming task"}</strong>
                    <p>Your existing question is kept.</p>
                    {incomingTasks.length > 1 && (
                      <p>
                        {incomingTasks.length} incoming tasks waiting for
                        review.
                      </p>
                    )}
                    <details>
                      <summary>Preview incoming task</summary>
                      <pre>{incomingTask.text}</pre>
                    </details>
                    <div className="actions">
                      <button
                        type="button"
                        onClick={() => addIncomingTask(incomingTask)}
                      >
                        Add to my question
                      </button>
                      <button
                        type="button"
                        onClick={() => dismissIncoming(incomingTask)}
                      >
                        Keep my question
                      </button>
                    </div>
                  </section>
                )}
                <div className="coding-pane-title">
                  <strong>
                    <Sparkles size={16} /> Code assistant
                  </strong>
                  <button
                    onClick={newConversation}
                    disabled={!!runningTurn || sending}
                    title="New coding conversation"
                  >
                    New chat
                  </button>
                </div>
                <ModelStatus
                  tools={tools}
                  task="code"
                  value={profile}
                  defaultId={defaultProfile}
                  worker={worker}
                  onModels={onModels}
                  onChange={preferences ? setProfile : undefined}
                  disabled={preferencesBusy}
                />
                <ProjectBrief
                  key={project.id}
                  project={project}
                  api={api}
                  value={brief}
                  onChange={setBrief}
                  onBusyChange={setBriefBusy}
                  disabled={sending}
                />
                {preferencesError && (
                  <div className="notice" role="alert">
                    <p>{preferencesError}</p>
                    <button
                      type="button"
                      onClick={() => loadPreferences(true)}
                      disabled={preferencesBusy}
                    >
                      Load saved AI setup
                    </button>
                  </div>
                )}
                {!preferences && (
                  <p className="helper" role="status">
                    {preferencesBusy
                      ? "Loading project AI setup…"
                      : "Load your project AI setup before asking the assistant."}
                  </p>
                )}
                <details className="coding-ai-setup">
                  <summary>
                    Project instructions{instructions.trim() ? " · active" : ""}
                  </summary>
                  <p className="helper">
                    Tell the model how this project works: language,
                    conventions, testing preferences, or things to preserve.
                    These instructions accompany each coding request.
                  </p>
                  <label>
                    Instructions for this project
                    <textarea
                      rows={4}
                      maxLength={2000}
                      disabled={!preferences || preferencesBusy}
                      value={instructions}
                      onChange={(event) => setInstructions(event.target.value)}
                      placeholder="Use Python 3.12. Keep dependencies minimal. Explain changes for a beginner."
                    />
                  </label>
                  <small>
                    {instructions.length.toLocaleString()} / 2,000 characters
                  </small>
                </details>
                {preferenceDirty && (
                  <div className="coding-setup-save">
                    <small>
                      AI setup changed. It applies to your next request.
                    </small>
                    <button
                      type="button"
                      disabled={preferencesBusy}
                      onClick={savePreferences}
                    >
                      <Save size={13} /> Save AI setup
                    </button>
                  </div>
                )}
                <details
                  className="coding-history"
                  onToggle={(event) => {
                    if (event.currentTarget.open) loadHistory();
                  }}
                >
                  <summary>Past coding conversations</summary>
                  {historyBusy && (
                    <p role="status" className="helper">
                      Loading conversations…
                    </p>
                  )}
                  {historyError && (
                    <p role="alert" className="helper">
                      {historyError}
                    </p>
                  )}
                  {!historyBusy && !history.length && !historyError && (
                    <p className="helper">
                      Your coding conversations will appear here.
                    </p>
                  )}
                  {history.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      aria-pressed={item.id === chatId}
                      disabled={!!runningTurn || sending}
                      onClick={() => resumeConversation(item.id)}
                    >
                      <MessageSquare size={12} /> {item.title}
                      <small>
                        {new Date(item.updated * 1000).toLocaleDateString()}
                      </small>
                    </button>
                  ))}
                </details>
                {restoringChat && (
                  <p role="status" className="helper">
                    Restoring your coding conversation…
                  </p>
                )}
                {chatError && (
                  <div className="notice" role="alert">
                    <p>{chatError}</p>
                    <button
                      onClick={() => setChatAttempt((value) => value + 1)}
                    >
                      Retry conversation
                    </button>
                  </div>
                )}
                {!chat?.turns?.length && (
                  <div className="coding-assistant-empty">
                    <MessageSquare size={28} />
                    <h3>A second pair of eyes.</h3>
                    <p>
                      Explain code, spot problems or draft a change. You choose
                      the context and review the result.
                    </p>
                    <div>
                      {[
                        "Explain this code",
                        "Find bugs and edge cases",
                        "Suggest tests for this code",
                      ].map((text) => (
                        <button key={text} onClick={() => setQuestion(text)}>
                          {text} <ArrowRight size={13} />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="coding-conversation">
                  {chat?.turns?.map((turn) => (
                    <article key={turn.id} className="coding-turn">
                      <div className="coding-turn-provenance">
                        <Cpu size={12} />
                        <span>
                          {turn.job.request?.profile?.model ||
                            turn.job.request?.profile?.label ||
                            "Local coding model"}
                        </span>
                      </div>
                      <p className="coding-question">
                        {snapshots[turn.client_id]?.question ||
                          turn.prompt
                            .split("\n\nTask: ")
                            .at(-1)
                            .split("\n\nFile:")[0]}
                      </p>
                      {!!turn.coding_context?.length && (
                        <details className="coding-sources">
                          <summary>
                            {turn.coding_context.length} supporting{" "}
                            {turn.coding_context.length === 1
                              ? "file"
                              : "files"}{" "}
                            included
                          </summary>
                          {turn.coding_context.map((file) => (
                            <p key={file.path}>
                              {file.path}{" "}
                              <small>
                                · saved snapshot ·{" "}
                                {file.content?.length ?? file.characters}{" "}
                                characters
                              </small>
                            </p>
                          ))}
                        </details>
                      )}
                      {turn.coding_instructions && (
                        <details className="coding-sources">
                          <summary>Project instructions used</summary>
                          <pre>{turn.coding_instructions}</pre>
                        </details>
                      )}
                      {(turn.job.request?.context_snapshot ||
                        !!turn.job.request?.messages?.length) && (
                        <ContextInspector
                          snapshot={
                            turn.job.request.context_snapshot ||
                            turn.job.request
                          }
                        />
                      )}
                      {turn.answer ? (
                        <>
                          <Answer
                            text={turn.answer}
                            report={setNotice}
                            onReview={
                              snapshots[turn.client_id]?.attached
                                ? (code) => reviewSuggestion(turn, code)
                                : null
                            }
                          />
                          <ResultActions
                            source={{
                              kind: "text",
                              text: turn.answer,
                              project_id: project.id,
                              asset_id: turn.asset?.id,
                              title: `Coding: ${chat.title}`,
                            }}
                            onHandoff={onHandoff}
                          />
                        </>
                      ) : (
                        <div className="coding-reply-status" role="status">
                          <strong>{turn.job.state}</strong>
                          <p>{turn.partial || turn.job.message}</p>
                        </div>
                      )}
                      {!TERMINAL.includes(turn.job.state) && (
                        <button
                          disabled={turn.job.state === "cancelling"}
                          onClick={() =>
                            api(`/jobs/${turn.job.id}/cancel`, {})
                              .then(async () =>
                                setChat(await api(`/chats/${chatId}`)),
                              )
                              .catch((failure) => setError(failure.message))
                          }
                        >
                          <Square size={13} /> Stop reply
                        </button>
                      )}
                      {["failed", "cancelled"].includes(turn.job.state) && (
                        <button
                          type="button"
                          onClick={() => {
                            setQuestion(
                              snapshots[turn.client_id]?.question ||
                                turn.prompt
                                  .split("\n\nTask: ")
                                  .at(-1)
                                  .split("\n\nFile:")[0],
                            );
                            setNotice(
                              "Question restored. Review the current model and file context before trying again.",
                            );
                          }}
                        >
                          Reuse question
                        </button>
                      )}
                    </article>
                  ))}
                </div>
                <form className="coding-composer" onSubmit={ask}>
                  <label>
                    Include with your question
                    <select
                      value={contextMode}
                      onChange={(event) => setContextMode(event.target.value)}
                    >
                      <option value="file">
                        Current file{buffer ? ` · ${basename(active)}` : ""}
                      </option>
                      <option value="selection">Selected code</option>
                      <option value="none">No file attached</option>
                    </select>
                  </label>
                  <p className="helper">
                    {contextMode === "none" || !buffer
                      ? "Your question and this conversation’s earlier replies."
                      : `${contextSize.toLocaleString()} characters from ${chosenRange ? "your selection" : "the current editor draft"}.`}
                  </p>
                  <details className="coding-context-picker">
                    <summary>
                      Supporting files
                      {references.length
                        ? ` · ${references.length} selected`
                        : ""}
                    </summary>
                    <p className="helper">
                      Select saved files the model should also read. Only these
                      files and the editor context above are included. Up to 4
                      files and 12,000 characters.
                    </p>
                    <div className="coding-reference-list">
                      {(workspace?.files || []).map((file) => (
                        <label key={file.path}>
                          <input
                            type="checkbox"
                            checked={references.some(
                              (item) => item.path === file.path,
                            )}
                            disabled={
                              contextBusy ||
                              (contextMode !== "none" &&
                                file.path === active) ||
                              (!references.some(
                                (item) => item.path === file.path,
                              ) &&
                                (references.length >= 4 ||
                                  Boolean(
                                    buffers[file.path] &&
                                      dirty(buffers[file.path]),
                                  )))
                            }
                            onChange={() => toggleReference(file.path)}
                          />
                          <span>
                            {file.path}
                            {contextMode !== "none" && file.path === active
                              ? " · included above"
                              : buffers[file.path] && dirty(buffers[file.path])
                                ? " · save draft first"
                                : ""}
                          </span>
                        </label>
                      ))}
                      {!workspace?.files?.length && (
                        <p className="helper">Save a project file first.</p>
                      )}
                    </div>
                    {!!references.length && (
                      <>
                        <p className="helper">
                          {referenceSize.toLocaleString()} / 12,000 characters
                          from saved files. Changes in VS Code are checked
                          before sending.
                        </p>
                        <div className="actions">
                          <button
                            type="button"
                            disabled={contextBusy}
                            onClick={refreshReferences}
                          >
                            <RefreshCw size={12} /> Refresh context
                          </button>
                          <button
                            type="button"
                            disabled={contextBusy}
                            onClick={() => setReferences([])}
                          >
                            Clear files
                          </button>
                        </div>
                      </>
                    )}
                    {contextBusy && (
                      <p role="status" className="helper">
                        Reading saved context…
                      </p>
                    )}
                  </details>
                  {invalidContext && (
                    <p className="helper">
                      {contextMode !== "none" && loadingFiles[active]
                        ? "Opening the current file for your question…"
                        : contextMode !== "none" && !buffer
                          ? "Choose a file, or ask without attaching one."
                          : contextMode === "selection" && !chosenRange
                            ? "Select some code in the editor first."
                            : "Select a smaller section (up to 6,000 characters), or ask without the file."}
                    </p>
                  )}
                  <textarea
                    aria-label="Ask about your code"
                    rows={3}
                    maxLength={1200}
                    value={question}
                    onChange={(event) => {
                      setQuestion(event.target.value);
                      nonce.current = null;
                    }}
                    placeholder="What would you like to change or understand?"
                  />
                  {paused && (
                    <p className="coding-paused">
                      Local AI is paused. You can keep editing files and use VS
                      Code.
                    </p>
                  )}
                  <ContextInspector
                    key={previewVersion}
                    api={api}
                    endpoint={
                      chatId
                        ? `/chats/${chatId}/context`
                        : `/projects/${project.id}/chat-context`
                    }
                    body={previewBody}
                    disabled={
                      !previewBody ||
                      sending ||
                      restoringChat ||
                      !!runningTurn ||
                      !preferences ||
                      preferencesBusy ||
                      contextBusy ||
                      briefBusy
                    }
                    onChange={(fingerprint) =>
                      setContextPreview(
                        fingerprint
                          ? { identity: previewIdentity, fingerprint }
                          : null,
                      )
                    }
                    onBusyChange={setPreviewBusy}
                  />
                  <button
                    className="primary"
                    disabled={
                      sending ||
                      restoringChat ||
                      !!runningTurn ||
                      paused ||
                      !model.canRun ||
                      !preferences ||
                      preferencesBusy ||
                      briefBusy ||
                      previewBusy ||
                      contextBusy ||
                      invalidContext ||
                      !question.trim()
                    }
                  >
                    <Send size={14} />
                    {sending ? "Sending…" : "Ask assistant"}
                  </button>
                </form>
              </aside>
            )}
          </div>
        )}
      {workspace && (
        <footer className="coding-footer">
          <span>
            {busy ||
              `${files.length} files · ${changed.length ? `${changed.length} unsaved drafts` : "Ready to edit"}`}
          </span>
          <div>
            {changed.length > 1 && (
              <button disabled={!!busy} onClick={saveAll}>
                <Save size={14} /> Save all
              </button>
            )}
            <small>
              Ctrl / ⌘ S to save · Tab to indent · Run and debug in your IDE
            </small>
          </div>
        </footer>
      )}
      {review && (
        <div className="coding-review-backdrop">
          <section
            ref={reviewDialog}
            role="dialog"
            aria-modal="true"
            aria-label={
              review.type === "conflict"
                ? "Review conflicting edits"
                : "Review code change"
            }
            className="coding-review"
          >
            <header>
              <div>
                <span className="eyebrow">
                  {review.type === "draft"
                    ? "UNSAVED CHANGES"
                    : review.type === "conflict"
                      ? review.deleted
                        ? "THIS FILE WAS REMOVED"
                        : "THIS FILE CHANGED IN ANOTHER EDITOR"
                      : "REVIEW BEFORE APPLYING"}
                </span>
                <h2>{review.path}</h2>
              </div>
              <button
                aria-label="Close code review"
                onClick={() => setReview(null)}
              >
                <X size={20} />
              </button>
            </header>
            <CodeDiff before={review.before} after={review.after} />
            <details className="coding-full-diff">
              <summary>Full files</summary>
              <div className="coding-comparison">
                <div>
                  <strong>
                    {review.type === "conflict" || review.type === "draft"
                      ? "Saved on the Studio host"
                      : "Your current file"}
                  </strong>
                  <pre>{review.before}</pre>
                </div>
                <div>
                  <strong>
                    {review.type === "conflict" || review.type === "draft"
                      ? "Your browser draft"
                      : "Proposed file"}
                  </strong>
                  <pre>{review.after}</pre>
                </div>
              </div>
            </details>
            <footer>
              <p>
                {review.type === "draft"
                  ? review.deleted
                    ? "The saved file was removed. Your draft is preserved. Close this review and use Save to review recreating it."
                    : "This compares your current draft with the saved file. Close this review and save separately when ready."
                  : review.type === "conflict"
                    ? review.deleted
                      ? "Your browser draft is kept. Choose to recreate the file, then Save to write it to the host."
                      : "Choose which version to keep editing. Your browser draft has not overwritten the file."
                    : "Applying updates your editor draft. Save separately to write the file. The code has not been run."}
              </p>
              <div className="actions">
                {review.type === "conflict" && !review.deleted && (
                  <button onClick={useDiskVersion}>Use saved version</button>
                )}
                {review.type !== "draft" && (
                  <button className="primary" onClick={applyReview}>
                    {review.type === "conflict"
                      ? review.deleted
                        ? "Prepare to recreate"
                        : "Keep my draft"
                      : "Apply to draft"}
                  </button>
                )}
                <button onClick={() => setReview(null)}>Cancel</button>
              </div>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
