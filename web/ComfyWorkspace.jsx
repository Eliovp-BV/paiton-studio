import React, { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Boxes,
  Film,
  Image,
  Maximize2,
  Minimize2,
  RefreshCw,
  Save,
  Square,
  Workflow,
} from "lucide-react";
import "./comfy-workspace.css";

const supports = (item, task) =>
  (item.tasks || (item.id === "flux" ? ["image"] : ["video"])).includes(task);
const title = (task) => (task === "video" ? "Video" : "Image");

export default function ComfyWorkspace({
  api,
  task,
  project,
  ensureProject,
  assets,
  onSourceChange,
  onVideo,
  enabled = true,
  sourceId,
  prompt = "",
}) {
  const [catalog, setCatalog] = useState(null);
  const [display, setDisplay] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [overrides, setOverrides] = useState({});
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState("");
  const [cycle, setCycle] = useState(0);
  const [readyKey, setReadyKey] = useState("");
  // Tasks whose editor was asked for in this page load. Showing the panel or
  // selecting the tab never starts a container: only "Open editor", "Try
  // again" or an explicit hand-off from an open editor does.
  const [wanted, setWanted] = useState({});
  const frame = useRef(null),
    displayRef = useRef(null),
    operation = useRef(false);
  const bridge = useRef(null),
    pending = useRef(new Map()),
    counter = useRef(0);
  const failed = useRef(""),
    closed = useRef(""),
    initialized = useRef("");
  const alive = useRef(true),
    desired = useRef(null);
  const baseKey = `${project?.id || ""}:${task}`;
  const reference = task === "video" ? sourceId : undefined;
  const preferred = overrides[baseKey] || "";
  const key = `${baseKey}:${preferred}:${reference || ""}`;
  desired.current = {
    key,
    task,
    project,
    enabled,
    sourceId: reference,
    prompt,
    packageId: preferred,
  };
  const packages = catalog?.packages || [];
  const compatible = packages.filter((item) => supports(item, task));
  const images = assets.filter((asset) => asset.kind === "image");
  const matching =
    display?.project_id === project?.id && display?.task === task;
  const isReady = matching && readyKey === key && !busy;
  const referenceAsset = images.find((asset) => asset.id === reference);
  const opened = Boolean(wanted[task]);
  const running = Boolean(
    catalog?.active && catalog.active.status !== "unavailable",
  );
  // The editor of another task stays open until this one is asked for.
  const keptOpen = Boolean(display) && !matching && !opened && !busy;
  const subtitle = isReady
    ? `${title(task)} workflow ready`
    : keptOpen
      ? `The ${title(display.task)} editor is still open.`
      : display || busy
        ? "Your workflow follows your next step."
        : "Opens only when you ask for it.";

  useEffect(() => {
    alive.current = true;
    const receive = (event) => {
      const data = event.data;
      if (
        event.origin !== location.origin ||
        event.source !== frame.current?.contentWindow ||
        !data ||
        data.session_id !== displayRef.current?.id
      )
        return;
      if (data.type === "paiton-comfy-ready") {
        bridge.current = {
          id: data.session_id,
          window: event.source,
          graphLoaded: data.graph_loaded === true,
        };
        for (const [id, request] of pending.current) {
          if (request.type === "ready" && request.session === data.session_id) {
            clearTimeout(request.timer);
            pending.current.delete(id);
            request.resolve();
          }
        }
        return;
      }
      if (data.type === "paiton-comfy-error" && !data.request_id) {
        for (const [id, request] of pending.current) {
          if (request.type === "ready" && request.session === data.session_id) {
            clearTimeout(request.timer);
            pending.current.delete(id);
            request.reject(
              Error(
                data.message ||
                  "The editor could not connect. Try closing and reopening it.",
              ),
            );
          }
        }
        return;
      }
      const request = pending.current.get(data.request_id);
      if (!request || request.session !== data.session_id) return;
      if (data.type !== request.type && data.type !== "paiton-comfy-error")
        return;
      clearTimeout(request.timer);
      pending.current.delete(data.request_id);
      if (data.type === "paiton-comfy-error")
        request.reject(
          Error(
            data.error ||
              data.message ||
              "The editor could not save this workflow. Your canvas is still open.",
          ),
        );
      else request.resolve(data);
    };
    window.addEventListener("message", receive);
    return () => {
      alive.current = false;
      window.removeEventListener("message", receive);
      for (const request of pending.current.values()) {
        clearTimeout(request.timer);
        request.reject(Error("Workspace closed."));
      }
      pending.current.clear();
    };
  }, []);

  function awaitMessage(session, type, send) {
    return new Promise((resolve, reject) => {
      const id = `studio-${Date.now()}-${++counter.current}`;
      const timer = setTimeout(
        () => {
          pending.current.delete(id);
          reject(
            Error(
              type === "ready"
                ? "The editor is taking longer to connect. Try again; your saved workflows are kept."
                : "The editor did not finish saving or loading. Your current canvas has been kept. Try again.",
            ),
          );
        },
        type === "ready"
          ? 95000
          : type === "paiton-comfy-loaded"
            ? 40000
            : 15000,
      );
      pending.current.set(id, {
        session: session.id,
        type,
        resolve,
        reject,
        timer,
      });
      send?.(id);
    });
  }
  async function editorReady(session) {
    if (
      bridge.current?.id === session.id &&
      bridge.current.window === frame.current?.contentWindow
    )
      return;
    await awaitMessage(session, "ready");
  }
  async function editorMessage(session, action, workflow) {
    await editorReady(session);
    return awaitMessage(
      session,
      action === "save" ? "paiton-comfy-saved" : "paiton-comfy-loaded",
      (request_id) => {
        frame.current.contentWindow.postMessage(
          {
            type: `paiton-comfy-${action}`,
            request_id,
            session_id: session.id,
            ...(workflow
              ? {
                  workflow,
                  workflow_name: `Studio ${title(session.task)}.json`,
                }
              : {}),
          },
          location.origin,
        );
      },
    );
  }
  function showSession(session) {
    if (displayRef.current?.id !== session.id) {
      bridge.current = null;
      initialized.current = "";
    }
    displayRef.current = session;
    setDisplay(session);
  }
  async function attach(session, workflow) {
    showSession(session);
    await editorReady(session);
    if (workflow !== undefined || initialized.current !== session.id) {
      const graph = workflow ?? (await api(`/comfy/${session.id}/workflow`));
      await editorMessage(session, "load", graph);
      initialized.current = session.id;
    }
  }
  const stillWanted = (intent) =>
    alive.current &&
    desired.current.enabled &&
    desired.current.key === intent.key;

  async function synchronize() {
    if (operation.current || !desired.current.enabled) return;
    const intent = { ...desired.current };
    operation.current = true;
    setBusy("Checking installed editors…");
    setError("");
    setNotice("");
    try {
      const next = await api("/comfy");
      if (!alive.current) return;
      setCatalog(next);
      if (!stillWanted(intent)) return;
      const choices = next.packages.filter(
        (item) => item.installed && supports(item, intent.task),
      );
      const choice =
        choices.find((item) => item.id === intent.packageId) ||
        (!intent.packageId &&
          (choices.find(
            (item) => item.id === next.recommended?.[intent.task],
          ) ||
            choices[0]));
      if (!choice)
        throw Error(
          `No compatible ${intent.task} editor is installed. Your current workflow stays open. Nothing was downloaded.`,
        );
      const destination = intent.project || (await ensureProject());
      if (!stillWanted(intent)) return;
      let workflow;
      if (next.active) {
        if (next.active.status === "unavailable") {
          showSession(next.active);
          throw Error(
            "The current editor has stopped. Close it to reopen your saved workflow.",
          );
        }
        setBusy(`Saving your ${next.active.task || "current"} workflow…`);
        // Restore the saved graph in a fresh browser. The bridge preserves an
        // unsaved draft across reloads only when it belongs to this session.
        showSession(next.active);
        await editorReady(next.active);
        if (
          initialized.current !== next.active.id &&
          !bridge.current.graphLoaded
        )
          await attach(next.active);
        initialized.current = next.active.id;
        if (!stillWanted(intent)) return;
        workflow = (await editorMessage(next.active, "save")).workflow;
      }
      if (!stillWanted(intent)) return;
      setBusy(`Opening your ${intent.task} workspace…`);
      setReadyKey("");
      const session = await api("/comfy/open", {
        project_id: destination.id,
        task: intent.task,
        expected_session_id: next.active?.id || null,
        ...(intent.packageId ? { package_id: intent.packageId } : {}),
        ...(workflow ? { workflow } : {}),
        ...(intent.sourceId ? { source_id: intent.sourceId } : {}),
        ...(intent.prompt ? { prompt: intent.prompt } : {}),
      });
      if (!alive.current) return;
      setCatalog((old) => ({ ...old, active: session }));
      setBusy(`Restoring your ${intent.task} workflow…`);
      const graph = await api(`/comfy/${session.id}/workflow`);
      await attach(session, graph);
      setReadyKey(intent.key);
      if (
        stillWanted(intent) &&
        session.source_filename &&
        !session.source_applied
      )
        setNotice(
          `Your image is available as ${session.source_filename}. This custom workflow needs you to choose which image input to use.`,
        );
    } catch (failure) {
      if (alive.current) {
        failed.current = intent.key;
        setError(failure.message);
      }
    } finally {
      operation.current = false;
      if (alive.current) {
        setBusy("");
        setCycle((value) => value + 1);
      }
    }
  }

  useEffect(() => {
    if (
      enabled &&
      opened &&
      readyKey !== key &&
      failed.current !== key &&
      closed.current !== key
    )
      synchronize();
  }, [enabled, opened, key, cycle, readyKey]);
  // While the panel is idle, read which editors are installed and whether a
  // session from an earlier page load is still running. Status only: this
  // never starts an editor.
  useEffect(() => {
    if (!enabled || opened) return;
    let cancelled = false;
    api("/comfy")
      .then((next) => {
        if (!cancelled && alive.current && !operation.current) setCatalog(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, opened, baseKey]);
  useEffect(() => {
    if (!enabled) setExpanded(false);
  }, [enabled]);
  useEffect(() => {
    setError("");
    setNotice("");
  }, [key]);
  useEffect(() => {
    setInput(reference || "");
  }, [reference, baseKey]);
  useEffect(() => {
    if (!expanded) return;
    const escape = (event) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [expanded]);

  function retry() {
    failed.current = "";
    closed.current = "";
    setWanted((old) => (old[task] ? old : { ...old, [task]: true }));
    setReadyKey("");
    setCycle((value) => value + 1);
  }
  async function save(close = false) {
    if (operation.current || !displayRef.current) return;
    const session = displayRef.current;
    const closingKey = desired.current.key;
    operation.current = true;
    setBusy(close ? "Saving before closing…" : "Saving workflow…");
    setError("");
    try {
      // A canvas that never finished loading was never available for editing.
      // Allow closing a failed startup without waiting for its missing bridge.
      if (!close || initialized.current === session.id) {
        const { workflow } = await editorMessage(session, "save");
        await api(`/comfy/${session.id}/workflow`, { workflow });
      }
      if (close) {
        await api("/comfy/stop", { session_id: session.id });
        closed.current = closingKey;
        displayRef.current = null;
        bridge.current = null;
        initialized.current = "";
        setDisplay(null);
        setCatalog((old) => ({ ...old, active: null }));
        setReadyKey("");
        setExpanded(false);
        setWanted({});
      } else setNotice("Workflow saved to this project.");
    } catch (failure) {
      failed.current = desired.current.key;
      setError(failure.message);
    } finally {
      operation.current = false;
      setBusy("");
      setCycle((value) => value + 1);
    }
  }
  async function sendImage() {
    if (!input || !display || operation.current) return;
    if (task === "video" && matching) {
      onSourceChange?.(input);
      failed.current = "";
      setNotice("");
      if (input === reference)
        setNotice(
          "This reference is already selected for your video workflow.",
        );
      return;
    }
    operation.current = true;
    setBusy("Adding your image…");
    setError("");
    try {
      const result = await api(`/comfy/${display.id}/input`, {
        asset_id: input,
      });
      setNotice(
        `Image added: ${result.filename}. Use ComfyUI’s Refresh node definitions command to choose it in an image input.`,
      );
    } catch (failure) {
      setError(failure.message);
    } finally {
      operation.current = false;
      setBusy("");
      setCycle((value) => value + 1);
    }
  }

  return (
    <section
      className={`comfy-workspace${expanded ? " comfy-expanded" : ""}`}
      aria-label="ComfyUI workspace"
    >
      <header className="comfy-heading">
        <div className="comfy-title">
          <Workflow size={22} />
          <div>
            <h2>ComfyUI · {title(task)}</h2>
            <p>{subtitle}</p>
          </div>
        </div>
        <div className="comfy-toolbar">
          {task === "image" && onVideo && (
            <button
              onClick={() => {
                setWanted((old) => ({ ...old, video: true }));
                onVideo();
              }}
              disabled={Boolean(busy)}
            >
              <Film size={16} /> Bring it to life
            </button>
          )}
          {display && (
            <>
              <a
                href={display.url}
                target="_blank"
                rel="noopener noreferrer"
                title="Open ComfyUI in a new tab"
              >
                <ArrowUpRight size={16} />
                <span>New tab</span>
              </a>
              <button
                onClick={() => setExpanded(!expanded)}
                aria-label={
                  expanded ? "Exit expanded workspace" : "Expand workspace"
                }
              >
                {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
              <button onClick={() => save()} disabled={Boolean(busy)}>
                <Save size={14} /> Save workflow
              </button>
              <button onClick={() => save(true)} disabled={Boolean(busy)}>
                <Square size={14} /> Close editor
              </button>
            </>
          )}
        </div>
      </header>
      <p className="comfy-pause">
        Edit and save ComfyUI graphs here. Studio’s Image and Video jobs run
        their own tuned presets; running a saved graph from inside Studio is not
        available.
      </p>
      {error && (
        <div className="comfy-error" role="alert">
          <span>{error}</span>
          <button onClick={retry} disabled={Boolean(busy)}>
            <RefreshCw size={14} /> Try again
          </button>
        </div>
      )}
      {notice && (
        <p className="comfy-input-notice" role="status">
          {notice}
        </p>
      )}
      {display && (
        <div className="comfy-project-bar">
          <span>
            <strong>
              {matching ? project?.name : "Previous workflow kept open"}
            </strong>{" "}
            ·{" "}
            {packages.find((item) => item.id === display.package_id)?.name ||
              display.package_id}
            {!matching && ` · ${title(display.task)} editor`}
          </span>
          {keptOpen && (
            <button onClick={retry}>
              <Workflow size={14} /> Open editor
            </button>
          )}
          {matching && images.length > 0 && (
            <div className="comfy-input">
              {task === "video" && referenceAsset && (
                <img
                  className="comfy-reference"
                  src={`/api/assets/${referenceAsset.id}/thumbnail?width=128`}
                  alt={referenceAsset.name}
                />
              )}
              <select
                aria-label="Project image for ComfyUI"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                disabled={Boolean(busy)}
              >
                <option value="">Choose a project image…</option>
                {images.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.name}
                  </option>
                ))}
              </select>
              <button onClick={sendImage} disabled={!input || Boolean(busy)}>
                {task === "video" ? "Use this image" : "Send to ComfyUI"}
              </button>
            </div>
          )}
        </div>
      )}
      <div className="comfy-canvas-shell" aria-busy={Boolean(busy)}>
        {display && (
          <iframe
            ref={frame}
            key={display.id}
            className="comfy-frame"
            src={display.url}
            title="ComfyUI workflow editor"
            allow="clipboard-read; clipboard-write; fullscreen"
            inert={Boolean(busy)}
          />
        )}
        {busy && (
          <div className="comfy-loading" role="status">
            <RefreshCw size={24} className="comfy-spinner" />
            <strong>{busy}</strong>
            <span>Your workflow is saved before changing editors.</span>
          </div>
        )}
        {!display && !busy && (
          <div className="comfy-launch">
            <div className="comfy-intro">
              <div className="comfy-icon">
                <Workflow size={34} />
              </div>
              <h3>Open the ComfyUI editor for {task} graphs.</h3>
              <p>
                Open editor starts an installed {task} editor and loads this
                project’s saved graph. No models are loaded and nothing is
                downloaded; nothing runs until you open it.
              </p>
              <div className="comfy-features">
                <span>
                  <Boxes size={17} /> Saved workflows
                </span>
                <span>
                  {task === "video" ? <Film size={17} /> : <Image size={17} />}{" "}
                  Project references
                </span>
              </div>
            </div>
            <div className="comfy-launch-controls">
              <button className="primary" onClick={retry}>
                <Workflow size={17} /> Open editor
              </button>
              {running && (
                <p className="helper">
                  An editor from an earlier session is still running. Open
                  editor reconnects to it and keeps its graph.
                </p>
              )}
              {catalog && !compatible.some((item) => item.installed) && (
                <p className="helper">
                  A compatible {task} editor must already be installed. No
                  downloads are started here.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
      <footer className="comfy-footer">
        <span>
          Studio saves the current graph before switching tools. Your image and
          video workflows are kept separately.
        </span>
        <details className="comfy-package-choice">
          <summary>Change editor</summary>
          <label>
            Editor package
            <select
              aria-label="Editor package"
              value={preferred}
              disabled={Boolean(busy)}
              onChange={(event) => {
                setOverrides((old) => ({
                  ...old,
                  [baseKey]: event.target.value,
                }));
                failed.current = "";
              }}
            >
              <option value="">Choose automatically</option>
              {compatible.map((item) => (
                <option
                  key={item.id}
                  value={item.id}
                  disabled={!item.installed}
                >
                  {item.name}
                  {item.installed ? "" : " · not installed"}
                </option>
              ))}
            </select>
          </label>
          <p>Only installed packages for {task} can be opened.</p>
        </details>
      </footer>
      {task === "image" && (
        <p className="comfy-input-notice">
          Qwen-Image 2.1 is available in Create. Its current package does not
          include a ComfyUI node.
        </p>
      )}
    </section>
  );
}
