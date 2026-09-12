import { createStudioApi } from "./studioApi";
import { Plug as MCPIcon } from "lucide-react";
import {
  EditorialHero,
  MachineStatus,
  CapabilityShelf,
} from "./StudioIdentity";
import MCPServers from "./MCPServers";
import { HostNotice } from "./HostGuidance";
import AgentsStudio from "./AgentsStudio";
import GPTPaiton from "./GPTPaiton";
import {
  PaitonMark,
  CommandBar,
  HardwarePanel,
  HomeWorkspace,
} from "./StudioDesign";
import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  Bot,
  Home,
  Folder,
  Image as ImageIcon,
  Film,
  PenLine,
  MessageSquare,
  PanelsTopLeft,
  Library,
  Settings,
  Boxes,
  ArrowRight,
  ArrowUpRight,
  Plus,
  Upload,
  Download,
  Star,
  Play,
  ChevronRight,
  Check,
  Clock,
  Square,
  X,
  RefreshCw,
  Monitor,
  Smartphone,
  Leaf,
  BookOpen,
  Activity,
  Globe,
} from "lucide-react";
import "./style.css";
import {
  GpuActivity,
  ModelChoice,
  ProjectFlow,
  StudioSettings,
  StudioWiki,
  taskProfiles,
} from "./WorkspaceExtras";
import WebsiteBuilder from "./WebsiteBuilder";
import DeliveryStudio from "./DeliveryStudio";
import MeetingStudio from "./MeetingStudio";
import { AudioLines } from "lucide-react";
import WebsiteNotifications from "./WebsiteNotifications";
import { stageForJob, formatElapsed, studioNow } from "./creationFeedback";

import "./studio-design.css";
import "./studio-gold.css";

const api = createStudioApi();
const NAV = [
  ["home", "Home", Home],
  ["projects", "Projects", Folder],
  ["image", "Image", ImageIcon],
  ["video", "Video", Film],
  ["chat", "GPT", MessageSquare],
  ["agents", "Agents", Bot],
  ["mcp", "MCP Servers", MCPIcon],
  ["meetings", "Meetings", AudioLines],
  ["delivery", "Reels & shorts", Smartphone],
  ["write", "Write", PenLine],
  ["page", "Build Page", PanelsTopLeft],
  ["library", "Library", Library],
];
const ACTIVE = [
  "queued",
  "preparing",
  "loading",
  "warming",
  "generating",
  "processing",
  "saving",
  "cancelling",
];
const url = (a) => "/api/assets/" + a.id;
const thumbnail = (a) => url(a) + "/thumbnail?width=384";
function Media({ asset, compact = false, ...props }) {
  return asset.kind === "video" ? (
    <video src={url(asset)} controls preload="metadata" {...props} />
  ) : asset.kind === "image" ? (
    <img
      src={compact ? thumbnail(asset) : url(asset)}
      alt={asset.name}
      loading={compact ? "lazy" : "eager"}
      decoding="async"
      {...props}
    />
  ) : (
    <div className="text-cover">
      <PenLine size={30} />
      <strong>{asset.name}</strong>
      <span>Writing · saved revision</span>
    </div>
  );
}
function App() {
  const [route, setRoute] = useState(() => {
      const value =
        location.hash.slice(1) === "mail" ? "mcp" : location.hash.slice(1);
      return [...NAV.map((n) => n[0]), "tools", "wiki", "settings"].includes(
        value,
      )
        ? value
        : "home";
    }),
    [projects, setProjects] = useState([]),
    [project, setProject] = useState(null),
    [assets, setAssets] = useState([]),
    [tools, setTools] = useState([]),
    [status, setStatus] = useState({
      jobs: [],
      gpu: { message: "Checking local tools" },
    }),
    [queueOpen, setQueueOpen] = useState(false),
    [notice, setNotice] = useState(""),
    [saved, setSaved] = useState(true),
    [saveConflict, setSaveConflict] = useState(false),
    [ready, setReady] = useState(false),
    [mobile, setMobile] = useState(false),
    [filter, setFilter] = useState("all"),
    [favorites, setFavorites] = useState(false),
    [settings, setSettings] = useState({
      defaults: {},
      appearance: {},
      generation: {},
    }),
    [gpuSamples, setGpuSamples] = useState([]),
    [queueHistory, setQueueHistory] = useState(false),
    [settingsTab, setSettingsTab] = useState("preferences");
  const [chatIntent, setChatIntent] = useState(null);
  const [agentIntent, setAgentIntent] = useState(null);
  const [mcpSelection, setMcpSelection] = useState(null);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [submittedWebsite, setSubmittedWebsite] = useState(null);
  const [requestedWebsiteReview, setRequestedWebsiteReview] = useState(null);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [startupError, setStartupError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [submittingTask, setSubmittingTask] = useState(null);
  const submissionLock = useRef(false),
    projectCreation = useRef(null),
    openRequest = useRef(0);
  const current = useRef(null),
    dirty = useRef(false),
    saving = useRef(null),
    conflict = useRef(false),
    saveTimer = useRef(),
    importRef = useRef(),
    completed = useRef(null);
  const pstate = project?.state || {};
  const draft = pstate[route] || {};
  const jobs = status.jobs.filter((j) => j.project === project?.id),
    active = status.jobs.filter((j) => ACTIVE.includes(j.state));
  const currentJob = active.find((j) => j.state !== "queued") || active[0];
  const currentStage = stageForJob(currentJob);
  const selected = assets.find((a) => a.id === pstate.selected) || assets[0];
  function report(e) {
    setNotice(e.message || String(e));
  }
  async function refreshProjects() {
    setProjects(await api("/projects"));
  }
  async function openProject(id, destination = "projects") {
    const attempt = ++openRequest.current;
    await flush();
    if (attempt !== openRequest.current) return;
    let p = await api("/projects/" + id);
    if (attempt !== openRequest.current) return;
    // Save edits made in the outgoing project while the next project was loading.
    await flush();
    if (attempt !== openRequest.current) return;
    if (current.current?.id === id && current.current.revision >= p.revision)
      p = { ...current.current, assets: p.assets };
    setAssets(p.assets);
    delete p.assets;
    setProject(p);
    current.current = p;
    dirty.current = false;
    setSaved(true);
    setRoute(destination);
    localStorage.setItem("studio-project", id);
  }
  async function ensureProject() {
    if (current.current) return current.current;
    if (!projectCreation.current) {
      projectCreation.current = (async () => {
        const p = await api("/projects", {});
        setProject(p);
        current.current = p;
        setProjects((old) => [p, ...old.filter((item) => item.id !== p.id)]);
        localStorage.setItem("studio-project", p.id);
        return p;
      })().finally(() => {
        projectCreation.current = null;
      });
    }
    return projectCreation.current;
  }
  async function navigate(to) {
    const attempt = ++openRequest.current;
    if (!["home", "tools", "settings", "wiki"].includes(to))
      await ensureProject();
    if (attempt === openRequest.current) setRoute(to);
  }
  function updateState(patch) {
    const p = {
      ...current.current,
      state: { ...current.current.state, ...patch },
    };
    setProject(p);
    current.current = p;
    dirty.current = true;
    setSaved(false);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => flush().catch(report), 450);
  }
  function changeDraft(patch) {
    updateState({ [route]: { ...draft, ...patch } });
  }
  async function flush() {
    clearTimeout(saveTimer.current);
    while (saving.current) await saving.current;
    if (conflict.current)
      throw Error(
        "This project changed in another window. Download your draft before loading the saved version.",
      );
    if (!dirty.current || !current.current) return;
    const snapshot = current.current;
    saving.current = api(
      "/projects/" + snapshot.id,
      {
        name: snapshot.name,
        state: snapshot.state,
        revision: snapshot.revision,
      },
      "PUT",
    )
      .then((stored) => {
        const unchanged = current.current === snapshot;
        if (current.current?.id === snapshot.id) {
          current.current = { ...current.current, revision: stored.revision };
          setProject(current.current);
        }
        if (unchanged) {
          dirty.current = false;
          setSaved(true);
        }
      })
      .catch((error) => {
        if (error.status === 409) {
          conflict.current = true;
          setSaveConflict(true);
        }
        throw error;
      });
    try {
      await saving.current;
    } finally {
      saving.current = null;
    }
    if (dirty.current) await flush();
  }
  function downloadConflictingDraft() {
    const source = current.current;
    // Asset IDs belong to the original project: preserve the complete draft as
    // a downloadable document, and retain the original project association.
    const draft = new Blob([JSON.stringify(source, null, 2)], {
      type: "application/json",
    });
    const href = URL.createObjectURL(draft);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "paiton-unsaved-draft.json";
    anchor.click();
    URL.revokeObjectURL(href);
    setNotice(
      "Your unsaved draft was downloaded as JSON. Load the saved version when you are ready; your download retains the text and project settings for recovery.",
    );
  }
  async function refreshAssets() {
    const id = current.current?.id;
    if (id) {
      const p = await api("/projects/" + id);
      if (current.current?.id === id) setAssets(p.assets);
    }
  }
  useEffect(() => {
    let alive = true;
    setStartupError("");
    (async () => {
      await api.connect();
      const [ps, availableTools, preferences, initialStatus] =
        await Promise.all([
          api("/projects"),
          api("/tools"),
          api("/settings"),
          api("/status"),
        ]);
      if (!alive) return;
      setProjects(ps);
      setTools(availableTools);
      setSettings(preferences);
      setStatus(initialStatus);
      completed.current = initialStatus.jobs
        .filter((j) => j.state === "completed")
        .map((j) => j.id)
        .join();
      const id = localStorage.getItem("studio-project");
      const destination =
        location.hash.slice(1) === "mail" ? "mcp" : location.hash.slice(1);
      const target = [
        ...NAV.map((n) => n[0]),
        "tools",
        "settings",
        "wiki",
      ].includes(destination)
        ? destination
        : "home";
      if (ps.length)
        await openProject(ps.find((p) => p.id === id)?.id || ps[0].id, target);
      else await navigate(target);
      if (alive) setReady(true);
    })().catch((error) => {
      if (alive) setStartupError(error.message);
    });
    return () => {
      alive = false;
      clearTimeout(saveTimer.current);
    };
  }, [startupAttempt]);
  useEffect(() => {
    if (!ready) return;
    let alive = true,
      timer,
      running = false;
    const tick = async () => {
      if (!alive || running) return;
      clearTimeout(timer);
      running = true;
      try {
        const s = await api("/status");
        if (!alive) return;
        setStatus(s);
        setConnectionError("");
        setGpuSamples((samples) => [
          ...samples.slice(-39),
          Number.isFinite(s.gpu.utilization_percent)
            ? s.gpu.utilization_percent
            : null,
        ]);
        const signature = s.jobs
          .filter((j) => j.state === "completed")
          .map((j) => j.id)
          .join();
        if (completed.current === null) completed.current = signature;
        else if (completed.current !== signature) {
          await Promise.all([refreshAssets(), refreshProjects()]);
          completed.current = signature;
        }
      } catch (error) {
        if (alive) setConnectionError(error.message);
      } finally {
        running = false;
        if (alive) timer = setTimeout(tick, document.hidden ? 6000 : 1800);
      }
    };
    const wake = () => {
      if (!document.hidden) tick();
    };
    tick();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    };
  }, [ready]);
  useEffect(() => {
    if (!ready) return;
    if (location.hash.slice(1) !== route)
      history.pushState(null, "", "#" + route);
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [route, ready]);
  useEffect(() => {
    const change = () => {
      const value =
        location.hash.slice(1) === "mail" ? "mcp" : location.hash.slice(1);
      if (
        [...NAV.map((n) => n[0]), "tools", "wiki", "settings"].includes(value)
      )
        navigate(value).catch(report);
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    function warn(e) {
      if (dirty.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  async function createProject() {
    if (projectCreation.current) return projectCreation.current;
    projectCreation.current = (async () => {
      await flush();
      const p = await api("/projects", {});
      setProjects((old) => [p, ...old.filter((item) => item.id !== p.id)]);
      await openProject(p.id, "image");
      return p;
    })().finally(() => {
      projectCreation.current = null;
    });
    return projectCreation.current;
  }
  async function importImage(file) {
    if (!file) return;
    const p = await ensureProject();
    const body = new FormData();
    body.append("file", file);
    const asset = await api("/projects/" + p.id + "/import", body);
    if (current.current?.id !== p.id) {
      setNotice(
        "Image imported into its original project. Open that project to animate it.",
      );
      return;
    }
    await refreshAssets();
    if (current.current?.id !== p.id) return;
    updateState({
      selected: asset.id,
      video: {
        ...(current.current.state.video || {}),
        source: asset.id,
        mode: "image",
      },
    });
    setRoute("video");
    setNotice("Your original image is saved. Describe how it should move.");
  }
  function animate(asset) {
    updateState({
      selected: asset.id,
      video: { ...(pstate.video || {}), source: asset.id, mode: "image" },
    });
    setRoute("video");
  }
  function useOnPage(asset) {
    const page = pstate.page || {};
    updateState({
      buildMode: "single",
      page: {
        ...page,
        assets: [...new Set([...(page.assets || []), asset.id])],
      },
    });
    setRoute("page");
  }
  function writeAbout(asset) {
    updateState({
      write: {
        ...(pstate.write || {}),
        context_ids: [
          ...new Set([...(pstate.write?.context_ids || []), asset.id]),
        ],
      },
    });
    setRoute("write");
  }
  async function generate() {
    if (submissionLock.current) return;
    submissionLock.current = true;
    setSubmittingTask(route);
    try {
      const p = await ensureProject();
      await flush();
      const profileId = draft.profile || "auto";
      const body = {
        task: route,
        profile_id: profileId,
        prompt: draft.prompt || "",
        seed: Number(draft.seed ?? settings.generation?.seed ?? 771),
      };
      if (route === "video" && (draft.mode || "image") === "image") {
        if (!draft.source) throw Error("Choose the image you want to animate.");
        body.source_id = draft.source;
        body.fit = "letterbox";
      }
      if (route === "write")
        Object.assign(body, {
          format: draft.format || "Blog post",
          tone: draft.tone || "Natural",
          length: Number(draft.length || 250),
          context_ids: draft.context_ids || [],
        });
      const job = await api("/projects/" + p.id + "/jobs", body);
      // A confirmed enqueue stays successful even if the next status poll fails.
      setStatus((s) => ({
        ...s,
        jobs: [job, ...s.jobs.filter((item) => item.id !== job.id)],
      }));
      setQueueOpen(true);
      setNotice("Request saved in the queue. You can keep editing.");
    } finally {
      submissionLock.current = false;
      setSubmittingTask(null);
    }
  }
  async function exportProject() {
    await flush();
    const blob = await api("/projects/" + project.id + "/export", {});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = project.name.replace(/[^a-zA-Z0-9 -]/g, "") + ".zip";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setNotice("Exported page, media, text and project metadata.");
  }
  async function selectDocument(asset) {
    const response = await fetch(url(asset));
    const text = await response.text();
    updateState({
      write: {
        ...(pstate.write || {}),
        document: asset.id,
        editor: text,
        pending: null,
      },
    });
  }
  async function saveDocument() {
    const a = await api("/projects/" + project.id + "/documents", {
      text: draft.editor || "",
      name: draft.title || "Writing draft",
      parent: draft.document || null,
    });
    changeDraft({ document: a.id });
    await refreshAssets();
    return a;
  }
  async function applyDocumentToPage() {
    const a = await saveDocument();
    updateState({
      buildMode: "single",
      page: {
        ...(current.current.state.page || {}),
        document: a.id,
        title: current.current.state.page?.title || project.name,
      },
    });
    setRoute("page");
  }
  function guarded(fn) {
    return (...args) => {
      try {
        return Promise.resolve(fn(...args)).catch(report);
      } catch (e) {
        report(e);
      }
    };
  }
  function actionAsset(asset) {
    return (
      <div className="actions">
        {asset.kind === "image" && (
          <button className="primary compact" onClick={() => animate(asset)}>
            <Play size={15} />
            Animate this
          </button>
        )}
        {asset.kind === "video" && (
          <button
            className="primary compact"
            onClick={() => {
              updateState({
                delivery: {
                  ...current.current.state.delivery,
                  source_id: asset.id,
                },
              });
              setRoute("delivery");
            }}
          >
            <Smartphone size={15} />
            Prepare for sharing
          </button>
        )}
        {asset.kind !== "text" && (
          <button onClick={() => writeAbout(asset)}>
            <PenLine size={15} />
            Write about this
          </button>
        )}
        {asset.kind === "text" ? (
          <button
            onClick={guarded(async () => {
              await selectDocument(asset);
              setRoute("write");
            })}
          >
            Open writing
          </button>
        ) : (
          <button onClick={() => useOnPage(asset)}>
            <PanelsTopLeft size={15} />
            Use on page
          </button>
        )}
        <a className="button" href={url(asset) + "?download=true"}>
          <Download size={15} />
          Export
        </a>
      </div>
    );
  }
  const visibleAssets = assets.filter(
    (a) =>
      (filter === "all" || a.kind === filter) && (!favorites || a.favorite),
  );
  const videos = assets.filter((a) => a.kind === "video"),
    images = assets.filter((a) => a.kind === "image"),
    documents = assets.filter((a) => a.kind === "text");
  const source = images.find((a) => a.id === draft.source);
  const page = pstate.page || {};
  const buildMode = pstate.buildMode || "single";
  const resolvedVideoProfile =
    (draft.profile && draft.profile !== "auto"
      ? draft.profile
      : settings.defaults?.[
          (draft.mode || "image") === "text" ? "video_text" : "video"
        ] !== "auto" &&
        settings.defaults?.[
          (draft.mode || "image") === "text" ? "video_text" : "video"
        ]) ||
    taskProfiles(
      tools,
      (draft.mode || "image") === "text" ? "video_text" : "video",
    ).find(
      (profile) =>
        profile.state === "ready" &&
        profile.compatibility?.compatible !== false,
    )?.id ||
    "video-short";
  const videoHasAudio =
    taskProfiles(
      tools,
      (draft.mode || "image") === "text" ? "video_text" : "video",
    ).find((item) => item.id === resolvedVideoProfile)?.audio === true;
  const jobsToShow =
    settings.appearance?.compact_queue && !queueHistory
      ? status.jobs.filter((job) => ACTIVE.includes(job.state))
      : status.jobs;
  if (!ready)
    return (
      <div className="startup" role="status">
        <span className="brand-mark">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
        <h2>Paiton Studio</h2>
        <p>{startupError || "Opening your local workspace…"}</p>
        {startupError && (
          <button
            className="primary"
            onClick={() => setStartupAttempt((n) => n + 1)}
          >
            Retry connection
          </button>
        )}
        <small>Your projects stay on the Studio host.</small>
      </div>
    );
  const launchIdea = guarded(async (to, idea) => {
    await ensureProject();
    if (idea.trim()) {
      if (to === "chat") setChatIntent({ text: idea, id: Date.now() });
      else if (to === "page")
        updateState({
          websiteDraft: {
            ...current.current.state.websiteDraft,
            brief: idea,
          },
        });
      else
        updateState({
          [to]: { ...current.current.state[to], prompt: idea },
        });
    }
    setRoute(to);
  });
  return (
    <div
      className={
        "shell studio-shell route-" +
        route +
        (navCollapsed ? " nav-collapsed" : "")
      }
    >
      <aside className="sidebar">
        <a
          className="brand"
          href="#home"
          onClick={(e) => {
            e.preventDefault();
            setRoute("home");
          }}
        >
          <PaitonMark />
          <span>
            Paiton <b>Studio</b>
            <small>Local AI. Bigger ideas.</small>
          </span>
        </a>
        <button
          className="nav-toggle"
          aria-label="Toggle navigation rail"
          onClick={() => setNavCollapsed(!navCollapsed)}
        >
          <PanelsTopLeft size={16} />
          <span>Creative workspace</span>
        </button>
        <nav aria-label="Main navigation">
          {NAV.map(([id, label, Icon], i) => (
            <React.Fragment key={id}>
              {i === 2 && <div className="nav-label">CREATE</div>}
              {id === "library" && (
                <>
                  <div className="nav-label">LIBRARY</div>
                  <button
                    className={route === "tools" ? "nav active" : "nav"}
                    onClick={() => setRoute("tools")}
                  >
                    <Boxes size={18} />
                    Creation tools
                  </button>
                </>
              )}
              <button
                aria-label={label}
                title={label}
                aria-current={route === id ? "page" : undefined}
                className={route === id ? "nav active" : "nav"}
                onClick={guarded(() => navigate(id))}
              >
                <Icon size={18} />
                <span>
                  {id === "page"
                    ? "Build Website"
                    : id === "write"
                      ? "Writing"
                      : label}
                </span>
              </button>
            </React.Fragment>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={route === "wiki" ? "nav active" : "nav"}
            onClick={() => setRoute("wiki")}
          >
            <BookOpen size={18} />
            Studio wiki
          </button>
          <button
            className={route === "settings" ? "nav active" : "nav"}
            onClick={() => {
              setSettingsTab("preferences");
              setRoute("settings");
            }}
          >
            <Settings size={18} />
            Settings
          </button>
          {!["home", "settings"].includes(route) && (
            <HardwarePanel
              gpu={status.gpu}
              samples={gpuSamples}
              active={active.length > 0}
              state={currentJob?.state}
              chatReady={status.chat_model_ready}
              onDetails={() => {
                setSettingsTab("system");
                setRoute("settings");
              }}
            />
          )}
          <a
            className="product-attribution"
            href="https://eliovp.com"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="An Eliovp Product — visit Eliovp (opens in a new tab)"
            title="An Eliovp Product · eliovp.com"
          >
            <span>
              An <strong>Eliovp</strong> Product
            </span>
            <ArrowUpRight size={15} aria-hidden="true" />
          </a>
        </div>
      </aside>
      <div className="body">
        <header className="topbar">
          <CommandBar shortcut onLaunch={launchIdea} />
          <div className="project-title">
            <Folder size={17} />
            {project ? (
              <input
                aria-label="Project name"
                value={project.name}
                onChange={(e) => {
                  const p = { ...current.current, name: e.target.value };
                  setProject(p);
                  current.current = p;
                  dirty.current = true;
                  setSaved(false);
                  clearTimeout(saveTimer.current);
                  saveTimer.current = setTimeout(
                    () => flush().catch(report),
                    650,
                  );
                }}
                onBlur={guarded(flush)}
              />
            ) : (
              <span>Your local workspace</span>
            )}
            <span className="save-state">
              <Check size={13} />
              {saved
                ? "Saved on Studio host"
                : saveConflict
                  ? "Save conflict · edits kept here"
                  : "Unsaved changes"}
            </span>
          </div>
          <div className="actions">
            <span className="local-ai-chip">
              <span className="status-dot" />
              Local AI
            </span>
            <span className="topbar-gpu">
              <Activity size={14} />
              {Number.isFinite(status.gpu.utilization_percent)
                ? `${status.gpu.utilization_percent}% GPU`
                : "GPU readings unavailable"}
            </span>
            <button onClick={() => setQueueOpen(!queueOpen)}>
              <Clock size={16} />
              <span>Queue</span>
              <b className="count">{active.length}</b>
            </button>
            <button
              className="primary"
              disabled={!project}
              onClick={guarded(exportProject)}
            >
              <Download size={16} />
              Export project
            </button>
          </div>
        </header>
        <main data-studio-page={route}>
          {connectionError && (
            <div className="notice" role="status">
              <strong>Reconnecting to your Studio</strong>
              <p>
                {connectionError} Your edits stay in this window; saved projects
                remain on the host.
              </p>
            </div>
          )}
          <HostNotice
            api={api}
            onDetails={() => {
              setSettingsTab("system");
              setRoute("settings");
              window.location.hash = "settings";
            }}
          />
          {saveConflict && (
            <div className="notice" role="alert">
              <div>
                <strong>Another window saved this project.</strong>
                <p>
                  Your current draft is still in this window. Download it before
                  loading the saved version, which replaces these unsaved edits.
                </p>
                <div className="actions">
                  <button onClick={downloadConflictingDraft}>
                    Download my draft
                  </button>
                  <button
                    onClick={guarded(async () => {
                      const id = current.current.id;
                      dirty.current = false;
                      conflict.current = false;
                      setSaveConflict(false);
                      await openProject(id, route);
                    })}
                  >
                    Load saved version
                  </button>
                </div>
              </div>
            </div>
          )}
          {status.worker?.recovery_pending && (
            <div role="status" className="notice">
              {status.worker.message}
            </div>
          )}
          {notice && (
            <div role="status" className="notice">
              {notice}
              <button
                aria-label="Dismiss message"
                onClick={() => setNotice("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {project &&
            ["projects", "image", "video", "write", "page"].includes(route) && (
              <ProjectFlow
                assets={assets}
                page={page}
                website={
                  !!(
                    pstate.websiteDraft?.editor ||
                    pstate.websiteDraft?.siteReady
                  )
                }
                route={route}
                onNavigate={guarded(navigate)}
              />
            )}
          {currentJob && (
            <button
              className="creation-status"
              onClick={() => setQueueOpen(true)}
            >
              <span className="status-dot busy" />
              <span>
                <strong>{currentStage.title}</strong>
                <small>{currentStage.description}</small>
              </span>
              <span className="live-request-time">
                {formatElapsed(
                  Math.max(0, studioNow() / 1000 - currentJob.created),
                )}{" "}
                on this task
              </span>
              <span className="helper">Open queue</span>
              <ChevronRight size={16} />
            </button>
          )}
          {route === "home" && (
            <HomeWorkspace
              gpu={status.gpu}
              active={active.length > 0}
              onDetails={() => {
                setSettingsTab("system");
                setRoute("settings");
              }}
              onLaunch={launchIdea}
              projects={projects}
              project={project}
              assets={assets}
              tools={tools}
              onNavigate={guarded(navigate)}
              onOpen={guarded(openProject)}
              onCreate={guarded(createProject)}
              onImport={() => importRef.current.click()}
              onSetup={() => {
                setSettingsTab("setup");
                setRoute("settings");
              }}
            />
          )}
          {(route === "projects" || route === "library") && (
            <>
              <div className="section-heading">
                <div>
                  <div className="eyebrow">
                    {route === "projects"
                      ? "PROJECT WORKSPACE"
                      : "PROJECT ASSETS"}
                  </div>
                  <h1>
                    {route === "projects" ? project?.name : "Your library"}
                  </h1>
                </div>
                <button onClick={guarded(createProject)}>
                  <Plus size={16} />
                  New project
                </button>
              </div>
              <div className="toolbar">
                <label>
                  Project
                  <select
                    aria-label="Project"
                    value={project?.id || ""}
                    onChange={guarded((e) =>
                      openProject(e.target.value, route),
                    )}
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="tabs">
                  {[
                    ["all", "All"],
                    ["image", "Images"],
                    ["video", "Video"],
                    ["text", "Writing"],
                  ].map(([v, t]) => (
                    <button
                      key={v}
                      className={filter === v ? "chosen" : ""}
                      onClick={() => setFilter(v)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <button
                  aria-pressed={favorites}
                  className={favorites ? "chosen" : ""}
                  onClick={() => setFavorites(!favorites)}
                >
                  <Star size={16} />
                  Favorites
                </button>
              </div>
              {selected && route === "projects" && (
                <div className="project-overview">
                  <div className="feature-media">
                    <Media asset={selected} />
                    {actionAsset(selected)}
                  </div>
                  <div className="panel history">
                    <h3>Creation history</h3>
                    {assets
                      .slice()
                      .reverse()
                      .map((a, i) => (
                        <button
                          key={a.id}
                          onClick={() => updateState({ selected: a.id })}
                          className={
                            selected.id === a.id
                              ? "history-item chosen"
                              : "history-item"
                          }
                        >
                          <span className="step">{i + 1}</span>
                          <span>
                            <strong>{a.name}</strong>
                            <small>
                              {a.metadata.origin === "imported"
                                ? "Imported original"
                                : a.kind === "video"
                                  ? a.metadata.source_ids?.length
                                    ? "Animated from project image"
                                    : "Generated video"
                                  : a.kind === "text"
                                    ? "Writing revision"
                                    : "Generated image"}
                            </small>
                          </span>
                          <ChevronRight size={14} />
                        </button>
                      ))}
                  </div>
                </div>
              )}
              {visibleAssets.length ? (
                <div className="asset-grid">
                  {visibleAssets.map((a) => (
                    <article className="asset-card" key={a.id}>
                      <button
                        className="asset-preview"
                        onClick={() => {
                          updateState({ selected: a.id });
                          setRoute("projects");
                        }}
                      >
                        <Media asset={a} compact controls={false} />
                      </button>
                      <div className="asset-details">
                        <input
                          aria-label="Asset name"
                          defaultValue={a.name}
                          key={a.id + a.name}
                          onBlur={guarded(async (e) => {
                            if (e.target.value !== a.name) {
                              await api(
                                "/assets/" + a.id,
                                {
                                  name: e.target.value,
                                  favorite: !!a.favorite,
                                },
                                "PUT",
                              );
                              await refreshAssets();
                            }
                          })}
                        />
                        <button
                          aria-label={
                            a.favorite ? "Remove favorite" : "Favorite"
                          }
                          className={a.favorite ? "favorite" : ""}
                          onClick={guarded(async () => {
                            await api(
                              "/assets/" + a.id,
                              { name: a.name, favorite: !a.favorite },
                              "PUT",
                            );
                            await refreshAssets();
                          })}
                        >
                          <Star size={17} />
                        </button>
                      </div>
                      <small>
                        {a.kind} · {a.metadata.origin}{" "}
                        {a.metadata.duration
                          ? "· " + a.metadata.duration.toFixed(2) + " seconds"
                          : ""}
                      </small>
                      {actionAsset(a)}
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty">
                  <ImageIcon size={30} />
                  <h3>Your story starts here</h3>
                  <p>Create an image or import a photo to begin.</p>
                  <button className="primary" onClick={() => setRoute("image")}>
                    Create an image
                  </button>
                </div>
              )}
            </>
          )}
          {route === "mcp" && project && (
            <MCPServers
              initialServer={
                mcpSelection?.project === project.id ? mcpSelection.id : null
              }
              onCreate={(starter) => {
                setAgentIntent({
                  project: project.id,
                  starter,
                  mcp: true,
                  id: Date.now(),
                });
                setRoute("agents");
              }}
              onAgent={(agent) => {
                setAgentIntent({ project: project.id, agent, id: Date.now() });
                setRoute("agents");
              }}
              key={project.id}
              project={project}
              assets={assets}
              tools={tools}
              api={api}
            />
          )}
          {route === "agents" && project && (
            <AgentsStudio
              initialIntent={
                agentIntent?.project === project.id ? agentIntent : null
              }
              onIntentConsumed={() => setAgentIntent(null)}
              onMCPServer={(id) => {
                setMcpSelection({ project: project.id, id });
                setRoute("mcp");
              }}
              key={project.id}
              project={project}
              assets={assets}
              tools={tools}
              api={api}
            />
          )}
          {route === "chat" && project && (
            <GPTPaiton
              gpu={status.gpu}
              key={project.id}
              initialIntent={chatIntent}
              defaultProfile={settings.defaults?.chat || "gptoss-chat"}
              project={project}
              api={api}
              tools={tools}
              report={report}
              onSetup={() => {
                setSettingsTab("setup");
                setRoute("settings");
              }}
            />
          )}
          {(route === "image" || route === "video") && (
            <>
              <div className="creation-identity">
                <EditorialHero
                  compact
                  label={route === "image" ? "IMAGE CREATION" : "MOTION STUDIO"}
                  title={route === "image" ? "Turn ideas" : "Bring your ideas"}
                  accent={route === "image" ? "into images." : "to life."}
                >
                  Your vision, created on your machine.
                </EditorialHero>
                <MachineStatus gpu={status.gpu} active={active.length > 0} />
              </div>
              {route === "video" && (
                <div className="tabs mode-tabs">
                  <button
                    className={
                      (draft.mode || "image") === "image" ? "chosen" : ""
                    }
                    onClick={() =>
                      changeDraft({ mode: "image", profile: "auto" })
                    }
                  >
                    From image
                  </button>
                  <button
                    className={draft.mode === "text" ? "chosen" : ""}
                    onClick={() =>
                      changeDraft({ mode: "text", profile: "auto" })
                    }
                  >
                    From text
                  </button>
                </div>
              )}
              <div className="visual-workbench">
                <section className="creation-canvas">
                  <div className="canvas-topline">
                    <span className="eyebrow">
                      {route === "image" ? "IMAGE CANVAS" : "VIDEO PREVIEW"}
                    </span>
                    <span className="helper">
                      Original assets · saved locally
                    </span>
                  </div>
                  {(route === "image" ? images : videos)[0] ? (
                    <Media
                      asset={
                        (route === "image" ? images : videos).find(
                          (a) => a.id === pstate.selected,
                        ) || (route === "image" ? images : videos)[0]
                      }
                    />
                  ) : (
                    <div className="canvas-empty">
                      <div className="canvas-reticle">
                        <ImageIcon size={42} />
                      </div>
                      <h2>
                        {route === "image"
                          ? "A place for your imagination."
                          : "Your next moving story."}
                      </h2>
                      <p>
                        {route === "image"
                          ? "Describe an idea. Your original image will appear here."
                          : "Choose a source and describe the motion. Your finished clip will appear here."}
                      </p>
                      <span className="eyebrow">CREATED ON YOUR MACHINE</span>
                    </div>
                  )}
                  {(route === "image" ? images : videos)[0] && (
                    <div className="canvas-actions">
                      {actionAsset(
                        (route === "image" ? images : videos).find(
                          (a) => a.id === pstate.selected,
                        ) || (route === "image" ? images : videos)[0],
                      )}
                    </div>
                  )}
                </section>
                <div
                  className={route === "video" ? "video-layout" : "image-form"}
                >
                  {route === "video" && (draft.mode || "image") === "image" && (
                    <div className="source-column">
                      <div className="source-preview">
                        {source ? (
                          <img
                            src={
                              "/api/assets/" +
                              source.id +
                              "/fit?profile_id=" +
                              resolvedVideoProfile
                            }
                            alt="Source image fitted to the video canvas"
                          />
                        ) : (
                          <div className="empty">
                            <ImageIcon size={32} />
                            <p>Choose the image to animate</p>
                            <button onClick={() => importRef.current.click()}>
                              <Upload size={16} />
                              Import image
                            </button>
                          </div>
                        )}
                      </div>
                      <label>
                        Source image
                        <select
                          aria-label="Source image"
                          value={draft.source || ""}
                          onChange={(e) =>
                            changeDraft({ source: e.target.value })
                          }
                        >
                          <option value="">Choose from this project</option>
                          {images.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="text-link"
                        onClick={() => importRef.current.click()}
                      >
                        <Upload size={15} />
                        Change image
                      </button>
                      {source && (
                        <p className="helper">
                          Fit with borders, as previewed. Your original stays
                          unchanged. The fitted image is passed into the video
                          tool.
                        </p>
                      )}
                    </div>
                  )}
                  <div className="creation-form">
                    <label htmlFor="creation-prompt">
                      {route === "image"
                        ? "Describe your image"
                        : videoHasAudio
                          ? "Describe the motion and sound"
                          : "Describe the motion"}
                    </label>
                    <textarea
                      id="creation-prompt"
                      className="prompt"
                      value={draft.prompt || ""}
                      maxLength={2500}
                      onChange={(e) => changeDraft({ prompt: e.target.value })}
                      placeholder={
                        route === "image"
                          ? "A cozy mountain cabin at sunset, warm light in the windows, surrounded by pine trees…"
                          : videoHasAudio
                            ? "The fox walks slowly beside the stream, then looks toward the camera. Birds sing softly."
                            : "The fox walks slowly beside the stream, then looks toward the camera. Gentle camera movement."
                      }
                    />
                    {route === "image" && (
                      <div className="style-suggestions">
                        {[
                          "Photograph",
                          "Illustration",
                          "Product",
                          "Cinematic",
                        ].map((s) => (
                          <button
                            key={s}
                            onClick={() =>
                              changeDraft({
                                prompt:
                                  (draft.prompt || "") +
                                  ", " +
                                  s.toLowerCase() +
                                  " style",
                              })
                            }
                          >
                            {s}
                          </button>
                        ))}
                        <span className="helper">
                          Prompt styles · illustrative previews
                        </span>
                      </div>
                    )}
                    <ModelChoice
                      tools={tools}
                      task={
                        route === "video" && (draft.mode || "image") === "text"
                          ? "video_text"
                          : route
                      }
                      value={draft.profile || "auto"}
                      defaultId={
                        settings.defaults?.[
                          route === "video" &&
                          (draft.mode || "image") === "text"
                            ? "video_text"
                            : route
                        ]
                      }
                      onChange={(profile) => changeDraft({ profile })}
                      label="Creation profile"
                      onSetup={() => {
                        setSettingsTab("setup");
                        setRoute("settings");
                      }}
                      details
                    />
                    {route === "video" && (
                      <p className="helper">
                        {(() => {
                          const profile = taskProfiles(
                            tools,
                            (draft.mode || "image") === "text"
                              ? "video_text"
                              : "video",
                          ).find((item) => item.id === resolvedVideoProfile);
                          return profile
                            ? `${profile.width} × ${profile.height} · ${profile.fps} fps${profile.audio ? " · native stereo sound" : " · silent video"}.`
                            : "Your selected tool defines the video settings.";
                        })()}{" "}
                        Preparation time is separate from clip length.
                        Generation time varies.
                      </p>
                    )}
                    <details>
                      <summary>Advanced</summary>
                      <label>
                        Seed
                        <input
                          type="number"
                          min="0"
                          max="9007199254740991"
                          value={draft.seed ?? settings.generation?.seed ?? 771}
                          onChange={(e) =>
                            changeDraft({ seed: e.target.value })
                          }
                        />
                      </label>
                      <p className="helper">
                        The selected local package defines the supported
                        settings. Changing a profile affects only your next
                        request.
                      </p>
                    </details>
                    <div className="generation-footer">
                      <span>
                        <span className="status-dot" />
                        Runs on the Studio host
                      </span>
                      <button
                        className="primary generate"
                        disabled={
                          !draft.prompt?.trim() || Boolean(submittingTask)
                        }
                        onClick={guarded(generate)}
                      >
                        <Play size={16} />
                        {submittingTask
                          ? "Adding to queue…"
                          : route === "image"
                            ? "Generate image"
                            : "Generate video"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <div className="section-heading">
                <h2>{route === "image" ? "Your images" : "Your videos"}</h2>
                <span className="helper">Every result is saved separately</span>
              </div>
              {(route === "image" ? images : videos).length ? (
                <div className="results">
                  {(route === "image" ? images : videos).map((a) => (
                    <article key={a.id}>
                      <button
                        className="filmstrip-preview"
                        aria-label={"Preview " + a.name}
                        onClick={() => updateState({ selected: a.id })}
                      >
                        {a.kind === "image" ? (
                          <img
                            src={thumbnail(a)}
                            alt={a.name}
                            loading="lazy"
                            decoding="async"
                          />
                        ) : (
                          <video src={url(a)} preload="metadata" muted />
                        )}
                      </button>
                      <div className="result-caption">
                        <strong>{a.name}</strong>
                        <span>
                          {a.metadata.width} × {a.metadata.height}
                          {a.metadata.duration
                            ? " · " + a.metadata.duration.toFixed(2) + " s clip"
                            : ""}
                        </span>
                      </div>
                      {a.metadata.generation_seconds && (
                        <p className="helper">
                          Created in {Math.round(a.metadata.generation_seconds)}{" "}
                          seconds, including tool startup and saving.
                        </p>
                      )}
                      <details className="filmstrip-actions">
                        <summary>Use this result</summary>
                        {actionAsset(a)}
                      </details>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty results-empty">
                  <ImageIcon size={28} />
                  <p>
                    {route === "image"
                      ? "Your first image will appear here."
                      : "Your finished video will appear here. Sound depends on the selected model."}
                  </p>
                  <span>Saved to {project?.name || "your project"}</span>
                </div>
              )}
            </>
          )}
          {route === "meetings" && (
            <MeetingStudio key={project?.id} api={api} project={project} />
          )}
          {route === "delivery" && project && (
            <DeliveryStudio
              key={project.id}
              project={project}
              assets={assets}
              api={api}
              draft={draft}
              onChange={changeDraft}
              refreshAssets={refreshAssets}
              report={report}
              onVideo={() => navigate("video")}
            />
          )}
          {route === "write" && (
            <>
              <div className="eyebrow">03 / FIND YOUR WORDS</div>
              <h1>Write your story</h1>
              <p className="lead">
                Start with your notes. Make the draft your own.
              </p>
              <div className="writing-layout">
                <div className="panel writing-input">
                  <ModelChoice
                    tools={tools}
                    task="write"
                    value={draft.profile || "auto"}
                    defaultId={settings.defaults?.write}
                    onChange={(profile) => changeDraft({ profile })}
                    label="Writing model"
                    onSetup={() => {
                      setSettingsTab("setup");
                      setRoute("settings");
                    }}
                    details
                  />
                  <label>
                    Format
                    <select
                      value={draft.format || "Blog post"}
                      onChange={(e) => changeDraft({ format: e.target.value })}
                    >
                      {[
                        "Blog post",
                        "Social caption",
                        "Product story",
                        "Short script",
                      ].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                  <div className="row">
                    <label>
                      Tone
                      <select
                        value={draft.tone || "Natural"}
                        onChange={(e) => changeDraft({ tone: e.target.value })}
                      >
                        {["Natural", "Warm", "Professional", "Playful"].map(
                          (s) => (
                            <option key={s}>{s}</option>
                          ),
                        )}
                      </select>
                    </label>
                    <label>
                      Approx. words
                      <input
                        type="number"
                        min="50"
                        max="500"
                        value={draft.length || 250}
                        onChange={(e) =>
                          changeDraft({ length: e.target.value })
                        }
                      />
                    </label>
                  </div>
                  <label>
                    Your notes
                    <textarea
                      value={draft.prompt || ""}
                      maxLength={2500}
                      onChange={(e) => changeDraft({ prompt: e.target.value })}
                      placeholder="What should the reader know? Include real facts, audience and key points."
                    />
                  </label>
                  <fieldset>
                    <legend>Use project context</legend>
                    {assets.slice(0, 12).map((a) => (
                      <label className="check-row" key={a.id}>
                        <input
                          type="checkbox"
                          checked={(draft.context_ids || []).includes(a.id)}
                          onChange={(e) =>
                            changeDraft({
                              context_ids: e.target.checked
                                ? [...(draft.context_ids || []), a.id]
                                : (draft.context_ids || []).filter(
                                    (x) => x !== a.id,
                                  ),
                            })
                          }
                        />
                        {a.name}
                      </label>
                    ))}
                    <p className="helper">
                      Uses saved prompts, titles and writing. This tool does not
                      see image pixels or watch videos.
                    </p>
                  </fieldset>
                  <button
                    className="primary"
                    disabled={!draft.prompt?.trim() || Boolean(submittingTask)}
                    onClick={guarded(generate)}
                  >
                    <PenLine size={16} />
                    {submittingTask
                      ? "Adding to queue…"
                      : "Generate a new draft"}
                  </button>
                  <p className="helper">
                    New drafts are separate revisions. Your edits will stay here
                    until you choose a replacement.
                  </p>
                </div>
                <div className="panel document">
                  <div className="document-toolbar">
                    <label>
                      Saved drafts
                      <select
                        value={draft.document || ""}
                        onChange={guarded(async (e) => {
                          if (e.target.value) {
                            const a = documents.find(
                              (a) => a.id === e.target.value,
                            );
                            changeDraft({ pending: a.id });
                          }
                        })}
                      >
                        <option value="">Choose a revision</option>
                        {documents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name} ·{" "}
                            {new Date(a.created * 1000).toLocaleTimeString()}
                          </option>
                        ))}
                      </select>
                    </label>
                    {draft.pending && (
                      <button
                        onClick={guarded(async () => {
                          await selectDocument(
                            documents.find((a) => a.id === draft.pending),
                          );
                          setNotice(
                            "Selected revision applied to the editor. Earlier revisions are retained.",
                          );
                        })}
                      >
                        Apply selected revision
                      </button>
                    )}
                  </div>
                  <input
                    className="document-title"
                    aria-label="Document title"
                    value={draft.title || ""}
                    placeholder="Give your story a title"
                    onChange={(e) => changeDraft({ title: e.target.value })}
                  />
                  <textarea
                    className="document-editor"
                    aria-label="Document editor"
                    value={draft.editor || ""}
                    onChange={(e) => changeDraft({ editor: e.target.value })}
                    placeholder="Your words belong here. Write freely, or generate a draft and apply it from Saved drafts."
                  />
                  <div className="document-footer">
                    <span>
                      {
                        (draft.editor || "").trim().split(/\s+/).filter(Boolean)
                          .length
                      }{" "}
                      words · {saved ? "Draft saved locally" : "Saving draft…"}
                    </span>
                    <div className="actions">
                      <button onClick={guarded(saveDocument)}>
                        Save revision
                      </button>
                      <button
                        className="primary"
                        onClick={guarded(applyDocumentToPage)}
                      >
                        Use in page <ArrowRight size={15} />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
          {route === "page" && (
            <div className="tabs build-tabs" aria-label="Website builder mode">
              <button
                className={buildMode === "single" ? "chosen" : ""}
                onClick={() => updateState({ buildMode: "single" })}
              >
                <PanelsTopLeft size={16} />
                Single page
              </button>
              <button
                className={buildMode === "website" ? "chosen" : ""}
                onClick={() => updateState({ buildMode: "website" })}
              >
                <Globe size={16} />
                Full website
              </button>
            </div>
          )}
          {route === "page" && buildMode === "website" && (
            <>
              <div className="eyebrow">04 / PUT IT TOGETHER</div>
              <EditorialHero
                compact
                label="WEBSITE STUDIO"
                title="Build your"
                accent="website."
              />
              <p className="lead">
                From a single idea to a connected set of pages.
              </p>
              <WebsiteBuilder
                key={project.id}
                project={project}
                assets={assets}
                tools={tools}
                settings={settings}
                draft={pstate.websiteDraft || {}}
                updateDraft={(patch) => {
                  if (current.current?.id !== project.id) return;
                  updateState({
                    websiteDraft: {
                      ...(current.current.state.websiteDraft || {}),
                      ...patch,
                    },
                  });
                }}
                api={api}
                report={report}
                flush={flush}
                onAssets={refreshAssets}
                jobs={status.jobs}
                onRunStarted={setSubmittedWebsite}
                reviewRequest={
                  requestedWebsiteReview?.project === project.id
                    ? requestedWebsiteReview
                    : null
                }
                onReviewOpened={() => setRequestedWebsiteReview(null)}
              />
            </>
          )}
          {route === "page" && buildMode === "single" && (
            <>
              <div className="eyebrow">04 / PUT IT TOGETHER</div>
              <EditorialHero
                compact
                label="WEBSITE STUDIO"
                title="Build your"
                accent="page."
              />
              <p className="lead">
                Your real media. Your writing. Ready to take with you.
              </p>
              <div className="template-picker">
                {[
                  ["story", "Blog article"],
                  ["product", "Product page"],
                  ["portfolio", "Portfolio / story"],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    className={
                      (page.template || "story") === id
                        ? "template chosen"
                        : "template"
                    }
                    onClick={() =>
                      updateState({ page: { ...page, template: id } })
                    }
                  >
                    <PanelsTopLeft size={24} />
                    <span>
                      {id === "page"
                        ? "Build Website"
                        : id === "write"
                          ? "Writing"
                          : label}
                    </span>
                  </button>
                ))}
              </div>
              <div className="page-layout">
                <div className="preview-panel">
                  <div className="preview-toolbar">
                    <span>Local preview</span>
                    <div className="actions">
                      <button
                        aria-label="Preview desktop"
                        className={!mobile ? "chosen" : ""}
                        onClick={() => setMobile(false)}
                      >
                        <Monitor size={17} />
                      </button>
                      <button
                        aria-label="Preview mobile"
                        className={mobile ? "chosen" : ""}
                        onClick={() => setMobile(true)}
                      >
                        <Smartphone size={17} />
                      </button>
                      <button
                        aria-label="Refresh preview"
                        onClick={guarded(async () => {
                          await flush();
                          document.querySelector("iframe").src =
                            "/api/preview/" + project.id + "?v=" + Date.now();
                        })}
                      >
                        <RefreshCw size={17} />
                      </button>
                    </div>
                  </div>
                  <iframe
                    title="Page preview"
                    sandbox="allow-same-origin"
                    className={mobile ? "mobile-preview" : ""}
                    src={
                      "/api/preview/" +
                      project?.id +
                      "?v=" +
                      (saved ? JSON.stringify(page).length : "draft")
                    }
                  />
                </div>
                <div className="panel page-settings">
                  <h3>Page settings</h3>
                  <label>
                    Title
                    <input
                      value={page.title ?? project?.name ?? ""}
                      onChange={(e) =>
                        updateState({
                          page: { ...page, title: e.target.value },
                        })
                      }
                    />
                  </label>
                  <label>
                    Writing
                    <select
                      value={page.document || ""}
                      onChange={(e) =>
                        updateState({
                          page: { ...page, document: e.target.value },
                        })
                      }
                    >
                      <option value="">Use the text below</option>
                      {documents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!page.document && (
                    <label>
                      Page text
                      <textarea
                        value={page.text || ""}
                        onChange={(e) =>
                          updateState({
                            page: { ...page, text: e.target.value },
                          })
                        }
                        placeholder="Add your story here"
                      />
                    </label>
                  )}
                  <fieldset>
                    <legend>Selected media</legend>
                    {assets
                      .filter((a) => a.kind !== "text")
                      .map((a) => (
                        <label key={a.id} className="check-row">
                          <input
                            type="checkbox"
                            checked={(page.assets || []).includes(a.id)}
                            onChange={(e) =>
                              updateState({
                                page: {
                                  ...page,
                                  assets: e.target.checked
                                    ? [...(page.assets || []), a.id]
                                    : (page.assets || []).filter(
                                        (x) => x !== a.id,
                                      ),
                                },
                              })
                            }
                          />
                          {a.name}
                        </label>
                      ))}
                  </fieldset>
                  <label>
                    Section order
                    <select
                      value={(page.order || ["media", "text"])[0]}
                      onChange={(e) =>
                        updateState({
                          page: {
                            ...page,
                            order:
                              e.target.value === "media"
                                ? ["media", "text"]
                                : ["text", "media"],
                          },
                        })
                      }
                    >
                      <option value="media">Media, then writing</option>
                      <option value="text">Writing, then media</option>
                    </select>
                  </label>
                  <label>
                    Theme
                    <select
                      value={page.theme || "light"}
                      onChange={(e) =>
                        updateState({
                          page: { ...page, theme: e.target.value },
                        })
                      }
                    >
                      <option value="light">Light</option>
                      <option value="dark">Dark</option>
                    </select>
                  </label>
                  <button className="primary" onClick={guarded(exportProject)}>
                    <Download size={16} />
                    Export page & project
                  </button>
                  <p className="helper">
                    Includes media and text. Open the exported page in a
                    browser, even offline.
                  </p>
                </div>
              </div>
            </>
          )}
          {route === "tools" && (
            <>
              <div className="creation-identity">
                <EditorialHero
                  label="CREATION TOOLS"
                  title="Powerful AI tools"
                  accent="running locally."
                >
                  Everything you need to imagine, create and share.
                </EditorialHero>
                <MachineStatus gpu={status.gpu} active={active.length > 0} />
              </div>
              <h2 className="editorial-section-title">
                Your creative toolkit.
              </h2>
              <CapabilityShelf tools={tools} onNavigate={guarded(navigate)} />
              <details className="installed-packages">
                <summary>
                  Models & packages · compatible choices and technical details
                </summary>
                <div className="tools-grid">
                  {tools.map((t) => (
                    <article
                      className={
                        "panel tool tool-" +
                        (t.capabilities?.includes("image.generate")
                          ? "image"
                          : t.capabilities?.includes("video.generate")
                            ? "video"
                            : "text")
                      }
                      key={t.id}
                    >
                      <div className="tool-identity">
                        {t.capabilities?.includes("image.generate") ? (
                          <ImageIcon size={30} />
                        ) : t.capabilities?.includes("video.generate") ? (
                          <Film size={30} />
                        ) : t.capabilities?.includes("text.chat") ? (
                          <MessageSquare size={30} />
                        ) : (
                          <PenLine size={30} />
                        )}
                        <span className="eyebrow">
                          LOCAL CREATIVE CAPABILITY
                        </span>
                      </div>
                      <div className="section-heading">
                        <h2>{t.name}</h2>
                        <span
                          className={
                            "badge " + (t.state === "ready" ? "ready" : "")
                          }
                        >
                          {t.state === "ready"
                            ? "Installed"
                            : t.integrated
                              ? t.state === "incompatible"
                                ? "Incompatible"
                                : "Setup needed"
                              : "Not integrated"}
                        </span>
                      </div>
                      <p>{t.message}</p>
                      {t.id === "minicpm5-2b" && (
                        <p className="fast-model-note">
                          Quick replies, lighter thinking. Choose this smaller
                          model for speed; choose a larger model for more
                          reliable reasoning and complex work.
                        </p>
                      )}
                      <button
                        className="text-link"
                        onClick={guarded(async () => {
                          if (t.state !== "ready") {
                            setSettingsTab("setup");
                            setRoute("settings");
                            return;
                          }
                          const destination = t.capabilities?.includes(
                            "image.generate",
                          )
                            ? "image"
                            : t.capabilities?.includes("video.generate")
                              ? "video"
                              : t.capabilities?.includes("text.chat")
                                ? "chat"
                                : "write";
                          await ensureProject();
                          const selected = t.profiles.find((p) =>
                            p.roles?.includes(destination),
                          );
                          if (destination === "chat" && selected)
                            setChatIntent({
                              profile: selected.id,
                              id: Date.now(),
                            });
                          else if (selected)
                            updateState({
                              [destination]: {
                                ...current.current.state[destination],
                                profile: selected.id,
                              },
                            });
                          setRoute(destination);
                        })}
                      >
                        {t.state === "ready"
                          ? "Open workspace"
                          : "Set up this capability"}
                        <ArrowRight size={14} />
                      </button>
                      {t.compatibility && (
                        <div className="tool-requirements">
                          <span>
                            GPU memory required
                            <strong>
                              {t.compatibility.required_vram_gib
                                ? `${t.compatibility.required_vram_gib} GB`
                                : "Not yet qualified"}
                            </strong>
                          </span>
                          <span>
                            Detected GPU memory
                            <strong>
                              {Number.isFinite(
                                t.compatibility.detected_vram_gib,
                              )
                                ? `${t.compatibility.detected_vram_gib.toFixed(0)} GB`
                                : "Unavailable"}
                            </strong>
                          </span>
                          {t.compatibility.compatible === false && (
                            <p>{t.compatibility.reason}</p>
                          )}
                        </div>
                      )}
                      <details>
                        <summary>Model and package details</summary>
                        <p>{t.model}</p>
                        <p className="helper">
                          Revision: {t.revision}
                          <br />
                          {t.license}
                        </p>
                        {t.profiles.map((p) => (
                          <p key={p.id}>{p.label}</p>
                        ))}
                        <p className="helper">
                          Hardware execution evidence is recorded in the local
                          verification report. Installed does not mean loaded.
                        </p>
                      </details>
                    </article>
                  ))}
                </div>
                <div className="panel">
                  <h3>GPU details</h3>
                  <p>{status.gpu.message}</p>
                  {status.gpu.total > 0 && (
                    <p className="helper">
                      Driver readings:{" "}
                      {(status.gpu.used / 1024 ** 3).toFixed(1)} GiB used /{" "}
                      {(status.gpu.total / 1024 ** 3).toFixed(1)} GiB total.
                    </p>
                  )}
                </div>
              </details>
            </>
          )}
          {route === "settings" && (
            <StudioSettings
              api={api}
              report={report}
              onToolsRefresh={async () => setTools(await api("/tools"))}
              settings={settings}
              modelMemory={status.model_memory}
              initialTab={settingsTab}
              tools={tools}
              gpu={status.gpu}
              onSave={async (value) => {
                try {
                  setSettings(
                    await api(
                      "/settings",
                      {
                        defaults: value.defaults,
                        appearance: value.appearance,
                        generation: value.generation,
                        performance: value.performance,
                      },
                      "PUT",
                    ),
                  );
                  return true;
                } catch (error) {
                  report(error);
                  return false;
                }
              }}
              onTools={() => setRoute("tools")}
              onWiki={() => setRoute("wiki")}
            />
          )}
          {route === "wiki" && <StudioWiki />}
        </main>
      </div>
      <input
        ref={importRef}
        type="file"
        accept="image/png,image/jpeg"
        hidden
        onChange={guarded((e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          return importImage(file);
        })}
      />
      <WebsiteNotifications
        api={api}
        enabled={ready}
        jobs={status.jobs}
        submitted={submittedWebsite}
        report={report}
        onQueue={() => setQueueOpen(true)}
        onReview={async (run) => {
          await openProject(run.project, "page");
          updateState({ buildMode: "website" });
          setRequestedWebsiteReview(run);
          setQueueOpen(false);
        }}
      />
      {queueOpen && (
        <aside className="queue-panel" aria-label="Creation queue">
          <div className="section-heading">
            <h2>Creation queue</h2>
            <button
              aria-label="Close queue"
              onClick={() => setQueueOpen(false)}
            >
              <X size={20} />
            </button>
          </div>
          <p className="helper">
            One creation tool at a time. Editing and exporting remain available.
          </p>
          <GpuActivity
            gpu={status.gpu}
            samples={gpuSamples}
            details={settings.appearance?.show_gpu_details ?? true}
          />
          {settings.appearance?.compact_queue && (
            <button
              className="text-link"
              onClick={() => setQueueHistory(!queueHistory)}
            >
              {queueHistory
                ? "Hide finished requests"
                : `Show history (${status.jobs.filter((job) => !ACTIVE.includes(job.state)).length})`}
            </button>
          )}
          {jobsToShow.length ? (
            jobsToShow.map((j) => (
              <article className="queue-job" key={j.id}>
                <div className="section-heading">
                  <strong>
                    {j.request.website_run
                      ? j.request.task === "image"
                        ? "Website artwork"
                        : "Website writing"
                      : j.request.task === "write"
                        ? "Writing"
                        : j.request.task === "image"
                          ? "Image"
                          : j.request.task === "meeting"
                            ? "Meeting transcription"
                            : "Video"}
                  </strong>
                  <span className="badge">{j.state}</span>
                </div>
                {ACTIVE.includes(j.state) ? (
                  <div className="queue-phase">
                    <strong>{stageForJob(j).title}</strong>
                    <p>{stageForJob(j).description}</p>
                    {stageForJob(j).measured ? (
                      <progress
                        aria-label="Current task progress"
                        value={j.progress.value}
                        max={j.progress.maximum}
                      />
                    ) : (
                      <progress aria-label={stageForJob(j).title} />
                    )}
                    <p>
                      {formatElapsed(
                        Math.max(0, studioNow() / 1000 - j.created),
                      )}{" "}
                      since this request entered the queue · AI processing stays
                      local.
                    </p>
                    {j.state === "queued" && j.message && (
                      <small>{j.message}</small>
                    )}
                  </div>
                ) : (
                  <p role="status">{j.message}</p>
                )}
                <div className="actions">
                  {ACTIVE.includes(j.state) && (
                    <button
                      disabled={j.state === "cancelling"}
                      onClick={guarded(async () => {
                        await api("/jobs/" + j.id + "/cancel", {});
                        setStatus(await api("/status"));
                      })}
                    >
                      <Square size={13} />
                      Cancel
                    </button>
                  )}
                  {["failed", "cancelled"].includes(j.state) &&
                    !j.request.website_run && (
                      <button
                        onClick={guarded(async () => {
                          await api("/jobs/" + j.id + "/retry", {});
                          setStatus(await api("/status"));
                        })}
                      >
                        <RefreshCw size={13} />
                        Retry same request
                      </button>
                    )}
                  {j.request.website_run && (
                    <button
                      onClick={guarded(async () => {
                        await openProject(j.project, "page");
                        updateState({ buildMode: "website" });
                        setQueueOpen(false);
                      })}
                    >
                      <Globe size={13} />
                      Open website builder
                    </button>
                  )}
                  {j.state === "failed" && j.request.task === "video" && (
                    <button
                      onClick={guarded(async () => {
                        await api("/jobs/" + j.id + "/recover", {});
                        await refreshAssets();
                        setStatus(await api("/status"));
                      })}
                    >
                      Recover saved output
                    </button>
                  )}
                  {j.asset && (
                    <button
                      onClick={guarded(() =>
                        openProject(j.project, "projects"),
                      )}
                    >
                      View result <ArrowRight size={13} />
                    </button>
                  )}
                </div>
              </article>
            ))
          ) : (
            <div className="empty">
              <Check size={26} />
              <p>
                {status.jobs.length
                  ? "No requests are running. Open history to see previous creations."
                  : "No requests yet."}
              </p>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
