import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  comfyBridgeLocation,
  installComfyStudioBridge,
  startComfyStudioBridge,
} from "../web/comfyStudioBridge.js";

const sessionId = "a".repeat(32);
const origin = "http://studio.test:8877";
const workflow = {
  version: 0.4,
  nodes: [{ id: 1, type: "LoadImage", widgets_values: ["source.png"] }],
  links: [],
};
const draftPrefix = "paiton-comfy-draft:v1:";
function memoryStorage() {
  const values = new Map();
  return {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}
function fixture(t, options = {}) {
  const activeSession = options.sessionId ?? sessionId;
  const messages = [],
    listeners = new Map(),
    loads = [];
  let graph = structuredClone(workflow),
    extension;
  const parent = {
    postMessage: (message, targetOrigin) =>
      messages.push({ ...structuredClone(message), targetOrigin }),
  };
  const host = {
    location: { origin },
    parent,
    sessionStorage: options.storage ?? memoryStorage(),
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    async send(data, overrides = {}) {
      await Promise.all(
        [...(listeners.get("message") || [])].map((fn) =>
          fn({ data, origin, source: parent, ...overrides }),
        ),
      );
    },
    async dispatch(type) {
      await Promise.all([...(listeners.get(type) || [])].map((fn) => fn()));
    },
  };
  const app = {
    graph: { serialize: () => graph },
    isGraphReady: true,
    extensionManager: { spinner: false },
    configuringGraph: false,
    registerExtension(value) {
      extension = value;
    },
    async loadGraphData(value, ...args) {
      loads.push({ value, args });
      graph = value;
    },
  };
  const bridge = installComfyStudioBridge(app, host, activeSession, {
    pollMs: 1,
    readyTimeoutMs: 500,
    loadTimeoutMs: 500,
    ...options,
  });
  t.after(() => bridge.dispose());
  const send = (type, id, extra = {}) =>
    host.send({
      type: `paiton-comfy-${type}`,
      request_id: id,
      session_id: activeSession,
      ...extra,
    });
  return {
    app,
    host,
    bridge,
    messages,
    loads,
    send,
    get extension() {
      return extension;
    },
    async ready() {
      extension.setup();
      await delay(8);
    },
    setGraph(value) {
      graph = value;
    },
  };
}

test("the served module determines its session and imports only that session's app", async () => {
  const moduleUrl = `${origin}/comfy/${sessionId}/studio-workspace.js`;
  assert.deepEqual(comfyBridgeLocation(moduleUrl), {
    sessionId,
    base: `${origin}/comfy/${sessionId}/`,
  });
  for (const path of [
    "/web/comfyStudioBridge.js",
    "/comfy/../studio-workspace.js",
    "/comfy/invalid/studio-workspace.js",
  ])
    assert.throws(
      () => comfyBridgeLocation(origin + path),
      /invalid session URL/,
    );
  let imported,
    registered = false;
  const host = {
    location: { origin },
    parent: {},
    addEventListener() {},
    removeEventListener() {},
  };
  const bridge = await startComfyStudioBridge(host, moduleUrl, async (url) => {
    imported = url;
    await delay(2);
    return {
      app: {
        registerExtension() {
          registered = true;
        },
      },
    };
  });
  assert.equal(imported, `${origin}/comfy/${sessionId}/scripts/app.js`);
  assert.equal(registered, true);
  bridge.dispose();
  await assert.rejects(
    startComfyStudioBridge(
      host,
      moduleUrl.replace(origin, "https://other.test"),
    ),
    /same Studio host/,
  );
});

test("native graph restoration never identifies a Studio session draft", async (t) => {
  const f = fixture(t);
  f.app.isGraphReady = false;
  f.app.extensionManager.spinner = true;
  await f.ready();
  assert.equal(f.messages.length, 0);
  f.app.isGraphReady = true;
  f.extension.afterConfigureGraph();
  await delay(8);
  assert.equal(
    f.messages.length,
    0,
    "extension setup precedes Comfy startup restoration",
  );
  f.app.extensionManager.spinner = false;
  await delay(8);
  assert.equal(f.messages.length, 1);
  assert.deepEqual(f.messages[0], {
    type: "paiton-comfy-ready",
    session_id: sessionId,
    graph_loaded: false,
    targetOrigin: origin,
  });
  f.extension.afterConfigureGraph();
  f.extension.afterConfigureGraph();
  await delay(8);
  assert.equal(
    f.messages.length,
    1,
    "ordinary graph edits must not request a parent reload",
  );
  assert.equal(
    f.loads.length,
    0,
    "readiness never loads or executes a workflow",
  );
  await f.send("save", "unrelated-native-canvas");
  assert.equal(f.messages.at(-1).code, "not_ready");
  await f.host.dispatch("beforeunload");
  await f.host.dispatch("pagehide");
  assert.equal(
    f.host.sessionStorage.length,
    0,
    "native defaults are never cached",
  );
});

test("only the exact same-origin embedding parent can request a snapshot", async (t) => {
  const f = fixture(t);
  await f.ready();
  const message = {
    type: "paiton-comfy-save",
    request_id: "snapshot",
    session_id: sessionId,
  };
  await f.host.send(message, { origin: "https://other.test" });
  await f.host.send(message, { source: {} });
  await f.host.send({ ...message, session_id: "b".repeat(32) });
  await f.host.send({ ...message, request_id: "" });
  await f.host.send({ ...message, type: "paiton-comfy-execute" });
  assert.equal(f.messages.length, 1);
  await f.send("load", "initial", { workflow });
  await f.host.send(message);
  assert.equal(f.messages.at(-1).type, "paiton-comfy-saved");
  assert.deepEqual(f.messages.at(-1).workflow, workflow);
  f.setGraph({ nodes: [], links: [] });
  await f.host.send(message);
  assert.deepEqual(
    f.messages.at(-1).workflow,
    workflow,
    "retry returns the original captured snapshot",
  );
  await f.send("load", "snapshot", { workflow });
  assert.equal(f.messages.at(-1).code, "request_conflict");
  assert.equal(f.loads.length, 1);
});

test("explicit graph loads acknowledge completion and prevent overlapping snapshots", async (t) => {
  const f = fixture(t);
  await f.ready();
  let finish;
  f.app.loadGraphData = async (value, ...args) => {
    f.loads.push({ value, args });
    await new Promise((resolve) => {
      finish = resolve;
    });
    f.setGraph(value);
    f.extension.afterConfigureGraph();
  };
  const loading = f.send("load", "load-one", { workflow });
  await delay(1);
  await f.send("load", "load-one", { workflow });
  assert.equal(f.loads.length, 1);
  assert.equal(
    f.messages.filter((message) => message.type === "paiton-comfy-loaded")
      .length,
    0,
  );
  await f.send("save", "during-load");
  assert.equal(f.messages.at(-1).code, "busy");
  finish();
  await loading;
  assert.equal(f.messages.at(-1).type, "paiton-comfy-loaded");
  assert.equal(f.messages.at(-1).request_id, "load-one");
  assert.deepEqual(f.loads[0].args, [
    true,
    true,
    null,
    { skipAssetScans: true, silentAssetErrors: true },
  ]);
  assert.notEqual(
    f.loads[0].value,
    workflow,
    "Comfy receives a copy, never the parent message object",
  );
  await f.send("save", "after-load");
  assert.deepEqual(f.messages.at(-1).workflow, workflow);
  assert.equal(
    f.messages.filter((message) => message.type === "paiton-comfy-ready")
      .length,
    1,
  );
});

test("errors identify unready, invalid, failed load, and failed snapshot requests", async (t) => {
  const f = fixture(t);
  await f.send("save", "early");
  assert.equal(f.messages.at(-1).code, "not_ready");
  await f.ready();
  await f.send("load", "invalid", { workflow: { prompt: {} } });
  assert.equal(f.messages.at(-1).code, "load_failed");
  assert.match(f.messages.at(-1).message, /nodes array/);
  assert.equal(f.loads.length, 0);
  await f.send("load", "initial", { workflow });
  f.app.graph.serialize = () => {
    throw Error("Cannot serialize this graph.");
  };
  await f.send("save", "snapshot-failed");
  assert.equal(f.messages.at(-1).code, "snapshot_failed");
  assert.equal(f.messages.at(-1).request_id, "snapshot-failed");
  f.app.loadGraphData = async () => {
    throw Error("Required node type is unavailable.");
  };
  await f.send("load", "failed", { workflow });
  assert.equal(f.messages.at(-1).message, "Required node type is unavailable.");
  await f.send("save", "partially-loaded");
  assert.equal(f.messages.at(-1).code, "not_ready");
});

test("a timed-out loader remains exclusive until it actually settles", async (t) => {
  const f = fixture(t, { loadTimeoutMs: 10 });
  await f.ready();
  let finish;
  f.app.loadGraphData = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const loading = f.send("load", "slow", { workflow });
  await delay(20);
  assert.equal(f.messages.at(-1).code, "load_timeout");
  await f.send("save", "while-timed-out");
  assert.equal(f.messages.at(-1).code, "busy");
  finish();
  await loading;
  assert.equal(
    f.messages.some((message) => message.type === "paiton-comfy-loaded"),
    false,
  );
});

test("readiness timeout is actionable and page teardown stops messages", async (t) => {
  const f = fixture(t, { readyTimeoutMs: 8 });
  f.app.extensionManager.spinner = true;
  await f.ready();
  await delay(8);
  assert.equal(f.messages.at(-1).code, "startup_timeout");
  const count = f.messages.length;
  f.bridge.dispose();
  f.app.extensionManager.spinner = false;
  f.extension.afterConfigureGraph();
  await f.send("save", "after-close");
  await delay(5);
  assert.equal(f.messages.length, count);
});

test("reload restores the exact session's edited draft and tab name before ready", async (t) => {
  const storage = memoryStorage();
  const first = fixture(t, { storage });
  await first.ready();
  await first.send("load", "initial", {
    workflow,
    workflow_name: "Studio Image.json",
  });
  assert.equal(first.loads[0].args[2], "Studio Image.json");
  const savedEdit = { ...workflow, studio_note: "saved edit" };
  first.setGraph(savedEdit);
  await first.send("save", "save-edit");
  assert.deepEqual(
    JSON.parse(storage.getItem(draftPrefix + sessionId)).workflow,
    savedEdit,
  );
  const latestEdit = {
    ...workflow,
    studio_note: "edit after last explicit save",
  };
  first.setGraph(latestEdit);
  await first.host.dispatch("beforeunload");
  assert.deepEqual(
    JSON.parse(storage.getItem(draftPrefix + sessionId)).workflow,
    latestEdit,
  );
  await first.host.dispatch("pagehide");

  const next = fixture(t, { storage });
  next.setGraph({ nodes: [{ type: "NativeDefault" }] });
  next.app.extensionManager.spinner = true;
  let completeRestore;
  next.app.loadGraphData = async (value, ...args) => {
    next.loads.push({ value, args });
    next.extension.afterConfigureGraph();
    await new Promise((resolve) => {
      completeRestore = resolve;
    });
    next.setGraph(value);
  };
  await next.ready();
  next.extension.afterConfigureGraph();
  await delay(5);
  assert.equal(next.loads.length, 0, "wait for native startup to finish first");
  next.app.extensionManager.spinner = false;
  await delay(5);
  assert.equal(next.loads.length, 1);
  assert.equal(
    next.messages.length,
    0,
    "ready must wait for scoped restoration",
  );
  await next.send("save", "during-restore");
  assert.equal(next.messages.at(-1).code, "not_ready");
  completeRestore();
  await delay(5);
  assert.deepEqual(next.loads[0], {
    value: latestEdit,
    args: [
      true,
      true,
      "Studio Image.json",
      { skipAssetScans: true, silentAssetErrors: true },
    ],
  });
  assert.equal(next.messages.at(-1).type, "paiton-comfy-ready");
  assert.equal(next.messages.at(-1).graph_loaded, true);
  await next.send("save", "after-restore");
  assert.deepEqual(next.messages.at(-1).workflow, latestEdit);
  next.extension.afterConfigureGraph();
  await delay(5);
  assert.equal(next.loads.length, 1, "graph hooks do not restore repeatedly");
});

test("other session drafts and mismatched draft identities never become the active graph", async (t) => {
  const storage = memoryStorage();
  const old = fixture(t, { storage });
  await old.ready();
  await old.send("load", "old-load", { workflow });
  const oldJson = storage.getItem(draftPrefix + sessionId);
  old.bridge.dispose();

  const newId = "b".repeat(32);
  storage.setItem(draftPrefix + newId, oldJson);
  const next = fixture(t, { storage, sessionId: newId });
  await next.ready();
  next.extension.afterConfigureGraph();
  assert.equal(next.messages.at(-1).graph_loaded, false);
  assert.equal(next.loads.length, 0);
  await next.send("save", "native-save");
  assert.equal(next.messages.at(-1).code, "not_ready");
  assert.equal(storage.getItem(draftPrefix + sessionId), oldJson);
});

test("failed parent loads retain the last good draft and never cache partial graphs", async (t) => {
  const f = fixture(t);
  await f.ready();
  await f.send("load", "good", { workflow });
  const key = draftPrefix + sessionId;
  const saved = f.host.sessionStorage.getItem(key);
  let finish;
  f.app.loadGraphData = async () => {
    f.setGraph({ nodes: [{ type: "PartiallyLoaded" }] });
    await new Promise((resolve) => {
      finish = resolve;
    });
    throw Error("Cannot load requested graph.");
  };
  const pending = f.send("load", "bad", { workflow });
  await delay(1);
  await f.host.dispatch("beforeunload");
  assert.equal(f.host.sessionStorage.getItem(key), saved);
  finish();
  await pending;
  assert.equal(f.messages.at(-1).code, "load_failed");
  await f.host.dispatch("pagehide");
  assert.equal(f.host.sessionStorage.getItem(key), saved);
});

test("draft restore failure retains recovery data and blocks default-canvas snapshots", async (t) => {
  const storage = memoryStorage();
  const first = fixture(t, { storage });
  await first.ready();
  await first.send("load", "initial", { workflow });
  first.bridge.dispose();
  const saved = storage.getItem(draftPrefix + sessionId);
  const next = fixture(t, { storage });
  next.app.loadGraphData = async () => {
    throw Error("Unknown custom node.");
  };
  await next.ready();
  assert.equal(next.messages.at(-1).code, "restore_failed");
  assert.equal(
    next.messages.some((message) => message.type === "paiton-comfy-ready"),
    false,
  );
  next.extension.afterConfigureGraph();
  await next.send("save", "unsafe-save");
  assert.equal(next.messages.at(-1).code, "not_ready");
  await next.host.dispatch("pagehide");
  assert.equal(storage.getItem(draftPrefix + sessionId), saved);
});

test("draft restoration timeout cannot announce a ready default canvas", async (t) => {
  const storage = memoryStorage();
  const first = fixture(t, { storage });
  await first.ready();
  await first.send("load", "initial", { workflow });
  first.bridge.dispose();
  const next = fixture(t, { storage, loadTimeoutMs: 8 });
  let finish;
  next.app.loadGraphData = async (value) => {
    await new Promise((resolve) => {
      finish = resolve;
    });
    next.setGraph(value);
  };
  await next.ready();
  await delay(10);
  assert.equal(next.messages.at(-1).code, "restore_timeout");
  await next.send("load", "overlap", { workflow });
  assert.equal(next.messages.at(-1).code, "not_ready");
  finish();
  await delay(5);
  assert.equal(
    next.messages.some((message) => message.type === "paiton-comfy-ready"),
    false,
  );
  assert.deepEqual(
    JSON.parse(storage.getItem(draftPrefix + sessionId)).workflow,
    workflow,
  );
});

test("restricted storage never prevents an explicit workflow load or snapshot", async (t) => {
  const f = fixture(t);
  Object.defineProperty(f.host, "sessionStorage", {
    get() {
      throw Error("Storage denied.");
    },
  });
  await f.ready();
  assert.equal(f.messages.at(-1).graph_loaded, false);
  await f.send("load", "load", { workflow });
  assert.equal(f.messages.at(-1).type, "paiton-comfy-loaded");
  await f.send("save", "save");
  assert.deepEqual(f.messages.at(-1).workflow, workflow);
  await f.host.dispatch("beforeunload");
});

test("quota and serialization failures invalidate stale same-session drafts", async (t) => {
  const f = fixture(t);
  await f.ready();
  await f.send("load", "initial", { workflow });
  const storage = f.host.sessionStorage;
  const key = draftPrefix + sessionId;
  assert.ok(storage.getItem(key));
  const setItem = storage.setItem;
  storage.setItem = () => {
    throw Error("Quota exceeded.");
  };
  await f.send("load", "new", {
    workflow: { nodes: [], title: "new workflow" },
  });
  assert.equal(f.messages.at(-1).type, "paiton-comfy-loaded");
  assert.equal(storage.getItem(key), null);
  storage.setItem = setItem;
  await f.send("save", "save");
  assert.ok(storage.getItem(key));
  f.app.graph.serialize = () => {
    throw Error("Cannot serialize graph.");
  };
  await f.host.dispatch("beforeunload");
  assert.equal(storage.getItem(key), null);
});

test("draft cache keeps only the last three sessions and stays within its storage budget", async (t) => {
  const storage = memoryStorage();
  storage.setItem("Comfy.Settings", "untouched");
  const ids = ["a", "b", "c", "d"].map((letter) => letter.repeat(32));
  for (const id of ids) {
    const f = fixture(t, { storage, sessionId: id });
    await f.ready();
    await f.send("load", "initial", { workflow });
    f.bridge.dispose();
  }
  assert.equal(storage.getItem(draftPrefix + ids[0]), null);
  for (const id of ids.slice(1)) assert.ok(storage.getItem(draftPrefix + id));
  assert.equal(storage.length, 4);
  const next = fixture(t, { storage, sessionId: "e".repeat(32) });
  await next.ready();
  await next.send("load", "large", {
    workflow: { nodes: [], note: "x".repeat(2 * 1024 * 1024 - 500) },
  });
  let cachedChars = 0;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key.startsWith(draftPrefix))
      cachedChars += key.length + storage.getItem(key).length;
  }
  assert.ok(cachedChars <= 2 * 1024 * 1024);
  assert.equal(storage.getItem("Comfy.Settings"), "untouched");
  await next.send("load", "too-large-to-cache", {
    workflow: { nodes: [], note: "x".repeat(3 * 1024 * 1024) },
  });
  assert.equal(next.messages.at(-1).type, "paiton-comfy-loaded");
  assert.equal(storage.getItem(draftPrefix + "e".repeat(32)), null);
});

test("workflow size and names are validated before the current canvas changes", async (t) => {
  const f = fixture(t);
  await f.ready();
  await f.send("load", "oversized", {
    workflow: { nodes: [], note: "x".repeat(5 * 1024 * 1024) },
  });
  assert.equal(f.messages.at(-1).code, "load_failed");
  assert.match(f.messages.at(-1).message, /5 MB limit/);
  await f.send("load", "bad-name", {
    workflow,
    workflow_name: "x".repeat(151),
  });
  assert.equal(f.messages.at(-1).code, "load_failed");
  assert.match(f.messages.at(-1).message, /150 characters/);
  assert.equal(f.loads.length, 0);
});
