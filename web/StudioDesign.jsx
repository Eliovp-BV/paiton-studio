import machineArtwork from "./art/local-machine-gold.svg";
import { MachineStatus } from "./StudioIdentity";
import React, { useState, useRef, useEffect } from "react";
import {
  ArrowRight,
  Search,
  Image as ImageIcon,
  Film,
  PenLine,
  PanelsTopLeft,
  Plus,
  Folder,
  MoreVertical,
  ShieldCheck,
  Cpu,
  MessageSquare,
  X,
} from "lucide-react";
import { GpuActivity } from "./WorkspaceExtras";
export function PaitonMark() {
  return (
    <svg
      className="paiton-mark"
      viewBox="0 0 40 42"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M6 3h17c10 0 15 7 12 16-2 6-8 9-15 9h-5l4-12h7c2-4-1-7-6-7H9z"
        fill="currentColor"
      />
      <path d="M5 17c1-4 5-6 10-5l5 2-8 25-10 2 1-16z" fill="currentColor" />
    </svg>
  );
}
export const CREATIVE_ACTIONS = [
  ["image", ImageIcon, "Create an image", "Turn imagination into visuals."],
  ["video", Film, "Make a video", "Animate your ideas."],
  ["write", PenLine, "Write & plan", "Stories, articles, scripts."],
  ["page", PanelsTopLeft, "Build a website", "Turn it into a real project."],
];
export function CommandBar({ onLaunch, shortcut = false }) {
  const [idea, setIdea] = useState(""),
    [open, setOpen] = useState(false);
  const root = useRef();
  useEffect(() => {
    const close = (e) => {
      if (!root.current?.contains(e.target)) setOpen(false);
    };
    const launch = (e) => {
      if (shortcut && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
        root.current?.querySelector("input")?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", launch);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", launch);
    };
  }, [shortcut]);
  return (
    <div className="studio-command" ref={root}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
      >
        <Search size={18} />
        <input
          aria-label="Describe your idea"
          placeholder="Describe what you want to create…"
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
        />
        {shortcut && <kbd className="command-shortcut">Ctrl K</kbd>}
        <button aria-label="Choose a creative tool" type="submit">
          <ArrowRight size={17} />
        </button>
      </form>
      {open && (
        <div className="command-menu">
          <div className="section-heading">
            <span className="eyebrow">TAKE YOUR IDEA SOMEWHERE</span>
            <button aria-label="Close launcher" onClick={() => setOpen(false)}>
              <X size={15} />
            </button>
          </div>
          {[
            ...CREATIVE_ACTIONS,
            [
              "chat",
              MessageSquare,
              "Explore with GPTPaiton",
              "Think it through, locally.",
            ],
          ].map(([to, Icon, title, copy]) => (
            <button
              key={to}
              onClick={() => {
                onLaunch(to, idea);
                setOpen(false);
                setIdea("");
              }}
            >
              <Icon size={19} />
              <span>
                <strong>{title}</strong>
                <small>{copy}</small>
              </span>
              <ArrowRight size={15} />
            </button>
          ))}
          <small>
            Opens the tool with your idea. You decide when to generate.
          </small>
        </div>
      )}
    </div>
  );
}
export function HardwarePanel({
  gpu,
  samples,
  active,
  state,
  chatReady,
  onDetails,
}) {
  return (
    <section className="hardware local-engine">
      <span className="eyebrow">
        <Cpu size={13} /> YOUR LOCAL ENGINE
      </span>
      <strong className="engine-name">
        {gpu.name || "Detecting your GPU"}
      </strong>
      <div className="engine-state">
        <span className={"status-dot " + (active ? "busy" : "")} />
        {active
          ? state === "queued"
            ? "Request queued"
            : "Creating on your machine"
          : chatReady
            ? "Local model ready"
            : gpu.available
              ? gpu.power_state === "suspended"
                ? "Ready · energy saving"
                : "Online · Ready"
              : gpu.message || "Checking local hardware"}
      </div>
      <GpuActivity gpu={gpu} samples={samples} compact details />
      <button className="engine-details" onClick={onDetails}>
        System details <ArrowRight size={13} />
      </button>
      <span className="engine-footnote">
        <ShieldCheck size={11} /> Your ideas stay here.
      </span>
    </section>
  );
}
function projectKind(p) {
  return p.state?.websiteDraft?.siteReady ||
    (p.state?.page?.title && (p.state?.page?.text || p.state?.page?.document))
    ? "website"
    : p.preview_kind || (p.cover ? "image" : "project");
}
function relative(seconds) {
  const n = Math.max(0, Date.now() / 1000 - seconds);
  return n < 60
    ? "Just now"
    : n < 3600
      ? `${Math.floor(n / 60)} min ago`
      : n < 86400
        ? `${Math.floor(n / 3600)} hours ago`
        : `${Math.floor(n / 86400)} days ago`;
}
export function HomeWorkspace({
  projects,
  project,
  assets,
  tools,
  onNavigate,
  onOpen,
  onCreate,
  onImport,
  onSetup,
  gpu,
  active,
  onDetails,
  onLaunch,
}) {
  // The home shelf leads with saved creative work; drafts remain in Projects.
  const savedWork = projects.filter(
    (p) =>
      p.preview_asset ||
      p.cover ||
      p.state?.websiteDraft?.siteReady ||
      p.state?.page?.text,
  );
  const recentProjects = (savedWork.length ? savedWork : projects).slice(0, 6);
  const needsSetup = ["image", "video", "write"].some(
    (task) =>
      !tools.some(
        (t) =>
          t.state === "ready" &&
          t.compatibility?.compatible !== false &&
          t.profiles?.some((p) => p.task === task),
      ),
  );
  return (
    <>
      {needsSetup && (
        <div className="onboarding-banner">
          <div>
            <h3>Prepare your local creation tools</h3>
            <p>
              Download the tools you need in Settings. First-time setup can take
              a while; installed tools remain available while the others
              download.
            </p>
          </div>
          <button onClick={onSetup}>
            Set up Studio <ArrowRight size={16} />
          </button>
        </div>
      )}
      <div className="creative-home">
        <div className="workspace-scene" aria-hidden="true">
          <img className="environment-art" src={machineArtwork} alt="" />
          <div className="hero-shade" />
        </div>
        <section className="cinematic-hero">
          <div className="cinematic-copy">
            <span className="eyebrow">
              <PaitonMark /> PAITON STUDIO
            </span>
            <h1>
              Create without <em>the cloud.</em>
            </h1>
            <p>Professional AI creation. On your machine.</p>
            <span className="hero-local">
              <ShieldCheck size={14} /> Local AI. Everything you create belongs
              to you.
            </span>
          </div>
        </section>
        <div className="home-idea">
          <span className="eyebrow">START WITH AN IDEA</span>
          <CommandBar onLaunch={onLaunch} />
        </div>
        <div className="home-content">
          <section className="recent-work">
            <div className="creative-actions">
              {CREATIVE_ACTIONS.map(([to, Icon, title, copy], i) => (
                <button
                  key={to}
                  className={"creative-action " + to}
                  style={
                    assets.find((a) => a.kind === "image") &&
                    ["image", "video", "page"].includes(to)
                      ? {
                          "--creative-thumbnail": `url(/api/assets/${assets.find((a) => a.kind === "image").id}/thumbnail?width=384)`,
                        }
                      : undefined
                  }
                  onClick={() => onNavigate(to)}
                >
                  <span className="action-number">0{i + 1}</span>
                  <Icon size={29} />
                  <span>
                    <strong>{title}</strong>
                    <small>{copy}</small>
                  </span>
                  <ArrowRight size={15} />
                </button>
              ))}
            </div>
            <div className="section-heading">
              <div>
                <h2>Recent projects</h2>
              </div>
              <button
                className="text-link"
                onClick={() => onNavigate("projects")}
              >
                View all <ArrowRight size={14} />
              </button>
            </div>
            <div className="creative-project-grid">
              {recentProjects.map((p) => (
                <article className="creative-project" key={p.id}>
                  <button className="project-open" onClick={() => onOpen(p.id)}>
                    <div className="project-visual">
                      {projectKind(p) === "video" ? (
                        <>
                          <video
                            src={"/api/assets/" + p.preview_asset}
                            poster={
                              p.cover
                                ? "/api/assets/" +
                                  p.cover +
                                  "/thumbnail?width=384"
                                : undefined
                            }
                            preload="metadata"
                            muted
                          />
                          <span className="project-type-icon">
                            <Film size={22} />
                          </span>
                        </>
                      ) : projectKind(p) === "text" ? (
                        <div className="project-writing-cover">
                          <PenLine size={18} />
                          <strong>{p.preview_name || p.name}</strong>
                          <span>Writing · saved draft</span>
                        </div>
                      ) : projectKind(p) === "website" ? (
                        <div className="project-site-cover">
                          <div>● ● ●</div>
                          <strong>{p.name}</strong>
                          {p.cover && (
                            <img
                              src={
                                "/api/assets/" +
                                p.cover +
                                "/thumbnail?width=384"
                              }
                              alt=""
                            />
                          )}
                          <span>Linked pages · local project</span>
                        </div>
                      ) : p.cover ? (
                        <img
                          src={
                            "/api/assets/" + p.cover + "/thumbnail?width=384"
                          }
                          alt=""
                        />
                      ) : (
                        <div className="project-paper">
                          <Folder size={30} />
                          <span>Your next story</span>
                        </div>
                      )}
                      <span className="project-hover">
                        Open workspace <ArrowRight size={15} />
                      </span>
                    </div>
                    <strong>{p.name}</strong>
                    <small>
                      {projectKind(p) === "text"
                        ? "Writing"
                        : projectKind(p).charAt(0).toUpperCase() +
                          projectKind(p).slice(1)}{" "}
                      · {relative(p.updated)}
                    </small>
                  </button>
                  <details className="project-menu">
                    <summary aria-label={"Options for " + p.name}>
                      <MoreVertical size={15} />
                    </summary>
                    <div>
                      <button onClick={() => onOpen(p.id)}>Open project</button>
                      <button onClick={() => onOpen(p.id, "image")}>
                        Create an image
                      </button>
                      <button onClick={() => onOpen(p.id, "page")}>
                        Build website
                      </button>
                    </div>
                  </details>
                </article>
              ))}
              <button className="new-project-tile" onClick={onCreate}>
                <Plus size={28} />
                <strong>
                  New
                  <br />
                  project
                </strong>
                <small>A space for your next idea</small>
              </button>
            </div>
            {project && assets.length > 0 && (
              <button
                className="resume-work"
                onClick={() => onOpen(project.id)}
              >
                <span className="status-dot" />
                <span>
                  Continue <strong>{project.name}</strong>
                </span>
                <small>{assets.length} saved assets</small>
                <ArrowRight size={16} />
              </button>
            )}
            <div className="home-start">
              <div>
                <span className="eyebrow">START WITH SOMETHING REAL</span>
                <p>A photo. A product. A spark of an idea.</p>
              </div>
              <button onClick={onImport}>
                Import an image <ArrowRight size={15} />
              </button>
            </div>
          </section>
          <aside className="creative-journey">
            <MachineStatus gpu={gpu} active={active} onDetails={onDetails} />
            <blockquote>
              Creativity hits different
              <br />
              when it’s <em>yours.</em>
              <small>PAITON STUDIO</small>
            </blockquote>
            <div className="home-quick">
              <h3>Quick actions</h3>
              {CREATIVE_ACTIONS.map(([to, Icon, title]) => (
                <button key={to} onClick={() => onNavigate(to)}>
                  <Icon size={21} />
                  {title}
                  <ArrowRight size={14} />
                </button>
              ))}
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}
