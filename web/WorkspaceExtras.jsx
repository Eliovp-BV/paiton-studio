import React, { useId, useState } from "react";
import {
  Activity,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  Cpu,
  Film,
  Image as ImageIcon,
  PenLine,
  PanelsTopLeft,
  Search,
  Settings2,
} from "lucide-react";
import { WIKI } from "./wiki.js";
import { EditorialHero, MachineStatus } from "./StudioIdentity";
import SetupTools from "./SetupTools";
import ModelMemorySettings from "./ModelMemorySettings";
import SystemDetails from "./SystemDetails";
import ReadinessPanel from "./ReadinessPanel";
import "./model-quality-note.css";

export function taskProfiles(tools, task) {
  return tools.flatMap((tool) =>
    (tool.profiles || [])
      .filter(
        (profile) =>
          profile.task ===
            (["website", "chat", "code"].includes(task)
              ? "write"
              : task === "video_text"
                ? "video"
                : task) &&
          (!profile.roles || profile.roles.includes(task)),
      )
      .map((profile) => ({
        ...profile,
        package: tool,
        state: profile.state ?? tool.state,
        compatibility: profile.compatibility ?? tool.compatibility,
      })),
  );
}
export function ModelChoice({
  tools,
  task,
  value = "auto",
  onChange,
  label = "Creation tool",
  defaultId = "auto",
  details = false,
  onSetup,
}) {
  const all = taskProfiles(tools, task);
  const available = all.filter(
    (profile) =>
      profile.state === "ready" && profile.compatibility?.compatible !== false,
  );
  const effectiveId = !value || value === "auto" ? defaultId : value;
  // Match the backend's deterministic recommendation without changing the
  // saved selection or substituting for an explicit unavailable choice.
  const selected =
    !effectiveId || effectiveId === "auto"
      ? available.find((profile) =>
          profile.package.default_for?.includes(task),
        ) || available[0]
      : all.find((profile) => profile.id === effectiveId);
  const noteId = useId();
  const preparationId = useId();
  const note = [selected?.quality_note, selected?.package.quality_note].find(
    (value) => typeof value === "string" && value.trim(),
  );
  const preparation = selected?.package.preparation_note;
  const preparationNote =
    typeof preparation === "string" ? preparation.trim() : "";
  const describedBy = [note && noteId, preparationNote && preparationId]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="model-choice">
      <label>
        {label}
        <select
          aria-label={label}
          aria-describedby={describedBy || undefined}
          value={value || "auto"}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="auto">Recommended automatically</option>
          {available.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.package.model || profile.package.name} · {profile.label}
            </option>
          ))}
          {all.some(
            (profile) => profile.compatibility?.compatible === false,
          ) && (
            <optgroup label="Needs different hardware">
              {all
                .filter(
                  (profile) => profile.compatibility?.compatible === false,
                )
                .map((profile) => (
                  <option key={profile.id} value={profile.id} disabled>
                    {profile.package.model} ·{" "}
                    {profile.compatibility.required_vram_gib >
                    (profile.compatibility.detected_vram_gib || 0)
                      ? `needs ${profile.compatibility.required_vram_gib} GB`
                      : "unsupported GPU"}
                  </option>
                ))}
            </optgroup>
          )}
          {value !== "auto" &&
            !all.some(
              (profile) =>
                profile.id === value &&
                (profile.state === "ready" ||
                  profile.compatibility?.compatible === false),
            ) && (
              <option value={value} disabled>
                Saved choice is unavailable
              </option>
            )}
        </select>
      </label>
      {details && (
        <p className="helper model-note">
          {selected
            ? `${selected.package.name} · ${selected.label}`
            : `Studio chooses an installed ${task === "write" || task === "website" ? "writing" : task} tool for this task.`}{" "}
          {available.length
            ? "Only compatible, installed choices can be selected."
            : all.find((profile) => profile.compatibility?.compatible === false)
                ?.compatibility.reason ||
              "No compatible tool is ready. Open Settings → Tool setup to prepare one."}
        </p>
      )}
      {!available.length && onSetup && (
        <button type="button" className="text-link" onClick={onSetup}>
          Prepare a local tool <ArrowRight size={14} />
        </button>
      )}
      {preparationNote && (
        <p
          className="helper model-preparation-note"
          id={preparationId}
          role="note"
        >
          <strong>Before you create:</strong> {preparationNote}
        </p>
      )}
      {note && (
        <p className="model-quality-note" id={noteId} role="note">
          <strong>About this choice</strong>
          {note.trim()}
        </p>
      )}
    </div>
  );
}
const reading = (value, suffix, digits = 0) =>
  Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : "Unavailable";
export function GpuActivity({
  gpu,
  samples = [],
  compact = false,
  details = true,
}) {
  const value = gpu.utilization_percent;
  const valid = samples.filter((sample) => Number.isFinite(sample));
  const points = samples.map((sample, i) =>
    Number.isFinite(sample)
      ? `${(i * 100) / Math.max(samples.length - 1, 1)},${30 - sample * 0.28}`
      : null,
  );
  const paths = [];
  let current = [];
  points.forEach((point) => {
    if (point) current.push(point);
    else if (current.length) {
      paths.push(current.join(" "));
      current = [];
    }
  });
  if (current.length) paths.push(current.join(" "));
  return (
    <div
      className={"gpu-activity " + (compact ? "gpu-compact" : "")}
      aria-label="Live GPU activity"
    >
      <div className="gpu-reading">
        <span>
          <Activity size={15} /> GPU activity
        </span>
        <strong>
          {!Number.isFinite(value) && gpu.power_state === "suspended"
            ? "Sleeping"
            : reading(value, "%")}
        </strong>
      </div>
      <div className="gpu-chart">
        {valid.length ? (
          <svg
            viewBox="0 0 100 32"
            preserveAspectRatio="none"
            role="img"
            aria-label="Recent GPU utilization"
          >
            <path d="M0 30 H100" stroke="currentColor" opacity=".2" />
            {paths.map((path, i) => (
              <polyline
                key={i}
                points={path}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
        ) : (
          <span>
            {gpu.power_state === "suspended"
              ? "Energy saving · wakes to create"
              : "Waiting for a driver reading"}
          </span>
        )}
      </div>
      {details && (
        <div className="gpu-stats">
          <span>
            Memory{" "}
            <b>
              {gpu.total
                ? `${(gpu.used / 1024 ** 3).toFixed(1)} / ${(gpu.total / 1024 ** 3).toFixed(0)} GB`
                : "Unavailable"}
            </b>
          </span>
          <span>
            Temperature{" "}
            <b>
              {!Number.isFinite(gpu.temperature_c) &&
              gpu.power_state === "suspended"
                ? "Sensor asleep"
                : reading(gpu.temperature_c, "°C")}
            </b>
          </span>
          <span>
            Power <b>{reading(gpu.power_w, " W")}</b>
          </span>
        </div>
      )}
      {!compact && (
        <p className="helper">
          Live readings from the Studio host. Activity includes other
          applications; missing readings are shown as unavailable.
        </p>
      )}
    </div>
  );
}

export function ProjectFlow({ assets, page, website, route, onNavigate }) {
  const steps = [
    {
      id: "image",
      label: "Create an image",
      detail: "Your starting point",
      icon: ImageIcon,
      count: assets.filter((a) => a.kind === "image").length,
    },
    {
      id: "video",
      label: "Bring it to life",
      detail: "Animate your image",
      icon: Film,
      count: assets.filter((a) => a.kind === "video").length,
    },
    {
      id: "write",
      label: "Tell the story",
      detail: "Write with context",
      icon: PenLine,
      count: assets.filter((a) => a.kind === "text").length,
    },
    {
      id: "page",
      label: "Build a website",
      detail: "Connect your assets",
      icon: PanelsTopLeft,
      count: website || (page?.title && (page?.text || page?.document)) ? 1 : 0,
    },
  ];
  return (
    <div className="project-flow" aria-label="Project workflow">
      {steps.map((step, index) => (
        <button
          key={step.id}
          className={
            (route === step.id ? "current " : "") +
            (step.count ? "complete" : "")
          }
          onClick={() => onNavigate(step.id)}
        >
          <span className="flow-number">
            {step.count ? <Check size={13} /> : `0${index + 1}`}
          </span>
          <span>
            <strong>{step.label}</strong>
            <small>
              {step.count
                ? `${step.count} saved${step.id === "page" ? " page draft" : " result" + (step.count > 1 ? "s" : "")}`
                : step.detail}
            </small>
          </span>
          <ChevronRight size={15} />
        </button>
      ))}
    </div>
  );
}

export function StudioSettings({
  settings,
  modelMemory,
  tools,
  gpu,
  onSave,
  onTools,
  onWiki,
  api,
  report,
  onToolsRefresh,
  initialTab = "preferences",
}) {
  const [draft, setDraft] = useState(settings);
  const [tab, setTab] = useState(initialTab);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const update = (group, patch) => {
    setDraft((value) => ({ ...value, [group]: { ...value[group], ...patch } }));
    setSaved(false);
  };
  const changed =
    JSON.stringify({
      defaults: draft.defaults,
      appearance: draft.appearance,
      generation: draft.generation,
      performance: draft.performance,
    }) !==
    JSON.stringify({
      defaults: settings.defaults,
      appearance: settings.appearance,
      generation: settings.generation,
      performance: settings.performance,
    });
  const labels = [
    [
      "image",
      ImageIcon,
      "Image creation",
      "Give visual ideas a starting point.",
    ],
    ["video", Film, "Video creation", "Animate images and create clips."],
    ["write", PenLine, "Writing", "Draft captions, stories and articles."],
    [
      "chat",
      PenLine,
      "GPTPaiton",
      "Local conversations and document questions.",
    ],
    ["code", PenLine, "Coding replies", "Code drafts for you to review."],
    ["video_text", Film, "Video from text", "Includes text-only video models."],
    [
      "website",
      PanelsTopLeft,
      "Website planning & writing",
      "Write a connected set of pages.",
    ],
  ];
  return (
    <>
      <EditorialHero
        compact
        label="SETTINGS"
        title="Make Studio"
        accent="yours."
      >
        Fine-tune your tools. Make room for bigger ideas.
      </EditorialHero>
      <div className="tabs settings-tabs" aria-label="Settings sections">
        <button
          className={tab === "preferences" ? "chosen" : ""}
          onClick={() => setTab("preferences")}
        >
          Preferences{changed ? " · unsaved" : ""}
        </button>
        <button
          className={tab === "setup" ? "chosen" : ""}
          onClick={() => setTab("setup")}
        >
          Tool setup & downloads
        </button>
        <button
          className={tab === "system" ? "chosen" : ""}
          onClick={() => setTab("system")}
        >
          System & drivers
        </button>
      </div>
      <div className="settings-layout">
        <div>
          <div hidden={tab !== "preferences"}>
            <section className="panel settings-section">
              <div className="section-heading">
                <div>
                  <h2>Default creation tools</h2>
                  <p className="helper">
                    Set your preferences once. You can change them for each
                    request.
                  </p>
                </div>
                <Settings2 size={21} />
              </div>
              <div className="default-models">
                {labels.map(([task, Icon, title, description]) => (
                  <div className="default-model" key={task}>
                    <div className="setting-icon">
                      <Icon size={20} />
                    </div>
                    <div>
                      <h3>{title}</h3>
                      <p className="helper">{description}</p>
                      <ModelChoice
                        tools={tools}
                        task={task}
                        value={draft.defaults?.[task] || "auto"}
                        label={`${title} model`}
                        onChange={(value) =>
                          update("defaults", { [task]: value })
                        }
                        details
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>
            <section className="panel settings-section">
              <h2>Workspace preferences</h2>
              <label className="preference-row">
                <span>
                  <strong>Detailed GPU readings</strong>
                  <small>
                    Show memory, temperature and power beside activity.
                  </small>
                </span>
                <input
                  type="checkbox"
                  checked={draft.appearance?.show_gpu_details ?? true}
                  onChange={(event) =>
                    update("appearance", {
                      show_gpu_details: event.target.checked,
                    })
                  }
                />
              </label>
              <label className="preference-row">
                <span>
                  <strong>Compact queue history</strong>
                  <small>
                    Keep finished requests collapsed while you create.
                  </small>
                </span>
                <input
                  type="checkbox"
                  checked={draft.appearance?.compact_queue ?? false}
                  onChange={(event) =>
                    update("appearance", {
                      compact_queue: event.target.checked,
                    })
                  }
                />
              </label>
              <details>
                <summary>Generation defaults</summary>
                <label>
                  Default seed
                  <input
                    type="number"
                    min="0"
                    max="9007199254740991"
                    value={draft.generation?.seed ?? 771}
                    onChange={(event) =>
                      update("generation", { seed: Number(event.target.value) })
                    }
                  />
                </label>
                <p className="helper">
                  A repeatable starting seed for new image and video requests.
                  Saved project settings take precedence.
                </p>
              </details>
            </section>
            <ModelMemorySettings
              value={draft.performance?.keep_ready_minutes ?? 2}
              memory={modelMemory}
              onChange={(keep_ready_minutes) =>
                update("performance", { keep_ready_minutes })
              }
              onSystem={() => setTab("system")}
            />
            <div className="settings-save">
              <span role="status">
                {saved
                  ? "Preferences saved on the Studio host."
                  : changed
                    ? "You have unsaved preference changes."
                    : "Preferences apply to new requests."}
              </span>
              <button
                className="primary"
                disabled={!changed || busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    setSaved(await onSave(draft));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Saving…" : "Save preferences"}
                <Check size={16} />
              </button>
            </div>
          </div>
          {tab === "setup" && (
            <SetupTools api={api} report={report} onTools={onToolsRefresh} />
          )}
          {tab === "system" && (
            <>
              <ReadinessPanel api={api} onSetup={() => setTab("setup")} />
              <SystemDetails api={api} />
            </>
          )}
        </div>
        <aside className="settings-aside">
          <MachineStatus gpu={gpu} />
          <div className="panel">
            <div className="setting-icon">
              <Cpu size={22} />
            </div>
            <h3>Your local workspace</h3>
            {gpu.total > 0 && (
              <div className="detected-hardware">
                <strong>
                  {gpu.name || gpu.model || "Detected graphics card"}
                </strong>
                <span>
                  {(gpu.total / 1024 ** 3).toFixed(0)} GB GPU memory
                  {gpu.architecture ? ` · ${gpu.architecture}` : ""}
                </span>
                <p>
                  Each tool is checked against its own memory and device
                  requirements.
                </p>
              </div>
            )}
            <p className="helper">
              Models run on the Studio host, even when you open Studio from
              another computer. One creation tool uses the GPU at a time.
            </p>
            <div className="storage-stats">
              <span>
                Projects<b>{settings.storage?.projects ?? "—"}</b>
              </span>
              <span>
                Saved assets<b>{settings.storage?.assets ?? "—"}</b>
              </span>
              <span>
                Project storage
                <b>
                  {reading(
                    (settings.storage?.bytes ?? 0) / 1024 ** 3,
                    " GB",
                    2,
                  )}
                </b>
              </span>
              <span>
                Available disk
                <b>
                  {Number.isFinite(settings.storage?.free_bytes)
                    ? reading(settings.storage.free_bytes / 1024 ** 3, " GB", 1)
                    : "—"}
                </b>
              </span>
            </div>
            <button onClick={onTools}>
              Manage creation tools
              <ArrowRight size={15} />
            </button>
          </div>
          <div className="panel">
            <BookOpen size={22} />
            <h3>A little help, built in</h3>
            <p className="helper">
              Learn about model choices, your queue, website drafts and project
              exports.
            </p>
            <button className="text-link" onClick={onWiki}>
              Open the Studio wiki
              <ArrowRight size={15} />
            </button>
          </div>
        </aside>
      </div>
    </>
  );
}

export function StudioWiki() {
  const [selected, setSelected] = useState(WIKI[0]?.id);
  const [query, setQuery] = useState("");
  const filtered = WIKI.filter((article) =>
    JSON.stringify(article).toLowerCase().includes(query.toLowerCase()),
  );
  const article =
    filtered.find((article) => article.id === selected) || filtered[0];
  return (
    <>
      <div className="eyebrow">A SMALL GUIDE TO CREATING LOCALLY</div>
      <h1>Studio wiki</h1>
      <p className="lead">Start here, find your way, and keep making things.</p>
      <div className="wiki-layout">
        <aside>
          <label className="wiki-search">
            <Search size={16} />
            <input
              aria-label="Search the wiki"
              placeholder="Find an answer…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <nav aria-label="Wiki articles">
            {filtered.map((item) => (
              <button
                key={item.id}
                className={article?.id === item.id ? "chosen" : ""}
                onClick={() => setSelected(item.id)}
              >
                {item.title}
                <ChevronRight size={15} />
              </button>
            ))}
          </nav>
          <p className="helper">Included with Studio. Available offline.</p>
        </aside>
        {article ? (
          <article className="panel wiki-article">
            <BookOpen size={24} />
            <h2>{article.title}</h2>
            <p className="lead">{article.summary}</p>
            {article.sections?.map((section, index) => (
              <section key={index}>
                <h3>{section.heading}</h3>
                {section.paragraphs?.map((paragraph, i) => (
                  <p key={i}>{paragraph}</p>
                ))}
                {section.steps && (
                  <ol>
                    {section.steps.map((step, i) => (
                      <li key={i}>{step}</li>
                    ))}
                  </ol>
                )}
              </section>
            ))}
          </article>
        ) : (
          <div className="empty">
            <Search size={25} />
            <h3>No articles found</h3>
            <p>Try “model”, “export” or “queue”.</p>
          </div>
        )}
      </div>
    </>
  );
}
