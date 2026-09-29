// Synthetic API and iframe fixtures only: no containers, downloads or GPU work.
import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const projectId = "a".repeat(32);
const firstId = "b".repeat(32),
  selectedId = "d".repeat(32);
let project = {
  id: projectId,
  name: "Workflow fixture",
  revision: 0,
  updated: Date.now() / 1000,
  state: {
    selected: selectedId,
    image: { prompt: "Keep this creative draft", seed: 17 },
    video: { prompt: "A gentle camera move", source: firstId, mode: "image" },
  },
};
const assets = [
  { id: firstId, name: "First reference" },
  { id: selectedId, name: "Selected reference" },
].map((asset) => ({
  ...asset,
  project: projectId,
  kind: "image",
  metadata: { width: 1024, height: 1024, origin: "imported" },
}));
const packages = [
  { id: "flux", name: "FLUX editor", installed: true, tasks: ["image"] },
  { id: "wan", name: "Wan editor", installed: true, tasks: ["video"] },
  { id: "h3", name: "H3 editor", installed: false, tasks: ["video"] },
];
let active = null,
  sequence = 0,
  nextInventoryGate = null;
const graphs = new Map(),
  sessions = new Map();
const requests = [],
  errors = [],
  unexpected = [];
const opens = () =>
  requests.filter((request) => request.path === "/api/comfy/open");
const graphKey = (session) =>
  `${session.project_id}:${session.package_id}:${session.task}`;
const clone = (value) => structuredClone(value);
function starter(task) {
  return {
    version: 0.4,
    nodes: [
      { id: 1, type: "LoadImage", widgets_values: [""] },
      { id: 2, type: "Prompt", widgets_values: [""] },
    ],
    links: [],
    extra: { fixture_name: `${task === "image" ? "Image" : "Video"} starter` },
  };
}
page.on("pageerror", (error) => errors.push(error.message));

// Emulate the actual session-bound bridge. The editable name is deliberately
// absent from Studio state, so preservation requires serializing the iframe.
await page.route("**/comfy/**", async (route) => {
  const match = new URL(route.request().url()).pathname.match(
    /^\/comfy\/([a-f0-9]{32})\/$/,
  );
  if (!match) {
    unexpected.push(`iframe ${route.request().url()}`);
    await route.abort();
    return;
  }
  await route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><title>Fixture editor</title>
      <label>Workflow name <input id="workflow-name" value="Unsaved canvas"></label>
      <p>Image input: <span id="source-image"></span></p>
      <script>
      const sessionId = ${JSON.stringify(match[1])};
      const storageKey = 'fixture-comfy-draft-' + sessionId;
      let graph = JSON.parse(localStorage.getItem(storageKey) || 'null') || {version: 0.4, nodes: [], links: [], extra: {}};
      window.fixtureBoot = Math.random().toString(36);
      window.failSnapshot = false;
      function displayGraph() {
        document.querySelector('#workflow-name').value = graph.extra?.fixture_name || 'Unnamed canvas';
        document.querySelector('#source-image').textContent = graph.nodes.find(node => node.type === 'LoadImage')?.widgets_values?.[0] || '';
      }
      displayGraph();
      document.querySelector('#workflow-name').addEventListener('input', () => {
        graph.extra = {...graph.extra, fixture_name: document.querySelector('#workflow-name').value};
        localStorage.setItem(storageKey, JSON.stringify(graph));
      });
      function reply(value) { parent.postMessage({...value, session_id: sessionId}, location.origin); }
      window.addEventListener('message', event => {
        const data = event.data;
        if (event.origin !== location.origin || event.source !== parent || data?.session_id !== sessionId) return;
        if (data.type === 'paiton-comfy-load') {
          graph = structuredClone(data.workflow);
          displayGraph();
          localStorage.setItem(storageKey, JSON.stringify(graph));
          reply({type: 'paiton-comfy-loaded', request_id: data.request_id});
        }
        if (data.type === 'paiton-comfy-save') {
          if (window.failSnapshot) {
            reply({type: 'paiton-comfy-error', request_id: data.request_id, error: 'Fixture snapshot failed. The current canvas is kept.'});
            return;
          }
          graph.extra = {...graph.extra, fixture_name: document.querySelector('#workflow-name').value};
          reply({type: 'paiton-comfy-saved', request_id: data.request_id, workflow: structuredClone(graph)});
        }
      });
      reply({type: 'paiton-comfy-ready', graph_loaded: Boolean(localStorage.getItem(storageKey))});
      </script>`,
  });
});

await page.route("**/api/**", async (route) => {
  const req = route.request(),
    path = new URL(req.url()).pathname,
    method = req.method();
  let data,
    status = 200;
  if (path.startsWith("/api/assets/")) {
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#333"/></svg>',
    });
    return;
  }
  if (path === "/api/session") data = { token: "fixture" };
  else if (path === "/api/settings")
    data = { defaults: {}, appearance: {}, generation: { seed: 771 } };
  else if (path === "/api/tools") data = [];
  else if (path === "/api/inbox")
    data = { events: [], unread: 0, has_more: false, limit: 100 };
  else if (path === "/api/meetings/readiness")
    data = {
      ready: false,
      message: "Meeting inference is unavailable in this CPU fixture.",
    };
  else if (path === "/api/host-guidance")
    data = { needs_attention: false, checks: [] };
  else if (path === "/api/status")
    data = {
      jobs: [],
      gpu: {
        available: true,
        supported: true,
        used: 0,
        total: 32 * 1024 ** 3,
        name: "Fixture",
        message: "Editing only",
      },
      worker: { state: "stopped" },
    };
  else if (path === "/api/projects") data = [project];
  else if (path === `/api/projects/${projectId}`) {
    if (method === "PUT")
      project = {
        ...project,
        ...req.postDataJSON(),
        revision: project.revision + 1,
      };
    data = { ...project, assets };
  } else if (path === `/api/projects/${projectId}/website`)
    data = { site: null, runs: [] };
  else if (path === `/api/projects/${projectId}/brief` && method === "GET")
    data = { content: "", revision: 0 };
  else if (path === "/api/comfy") {
    if (nextInventoryGate) {
      const gate = nextInventoryGate;
      nextInventoryGate = null;
      gate.started();
      await gate.release;
    }
    data = {
      packages,
      active,
      recommended: {
        image: "flux",
        video: packages[1].installed ? "wan" : null,
      },
      generation_enabled: false,
    };
  } else if (path === "/api/comfy/open") {
    const body = req.postDataJSON();
    requests.push({ path, body: clone(body) });
    assert.equal(body.project_id, projectId);
    assert.equal(body.expected_session_id, active?.id || null);
    assert.ok(["image", "video"].includes(body.task));
    const packageId =
      body.package_id || (body.task === "image" ? "flux" : "wan");
    assert.ok(
      packages.find(
        (item) =>
          item.id === packageId &&
          item.installed &&
          item.tasks.includes(body.task),
      ),
    );
    if (active) {
      assert.ok(
        body.workflow,
        "An outgoing editor must be serialized before open",
      );
      graphs.set(graphKey(active), clone(body.workflow));
    }
    if (
      !active ||
      active.task !== body.task ||
      active.package_id !== packageId
    ) {
      active = {
        id: (++sequence).toString(16).padStart(32, "0"),
        project_id: projectId,
        package_id: packageId,
        task: body.task,
        mode: "editing",
        status: "ready",
        generation_enabled: false,
      };
      active.url = `/comfy/${active.id}/`;
    }
    const key = graphKey(active),
      graph = clone(graphs.get(key) || starter(active.task));
    if (body.source_id) {
      assert.ok(assets.find((asset) => asset.id === body.source_id));
      active.source_filename = `${body.source_id}.png`;
      active.source_applied = true;
      graph.nodes.find((node) => node.type === "LoadImage").widgets_values[0] =
        active.source_filename;
    }
    if (body.prompt && !graphs.has(key))
      graph.nodes[1].widgets_values[0] = body.prompt;
    graphs.set(key, graph);
    sessions.set(active.id, clone(active));
    data = clone(active);
  } else if (/^\/api\/comfy\/[a-f0-9]{32}\/workflow$/.test(path)) {
    const session = sessions.get(path.split("/")[3]);
    assert.ok(
      session,
      "Only an opened fixture session may read/write its workflow",
    );
    if (method === "POST") {
      const body = req.postDataJSON();
      requests.push({ path, body: clone(body) });
      graphs.set(graphKey(session), clone(body.workflow));
      data = { saved: true };
    } else data = clone(graphs.get(graphKey(session)));
  } else if (path === "/api/comfy/stop") {
    const body = req.postDataJSON();
    requests.push({ path, body });
    assert.equal(body.session_id, active.id);
    active = null;
    data = { stopped: true };
  } else if (/^\/api\/comfy\/[a-f0-9]{32}\/input$/.test(path)) {
    const body = req.postDataJSON();
    requests.push({ path, body });
    data = { filename: `${body.asset_id}.png` };
  } else {
    unexpected.push(`${method} ${path}`);
    status = 404;
    data = { error: "Unexpected fixture request; no live API was contacted" };
  }
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(data),
  });
});

const navigation = page.getByRole("navigation", { name: "Main navigation" });
const go = (name) =>
  navigation.getByRole("button", { name, exact: true }).click();
const frame = () => page.frameLocator("iframe.comfy-frame");
const nameInput = () => frame().getByLabel("Workflow name");
async function ready(task) {
  await page
    .locator(".comfy-title p")
    .filter({ hasText: `${task} workflow ready` })
    .waitFor();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".comfy-canvas-shell")
        ?.getAttribute("aria-busy") === "false",
  );
}
const boot = () =>
  page
    .locator("iframe.comfy-frame")
    .evaluate((element) => element.contentWindow.fixtureBoot);

try {
  await page.goto(
    (process.env.STUDIO_URL || "http://127.0.0.1:8898") + "/#image",
  );
  await page.getByLabel("Describe your image").waitFor();
  await go("Video");
  await go("Image");
  assert.equal(
    opens().length,
    0,
    "Create navigation never opens editor containers",
  );

  const inventoryRead = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/comfy",
  );
  await page
    .getByRole("button", { name: "ComfyUI Advanced", exact: true })
    .click();
  // Selecting the tab shows the panel and reads the inventory; nothing starts.
  const openEditor = () =>
    page.getByRole("button", { name: "Open editor", exact: true });
  await openEditor().waitFor();
  await inventoryRead;
  assert.equal(opens().length, 0, "Selecting the ComfyUI tab starts nothing");
  assert.equal(await page.locator("iframe.comfy-frame").count(), 0);
  assert.equal(new URL(page.url()).searchParams.get("workspace"), "comfy");
  await openEditor().click();
  await ready("Image");
  assert.equal(active.package_id, "flux");
  assert.equal(
    opens().length,
    1,
    "Open editor starts one installed task-compatible editor",
  );
  assert.equal(opens()[0].body.task, "image");
  assert.equal(opens()[0].body.source_id, undefined);
  await nameInput().fill("Unsaved image canvas");
  const originalBoot = await boot();

  // Create remains a nearby, stable option, and hiding does not discard the iframe.
  await page.setViewportSize({ width: 1050, height: 560 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const workspaceSwitch = page.getByRole("group", {
    name: "Creation workspace",
  });
  const beforeCreate = await workspaceSwitch.boundingBox();
  await workspaceSwitch
    .getByRole("button", { name: "Create", exact: true })
    .click();
  const afterCreate = await workspaceSwitch.boundingBox();
  assert.ok(
    Math.abs(beforeCreate.y - afterCreate.y) < 2,
    "Workspace switch stays in place",
  );
  assert.equal(await page.locator("iframe.comfy-frame").isVisible(), false);
  assert.equal(await boot(), originalBoot);
  assert.equal(
    await page.getByLabel("Describe your image").inputValue(),
    "Keep this creative draft",
  );
  assert.equal(new URL(page.url()).searchParams.has("workspace"), false);
  await page.evaluate(() => window.scrollTo(0, 700));
  const scrolledSwitch = await workspaceSwitch.boundingBox();
  assert.ok(
    scrolledSwitch.y >= 0 && scrolledSwitch.y + scrolledSwitch.height <= 560,
    "Workspace switch stays visible while scrolling",
  );
  await page
    .getByRole("button", { name: "ComfyUI Advanced", exact: true })
    .click();
  await ready("Image");
  assert.equal(await nameInput().inputValue(), "Unsaved image canvas");
  assert.equal(opens().length, 1);
  await page.setViewportSize({ width: 1440, height: 1100 });

  await go("Projects");
  await go("All creations");
  assert.equal(await page.locator("iframe.comfy-frame").count(), 1);
  assert.equal(await page.locator("iframe.comfy-frame").isVisible(), false);
  assert.equal(await boot(), originalBoot);
  await go("Image");
  await ready("Image");
  assert.equal(await boot(), originalBoot);
  assert.equal(opens().length, 1, "Hidden routes never auto-open editors");

  // Failure to snapshot must not invoke /open or destroy the unsaved graph.
  await page.locator("iframe.comfy-frame").evaluate((element) => {
    element.contentWindow.failSnapshot = true;
  });
  await page
    .getByRole("button", { name: "Bring it to life", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Fixture snapshot failed" })
    .waitFor();
  assert.equal(opens().length, 1);
  assert.equal(active.task, "image");
  assert.equal(await boot(), originalBoot);
  assert.equal(await nameInput().inputValue(), "Unsaved image canvas");
  await page.locator("iframe.comfy-frame").evaluate((element) => {
    element.contentWindow.failSnapshot = false;
  });

  // An unrelated installed image package is never used as a video fallback.
  packages[1].installed = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "No compatible video editor is installed" })
    .waitFor();
  assert.equal(opens().length, 1);
  assert.equal(await boot(), originalBoot);
  packages[1].installed = true;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await ready("Video");
  assert.equal(active.package_id, "wan");
  assert.equal(opens().at(-1).body.source_id, selectedId);
  assert.equal(
    opens().at(-1).body.workflow.extra.fixture_name,
    "Unsaved image canvas",
  );
  assert.equal(
    await frame().locator("#source-image").innerText(),
    `${selectedId}.png`,
  );
  assert.equal(await nameInput().inputValue(), "Video starter");
  await nameInput().fill("Unsaved video canvas");

  await go("Image");
  await ready("Image");
  assert.equal(await nameInput().inputValue(), "Unsaved image canvas");
  assert.equal(
    opens().at(-1).body.workflow.extra.fixture_name,
    "Unsaved video canvas",
  );
  await go("Video");
  await ready("Video");
  assert.equal(await nameInput().inputValue(), "Unsaved video canvas");
  assert.equal(
    await frame().locator("#source-image").innerText(),
    `${selectedId}.png`,
  );

  // Changing reference preserves the graph and Studio's durable source binding.
  const sourceSaved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === `/api/projects/${projectId}` &&
      response.request().postDataJSON()?.state?.video?.source === firstId,
  );
  await page.getByLabel("Project image for ComfyUI").selectOption(firstId);
  await page
    .getByRole("button", { name: "Use this image", exact: true })
    .click();
  await page.waitForFunction(
    (id) =>
      document
        .querySelector("iframe.comfy-frame")
        ?.contentDocument.querySelector("#source-image")?.textContent ===
      `${id}.png`,
    firstId,
  );
  await ready("Video");
  assert.equal(opens().at(-1).body.source_id, firstId);
  assert.equal(await nameInput().inputValue(), "Unsaved video canvas");
  await go("Image");
  await ready("Image");
  await go("Video");
  await ready("Video");
  assert.equal(
    opens().at(-1).body.source_id,
    firstId,
    "Returning to video must not restore an old reference",
  );
  await sourceSaved;
  assert.equal(project.state.video.source, firstId);

  // A superseded intent exits before /open, leaving the current canvas intact.
  const beforeRapid = opens().length;
  let releaseInventory, inventoryStarted;
  const started = new Promise((resolve) => {
    inventoryStarted = resolve;
  });
  nextInventoryGate = {
    started: inventoryStarted,
    release: new Promise((resolve) => {
      releaseInventory = resolve;
    }),
  };
  await go("Image");
  await Promise.race([
    started,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error("Inventory fixture did not start")), 5000),
    ),
  ]);
  await go("Video");
  releaseInventory();
  await ready("Video");
  assert.equal(opens().length, beforeRapid);
  assert.equal(await nameInput().inputValue(), "Unsaved video canvas");

  await nameInput().fill("Final saved video canvas");
  await page
    .getByRole("button", { name: "Save workflow", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Workflow saved to this project" })
    .waitFor();
  assert.equal(
    graphs.get(`${projectId}:wan:video`).extra.fixture_name,
    "Final saved video canvas",
  );
  const beforeClose = opens().length;
  await page.getByRole("button", { name: "Close editor", exact: true }).click();
  await openEditor().waitFor();
  assert.equal(await page.locator("iframe.comfy-frame").count(), 0);
  assert.equal(opens().length, beforeClose);
  assert.equal(requests.at(-1).path, "/api/comfy/stop");
  assert.match(requests.at(-2).path, /\/workflow$/);
  assert.equal(
    requests.at(-2).body.workflow.extra.fixture_name,
    "Final saved video canvas",
  );
  // Closing forgets the request to run: Image shows the idle panel too.
  await go("Image");
  await openEditor().waitFor();
  await go("Video");
  assert.equal(opens().length, beforeClose, "Navigation never reopens");
  await openEditor().click();
  await ready("Video");
  assert.equal(await nameInput().inputValue(), "Final saved video canvas");

  // A recovered editor may contain a newer browser draft than Studio's last
  // saved graph. Snapshot it before attempting to restore anything on reload.
  // `?workspace=comfy` survives the reload and shows the panel, but the
  // running session is only reconnected after an explicit Open editor.
  await nameInput().fill("Recovered unsaved video canvas");
  const beforeReload = opens().length;
  await page.reload();
  await openEditor().waitFor();
  await page
    .locator(".comfy-launch-controls .helper")
    .filter({ hasText: "still running" })
    .waitFor();
  assert.equal(opens().length, beforeReload, "Reload starts nothing");
  assert.equal(await page.locator("iframe.comfy-frame").count(), 0);
  await openEditor().click();
  await ready("Video");
  assert.equal(
    await nameInput().inputValue(),
    "Recovered unsaved video canvas",
  );
  assert.equal(
    opens().at(-1).body.workflow.extra.fixture_name,
    "Recovered unsaved video canvas",
  );

  await page
    .getByRole("button", { name: "Expand workspace", exact: true })
    .click();
  assert.equal(await page.locator(".comfy-expanded").count(), 1);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".comfy-expanded").count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "No mobile horizontal overflow",
  );
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  console.log(
    "ComfyUI workspace passed: tab selection starts nothing, Open editor starts one task-compatible editor, image references, separate unsaved graphs, failed snapshots, missing packages, hidden routes, sticky tabs, rapid navigation, source persistence, save/close/reopen, reload without auto-start, mobile. All requests intercepted; no containers, GPU work or downloads.",
  );
} finally {
  await browser.close();
}
