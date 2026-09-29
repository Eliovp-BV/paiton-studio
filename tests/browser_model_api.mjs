// Real model connection UI; every API request is synthetic and intercepted.
// No backend inference, model loading, packages, IDEs or services are started.
import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const base = process.env.STUDIO_TEST_URL || "http://127.0.0.1:8898";
assert.notEqual(new URL(base).port, "8877");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
page.setDefaultTimeout(12000);
const errors = [],
  unexpected = [],
  requests = [],
  gates = [],
  issuedTokens = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  window.fixtureCopies = [];
  window.fixtureCopyFails = false;
  document.execCommand = (command) => {
    if (window.fixtureCopyFails) throw Error("Fixture clipboard unavailable.");
    if (command !== "copy") return false;
    window.fixtureCopies.push(document.activeElement.value);
    return true;
  };
});
const projects = ["a", "b"].map((letter) => ({
  id: letter.repeat(32),
  name: `API project ${letter.toUpperCase()}`,
}));
const tools = [
  {
    id: "text-package",
    model: "Local qualified text",
    state: "ready",
    compatibility: { compatible: true },
    profiles: [
      {
        id: "qualified-chat",
        task: "write",
        roles: ["chat"],
        context: 8192,
        max_tokens: 768,
        label: "Conversation",
      },
    ],
  },
  {
    id: "small-package",
    model: "Small local text",
    state: "ready",
    profiles: [
      {
        id: "small-chat",
        task: "write",
        roles: ["chat"],
        context: 2048,
        max_tokens: 1024,
      },
    ],
  },
  {
    id: "missing-package",
    model: "Not installed",
    state: "setup_required",
    profiles: [{ id: "missing-chat", task: "write", roles: ["chat"] }],
  },
  {
    id: "incompatible-package",
    model: "Incompatible GPU",
    state: "ready",
    compatibility: { compatible: false },
    profiles: [{ id: "incompatible-chat", task: "write", roles: ["chat"] }],
  },
  {
    id: "code-only",
    model: "Code only",
    state: "ready",
    profiles: [{ id: "code-only", task: "write", roles: ["code"] }],
  },
];
const connections = new Map(
  projects.map((project) => [
    project.id,
    { enabled: false, revision: 0, token: "" },
  ]),
);
let heldSettings, heldModels, heldConfigure;
function publicSettings(project) {
  const { token, ...connection } = connections.get(project);
  return {
    ...connection,
    execution_paused: true,
    capabilities: {
      text_chat: true,
      streaming: true,
      tool_calling: false,
      vision: false,
      embeddings: false,
    },
    max_input_characters: 24000,
  };
}
function mutateConnection(project, body) {
  const connection = connections.get(project);
  if (connection.enabled === body.enabled && !body.rotate)
    return publicSettings(project);
  connection.enabled = body.enabled;
  connection.revision++;
  connection.token = body.enabled
    ? `paiton_synthetic_${project[0]}_${connection.revision}`
    : "";
  if (connection.token) issuedTokens.push(connection.token);
  return {
    ...publicSettings(project),
    ...(connection.token ? { token: connection.token } : {}),
  };
}
function gate(fields = {}) {
  let arrive, release, finish;
  const result = {
    ...fields,
    arrival: new Promise((resolve) => (arrive = resolve)),
    arrived: () => arrive(),
    release: new Promise((resolve) => (release = resolve)),
    resume: () => release(),
    completion: new Promise((resolve) => (finish = resolve)),
    finished: () => finish(),
  };
  gates.push(result);
  return result;
}
async function waitForGate(promise, label) {
  let timeout;
  try {
    await Promise.race([
      promise,
      new Promise(
        (_, reject) =>
          (timeout = setTimeout(
            () => reject(Error(`Timed out: ${label}`)),
            12000,
          )),
      ),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
await page.route("**/api/**", async (route) => {
  const request = route.request(),
    path = new URL(request.url()).pathname,
    method = request.method();
  const match = path.match(/^\/api\/projects\/([a-f0-9]{32})\/model-api$/);
  let data,
    status = 200,
    delayed;
  const body = request.postData() ? request.postDataJSON() : undefined;
  requests.push({ path, method, body });
  if (
    !match ||
    !connections.has(match[1]) ||
    !["GET", "PUT"].includes(method)
  ) {
    unexpected.push(`${method} ${path}`);
    return route.abort();
  }
  const project = match[1];
  if (method === "GET") {
    data = publicSettings(project);
    if (heldSettings?.project === project) {
      delayed = heldSettings;
      heldSettings = null;
    }
  } else if (body.revision !== connections.get(project).revision) {
    status = 409;
    data = {
      detail:
        "This API connection changed in another window. Reload its settings.",
    };
  } else {
    data = mutateConnection(project, body);
    if (heldConfigure?.project === project) {
      delayed = heldConfigure;
      heldConfigure = null;
    }
  }
  if (delayed) {
    delayed.arrived();
    await delayed.release;
  }
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(data),
  });
  delayed?.finished();
});
await page.route("**/v1/**", async (route) => {
  const request = route.request(),
    path = new URL(request.url()).pathname,
    authorization = request.headers().authorization;
  requests.push({ path, method: request.method(), authorization });
  if (path !== "/v1/models" || request.method() !== "GET") {
    unexpected.push(
      `Generation or unsupported API attempted: ${request.method()} ${path}`,
    );
    return route.abort();
  }
  const permitted = [...connections.values()].some(
    (connection) =>
      connection.enabled && authorization === `Bearer ${connection.token}`,
  );
  const delayed = heldModels;
  heldModels = null;
  if (delayed) {
    delayed.arrived();
    await delayed.release;
  }
  await route.fulfill({
    status: permitted ? 200 : 401,
    contentType: "application/json",
    body: JSON.stringify(
      permitted
        ? {
            object: "list",
            data: [{ id: "qualified-chat" }, { id: "small-chat" }],
          }
        : { error: { message: "Invalid or revoked API token." } },
    ),
  });
  delayed?.finished();
});
await page.route("**/model-api-fixture", (route) =>
  route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta charset="utf-8"><title>Model API fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;
const {default: React} = await import('/node_modules/.vite-ui/deps/react.js'); const {useState} = React;
const {default: ReactDOM} = await import('/node_modules/.vite-ui/deps/react-dom_client.js');
await import('/web/style.css?import'); await import('/web/studio-design.css?import'); await import('/web/studio-gold.css?import'); await import('/web/coding-studio.css?import');
const {default: ModelAPI} = await import('/web/ModelAPI.jsx');
const projects = ${JSON.stringify(projects)}, availableTools = ${JSON.stringify(tools)};
const api = async (path, body, method) => { const response = await fetch('/api' + path, {method:method || (body === undefined ? 'GET' : 'POST'),headers:{'Content-Type':'application/json'},body:body === undefined ? undefined : JSON.stringify(body)}); const value = await response.json(); if (!response.ok) { const failure = Error(value.detail); failure.status = response.status; throw failure; } return value; };
function Harness() {
  const [project,setProject] = useState(projects[0]), [models,setModels] = useState(availableTools), [handoff,setHandoff] = useState('');
  window.fixtureProject = index => setProject(projects[index]); window.fixtureModels = setModels;
  return React.createElement('main',{style:{padding:'16px',maxWidth:'1500px',margin:'0 auto',minWidth:0}},React.createElement(ModelAPI,{key:project.id,project,api,tools:models,worker:{state:'stopped'},onModels:()=>setHandoff('Models requested')}),React.createElement('output',{id:'handoff'},handoff));
}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
</script></body></html>`,
  }),
);
const button = (name) => page.getByRole("button", { name, exact: true });
const tokenField = () => page.locator(".model-api-token input");
const configuration = () => page.locator(".model-api-config");
const settle = () =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
async function downloadConfiguration(filename) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    button("Download configuration").click(),
  ]);
  assert.equal(download.suggestedFilename(), filename);
  return readFile(await download.path(), "utf8");
}
async function assertNoPersistedSecrets() {
  const contents = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
      url: location.href,
    }),
  );
  const config = (await configuration().count())
    ? await configuration().innerText()
    : "";
  for (const token of issuedTokens) {
    assert.equal(
      contents.includes(token),
      false,
      "tokens must not enter storage or URLs",
    );
    assert.equal(
      config.includes(token),
      false,
      "downloadable configuration must contain a placeholder only",
    );
  }
}

try {
  await page.goto(base + "/model-api-fixture");
  await button("Enable connection").waitFor();
  assert.equal(await button("Check connection").count(), 0);
  assert.equal(await tokenField().count(), 0);
  assert.match(
    await page.locator(".model-api-status").innerText(),
    /AI execution is paused/,
  );
  assert.equal(
    (
      await page
        .getByRole("combobox", { name: "Installed text model" })
        .locator("option")
        .allTextContents()
    ).length,
    2,
  );
  await button("Model settings").click();
  assert.equal(await page.locator("#handoff").innerText(), "Models requested");
  const initialConfig = JSON.parse(await configuration().innerText());
  assert.equal(initialConfig[0].models[0].id, "qualified-chat");
  assert.equal(initialConfig[0].models[0].toolCalling, false);
  assert.equal(initialConfig[0].models[0].vision, false);
  assert.equal(initialConfig[0].models[0].maxOutputTokens, 768);
  assert.equal(initialConfig[0].apiKey, "${input:paitonApiKey}");

  await button("Enable connection").click();
  await tokenField().waitFor();
  const firstToken = await tokenField().inputValue();
  assert.equal(await tokenField().getAttribute("type"), "password");
  assert.equal(await page.evaluate(() => window.fixtureCopies.length), 0);
  assert.equal(
    (await page.locator("body").innerText()).includes(firstToken),
    false,
  );
  await assertNoPersistedSecrets();
  await button("Reveal token").click();
  assert.equal(await tokenField().getAttribute("type"), "text");
  await button("Hide token").click();
  await button("Copy token").click();
  assert.equal(
    await page.evaluate(() => window.fixtureCopies.at(-1)),
    firstToken,
  );
  await button("Copy base URL").click();
  assert.equal(
    await page.evaluate(() => window.fixtureCopies.at(-1)),
    new URL(base).origin + "/v1",
  );
  await button("Copy configuration").click();
  const copied = await page.evaluate(() => window.fixtureCopies.at(-1));
  assert.equal(copied.includes(firstToken), false);
  assert.deepEqual(
    JSON.parse(await downloadConfiguration("paiton-models.json")),
    JSON.parse(copied),
  );
  await page
    .getByRole("combobox", { name: "Installed text model" })
    .selectOption("small-chat");
  const smallConfig = JSON.parse(await configuration().innerText())[0]
    .models[0];
  assert.equal(smallConfig.id, "small-chat");
  assert.equal(smallConfig.maxInputTokens, 1024);
  assert.equal(smallConfig.maxOutputTokens, 1024);
  await page
    .getByRole("group", { name: "API client", exact: true })
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  const yaml = await downloadConfiguration("paiton-model.yaml");
  assert.match(yaml, /model: "small-chat"/);
  assert.match(yaml, /provider: openai/);
  assert.match(yaml, /useResponsesApi: false/);
  assert.match(yaml, /roles: \[chat\]/);
  assert.ok(yaml.includes("${{ secrets.PAITON_API_KEY }}"));
  assert.equal(yaml.includes(firstToken), false);

  // Read-only verification works while inference is paused and needs explicit authorization.
  await button("Check connection").click();
  await page
    .getByRole("status")
    .filter({ hasText: "Connection verified from this browser" })
    .waitFor();
  assert.equal(
    requests.filter((request) => request.path === "/v1/models").at(-1)
      .authorization,
    `Bearer ${firstToken}`,
  );
  assert.equal(
    requests.some((request) => request.path.includes("chat/completions")),
    false,
  );
  await page.reload();
  await button("Disable connection").waitFor();
  assert.equal(
    await tokenField().count(),
    0,
    "a new token is not retrievable after leaving the setup view",
  );
  assert.equal(
    await page.getByLabel("Token to verify", { exact: true }).inputValue(),
    "",
  );
  assert.equal(await button("Check connection").isDisabled(), true);
  await button("Replace token").click();
  await tokenField().waitFor();
  const rotatedToken = await tokenField().inputValue();
  assert.notEqual(rotatedToken, firstToken);
  assert.equal(await tokenField().getAttribute("type"), "password");
  await page.reload();
  await page.getByLabel("Token to verify", { exact: true }).fill(firstToken);
  await button("Check connection").click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Invalid or revoked API token" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("status")
      .filter({ hasText: "Connection verified" })
      .count(),
    0,
  );

  // Reload is exclusive: a pending settings response cannot erase a newly issued token.
  const reload = gate({ project: projects[0].id });
  heldSettings = reload;
  await button("Reload connection").click();
  await waitForGate(reload.arrival, "settings reload");
  await settle();
  assert.equal(await button("Replace token").isDisabled(), true);
  assert.equal(await button("Disable connection").isDisabled(), true);
  assert.equal(await button("Check connection").isDisabled(), true);
  reload.resume();
  await waitForGate(reload.completion, "released settings reload");
  await page.getByLabel("Token to verify", { exact: true }).fill(rotatedToken);
  await button("Check connection").click();
  await page
    .getByRole("status")
    .filter({ hasText: "Connection verified from this browser" })
    .waitFor();

  // Realistic compare-and-swap conflicts preserve the other window's enabled state.
  mutateConnection(projects[0].id, { enabled: true, rotate: true });
  await button("Disable connection").click();
  await page
    .getByRole("alert")
    .filter({ hasText: "changed in another window" })
    .waitFor();
  assert.equal(connections.get(projects[0].id).enabled, true);
  await button("Reload connection").click();
  await page.getByRole("alert").waitFor({ state: "detached" });
  await button("Disable connection").click();
  await button("Enable connection").waitFor();
  assert.equal(connections.get(projects[0].id).enabled, false);
  assert.equal(await tokenField().count(), 0);
  assert.equal(await button("Check connection").count(), 0);

  // Old checks and token-creation responses must not leak into another project's page.
  await button("Enable connection").click();
  await tokenField().waitFor();
  const oldCheck = gate();
  heldModels = oldCheck;
  await button("Check connection").click();
  await waitForGate(oldCheck.arrival, "old project verification");
  await page.evaluate(() => window.fixtureProject(1));
  await button("Enable connection").waitFor();
  oldCheck.resume();
  await waitForGate(oldCheck.completion, "old verification response");
  await settle();
  assert.equal(
    await page
      .getByRole("status")
      .filter({ hasText: "Connection verified" })
      .count(),
    0,
  );
  assert.equal(await tokenField().count(), 0);
  const oldToken = gate({ project: projects[1].id });
  heldConfigure = oldToken;
  await button("Enable connection").click();
  await waitForGate(oldToken.arrival, "old project token creation");
  await page.evaluate(() => window.fixtureProject(0));
  await button("Disable connection").waitFor();
  oldToken.resume();
  await waitForGate(oldToken.completion, "old token response");
  await settle();
  assert.equal(await tokenField().count(), 0);
  await assertNoPersistedSecrets();

  await page.evaluate(() => {
    window.fixtureCopyFails = true;
  });
  const textareas = await page.locator("textarea").count();
  await button("Copy configuration").click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Fixture clipboard unavailable" })
    .waitFor();
  assert.equal(await page.locator("textarea").count(), textareas);
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      "model API UI must not overflow a narrow viewport",
    );
  }
  await page.evaluate(() => window.fixtureModels([]));
  await page
    .getByText(
      "Prepare a compatible text model in Model settings when you’re ready. Enabling this connection does not install one.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await configuration().count(), 0);
  assert.equal(await button("Copy configuration").count(), 0);
  assert.equal(await button("Download configuration").count(), 0);
  assert.equal(
    await page
      .getByRole("combobox", { name: "Installed text model" })
      .inputValue(),
    "",
  );
  await assertNoPersistedSecrets();
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(
    "Model API browser checks passed: enable/rotate/revoke, hidden one-time tokens, secret-free configs/storage, truthful model limits/capabilities, read-only paused verification, reload/CAS/project races, clipboard fallback and responsive empty states; no generation.",
  );
} catch (error) {
  console.error("Model API fixture diagnostics:", {
    errors,
    unexpected,
    url: page.url(),
  });
  throw error;
} finally {
  for (const item of gates) item.resume();
  await browser.close();
}
