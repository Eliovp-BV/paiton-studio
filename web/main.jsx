import Diagnostics from "./Diagnostics";
import { createStudioApi } from "./studioApi";
import { PairingScreen } from "./NetworkAccess";
import { CapabilityShelf } from "./StudioIdentity";
import MCPServers from "./MCPServers";
import { HostNotice } from "./HostGuidance";
import AgentsStudio from "./AgentsStudio";
import CodingStudio from "./CodingStudio";
import ModelAPI from "./ModelAPI";
import GPTPaiton from "./GPTPaiton";
import ProjectBrief from "./ProjectBrief";
import ResultActions from "./ResultActions";
import SavedResultReader from "./SavedResultReader";
import TransferReview from "./TransferReview";
import WorkspaceDialog from "./WorkspaceDialog";
import ProjectSearch from "./ProjectSearch";
import Recipes from "./Recipes";
import CompletionInbox from "./CompletionInbox";
import {
  appendDraft,
  suggestedCodeName,
  uniqueCodeName,
  destinationName,
} from "./workspaceLinks";
import StudioNavigation, { WorkspaceSections } from "./StudioNavigation";
import { studioRoute, MODEL_TABS } from "./studioNavigation";
import {
  PaitonMark,
  CommandBar,
  HardwarePanel,
  HomeWorkspace,
} from "./StudioDesign";
import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import {
  Folder,
  Image as ImageIcon,
  Film,
  PenLine,
  MessageSquare,
  PanelsTopLeft,
  Library,
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
  BookOpen,
  Globe,
} from "lucide-react";
import "./style.css";
import {
  ModelChoice,
  ProjectFlow,
  StudioSettings,
  StudioWiki,
  taskProfiles,
  selectedProfile,
} from "./WorkspaceExtras";
import ImageRecipe from "./ImageRecipe";
import { PerformanceSummary, ImageTime, QueueEstimate } from "./Performance";
import ComfyWorkspace from "./ComfyWorkspace";
import { filterLibraryAssets, isPageMedia } from "./librarySearch";
import {
  IMAGE_STYLES,
  imageRecipeDraft,
  imagePromptLimit,
  imageEditSourceIssue,
  imagePromotionProfile,
  imageSeedSequence,
  imageSequenceCount,
  imageStyle,
  imageStylePhrase,
  newImageSeed,
  styledImagePrompt,
} from "./imageRecipe";
import WebsiteBuilder from "./WebsiteBuilder";
import DeliveryStudio from "./DeliveryStudio";
import MeetingStudio from "./MeetingStudio";
import WebsiteNotifications from "./WebsiteNotifications";
import { stageForJob, formatElapsed, studioNow } from "./creationFeedback";
import { stateLabel } from "./jobStates";

import "./studio-design.css";
import "./studio-gold.css";

const api = createStudioApi();
const opensComfy =
  new URLSearchParams(location.search).get("workspace") === "comfy";
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
      {asset.kind === "document" ? (
        <BookOpen size={30} />
      ) : (
        <PenLine size={30} />
      )}
      <strong>{asset.name}</strong>
      <span>
        {asset.kind === "document"
          ? "Document · uploaded reference"
          : asset.kind === "text"
            ? "Writing · saved revision"
            : "Saved asset"}
      </span>
    </div>
  );
}
function App() {
  const [route, setRoute] = useState(() => studioRoute(location.hash.slice(1))),
    [projects, setProjects] = useState([]),
    [project, setProject] = useState(null),
    [assets, setAssets] = useState([]),
    [tools, setTools] = useState([]),
    [status, setStatus] = useState({
      jobs: [],
      gpu: { message: "Checking local tools" },
    }),
    [queueOpen, setActivityOpen] = useState(false),
    [notice, setNotice] = useState(""),
    [saved, setSaved] = useState(true),
    [saveConflict, setSaveConflict] = useState(false),
    [ready, setReady] = useState(false),
    [mobile, setMobile] = useState(false),
    [filter, setFilter] = useState("all"),
    [libraryQuery, setLibraryQuery] = useState(""),
    [favorites, setFavorites] = useState(false),
    [settings, setSettings] = useState({
      defaults: {},
      appearance: {},
      generation: {},
    }),
    [gpuSamples, setGpuSamples] = useState([]),
    [queueHistory, setQueueHistory] = useState(false);
  const [chatIntent, setChatIntent] = useState(null);
  const [focusedQueueJob, setFocusedQueueJob] = useState(null);
  const [queueFocusRequest, setQueueFocusRequest] = useState(0);
  const queueFocusCard = useRef(null);
  const [codingIntent, setCodingIntent] = useState(null);
  const [handoff, setHandoff] = useState(null);
  const [readingResult, setReadingResult] = useState(null);
  const [recipesOpen, setRecipesOpen] = useState(false);
  const handoffSequence = useRef(0);
  const [agentIntent, setAgentIntent] = useState(null);
  const [mcpSelection, setMcpSelection] = useState(null);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [submittedWebsite, setSubmittedWebsite] = useState(null);
  const [requestedWebsiteReview, setRequestedWebsiteReview] = useState(null);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [startupError, setStartupError] = useState("");
  const [pairing, setPairing] = useState(null);
  useEffect(() => {
    api.onPairingRequired = (error) =>
      setPairing({ enabled: error.networkEnabled });
    return () => {
      api.onPairingRequired = null;
    };
  }, []);
  function paired() {
    setPairing(null);
    setConnectionError("");
    if (!ready) setStartupAttempt((attempt) => attempt + 1);
  }
  const [connectionError, setConnectionError] = useState("");
  const [submittingTask, setSubmittingTask] = useState(null);
  // null until the local meeting package has been checked; the navigation
  // entry appears only when it is ready, Home offers a setup card otherwise.
  const [meetingsReady, setMeetingsReady] = useState(null);
  const [creationWorkspace, setCreationWorkspace] = useState(
    opensComfy ? { image: "comfy", video: "comfy" } : {},
  );
  const [comfyVisited, setComfyVisited] = useState(opensComfy);
  const mediaNavigation = useRef({
    route,
    workspaces: creationWorkspace,
    assets,
  });
  mediaNavigation.current = { route, workspaces: creationWorkspace, assets };
  const lastMediaTask = useRef(route === "video" ? "video" : "image");
  const isMediaRoute = route === "image" || route === "video";
  if (isMediaRoute) lastMediaTask.current = route;
  const mediaTask = isMediaRoute ? route : lastMediaTask.current;
  const comfyEnabled = isMediaRoute && creationWorkspace[route] === "comfy";
  const submissionLock = useRef(false),
    projectCreation = useRef(null),
    openRequest = useRef(0),
    generateButton = useRef(null);
  const current = useRef(null),
    dirty = useRef(false),
    saving = useRef(null),
    conflict = useRef(false),
    saveTimer = useRef(),
    importRef = useRef(),
    importDestination = useRef("video"),
    completed = useRef(null);
  const pstate = project?.state || {};
  const [activityTab, setActivityTab] = useState("queue");
  const [activityUnread, setActivityUnread] = useState(0);
  const [websitePending, setWebsitePending] = useState(0);
  const activityTrigger = useRef(null);
  useEffect(() => {
    if (!queueOpen) return;
    const close = (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setActivityOpen(false);
      activityTrigger.current?.focus();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [queueOpen]);
  function setQueueOpen(value) {
    setActivityOpen(value);
    if (value) setActivityTab("queue");
  }
  const imageEditing = route === "image" && pstate.image?.mode === "edit";
  const draft = imageEditing ? pstate.image?.edit || {} : pstate[route] || {};
  const active = status.jobs.filter((j) => ACTIVE.includes(j.state));
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
    if (current.current?.id !== id) resetLibraryFilters();
    setAssets(p.assets);
    delete p.assets;
    setProject(p);
    current.current = p;
    dirty.current = false;
    setSaved(true);
    setRoute(destination);
    localStorage.setItem("studio-project", id);
  }
  async function openWorkspaceTarget(target) {
    const owner = target.project_id || current.current?.id;
    if (!owner) throw Error("Open a project first.");
    const attempt = ++openRequest.current;
    let value;
    let destination = "projects";
    if (target.kind === "chat") {
      value = await api(`/chats/${target.chat_id}`);
      if (
        value.project !== owner ||
        (target.turn_id &&
          !value.turns.some((turn) => turn.id === target.turn_id))
      )
        throw Error(
          "This conversation result is no longer available in the project.",
        );
      destination = "chat";
    } else if (target.kind === "agent") {
      value = await api(`/projects/${owner}/agent-runs/${target.run_id}`);
      if (value.agent !== target.agent_id)
        throw Error("This agent result no longer matches its source.");
      destination = "agents";
    } else if (target.kind === "code") {
      value = await api(
        `/projects/${owner}/code/file?path=${encodeURIComponent(target.path)}`,
      );
      if (target.version && value.version !== target.version)
        throw Error(
          "This saved file changed. Search again to find its current content.",
        );
      destination = "coding";
    } else if (target.kind === "website") {
      value = await api(`/projects/${owner}/website-runs/${target.run_id}`);
      destination = "page";
    } else if (target.kind === "asset") {
      const data = await api(`/projects/${owner}`);
      value = data.assets.find((asset) => asset.id === target.asset_id);
      if (!value)
        throw Error("This result is no longer available in the project.");
      if (["document", "text"].includes(value.kind))
        value = {
          ...value,
          reader: await api(`/projects/${owner}/assets/${value.id}/text`),
        };
    } else if (target.kind === "job") {
      value = await api(`/projects/${owner}/jobs/${target.job_id}`);
      if (value.id !== target.job_id || value.project !== owner)
        throw Error("This task is no longer available in the project.");
    } else throw Error("This result has no supported destination.");
    if (attempt !== openRequest.current) return false;
    const opening = openProject(owner, destination),
      navigation = openRequest.current;
    await opening;
    if (navigation !== openRequest.current || current.current?.id !== owner)
      return false;
    const id = `${Date.now()}-${navigation}`;
    if (target.kind === "chat")
      setChatIntent({
        project: owner,
        chatId: target.chat_id,
        turnId: target.turn_id,
        id,
      });
    if (target.kind === "agent")
      setAgentIntent({
        project: owner,
        agent: target.agent_id,
        run: value,
        id,
      });
    if (target.kind === "code")
      setCodingIntent({ ...target, project: owner, kind: "open", id });
    if (target.kind === "website") {
      updateState({ buildMode: "website" });
      setRequestedWebsiteReview(value);
    }
    if (target.kind === "asset") {
      resetLibraryFilters();
      updateState({ selected: value.id });
      if (value.reader)
        setReadingResult({ ...value.reader, query: target.query || "" });
    }
    if (target.kind === "job") {
      setFocusedQueueJob(value);
      setQueueFocusRequest((request) => request + 1);
      setQueueHistory(true);
      setQueueOpen(true);
      setNotice(value.message || "Task opened in the queue.");
    } else setQueueOpen(false);
    return true;
  }
  async function prepareHandoff(source) {
    const owner = current.current;
    if (!owner || source.project_id !== owner.id)
      throw Error("Open this result's project before continuing.");
    const attempt = ++handoffSequence.current;
    let next = { ...source, project_name: owner.name };
    if (source.kind !== "image" && typeof source.text !== "string") {
      const result = await api(
        `/projects/${owner.id}/assets/${source.asset_id}/text`,
      );
      next.text = result.text;
    }
    if (source.target === "coding") {
      const workspace = await api(`/projects/${owner.id}/code`);
      let cached = {};
      try {
        cached =
          JSON.parse(
            sessionStorage.getItem(`paiton-code-drafts:${owner.id}`) || "{}",
          ).buffers || {};
      } catch {
        /* Host files remain authoritative. */
      }
      next.filename = uniqueCodeName(suggestedCodeName(source.language), [
        ...workspace.files.map((file) => file.path),
        ...Object.keys(cached),
      ]);
    }
    if (attempt !== handoffSequence.current || current.current?.id !== owner.id)
      return;
    setReadingResult(null);
    setHandoff(next);
  }
  async function applyHandoff(source) {
    const owner = current.current;
    if (source.project_id !== owner?.id)
      throw Error(
        "The project changed. Open the original result and try again.",
      );
    if (source.target === "coding") {
      let cached = {};
      try {
        cached =
          JSON.parse(
            sessionStorage.getItem(`paiton-code-drafts:${owner.id}`) || "{}",
          ).buffers || {};
      } catch {
        /* The editor also checks its live buffers. */
      }
      if (cached[source.filename])
        throw Error(
          "A draft already uses this name. Choose a different file name.",
        );
      const checked = await api(`/projects/${owner.id}/code/check-draft`, {
        path: source.filename,
        content: source.text,
        version: null,
      });
      if (current.current?.id !== owner.id)
        throw Error("The project changed; no file was created.");
      setCodingIntent({
        project: owner.id,
        kind: "draft",
        path: checked.path,
        language: checked.language,
        content: source.text,
        source: source.title,
        id: Date.now(),
      });
      setRoute("coding");
    } else if (source.target === "chat") {
      if (!source.asset_id)
        throw Error("Save this result before attaching it to Chat.");
      setChatIntent({
        project: owner.id,
        task: {
          text: "Help me build on this result.",
          document: { id: source.asset_id, name: source.title },
          source: source.title,
        },
        id: Date.now(),
      });
      setRoute("chat");
    } else if (source.target === "write") {
      const currentDraft = owner.state.write || {};
      const editor = appendDraft(
        currentDraft.editor || "",
        source.text,
        100000,
      );
      updateState({
        write: {
          ...currentDraft,
          editor,
          title: currentDraft.title || source.title,
          sourceNote: `Added from ${source.title}`,
          sourceIds: [
            ...new Set(
              [...(currentDraft.sourceIds || []), source.asset_id].filter(
                Boolean,
              ),
            ),
          ],
        },
      });
      setRoute("write");
      setNotice(
        "Result added to your Writing draft. Save a revision when ready.",
      );
    } else if (["video", "image"].includes(source.target)) {
      const asset = assets.find(
        (item) =>
          item.id === source.asset_id &&
          item.project === owner.id &&
          item.kind === "image",
      );
      if (!asset) throw Error("This image is no longer available.");
      if (source.target === "image") editImage(asset);
      else openMediaTask("video", asset);
    }
    setHandoff(null);
  }
  async function useRecipe(recipe) {
    const navigation = openRequest.current;
    const owner = await ensureProject();
    if (navigation !== openRequest.current || current.current?.id !== owner.id)
      throw Error(
        "The project changed. Open the recipe again in the intended project.",
      );
    const id = Date.now();
    if (recipe.target === "chat")
      setChatIntent({
        project: owner.id,
        task: { text: recipe.prompt, source: `Recipe: ${recipe.name}` },
        id,
      });
    else if (recipe.target === "coding")
      setCodingIntent({
        project: owner.id,
        kind: "task",
        text: recipe.prompt,
        source: `Recipe: ${recipe.name}`,
        id,
      });
    else if (recipe.target === "page")
      updateState({
        buildMode: "website",
        websiteDraft: {
          ...owner.state.websiteDraft,
          brief: appendDraft(
            owner.state.websiteDraft?.brief || "",
            recipe.prompt,
            2500,
          ),
        },
      });
    else if (["image", "write"].includes(recipe.target)) {
      updateState({
        [recipe.target]: {
          ...owner.state[recipe.target],
          ...(recipe.target === "image" ? { mode: "create" } : {}),
          prompt: appendDraft(
            owner.state[recipe.target]?.prompt || "",
            recipe.prompt,
            2500,
          ),
        },
      });
      if (recipe.target === "image") chooseCreationWorkspace("image", "create");
    } else throw Error("Choose a supported recipe destination.");
    setRoute(recipe.target);
    setRecipesOpen(false);
    setNotice(
      `${recipe.name} opened in ${destinationName(recipe.target)}. Review the draft and context before generating.`,
    );
    return true;
  }
  async function openQueueItem(job) {
    const opening = openProject(
      job.project,
      job.request.chat_id ? "chat" : "projects",
    );
    const attempt = openRequest.current;
    await opening;
    if (attempt !== openRequest.current || current.current?.id !== job.project)
      return;
    if (job.asset) updateState({ selected: job.asset });
    if (job.request.chat_id)
      setChatIntent({
        project: job.project,
        chatId: job.request.chat_id,
        id: attempt,
      });
    setQueueOpen(false);
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
    if (
      ![
        "home",
        "tools",
        "settings",
        "wiki",
        "system",
        ...Object.keys(MODEL_TABS),
      ].includes(to)
    )
      await ensureProject();
    if (attempt !== openRequest.current) return;
    if (to === "image" || to === "video") openMediaTask(to);
    else setRoute(to);
  }
  function chooseCreationWorkspace(task, mode) {
    const next = { ...mediaNavigation.current.workspaces, [task]: mode };
    mediaNavigation.current.workspaces = next;
    setCreationWorkspace(next);
    if (mode === "comfy") setComfyVisited(true);
  }
  function openMediaTask(task, explicitSource) {
    const navigation = mediaNavigation.current;
    const outgoingMedia =
      navigation.route === "image" || navigation.route === "video";
    const mode =
      navigation.workspaces[outgoingMedia ? navigation.route : task] ||
      "create";
    const owner = current.current;
    if (
      explicitSource &&
      (explicitSource.kind !== "image" || explicitSource.project !== owner?.id)
    ) {
      setNotice("Open this image's project before using it for video.");
      return;
    }
    chooseCreationWorkspace(task, mode);
    if (
      task === "video" &&
      owner &&
      (navigation.route === "image" || explicitSource)
    ) {
      const projectImages = navigation.assets.filter(
        (asset) => asset.kind === "image" && asset.project === owner.id,
      );
      const state = owner.state || {};
      const source =
        explicitSource ||
        projectImages.find((asset) => asset.id === state.selected) ||
        projectImages.find((asset) => asset.id === state.video?.source) ||
        projectImages[0];
      if (source) {
        const patch = {
          selected: source.id,
          video: { ...(state.video || {}), source: source.id, mode: "image" },
        };
        // Choosing an image for video is an edit; merely entering the Video
        // workspace only seeds the view and must not save the project.
        if (explicitSource) updateState(patch);
        else seedState(patch);
      }
    }
    mediaNavigation.current.route = task;
    lastMediaTask.current = task;
    setRoute(task);
  }
  function seedState(patch) {
    const p = {
      ...current.current,
      state: { ...current.current.state, ...patch },
    };
    setProject(p);
    current.current = p;
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
    if (imageEditing)
      updateState({
        image: { ...current.current.state.image, edit: { ...draft, ...patch } },
      });
    else updateState({ [route]: { ...draft, ...patch } });
  }
  function changeImageMode(mode) {
    updateState({ image: { ...current.current.state.image, mode } });
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
          api("/status?compact=true"),
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
      const target = studioRoute(location.hash.slice(1));
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
      retry;
    // A failed check leaves readiness unknown, so a transient error never
    // hides a prepared package; one retry covers a backend still starting.
    // Only an explicit "not ready" hides the Meetings entry.
    const check = (attempt) =>
      api("/meetings/readiness")
        .then((readiness) => {
          if (alive) setMeetingsReady(Boolean(readiness.ready));
        })
        .catch(() => {
          if (alive && attempt === 0) retry = setTimeout(() => check(1), 4000);
        });
    check(0);
    return () => {
      alive = false;
      clearTimeout(retry);
    };
  }, [ready]);
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
        const s = await api("/status?compact=true");
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
    if (!ready || !["image", "video"].includes(route)) return;
    const destination = new URL(location.href);
    if (creationWorkspace[route] === "comfy")
      destination.searchParams.set("workspace", "comfy");
    else destination.searchParams.delete("workspace");
    if (destination.href !== location.href)
      history.replaceState(history.state, "", destination);
  }, [creationWorkspace, route, ready]);
  useEffect(() => {
    const change = () => {
      navigate(studioRoute(location.hash.slice(1))).catch(report);
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
  function chooseImageImport(destination = "video") {
    importDestination.current = destination;
    importRef.current.click();
  }
  async function importImage(file, destination = "video") {
    if (!file) return;
    const p = await ensureProject();
    const body = new FormData();
    body.append("file", file);
    const asset = await api("/projects/" + p.id + "/import", body);
    if (current.current?.id !== p.id) {
      setNotice(
        "Image imported into its original project. Open that project to use it.",
      );
      return;
    }
    await refreshAssets();
    if (current.current?.id !== p.id) return;
    if (destination === "image") editImage(asset);
    else animate(asset);
    setNotice(
      `Your original image is saved and selected for ${destination === "image" ? "editing" : "video"}.`,
    );
  }
  function editImage(asset) {
    if (asset.kind !== "image" || asset.project !== current.current?.id)
      throw Error("Choose an image from the current project.");
    const state = current.current.state;
    updateState({
      image: {
        ...state.image,
        mode: "edit",
        edit: { ...state.image?.edit, source: asset.id },
      },
      selected: asset.id,
    });
    chooseCreationWorkspace("image", "create");
    setRoute("image");
    setNotice(
      "Describe your changes below. Your original is kept, and the edited image is saved separately.",
    );
  }
  function animate(asset) {
    openRequest.current++;
    openMediaTask("video", asset);
  }
  function useOnPage(asset) {
    if (!isPageMedia(asset)) return;
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
    if (status.worker?.state === "stopped")
      throw Error(
        "AI is paused. Your draft is saved for when execution resumes.",
      );
    submissionLock.current = true;
    setSubmittingTask(route);
    try {
      if (creationPromptLength > creationPromptLimit)
        throw Error(
          `This profile supports ${creationProfileLimit} characters${
            creationStyle
              ? ` including the ${creationStyle.label} style phrase`
              : ""
          }. Shorten your prompt or choose another profile.`,
        );
      const p = await ensureProject();
      // An empty image seed is drawn once before the sequence is derived, and
      // written back so the series stays reproducible from the draft. Any other
      // value is sent as typed: the server's validation message explains a
      // negative or fractional seed instead of a silent replacement.
      let baseSeed = Number(shownSeed);
      if (route === "image" && shownSeed === "") {
        baseSeed = newImageSeed();
        changeDraft({ seed: baseSeed });
      }
      await flush();
      const profileId = draft.profile || "auto";
      const body = {
        task: route,
        profile_id: profileId,
        prompt: draft.prompt || "",
      };
      if (creationStyle) {
        // The style is applied here, never to the draft text.
        body.prompt = styledImagePrompt(draft.prompt, creationStyle.id);
        body.style = creationStyle.id;
      }
      if (imageEditing) {
        const original = assets.find((asset) => asset.id === draft.source);
        const issue = imageEditSourceIssue(original, p.id);
        if (issue) throw Error(issue);
        body.source_id = original.id;
      }
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
      const seeds =
        route === "image"
          ? imageSeedSequence(baseSeed, imageCount)
          : [baseSeed];
      const queued = [];
      for (const seed of seeds) {
        let job;
        try {
          job = await api("/projects/" + p.id + "/jobs", { ...body, seed });
        } catch (error) {
          // Keep what the queue accepted and say how far the series got.
          if (!queued.length) throw error;
          setQueueOpen(true);
          setNotice(
            `Queued ${queued.length} of ${seeds.length} requests (seeds ${seeds
              .slice(0, queued.length)
              .join(", ")}). ${error.message}`,
          );
          return;
        }
        queued.push(job);
        // A confirmed enqueue stays successful even if the next status poll fails.
        setStatus((s) => ({
          ...s,
          jobs: [job, ...s.jobs.filter((item) => item.id !== job.id)],
        }));
      }
      setQueueOpen(true);
      setNotice(
        seeds.length > 1
          ? `${seeds.length} requests saved in the queue with seeds ${seeds.join(", ")}. You can keep editing.`
          : "Request saved in the queue. You can keep editing.",
      );
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
  function reuseImage(asset, variation = false, promoteTo = null) {
    if (asset.project !== current.current?.id)
      throw Error("Open this image's project before reusing its settings.");
    const next = imageRecipeDraft(
      asset,
      variation ? newImageSeed(asset.metadata?.request?.seed) : undefined,
    );
    if (!next) throw Error("This image has no reusable generation settings.");
    // Promotion keeps the prompt, style and seed and only raises the profile.
    if (promoteTo) next.profile = promoteTo;
    const imageState = current.current.state.image || {};
    updateState({
      image:
        next.mode === "edit"
          ? { ...imageState, mode: "edit", edit: next }
          : {
              ...imageState,
              ...next,
              ...(imageState.mode ? { mode: "create" } : {}),
            },
      selected: asset.id,
    });
    chooseCreationWorkspace("image", "create");
    setRoute("image");
    const restored = `Prompt, ${next.style ? "style, " : ""}profile`;
    setNotice(
      promoteTo
        ? `Prompt, ${next.style ? "style " : ""}and seed restored with the 2048 × 2048 profile. Review the request, then generate.`
        : variation
          ? `${restored} restored with a new seed. Review the request, then generate.`
          : `${restored} and seed restored. Review the request, then generate.`,
    );
    if (promoteTo) setTimeout(() => generateButton.current?.focus(), 0);
  }
  function actionAsset(asset) {
    const promotion = imagePromotionProfile(asset, tools);
    return (
      <>
        <div className="actions">
          {imageRecipeDraft(asset) && (
            <>
              <button onClick={guarded(() => reuseImage(asset))}>
                <RefreshCw size={15} />
                Reuse settings
              </button>
              <button onClick={guarded(() => reuseImage(asset, true))}>
                <Plus size={15} />
                New variation
              </button>
              {promotion && (
                <button
                  title="Creates this prompt and seed again at 2048 × 2048; details can change."
                  onClick={guarded(() =>
                    reuseImage(asset, false, promotion.id),
                  )}
                >
                  <ArrowUpRight size={15} />
                  Promote to 2048
                </button>
              )}
            </>
          )}
          {asset.kind === "image" && (
            <button onClick={guarded(() => editImage(asset))}>
              <PenLine size={15} /> Edit image
            </button>
          )}
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
          {asset.kind === "text" && (
            <button
              onClick={guarded(async () => {
                await selectDocument(asset);
                setRoute("write");
              })}
            >
              Open writing
            </button>
          )}
          {isPageMedia(asset) && (
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
        {["text", "document"].includes(asset.kind) && (
          <ResultActions
            source={{
              kind: "text",
              asset_id: asset.id,
              project_id: asset.project,
              title: asset.name,
            }}
            onHandoff={guarded(prepareHandoff)}
          />
        )}
        <ImageRecipe asset={asset} />
      </>
    );
  }
  const projectAssets = assets.filter((a) => a.project === project?.id);
  const visibleAssets = filterLibraryAssets(assets, {
    projectId: project?.id,
    query: libraryQuery,
    kind: filter,
    favorites,
  });
  const hasLibraryFilters = !!libraryQuery || filter !== "all" || favorites;
  function resetLibraryFilters() {
    setLibraryQuery("");
    setFilter("all");
    setFavorites(false);
  }
  const videos = assets.filter((a) => a.kind === "video"),
    images = assets.filter((a) => a.kind === "image"),
    documents = assets.filter((a) => a.kind === "text");
  const editorImages = images.filter((a) => a.project === project?.id);
  const editorSource =
    editorImages.find((a) => a.id === pstate.video?.source) ||
    editorImages.find((a) => a.id === pstate.selected) ||
    editorImages[0];
  const source = editorImages.find((a) => a.id === draft.source);
  const creationSource =
    imageEditing || (route === "video" && (draft.mode || "image") === "image");
  const editSourceIssue = imageEditing
    ? imageEditSourceIssue(source, project?.id)
    : "";
  const imageRole = imageEditing ? "image_edit" : "image";
  const page = pstate.page || {};
  const buildMode = pstate.buildMode || "single";
  const creationProfileLimit =
    route === "image"
      ? imagePromptLimit(
          selectedProfile(
            tools,
            imageRole,
            draft.profile || "auto",
            settings.defaults?.[imageRole],
          ),
        )
      : 2500;
  // A selected style is appended when the request is built, so its phrase is
  // reserved out of the profile's prompt budget instead of counted in the draft.
  const creationStyle =
    route === "image" && !imageEditing ? imageStyle(draft.style) : null;
  const creationStyleReserve = imageStylePhrase(creationStyle?.id).length;
  const creationPromptLimit = creationProfileLimit - creationStyleReserve;
  const creationPromptLength =
    route === "image"
      ? Array.from(draft.prompt || "").length
      : (draft.prompt || "").length;
  const promptOverLimit = creationPromptLength > creationPromptLimit;
  // Count queues one ordinary request per seed, counting up from the seed shown.
  const imageCount = route === "image" ? imageSequenceCount(draft.count) : 1;
  const shownSeed = draft.seed ?? settings.generation?.seed ?? 771;
  const imageSeeds =
    imageCount > 1 &&
    shownSeed !== "" &&
    Number.isSafeInteger(Number(shownSeed)) &&
    Number(shownSeed) >= 0
      ? imageSeedSequence(Number(shownSeed), imageCount)
      : null;
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
  useEffect(() => {
    if (focusedQueueJob && focusedQueueJob.project !== project?.id)
      setFocusedQueueJob(null);
  }, [project?.id, focusedQueueJob?.project]);
  useEffect(() => {
    if (!focusedQueueJob) return;
    const latest = status.jobs.find((job) => job.id === focusedQueueJob.id);
    if (
      latest &&
      latest !== focusedQueueJob &&
      (latest.updated || 0) >= (focusedQueueJob.updated || 0)
    )
      setFocusedQueueJob(latest);
  }, [status.jobs, focusedQueueJob]);
  useEffect(() => {
    if (
      !queueOpen ||
      !focusedQueueJob ||
      focusedQueueJob.project !== project?.id
    )
      return;
    const frame = requestAnimationFrame(() => {
      queueFocusCard.current?.scrollIntoView({
        block: "center",
        behavior: "instant",
      });
      queueFocusCard.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [queueOpen, queueFocusRequest, focusedQueueJob?.id, project?.id]);
  const queueJobs =
    focusedQueueJob && focusedQueueJob.project === project?.id
      ? [
          focusedQueueJob,
          ...status.jobs.filter((job) => job.id !== focusedQueueJob.id),
        ]
      : status.jobs;
  const jobsToShow =
    settings.appearance?.compact_queue && !queueHistory
      ? queueJobs.filter((job) => ACTIVE.includes(job.state))
      : queueJobs;
  if (!ready && pairing)
    return (
      <PairingScreen api={api} enabled={pairing.enabled} onPaired={paired} />
    );
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
      inert={pairing ? true : undefined}
      className={
        "shell studio-shell route-" +
        route +
        (navCollapsed ? " nav-collapsed" : "")
      }
    >
      {pairing &&
        createPortal(
          <PairingScreen
            api={api}
            enabled={pairing.enabled}
            onPaired={paired}
            overlay
          />,
          document.body,
        )}
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
        <StudioNavigation
          route={route}
          collapsed={navCollapsed}
          hidden={meetingsReady === false ? ["meetings"] : []}
          onNavigate={(to) => guarded(() => navigate(to))()}
        />
        <div className="sidebar-bottom">
          <HardwarePanel
            gpu={status.gpu}
            samples={gpuSamples}
            active={active.length > 0}
            state={currentJob?.state}
            chatReady={status.chat_model_ready}
            details={settings.appearance?.show_gpu_details ?? true}
            onDetails={() => setRoute("system")}
          />
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
                ? "Saved on this computer"
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
            <button
              aria-label="Activity"
              aria-expanded={queueOpen}
              aria-controls="studio-activity"
              ref={activityTrigger}
              onClick={() => setActivityOpen(!queueOpen)}
            >
              <Clock size={16} />
              <span>Activity</span>
              {active.length > 0 && <b className="count">{active.length}</b>}
              {(activityUnread > 0 || websitePending > 0) && (
                <span
                  className="activity-unread"
                  title="Saved outcomes are ready to review"
                >
                  •
                </span>
              )}
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
              setRoute("system");
              window.location.hash = "system";
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
          {project && route === "projects" && (
            <ProjectFlow
              assets={assets}
              page={page}
              website={
                !!(
                  pstate.websiteDraft?.editor || pstate.websiteDraft?.siteReady
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
          <div className="studio-workspace-tools" aria-label="Workspace tools">
            {project && (
              <ProjectSearch
                project={project}
                api={api}
                onOpen={openWorkspaceTarget}
                report={report}
              />
            )}
            <button type="button" onClick={() => setRecipesOpen(true)}>
              <BookOpen size={15} /> Recipes
            </button>
          </div>
          {![
            "image",
            "video",
            "write",
            "page",
            "settings",
            "system",
            ...Object.keys(MODEL_TABS),
          ].includes(route) && (
            <WorkspaceSections
              route={route}
              onNavigate={(to) => guarded(() => navigate(to))()}
            />
          )}
          {route === "home" && (
            <HomeWorkspace
              gpu={status.gpu}
              active={active.length > 0}
              onDetails={() => {
                setRoute("system");
              }}
              onLaunch={launchIdea}
              projects={projects}
              project={project}
              assets={assets}
              tools={tools}
              meetingsReady={meetingsReady}
              onNavigate={guarded(navigate)}
              onOpen={guarded(openProject)}
              onCreate={guarded(createProject)}
              onImport={() => chooseImageImport("video")}
              onSetup={() => {
                setRoute("model-setup");
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
              {route === "projects" && project && (
                <ProjectBrief
                  key={project.id}
                  project={project}
                  api={api}
                  selection={false}
                />
              )}
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
                    ["document", "Documents"],
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
              <div className="toolbar">
                <label style={{ flex: 1, minWidth: 0 }}>
                  Search this project
                  <input
                    type="search"
                    value={libraryQuery}
                    placeholder="Search by name, prompt or model"
                    aria-describedby="library-search-scope"
                    onChange={(e) => setLibraryQuery(e.target.value)}
                  />
                </label>
                {hasLibraryFilters && (
                  <button onClick={resetLibraryFilters}>
                    <X size={16} />
                    Clear filters
                  </button>
                )}
              </div>
              <p className="helper" id="library-search-scope" role="status">
                Showing {visibleAssets.length} of {projectAssets.length} assets
                in {project?.name || "this project"}. Search covers names,
                prompts and models.
              </p>
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
                                    : a.kind === "document"
                                      ? "Uploaded document"
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
              ) : projectAssets.length > 0 ? (
                <div className="empty">
                  <Library size={30} />
                  <h3>No assets match these filters</h3>
                  <p>
                    Try another name, prompt or model, or clear the filters to
                    see every asset in {project?.name || "this project"}.
                  </p>
                  <button onClick={resetLibraryFilters}>
                    Show all project assets
                  </button>
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
              onCoding={() => setRoute("coding")}
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
                setAgentIntent({
                  project: project.id,
                  agent,
                  id: Date.now(),
                });
                setRoute("agents");
              }}
              key={project.id}
              project={project}
              assets={assets}
              api={api}
            />
          )}
          {route === "agents" && project && (
            <AgentsStudio
              defaultConversationOptions={settings.conversation}
              defaultProfile={settings.defaults?.chat || "auto"}
              onModels={() => {
                setRoute("model-setup");
              }}
              onCoding={() => setRoute("coding")}
              onHandoff={guarded(prepareHandoff)}
              worker={status.worker}
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
              assets={assets}
              worker={status.worker}
              defaultImageProfile={settings.defaults?.image || "auto"}
              gpu={status.gpu}
              key={project.id}
              initialIntent={chatIntent}
              onHandoff={guarded(prepareHandoff)}
              onIntentConsumed={(id) =>
                setChatIntent((intent) => (intent?.id === id ? null : intent))
              }
              defaultProfile={settings.defaults?.chat || "auto"}
              defaultCodeProfile={settings.defaults?.code || "auto"}
              defaultConversationOptions={settings.conversation}
              project={project}
              api={api}
              tools={tools}
              report={report}
              onSetup={() => {
                setRoute("model-setup");
              }}
            />
          )}
          {route === "coding" && project && (
            <CodingStudio
              defaultProfile={settings.defaults?.code || "auto"}
              onModels={() => {
                setRoute("model-setup");
              }}
              key={project.id}
              project={project}
              api={api}
              tools={tools}
              worker={status.worker}
              initialPrompt={pstate.coding?.prompt || ""}
              initialIntent={
                codingIntent?.project === project.id ? codingIntent : null
              }
              onIntentConsumed={(id) =>
                setCodingIntent((intent) => (intent?.id === id ? null : intent))
              }
              onHandoff={guarded(prepareHandoff)}
              onMCP={() => setRoute("mcp")}
              onAgents={() => setRoute("agents")}
              onModelAPI={() => setRoute("model-api")}
            />
          )}
          {route === "model-api" && project && (
            <ModelAPI
              key={project.id}
              project={project}
              api={api}
              tools={tools}
              worker={status.worker}
              onModels={() => {
                setRoute("model-setup");
              }}
            />
          )}
          {(route === "image" || route === "video") && (
            <>
              <div
                className="creation-workspace-tabs"
                role="group"
                aria-label="Creation workspace"
              >
                <button
                  aria-pressed={creationWorkspace[route] !== "comfy"}
                  onClick={() => chooseCreationWorkspace(route, "create")}
                >
                  {route === "image" ? (
                    <ImageIcon size={16} />
                  ) : (
                    <Film size={16} />
                  )}{" "}
                  Create
                </button>
                <button
                  aria-pressed={creationWorkspace[route] === "comfy"}
                  onClick={() => {
                    chooseCreationWorkspace(route, "comfy");
                  }}
                >
                  <Boxes size={16} /> ComfyUI <small>Advanced</small>
                </button>
              </div>
              {creationWorkspace[route] !== "comfy" && (
                <header className="create-heading">
                  <h1>
                    {route === "image" ? "Create an image" : "Create a video"}
                  </h1>
                  <p>Your ideas, created and saved on this computer.</p>
                </header>
              )}
              <div hidden={creationWorkspace[route] === "comfy"}>
                {route === "image" && (
                  <div
                    className="tabs mode-tabs"
                    role="group"
                    aria-label="Image task"
                  >
                    <button
                      className={!imageEditing ? "chosen" : ""}
                      aria-pressed={!imageEditing}
                      onClick={() => changeImageMode("create")}
                    >
                      Create new
                    </button>
                    <button
                      className={imageEditing ? "chosen" : ""}
                      aria-pressed={imageEditing}
                      onClick={() => changeImageMode("edit")}
                    >
                      Edit existing
                    </button>
                  </div>
                )}
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
                  <div
                    className={
                      route === "video" ? "video-layout" : "image-form"
                    }
                  >
                    <div className="creation-form">
                      <label htmlFor="creation-prompt">
                        {route === "image"
                          ? imageEditing
                            ? "Describe your changes"
                            : "Describe your image"
                          : videoHasAudio
                            ? "Describe the motion and sound"
                            : "Describe the motion"}
                      </label>
                      <textarea
                        id="creation-prompt"
                        className="prompt"
                        value={draft.prompt || ""}
                        maxLength={
                          route === "image"
                            ? creationPromptLimit * 2
                            : creationPromptLimit
                        }
                        aria-describedby={
                          route === "image" ? "image-prompt-limit" : undefined
                        }
                        aria-invalid={promptOverLimit || undefined}
                        onChange={(e) =>
                          changeDraft({ prompt: e.target.value })
                        }
                        placeholder={
                          route === "image"
                            ? imageEditing
                              ? "Change the background to a sunlit garden. Keep the subject and its details unchanged…"
                              : "A cozy mountain cabin at sunset, warm light in the windows, surrounded by pine trees…"
                            : videoHasAudio
                              ? "The fox walks slowly beside the stream, then looks toward the camera. Birds sing softly."
                              : "The fox walks slowly beside the stream, then looks toward the camera. Gentle camera movement."
                        }
                      />
                      {route === "image" && (
                        <p
                          id="image-prompt-limit"
                          className="helper prompt-limit"
                          role={promptOverLimit ? "alert" : undefined}
                        >
                          {creationPromptLength} / {creationPromptLimit}{" "}
                          characters
                          {creationStyle &&
                            ` · ${creationStyleReserve} reserved for the ${creationStyle.label} style`}
                          {promptOverLimit &&
                            (creationStyle
                              ? " · Shorten your prompt, clear the style or choose another profile. Your draft is kept."
                              : " · Shorten your prompt or choose another profile. Your draft is kept.")}
                        </p>
                      )}
                      <div className="generation-footer">
                        <span
                          className={
                            creationSource ? "generation-source" : undefined
                          }
                          title={creationSource ? source?.name : undefined}
                        >
                          <span className="status-dot" />
                          {creationSource
                            ? `Source: ${source?.name || "Choose an image below"}`
                            : "Runs on the Studio host"}
                        </span>
                        <button
                          ref={generateButton}
                          className="primary generate"
                          disabled={
                            !draft.prompt?.trim() ||
                            promptOverLimit ||
                            Boolean(editSourceIssue) ||
                            status.worker?.state === "stopped" ||
                            Boolean(submittingTask)
                          }
                          onClick={guarded(generate)}
                        >
                          <Play size={16} />
                          {submittingTask
                            ? "Adding to queue…"
                            : route === "image"
                              ? imageEditing
                                ? "Generate edit"
                                : "Generate image"
                              : "Generate video"}
                        </button>
                      </div>
                      {route === "image" && !imageEditing && (
                        <div className="style-suggestions">
                          {IMAGE_STYLES.map((style) => (
                            <button
                              key={style.id}
                              type="button"
                              aria-pressed={draft.style === style.id}
                              onClick={() =>
                                changeDraft({
                                  style:
                                    draft.style === style.id ? null : style.id,
                                })
                              }
                            >
                              {style.label}
                            </button>
                          ))}
                          <span className="helper">
                            {creationStyle
                              ? `${creationStyle.label} · appended to your prompt as “${imageStylePhrase(creationStyle.id)}”`
                              : "Prompt style · choose one, click again to clear"}
                          </span>
                        </div>
                      )}
                      <ModelChoice
                        tools={tools}
                        task={
                          route === "video" &&
                          (draft.mode || "image") === "text"
                            ? "video_text"
                            : route === "image"
                              ? imageRole
                              : route
                        }
                        value={draft.profile || "auto"}
                        defaultId={
                          settings.defaults?.[
                            route === "video" &&
                            (draft.mode || "image") === "text"
                              ? "video_text"
                              : route === "image"
                                ? imageRole
                                : route
                          ]
                        }
                        onChange={(profile) => changeDraft({ profile })}
                        label="Creation profile"
                        onSetup={() => {
                          setRoute("model-setup");
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
                        <label htmlFor="creation-seed">Seed</label>
                        <div className="image-seed-control">
                          <input
                            id="creation-seed"
                            type="number"
                            min="0"
                            max="9007199254740991"
                            value={
                              draft.seed ?? settings.generation?.seed ?? 771
                            }
                            onChange={(e) =>
                              changeDraft({ seed: e.target.value })
                            }
                          />
                          {route === "image" && (
                            <button
                              type="button"
                              onClick={() =>
                                changeDraft({
                                  seed: newImageSeed(
                                    draft.seed ??
                                      settings.generation?.seed ??
                                      771,
                                  ),
                                })
                              }
                            >
                              <RefreshCw size={14} /> New seed
                            </button>
                          )}
                        </div>
                        {route === "image" && (
                          <>
                            <label htmlFor="creation-count">Count</label>
                            <div className="image-count-control">
                              <select
                                id="creation-count"
                                aria-describedby="creation-count-help"
                                value={imageCount}
                                onChange={(e) =>
                                  changeDraft({
                                    count: Number(e.target.value),
                                  })
                                }
                              >
                                {[1, 2, 3, 4].map((n) => (
                                  <option key={n} value={n}>
                                    {n}
                                  </option>
                                ))}
                              </select>
                              <span className="helper" id="creation-count-help">
                                {imageCount === 1
                                  ? "One request per Generate"
                                  : imageSeeds
                                    ? `${imageCount} separate requests with seeds ${imageSeeds.join(", ")}`
                                    : `${imageCount} separate requests, counting up from a new seed`}
                              </span>
                            </div>
                          </>
                        )}
                        <p className="helper">
                          The selected local package defines the supported
                          settings. Changing a profile affects only your next
                          request.
                        </p>
                      </details>
                      {status.worker?.state === "stopped" && (
                        <p className="helper" role="status">
                          AI is paused. Prepare your draft now; generation
                          becomes available when execution resumes.
                        </p>
                      )}
                    </div>
                    {(imageEditing ||
                      (route === "video" &&
                        (draft.mode || "image") === "image")) && (
                      <div
                        className={`source-column${imageEditing ? " image-edit-source" : ""}`}
                      >
                        <div className="source-preview">
                          {source ? (
                            <img
                              src={
                                imageEditing
                                  ? url(source)
                                  : "/api/assets/" +
                                    source.id +
                                    "/fit?profile_id=" +
                                    resolvedVideoProfile
                              }
                              alt={
                                imageEditing
                                  ? "Original image to edit"
                                  : "Source image fitted to the video canvas"
                              }
                            />
                          ) : (
                            <div className="empty">
                              <ImageIcon size={32} />
                              <p>
                                {imageEditing
                                  ? "Choose the image to edit"
                                  : "Choose the image to animate"}
                              </p>
                              <button
                                onClick={() =>
                                  chooseImageImport(
                                    imageEditing ? "image" : "video",
                                  )
                                }
                              >
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
                            {draft.source && !source && (
                              <option value={draft.source} disabled>
                                Original image is unavailable
                              </option>
                            )}
                            {editorImages.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          className="text-link"
                          onClick={() =>
                            chooseImageImport(imageEditing ? "image" : "video")
                          }
                        >
                          <Upload size={15} />
                          Change image
                        </button>
                        {imageEditing ? (
                          <>
                            <p className="helper">
                              One source image · up to 4,194,304 pixels. Edits
                              create a new 1024 × 1024 image in 40 steps. Your
                              original stays unchanged.
                            </p>
                            {source && editSourceIssue && (
                              <p className="notice" role="alert">
                                {editSourceIssue}
                              </p>
                            )}
                            {!source && draft.source && (
                              <p className="notice" role="alert">
                                The saved original is no longer in this project.
                                Choose another image; your edit instructions are
                                kept.
                              </p>
                            )}
                          </>
                        ) : (
                          source && (
                            <p className="helper">
                              Fit with borders, as previewed. Your original
                              stays unchanged. The fitted image is passed into
                              the video tool.
                            </p>
                          )
                        )}
                      </div>
                    )}
                  </div>
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
                </div>
                <div className="section-heading">
                  <h2>{route === "image" ? "Your images" : "Your videos"}</h2>
                  <span className="helper">
                    Every result is saved separately
                  </span>
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
                              ? " · " +
                                a.metadata.duration.toFixed(2) +
                                " s clip"
                              : ""}
                          </span>
                        </div>
                        {a.kind === "image" ? (
                          <ImageTime asset={a} />
                        ) : (
                          a.metadata.generation_seconds && (
                            <p className="helper">
                              Created in{" "}
                              {Math.round(a.metadata.generation_seconds)}{" "}
                              seconds, including tool startup and saving.
                            </p>
                          )
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
              </div>
            </>
          )}
          {comfyVisited && (
            <div hidden={!comfyEnabled}>
              <ComfyWorkspace
                api={api}
                enabled={comfyEnabled}
                task={mediaTask}
                project={project}
                ensureProject={ensureProject}
                assets={assets}
                sourceId={editorSource?.id || ""}
                prompt={pstate[mediaTask]?.prompt || ""}
                onVideo={() =>
                  openMediaTask(
                    "video",
                    editorImages.find((a) => a.id === pstate.selected) ||
                      editorSource,
                  )
                }
                onSourceChange={(source) =>
                  updateState({
                    selected: source,
                    video: {
                      ...current.current.state.video,
                      source,
                      mode: "image",
                    },
                  })
                }
              />
            </div>
          )}
          {route === "meetings" && (
            <MeetingStudio
              key={project?.id}
              api={api}
              project={project}
              onReadiness={(readiness) =>
                setMeetingsReady(Boolean(readiness.ready))
              }
            />
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
              <header className="create-heading">
                <h1>Write your story</h1>
                <p>Start with your notes. Make the draft your own.</p>
              </header>
              <div className="writing-layout">
                <div className="panel writing-input">
                  <label>
                    Your notes
                    <textarea
                      value={draft.prompt || ""}
                      maxLength={2500}
                      onChange={(e) => changeDraft({ prompt: e.target.value })}
                      placeholder="What should the reader know? Include real facts, audience and key points."
                    />
                  </label>
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
                  <ModelChoice
                    tools={tools}
                    task="write"
                    value={draft.profile || "auto"}
                    defaultId={settings.defaults?.write}
                    onChange={(profile) => changeDraft({ profile })}
                    label="Writing model"
                    onSetup={() => {
                      setRoute("model-setup");
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
                  {draft.sourceNote && (
                    <p className="workspace-source-note">
                      {draft.sourceNote} · original result retained
                    </p>
                  )}
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
              <header className="create-heading">
                <h1>Build your website</h1>
                <p>From a single idea to a connected set of pages.</p>
              </header>
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
                onRunStarted={(run) => {
                  setSubmittedWebsite(run);
                  setActivityTab("websites");
                  setActivityOpen(true);
                }}
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
              <header className="create-heading">
                <h1>Build your page</h1>
                <p>Your real media. Your writing. Ready to take with you.</p>
              </header>
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
                    <span>{label}</span>
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
                    {assets.filter(isPageMedia).map((a) => (
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
              <header className="create-heading">
                <h1>Models</h1>
                <p>Compatible local models, weights and pinned runtimes.</p>
              </header>
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
                            setRoute("model-setup");
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
                                ? `${t.compatibility.required_vram_gib} GiB`
                                : "Not yet qualified"}
                            </strong>
                          </span>
                          <span>
                            Detected GPU memory
                            <strong>
                              {Number.isFinite(
                                t.compatibility.detected_vram_gib,
                              )
                                ? `${t.compatibility.detected_vram_gib.toFixed(0)} GiB`
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
                          Installed tools load into GPU memory when you use
                          them.
                        </p>
                      </details>
                    </article>
                  ))}
                </div>
              </details>
            </>
          )}
          {(route === "settings" ||
            route === "system" ||
            MODEL_TABS[route]) && (
            <StudioSettings
              api={api}
              report={report}
              onToolsRefresh={async () => setTools(await api("/tools"))}
              settings={settings}
              modelMemory={status.model_memory}
              scope={MODEL_TABS[route] ? "models" : "workspace"}
              initialTab={
                MODEL_TABS[route] ||
                (route === "system" ? "system" : "preferences")
              }
              onTabChange={(tab) =>
                setRoute(
                  MODEL_TABS[route]
                    ? Object.keys(MODEL_TABS).find(
                        (key) => MODEL_TABS[key] === tab,
                      ) || "tools"
                    : tab === "system"
                      ? "system"
                      : "settings",
                )
              }
              onSetup={() => setRoute("model-setup")}
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
                        conversation: value.conversation,
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
          return importImage(file, importDestination.current);
        })}
      />
      {handoff && (
        <TransferReview
          key={`${handoff.project_id}:${handoff.target}:${handoff.asset_id || handoff.filename}`}
          source={handoff}
          onApply={applyHandoff}
          onClose={() => setHandoff(null)}
        />
      )}
      {readingResult && (
        <SavedResultReader
          result={readingResult}
          projectName={project?.name}
          onClose={() => setReadingResult(null)}
          onHandoff={guarded(prepareHandoff)}
        />
      )}
      {recipesOpen && (
        <WorkspaceDialog
          title="Recipes"
          wide
          onClose={() => setRecipesOpen(false)}
        >
          <Recipes
            project={project}
            api={api}
            onUse={useRecipe}
            report={report}
          />
        </WorkspaceDialog>
      )}
      <aside
        id="studio-activity"
        className="queue-panel activity-panel"
        aria-label="Activity"
        hidden={!queueOpen}
      >
        <div className="section-heading">
          <h2>Activity</h2>
          <button
            aria-label="Close activity"
            onClick={() => setQueueOpen(false)}
          >
            <X size={20} />
          </button>
        </div>
        <div className="tabs activity-tabs" aria-label="Activity sections">
          <button
            className={activityTab === "queue" ? "chosen" : ""}
            onClick={() => setActivityTab("queue")}
          >
            Queue{active.length ? ` (${active.length})` : ""}
          </button>
          <button
            className={activityTab === "completed" ? "chosen" : ""}
            onClick={() => setActivityTab("completed")}
          >
            Completed{activityUnread ? ` (${activityUnread})` : ""}
          </button>
          <button
            className={activityTab === "websites" ? "chosen" : ""}
            onClick={() => setActivityTab("websites")}
          >
            Website reviews{websitePending ? ` (${websitePending})` : ""}
          </button>
        </div>
        <section hidden={activityTab !== "queue"} aria-label="Creation queue">
          <h3>Creation queue</h3>
          <p className="helper">
            One creation tool at a time. Editing and exporting remain available.
          </p>
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
              <article
                className={`queue-job${j.id === focusedQueueJob?.id ? " queue-job-focused" : ""}`}
                key={j.id}
                data-job-id={j.id}
                tabIndex={j.id === focusedQueueJob?.id ? -1 : undefined}
                ref={j.id === focusedQueueJob?.id ? queueFocusCard : undefined}
                aria-label={
                  j.id === focusedQueueJob?.id ? "Opened queue task" : undefined
                }
              >
                {j.id === focusedQueueJob?.id && (
                  <small className="queue-opened-marker">
                    Opened task · {project?.name}
                  </small>
                )}
                <div className="section-heading">
                  <strong>
                    {j.request.website_run
                      ? j.request.task === "image"
                        ? "Website artwork"
                        : "Website writing"
                      : j.request.agent_run_id
                        ? "Agent step"
                        : j.request.chat_id
                          ? j.request.task === "image"
                            ? "Conversation image"
                            : "Conversation reply"
                          : {
                              write: "Writing",
                              image: "Image",
                              video: "Video",
                              meeting: "Meeting transcription",
                            }[j.request.task] || "Saved task"}
                  </strong>
                  <span className="badge">{stateLabel(j.state)}</span>
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
                    <QueueEstimate estimate={j.estimate} />
                  </div>
                ) : (
                  <>
                    <p role="status">{j.message}</p>
                    {j.state === "completed" && (
                      <>
                        <PerformanceSummary metrics={j.performance} />
                        <ImageTime asset={j.result} />
                      </>
                    )}
                  </>
                )}
                {["failed", "interrupted"].includes(j.state) && (
                  <Diagnostics
                    api={api}
                    endpoint={`/jobs/${j.id}/diagnostics`}
                  />
                )}
                <div className="actions">
                  {ACTIVE.includes(j.state) && (
                    <button
                      disabled={j.state === "cancelling"}
                      onClick={guarded(async () => {
                        await api("/jobs/" + j.id + "/cancel", {});
                        setStatus(await api("/status?compact=true"));
                      })}
                    >
                      <Square size={13} />
                      Cancel
                    </button>
                  )}
                  {["failed", "cancelled"].includes(j.state) &&
                    !j.request.website_run &&
                    !j.request.chat_id && (
                      <button
                        onClick={guarded(async () => {
                          await api("/jobs/" + j.id + "/retry", {});
                          setStatus(await api("/status?compact=true"));
                        })}
                      >
                        <RefreshCw size={13} />
                        Retry same request
                      </button>
                    )}
                  {["failed", "cancelled"].includes(j.state) &&
                    j.request.chat_id && (
                      <button onClick={guarded(() => openQueueItem(j))}>
                        <MessageSquare size={13} />
                        Open conversation
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
                  {j.recoverable && (
                    <button
                      onClick={guarded(async () => {
                        await api("/jobs/" + j.id + "/recover", {});
                        await refreshAssets();
                        setStatus(await api("/status?compact=true"));
                      })}
                    >
                      Recover saved output
                    </button>
                  )}
                  {j.asset && (
                    <button onClick={guarded(() => openQueueItem(j))}>
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
        </section>
        <section
          hidden={activityTab !== "completed"}
          aria-label="Completed activity"
        >
          <CompletionInbox
            embedded
            onUnread={setActivityUnread}
            project={project}
            api={api}
            onOpen={openWorkspaceTarget}
            report={report}
          />
        </section>
        <section
          hidden={activityTab !== "websites"}
          aria-label="Website reviews"
        >
          <h3>Website reviews</h3>
          <WebsiteNotifications
            embedded
            onClose={() => setActivityOpen(false)}
            onPending={setWebsitePending}
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
          {!submittedWebsite && !websitePending && (
            <p className="helper">
              Finished website drafts and updates appear here for review.
            </p>
          )}
        </section>
      </aside>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
