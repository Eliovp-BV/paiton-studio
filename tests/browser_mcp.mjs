// Every API/MCP request is intercepted. No inference, services, packages or
// real project data are touched by these synthetic browser fixtures.
import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const base = process.env.STUDIO_TEST_URL || "http://127.0.0.1:8897";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(12000);
const errors = [],
  unexpected = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  window.fixtureCopies = [];
  window.fixtureCopyAllowed = true;
  document.execCommand = (command) => {
    if (command !== "copy" || !window.fixtureCopyAllowed) return false;
    window.fixtureCopies.push(document.activeElement.value);
    return true;
  };
});
const project = {
  id: "a".repeat(32),
  name: "MCP browser fixture",
  revision: 0,
  state: {},
  updated: Date.now() / 1000,
};
const server = {
  id: "b".repeat(32),
  agent: "c".repeat(32),
  enabled: false,
  definition: {
    name: "Project reviewer",
    purpose: "Review only the selected project documents.",
    document_ids: [],
    profile_id: "auto",
  },
};
const tools = [
  {
    id: "chat-fixture",
    name: "CPU fixture",
    model: "CPU fixture",
    state: "ready",
    compatibility: { compatible: true },
    profiles: [
      {
        id: "chat-fixture",
        label: "Conversation",
        task: "write",
        roles: ["chat", "code"],
      },
    ],
  },
];
let token = "synthetic-mcp-token-version-one",
  configReads = 0,
  issued = 0,
  heldRotation;
const serverBase = `/api/projects/${project.id}/mcp-servers`;
await page.route("**/mcp/**", (route) => {
  unexpected.push("MCP execution attempted");
  return route.abort();
});
await page.route("**/api/**", async (route) => {
  const request = route.request(),
    path = new URL(request.url()).pathname;
  let data, headers;
  if (path === "/api/session") data = { token: "browser-fixture" };
  else if (path === "/api/inbox")
    data = { events: [], unread: 0, has_more: false, limit: 100 };
  else if (path === "/api/meetings/readiness")
    data = {
      ready: false,
      message: "Meeting inference is unavailable in this CPU fixture.",
    };
  else if (path === "/api/host-guidance")
    data = { needs_attention: false, checks: [] };
  else if (path === "/api/settings")
    data = {
      defaults: {},
      appearance: {},
      generation: { seed: 771 },
      storage: {},
    };
  else if (path === "/api/tools") data = tools;
  else if (path === "/api/status")
    data = {
      jobs: [],
      gpu: { available: false, message: "CPU fixture" },
      worker: { state: "disabled" },
    };
  else if (path === "/api/projects") data = [project];
  else if (path === `/api/projects/${project.id}`)
    data = { ...project, assets: [] };
  else if (path.endsWith("/website")) data = { site: null, runs: [] };
  else if (path === serverBase) data = [server];
  else if (
    path === `${serverBase}/${server.id}` &&
    request.method() === "POST"
  ) {
    server.enabled = request.postDataJSON().enabled;
    token = "synthetic-mcp-token-" + ++issued;
    data = { ...server, ...(server.enabled ? { token } : {}) };
    if (heldRotation) {
      const hold = heldRotation;
      heldRotation = null;
      hold.arrived();
      await hold.release;
    }
  } else if (path === `${serverBase}/${server.id}/config`) {
    configReads++;
    unexpected.push("GET attempted to retrieve a stored credential");
    data = { error: "Rotate to obtain a new token." };
  } else {
    unexpected.push(`${request.method()} ${path}`);
    data = { error: "Unexpected fixture request" };
  }
  await route.fulfill({
    contentType: "application/json",
    headers,
    body: JSON.stringify(data),
  });
});
const guide = page.getByRole("region", { name: "Connect an editor" });
const manage = () =>
  page
    .locator(".mcp-server-card")
    .filter({
      has: page.getByRole("heading", {
        name: server.definition.name,
        exact: true,
      }),
    })
    .getByRole("button", { name: "Manage server" })
    .click();
const preview = async () =>
  JSON.parse(await guide.locator("pre").textContent());
const lastCopy = () => page.evaluate(() => window.fixtureCopies.at(-1));
const button = (name) => guide.getByRole("button", { name, exact: true });
try {
  await page.goto(base + "/#mcp");
  await page
    .getByRole("heading", { name: "MCP Servers", exact: true })
    .waitFor();
  await manage();
  await page.getByText("Server disabled", { exact: true }).waitFor();
  assert.equal(await button("VS Code").getAttribute("aria-pressed"), "true");
  for (const name of [
    "Copy configuration",
    "Download JSON",
    "Copy token",
    "Show token",
  ])
    assert.equal(await button(name).isDisabled(), true);
  assert.equal(configReads, 0);
  await page
    .getByRole("button", { name: "Enable MCP server", exact: true })
    .click();
  await page.getByText("Server enabled", { exact: true }).waitFor();
  await page
    .getByText("Client connection unverified", { exact: true })
    .waitFor();
  assert.equal(configReads, 0, "enabling never fetches credentials");
  await button("Copy configuration").click();
  await page.getByText("Configuration copied.", { exact: true }).waitFor();
  const vscode = JSON.parse(await lastCopy()),
    name = `paiton-${server.id}`;
  assert.equal(vscode.servers[name].type, "http");
  assert.equal(vscode.servers[name].url, new URL("/mcp/agents/", base).href);
  assert.equal(vscode.inputs[0].password, true);
  assert.equal(
    vscode.servers[name].headers.Authorization,
    "Bearer ${input:" + vscode.inputs[0].id + "}",
  );
  assert.equal(JSON.stringify(vscode).includes(token), false);
  assert.equal(configReads, 0);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    button("Download JSON").click(),
  ]);
  assert.equal(download.suggestedFilename(), "paiton-vscode-mcp.json");
  assert.deepEqual(
    JSON.parse(await fs.readFile(await download.path(), "utf8")),
    vscode,
  );
  if (process.env.STUDIO_MCP_SCREENSHOT_DIR) {
    await fs.mkdir(process.env.STUDIO_MCP_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: `${process.env.STUDIO_MCP_SCREENSHOT_DIR}/mcp-desktop.png`,
      fullPage: true,
    });
  }
  await button("Copy token").click();
  await page.getByText("Server token copied.", { exact: true }).waitFor();
  assert.equal(await lastCopy(), token);
  assert.equal(
    await page.getByLabel("Access token", { exact: true }).count(),
    0,
  );
  assert.equal((await page.content()).includes(token), false);
  await button("Show token").click();
  await page.getByLabel("Access token", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Access token", { exact: true }).inputValue(),
    token,
  );
  await button("Hide token").click();
  assert.equal(
    await page.getByLabel("Access token", { exact: true }).count(),
    0,
  );
  await guide
    .getByLabel("Token setup", { exact: true })
    .selectOption("environment");
  const remote = await preview();
  assert.equal(remote.inputs, undefined);
  assert.match(
    remote.servers[name].headers.Authorization,
    /^Bearer \$\{env:PAITON_MCP_[A-F0-9]+_TOKEN\}$/,
  );
  await guide
    .getByText("Using Remote-SSH or Agent Host?", { exact: true })
    .click();
  await guide.getByText(/Agent Host does not forward servers/).waitFor();
  await button("Cursor").click();
  const cursor = await preview();
  assert.ok(cursor.mcpServers[name]);
  assert.equal(cursor.servers, undefined);
  assert.match(cursor.mcpServers[name].headers.Authorization, /\$\{env:/);
  await button("Other MCP app").click();
  assert.equal(
    (await preview()).mcpServers[name].headers.Authorization,
    "Bearer PASTE_SERVER_TOKEN",
  );
  await page.evaluate(() => {
    window.fixtureCopyAllowed = false;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText() {
          throw Error("Clipboard permission denied.");
        },
      },
    });
  });
  await button("Copy configuration").click();
  const manual = page.getByLabel("Configuration · manual copy", {
    exact: true,
  });
  await manual.waitFor();
  assert.deepEqual(JSON.parse(await manual.inputValue()), await preview());
  await button("Close manual copy").click();
  await button("Copy token").click();
  const manualToken = page.getByLabel("Server token · manual copy", {
    exact: true,
  });
  await manualToken.waitFor();
  assert.equal(await manualToken.inputValue(), token);
  await button("Hide token").click();
  await page.evaluate(() => {
    window.fixtureCopyAllowed = true;
  });
  await page
    .getByRole("button", { name: "Rotate server token", exact: true })
    .click();
  await page.getByText("Server enabled", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Access token", { exact: true }).count(),
    0,
  );
  await button("Copy token").click();
  await page.getByText("Server token copied.", { exact: true }).waitFor();
  assert.equal(await lastCopy(), token);
  let arrive, release;
  const arrival = new Promise((resolve) => {
    arrive = resolve;
  });
  heldRotation = {
    arrived: arrive,
    release: new Promise((resolve) => {
      release = resolve;
    }),
  };
  const priorCopies = await page.evaluate(() => window.fixtureCopies.length);
  await page
    .getByRole("button", { name: "Rotate server token", exact: true })
    .click();
  await arrival;
  await page
    .getByRole("button", { name: "All MCP servers", exact: true })
    .click();
  release();
  await manage();
  assert.equal(
    await page.getByLabel("Access token", { exact: true }).count(),
    0,
    "late rotation responses cannot reveal credentials after navigation",
  );
  assert.equal(
    await page.evaluate(() => window.fixtureCopies.length),
    priorCopies,
  );
  await button("Show token").click();
  await page.getByText(/This token is no longer visible/).waitFor();
  assert.equal(configReads, 0, "credentials are never recoverable through GET");
  await page
    .getByRole("button", { name: "Rotate server token", exact: true })
    .click();
  await button("Show token").click();
  await page.getByLabel("Access token", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Access token", { exact: true }).inputValue(),
    token,
  );
  await page
    .getByRole("button", { name: "Disable server", exact: true })
    .click();
  await page.getByText("Server disabled", { exact: true }).waitFor();
  assert.equal(await button("Copy token").isDisabled(), true);
  assert.equal(
    await page
      .getByText("Client connection unverified", { exact: true })
      .count(),
    0,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  if (process.env.STUDIO_MCP_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.STUDIO_MCP_SCREENSHOT_DIR}/mcp-mobile.png`,
      fullPage: true,
    });
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  console.log(
    "MCP browser checks passed: client-specific config, remote variables, hidden/rotated tokens, HTTP clipboard fallback, stale responses, disabled guards and mobile layout; no execution.",
  );
} finally {
  await browser.close();
}
