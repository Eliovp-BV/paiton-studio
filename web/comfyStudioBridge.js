// Loaded directly by the reviewed ComfyUI extension loader, without React/Vite.
// Only the embedding Studio window can request graph snapshots or graph loads.
const MESSAGE_PREFIX = "paiton-comfy-";
const MAX_WORKFLOW_BYTES = 5 * 1024 * 1024;
const DRAFT_PREFIX = "paiton-comfy-draft:v1:";
const MAX_DRAFTS = 3;
// Web Storage counts UTF-16 strings. Leave room for Comfy's own preferences.
const MAX_DRAFT_CHARS = 2 * 1024 * 1024;

export function comfyBridgeLocation(moduleUrl) {
  const url = new URL(moduleUrl);
  const match = url.pathname.match(
    /^\/comfy\/([a-f0-9]{32})\/studio-workspace\.js$/,
  );
  if (!match)
    throw Error("The Studio workflow bridge has an invalid session URL.");
  return { sessionId: match[1], base: new URL("./", url).href };
}

function copyWorkflow(workflow) {
  if (
    !workflow ||
    typeof workflow !== "object" ||
    !Array.isArray(workflow.nodes)
  )
    throw Error("Choose a ComfyUI workflow containing a nodes array.");
  const json = JSON.stringify(workflow);
  if (new TextEncoder().encode(json).length > MAX_WORKFLOW_BYTES)
    throw Error("This workflow exceeds Studio’s 5 MB limit.");
  return JSON.parse(json);
}

function workflowName(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 150)
    throw Error("The Studio workflow name must be at most 150 characters.");
  return value.trim() || null;
}

function sessionDrafts(host, sessionId) {
  const key = DRAFT_PREFIX + sessionId;
  function discard(storage) {
    try {
      storage?.removeItem(key);
    } catch {
      // Storage may be unavailable in private or restricted browser contexts.
    }
  }
  return {
    clear() {
      try {
        discard(host.sessionStorage);
      } catch {
        // Even accessing sessionStorage can be denied by the browser.
      }
    },
    read() {
      try {
        const json = host.sessionStorage?.getItem(key);
        if (!json || json.length + key.length > MAX_DRAFT_CHARS) return null;
        const draft = JSON.parse(json);
        if (draft.version !== 1 || draft.session_id !== sessionId) return null;
        return {
          workflow: copyWorkflow(draft.workflow),
          name: workflowName(draft.workflow_name),
        };
      } catch {
        return null;
      }
    },
    write(workflow, name) {
      let storage;
      try {
        storage = host.sessionStorage;
        if (!storage) return;
        const json = JSON.stringify({
          version: 1,
          session_id: sessionId,
          saved_at: Date.now(),
          workflow,
          workflow_name: name,
        });
        if (json.length + key.length > MAX_DRAFT_CHARS) {
          discard(storage);
          return;
        }
        const others = [];
        for (let i = 0; i < storage.length; i++) {
          const otherKey = storage.key(i);
          if (!otherKey?.startsWith(DRAFT_PREFIX) || otherKey === key) continue;
          const value = storage.getItem(otherKey) || "";
          let savedAt = 0;
          try {
            savedAt = Number(JSON.parse(value).saved_at) || 0;
          } catch {
            // Invalid obsolete entries are first to leave the bounded cache.
          }
          others.push({
            key: otherKey,
            size: otherKey.length + value.length,
            savedAt,
          });
        }
        others.sort((a, b) => a.savedAt - b.savedAt);
        let total =
          key.length +
          json.length +
          others.reduce((sum, item) => sum + item.size, 0);
        while (others.length >= MAX_DRAFTS || total > MAX_DRAFT_CHARS) {
          const oldest = others.shift();
          storage.removeItem(oldest.key);
          total -= oldest.size;
        }
        try {
          storage.setItem(key, json);
        } catch {
          // Other application data may have consumed the shared storage quota.
          for (const other of others) storage.removeItem(other.key);
          storage.setItem(key, json);
        }
      } catch {
        // A successful load must not resurrect an older draft on the next visit.
        // Writes happen only after loading/snapshotting the current Studio graph.
        discard(storage);
      }
    },
  };
}

export function installComfyStudioBridge(app, host, sessionId, options = {}) {
  const pollMs = options.pollMs ?? 50;
  const readyTimeoutMs = options.readyTimeoutMs ?? 90000;
  const loadTimeoutMs = options.loadTimeoutMs ?? 30000;
  const origin = host.location.origin;
  const parent = host.parent;
  let loadedName = null;
  let setup = false,
    graphLoaded = false,
    ready = false,
    restoring = false,
    startupFailed = false,
    disposed = false;
  let readyTimer,
    loading = false,
    loadingTimer;
  const deadline = Date.now() + readyTimeoutMs;
  const requests = new Map();
  const drafts = sessionDrafts(host, sessionId);

  function post(message) {
    if (!disposed && parent !== host)
      parent.postMessage({ ...message, session_id: sessionId }, origin);
  }
  function graphAvailable() {
    return (
      setup &&
      app.graph &&
      typeof app.graph.serialize === "function" &&
      app.isGraphReady !== false &&
      !app.configuringGraph &&
      app.extensionManager?.spinner !== true
    );
  }
  function cacheCurrentGraph() {
    if (!graphLoaded || disposed || !graphAvailable()) return;
    try {
      drafts.write(copyWorkflow(app.graph.serialize()), loadedName);
    } catch {
      // A browser draft is best effort; explicit snapshots still report errors.
      drafts.clear();
    }
  }
  function loadCanvas(workflow, name) {
    // This changes the canvas only. Never queue, execute, or download models.
    return app.loadGraphData(workflow, true, true, name, {
      skipAssetScans: true,
      silentAssetErrors: true,
    });
  }
  function announceReady() {
    ready = true;
    post({ type: MESSAGE_PREFIX + "ready", graph_loaded: graphLoaded });
  }
  async function checkReady() {
    clearTimeout(readyTimer);
    if (disposed || ready || restoring || startupFailed) return;
    if (graphAvailable()) {
      const draft = drafts.read();
      if (!draft) {
        // Comfy's native default/restored canvas has no Studio session identity.
        announceReady();
        return;
      }
      restoring = true;
      loading = true;
      loadingTimer = setTimeout(() => {
        startupFailed = true;
        post(
          error(
            null,
            "restore_timeout",
            "ComfyUI did not finish restoring this session’s draft. Reload the editor to retry; the saved draft is retained.",
          ),
        );
      }, loadTimeoutMs);
      try {
        await loadCanvas(draft.workflow, draft.name);
        if (disposed) return;
        loadedName = draft.name;
        graphLoaded = true;
        cacheCurrentGraph();
        if (!startupFailed) announceReady();
      } catch {
        if (!startupFailed) {
          startupFailed = true;
          post(
            error(
              null,
              "restore_failed",
              "ComfyUI could not restore this session’s draft. Reload the editor to retry; the saved draft is retained.",
            ),
          );
        }
      } finally {
        clearTimeout(loadingTimer);
        loading = false;
        restoring = false;
      }
    } else if (Date.now() >= deadline) {
      startupFailed = true;
      post({
        type: MESSAGE_PREFIX + "error",
        request_id: null,
        code: "startup_timeout",
        message:
          "ComfyUI is still starting. Reload the editor before changing workspaces.",
      });
    } else readyTimer = setTimeout(checkReady, pollMs);
  }
  function error(requestId, code, message) {
    return {
      type: MESSAGE_PREFIX + "error",
      request_id: requestId,
      code,
      message,
    };
  }
  function finish(record, reply) {
    record.reply = reply;
    post(reply);
  }
  async function receive(event) {
    if (
      disposed ||
      event.origin !== origin ||
      event.source !== parent ||
      parent === host
    )
      return;
    const message = event.data;
    if (
      !message ||
      message.session_id !== sessionId ||
      ![MESSAGE_PREFIX + "save", MESSAGE_PREFIX + "load"].includes(
        message.type,
      ) ||
      typeof message.request_id !== "string" ||
      !message.request_id ||
      message.request_id.length > 128
    )
      return;
    const id = message.request_id;
    const previous = requests.get(id);
    if (previous) {
      if (previous.type !== message.type)
        post(
          error(
            id,
            "request_conflict",
            "Use a new request identifier for this workflow action.",
          ),
        );
      else if (previous.reply) post(previous.reply);
      return;
    }
    // Keep completed responses for bounded, idempotent retries. Never evict an
    // unfinished load: a timed-out parent request cannot cancel Comfy's loader.
    if (requests.size >= 64) {
      const finished = [...requests].find(([, item]) => item.reply);
      if (finished) requests.delete(finished[0]);
      else {
        post(
          error(
            id,
            "busy",
            "ComfyUI has too many pending workflow actions. Wait or reload the editor.",
          ),
        );
        return;
      }
    }
    const record = { type: message.type, reply: null };
    requests.set(id, record);
    if (!ready || !graphAvailable()) {
      finish(
        record,
        error(
          id,
          "not_ready",
          "ComfyUI is still preparing its graph. Wait until the editor is ready, then retry.",
        ),
      );
      return;
    }
    if (loading) {
      finish(
        record,
        error(
          id,
          "busy",
          "ComfyUI is still loading a workflow. Wait for it to finish before changing workspaces.",
        ),
      );
      return;
    }
    try {
      if (message.type === MESSAGE_PREFIX + "save") {
        if (!graphLoaded) {
          finish(
            record,
            error(
              id,
              "not_ready",
              "Studio has not restored this session’s workflow yet. Wait for the workflow to load before saving or changing workspaces.",
            ),
          );
          return;
        }
        const workflow = copyWorkflow(app.graph.serialize());
        drafts.write(workflow, loadedName);
        finish(record, {
          type: MESSAGE_PREFIX + "saved",
          request_id: id,
          workflow,
        });
        return;
      }
      const workflow = copyWorkflow(message.workflow);
      const name = workflowName(message.workflow_name);
      loading = true;
      graphLoaded = false;
      loadingTimer = setTimeout(
        () =>
          finish(
            record,
            error(
              id,
              "load_timeout",
              "ComfyUI did not finish loading this workflow. Reload the editor before changing workspaces.",
            ),
          ),
        loadTimeoutMs,
      );
      await loadCanvas(workflow, name);
      if (disposed) return;
      loadedName = name;
      graphLoaded = true;
      cacheCurrentGraph();
      if (!record.reply)
        finish(record, {
          type: MESSAGE_PREFIX + "loaded",
          request_id: id,
          graph_loaded: true,
        });
    } catch (failure) {
      if (message.type === MESSAGE_PREFIX + "save") drafts.clear();
      if (!record.reply)
        finish(
          record,
          error(
            id,
            message.type === MESSAGE_PREFIX + "save"
              ? "snapshot_failed"
              : "load_failed",
            failure instanceof Error
              ? failure.message
              : "ComfyUI could not transfer this workflow. Save it in ComfyUI before retrying.",
          ),
        );
    } finally {
      if (message.type === MESSAGE_PREFIX + "load" && loading) {
        clearTimeout(loadingTimer);
        loading = false;
      }
    }
  }
  function beforeUnload() {
    if (!loading) cacheCurrentGraph();
  }
  function pageHide() {
    beforeUnload();
    dispose();
  }
  function dispose() {
    disposed = true;
    clearTimeout(readyTimer);
    clearTimeout(loadingTimer);
    host.removeEventListener("message", receive);
    host.removeEventListener("pagehide", pageHide);
    host.removeEventListener("beforeunload", beforeUnload);
  }
  host.addEventListener("message", receive);
  host.addEventListener("pagehide", pageHide);
  host.addEventListener("beforeunload", beforeUnload);
  app.registerExtension({
    name: "Paiton.StudioWorkspace",
    setup() {
      setup = true;
      // Comfy restores the previous graph AFTER extension setup. Its workspace
      // spinner covers that initialization; a later task also lets hooks settle.
      clearTimeout(readyTimer);
      readyTimer = setTimeout(checkReady, 0);
    },
    afterConfigureGraph() {
      if (!ready && setup) {
        clearTimeout(readyTimer);
        readyTimer = setTimeout(checkReady, 0);
      }
    },
  });
  return { dispose };
}

export async function startComfyStudioBridge(
  host,
  moduleUrl,
  importer = (url) => import(url),
) {
  const { sessionId, base } = comfyBridgeLocation(moduleUrl);
  if (new URL(base).origin !== host.location.origin)
    throw Error("Open the workflow editor from the same Studio host.");
  const { app } = await importer(new URL("scripts/app.js", base).href);
  return installComfyStudioBridge(app, host, sessionId);
}

if (typeof window !== "undefined" && window.parent !== window) {
  try {
    // The native extension loader must await registration before invoking setup.
    await startComfyStudioBridge(window, import.meta.url);
  } catch (failure) {
    const { sessionId } = comfyBridgeLocation(import.meta.url);
    window.parent.postMessage(
      {
        type: MESSAGE_PREFIX + "error",
        session_id: sessionId,
        request_id: null,
        code: "bridge_failed",
        message:
          failure.message || "The Studio workflow bridge could not start.",
      },
      window.location.origin,
    );
  }
}
