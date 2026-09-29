// Synthetic failure responses; the harness backend never starts a worker or runtime.
import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const project = process.env.STUDIO_PROJECT;
assert.ok(project, "Run through the isolated UI harness.");
const now = Date.now() / 1000;
const queueId = "d".repeat(32);
const chatJobId = "e".repeat(32);
const chatId = "f".repeat(32);
const setupId = "9".repeat(32);
const packageId = "flux";
const model = {
  id: "fixture-chat",
  model: "Fixture writing model",
  package: "fixture",
  label: "Conversation",
};
const job = {
  id: queueId,
  project,
  state: "failed",
  created: now - 5,
  updated: now,
  message: "The saved request could not finish.",
  request: { task: "write", prompt: "A synthetic request", profile: model },
};
const chat = {
  id: chatId,
  project,
  title: "Diagnostics conversation",
  created: now,
  updated: now,
  revision: 1,
  archived: false,
  pinned: false,
  settings: { preset: "general", instructions: "", profile_id: "auto" },
  options: {},
  turns: [
    {
      id: "8".repeat(32),
      prompt: "Explain this synthetic failure",
      mode: "chat",
      documents: [],
      answer: null,
      partial: "A saved partial reply.",
      asset: null,
      job: {
        ...job,
        id: chatJobId,
        request: { ...job.request, chat_id: chatId },
      },
    },
  ],
};
const setupJob = {
  id: setupId,
  package: packageId,
  state: "failed",
  message: "The package could not be verified.",
  created: now,
  updated: now,
};
const setup = {
  system: {
    disk_free_bytes: 512 * 1024 ** 3,
    message: "Synthetic setup fixture.",
    checks: [],
  },
  tools: [
    {
      id: packageId,
      title: "Create images",
      model: "Fixture image model",
      state: "setup_required",
      message: "Download the creation tool.",
      can_install: true,
      steps: [],
      download_bytes: 1024 ** 3,
      required_disk_bytes: 2 * 1024 ** 3,
      source_url: "https://example.com/fixture",
      license: "Synthetic fixture",
    },
  ],
  jobs: [setupJob],
};
const copyText =
  "Paiton Studio diagnostics\nRequest failed\nSensitive values: [redacted]";
const logText =
  "A sanitized runtime error.\n" +
  "x".repeat(220) +
  "\n<script>window.diagnosticsInjected = true</script>";
const response = {
  log: { available: true, text: logText, truncated: true },
  diagnostics: { state: "failed", message: "Request failed" },
  copy_text: copyText,
};
const reads = new Map();
let setupFailure = true;
const errors = [],
  unexpectedWrites = [];
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
page.setDefaultTimeout(12000);
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript((selectedProject) => {
  localStorage.setItem("studio-project", selectedProject);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      async writeText(text) {
        if (window.blockClipboard) throw Error("Synthetic clipboard block");
        window.copiedDiagnostics = text;
      },
    },
  });
}, project);
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const method = request.method();
  const endpoint = url.pathname;
  let value,
    status = 200;
  if (/^\/api\/(jobs|setup-jobs)\/[^/]+\/diagnostics$/.test(endpoint)) {
    assert.equal(method, "GET");
    reads.set(endpoint, (reads.get(endpoint) || 0) + 1);
    if (endpoint.includes("setup-jobs") && setupFailure) {
      status = 500;
      value = { error: "Private server detail must not be displayed" };
    } else
      value = endpoint.includes("setup-jobs")
        ? { ...response, log: { available: false, text: "", truncated: false } }
        : response;
  } else if (endpoint === "/api/status") {
    const upstream = await route.fetch();
    value = { ...(await upstream.json()), jobs: [job] };
  } else if (endpoint === `/api/projects/${project}/chats`) value = [chat];
  else if (endpoint === `/api/chats/${chatId}`) value = chat;
  else if (endpoint === "/api/chat-presence" && method === "POST")
    value = { ok: true };
  else if (endpoint === "/api/setup") value = setup;
  else if (endpoint === "/api/runtime-packages")
    value = {
      available: true,
      repository: "ghcr.io/eliovp/paiton-vllm-plugin",
      message: "",
      packages: [
        {
          id: packageId,
          model: "Fixture image model",
          current: { reference: "", image_id: null, digests: [] },
          versions: [],
          can_switch: false,
          can_pull: false,
          message: "Download required.",
        },
      ],
    };
  else {
    if (!["GET", "HEAD"].includes(method)) {
      unexpectedWrites.push(`${method} ${endpoint}`);
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: '{"error":"Fixture does not permit writes"}',
      });
    }
    return route.continue();
  }
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
});

try {
  await page.goto(process.env.STUDIO_URL);
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const queue = page.getByRole("complementary", { name: "Activity" });
  const card = queue.locator(`[data-job-id="${queueId}"]`);
  await card.getByText("The saved request could not finish.").waitFor();
  assert.equal(
    reads.size,
    0,
    "Diagnostics are fetched only when details open.",
  );
  assert.ok(
    await card.getByRole("button", { name: "Retry same request" }).isEnabled(),
  );
  await card.getByText("Show details", { exact: true }).click();
  await card.getByLabel("Diagnostics log").waitFor();
  assert.equal(await card.getByLabel("Diagnostics log").textContent(), logText);
  await card.getByText("Showing the last portion of the log.").waitFor();
  assert.equal(reads.get(`/api/jobs/${queueId}/diagnostics`), 1);
  assert.equal(
    await page.evaluate(() => window.diagnosticsInjected),
    undefined,
  );
  await card.getByRole("button", { name: "Copy diagnostics" }).click();
  await card.getByText("Diagnostics copied.").waitFor();
  assert.equal(await page.evaluate(() => window.copiedDiagnostics), copyText);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "Open diagnostics must wrap on a narrow screen.",
  );
  const output = process.env.STUDIO_CAPTURE_DIR;
  await fs.mkdir(output, { recursive: true });
  await page.screenshot({
    path: path.join(output, "diagnostics-mobile.png"),
    fullPage: true,
  });
  await queue.getByRole("button", { name: "Close activity" }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    location.hash = "chat";
  });
  await page
    .getByRole("button", { name: "Diagnostics conversation", exact: true })
    .click();
  const reply = page.locator(".gpt-assistant");
  await reply.getByText("A saved partial reply.").waitFor();
  assert.ok(
    await reply
      .getByRole("button", { name: "Retry saved request" })
      .isEnabled(),
  );
  assert.equal(reads.has(`/api/jobs/${chatJobId}/diagnostics`), false);
  await reply.getByText("Show details", { exact: true }).click();
  await reply.getByLabel("Diagnostics log").waitFor();
  assert.equal(reads.get(`/api/jobs/${chatJobId}/diagnostics`), 1);

  await page.evaluate(() => {
    location.hash = "model-setup";
  });
  const tool = page.locator(".setup-tool");
  await tool.getByText("failed: The package could not be verified.").waitFor();
  assert.equal(reads.has(`/api/setup-jobs/${setupId}/diagnostics`), false);
  assert.ok(
    await tool.getByRole("button", { name: "Download & set up" }).isEnabled(),
  );
  await tool.getByText("Show details", { exact: true }).click();
  await tool
    .getByRole("alert")
    .getByText("Details could not be loaded. Try again.")
    .waitFor();
  assert.equal(
    await page.getByText("Private server detail must not be displayed").count(),
    0,
  );
  setupFailure = false;
  await tool.getByRole("button", { name: "Try again", exact: true }).click();
  await tool.getByText("No log was saved for this request.").waitFor();
  assert.equal(reads.get(`/api/setup-jobs/${setupId}/diagnostics`), 2);
  await page.evaluate(() => {
    window.blockClipboard = true;
    document.execCommand = () => false;
  });
  await tool.getByRole("button", { name: "Copy diagnostics" }).click();
  await tool
    .getByText("Copy was blocked. Select the diagnostics below and copy them.")
    .waitFor();
  assert.equal(
    await tool.getByLabel("Diagnostics to copy").inputValue(),
    copyText,
  );
  assert.equal(
    await tool.getByLabel("Diagnostics to copy").getAttribute("readonly"),
    "",
  );

  await page
    .locator("main .settings-tabs")
    .getByRole("button", { name: "Runtime packages", exact: true })
    .click();
  const runtime = page.locator(".runtime-package-card");
  await runtime.getByRole("heading", { name: "Fixture image model" }).waitFor();
  assert.equal(reads.get(`/api/setup-jobs/${setupId}/diagnostics`), 2);
  await runtime.getByText("Show details", { exact: true }).click();
  await runtime.getByText("No log was saved for this request.").waitFor();
  assert.equal(reads.get(`/api/setup-jobs/${setupId}/diagnostics`), 3);
  assert.deepEqual(unexpectedWrites, []);
  assert.deepEqual(errors, []);
  console.log(
    "Diagnostics browser checks passed: lazy logs, retries, copy and manual fallback, queue/chat/setup/runtime cards, mobile wrapping.",
  );
} finally {
  await browser.close();
}
