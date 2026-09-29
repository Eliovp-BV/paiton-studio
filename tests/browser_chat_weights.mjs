// Real chat APIs with disposable CPU-only data. All completions are synthetic;
// tool readiness is a browser fixture and the backend worker remains disabled.
import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
const base = process.env.STUDIO_URL,
  project = process.env.STUDIO_PROJECT;
const data = path.resolve(process.env.STUDIO_TEST_DATA);
assert.ok(data.startsWith(path.resolve(".local/ui-tests") + path.sep));
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 1100 },
  reducedMotion: "reduce",
});
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let setupUnavailable = false;
await page.addInitScript(
  (id) => localStorage.setItem("studio-project", id),
  project,
);
await page.route(/\/api\/status(?:\?.*)?$/, async (route) => {
  const response = await route.fetch(),
    value = await response.json();
  await route.fulfill({
    json: { ...value, worker: { ...value.worker, state: "idle" } },
  });
});
await page.route(/\/api\/tools(?:\?.*)?$/, async (route) => {
  const response = await route.fetch(),
    values = await response.json();
  await route.fulfill({
    json: values.map((tool) =>
      tool.id !== "qwen38-mxfp4"
        ? tool
        : {
            ...tool,
            state: setupUnavailable ? "setup_required" : "ready",
            optional_components: [
              { id: "w3a4", verified: true, enabled_default: false },
            ],
            release_states: {
              "64k": {
                state: setupUnavailable ? "setup_required" : "ready",
                message: setupUnavailable
                  ? "The unified runtime target needs installation."
                  : "Unified runtime ready.",
              },
              "200k": {
                state: setupUnavailable ? "setup_required" : "ready",
                message: setupUnavailable
                  ? "The unified runtime target needs installation."
                  : "Unified runtime ready.",
              },
            },
          },
    ),
  });
});
const session = await (await page.request.get(base + "/api/session")).json();
async function api(endpoint, body, method = "POST") {
  const response = await page.request.fetch(base + "/api" + endpoint, {
    method: body === undefined ? "GET" : method,
    headers: { "X-Studio-Token": session.token },
    data: body,
  });
  assert.ok(response.ok(), `${endpoint}: ${await response.text()}`);
  return response.json();
}
function complete(job, text) {
  const result = spawnSync(
    process.env.STUDIO_PYTHON,
    [
      "-c",
      `
from pathlib import Path
import sys
from studio.store import Store
from studio.conversation_options import details
store=Store(Path(sys.argv[1]));job=store.job(sys.argv[3])
metadata={'conversation':details(job['request']['profile'])}
asset=store.add_asset(sys.argv[2],'text','Synthetic precision reply',sys.argv[4].encode(),'.md',metadata)
store.status(job['id'],'completed','Saved synthetic reply',asset=asset['id'])
`,
      data,
      project,
      job.id,
      text,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
}
async function openSetup() {
  const panel = page.locator(".chat-reply-setup");
  if (!(await panel.evaluate((el) => el.open)))
    await panel.locator(":scope > summary").click();
}
async function openTechnical() {
  await openSetup();
  const panel = page.locator(".conversation-controls details");
  if (!(await panel.evaluate((el) => el.open)))
    await panel.locator(":scope > summary").click();
}
async function selectWeights(value) {
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/options") &&
      r.request().method() === "PUT" &&
      r.status() === 200,
  );
  await page
    .getByRole("combobox", { name: "Weights for this chat" })
    .selectOption(value);
  await response;
  await page.waitForFunction(
    () =>
      !document.querySelector('select[aria-label="Weights for this chat"]')
        .disabled,
  );
}
try {
  let chat = await api(`/projects/${project}/chats`, {
    title: "Precision history fixture",
  });
  chat = await api(
    `/chats/${chat.id}`,
    {
      expected_revision: chat.revision,
      settings: {
        preset: "general",
        instructions: "",
        profile_id: "qwen38-mxfp4-chat",
      },
    },
    "PATCH",
  );
  await api(
    `/chats/${chat.id}/options`,
    {
      conversation: {
        context_mode: "long",
        reuse_cache: false,
        weights: "w3a4",
      },
      tools_enabled: false,
    },
    "PUT",
  );
  const first = await api(`/chats/${chat.id}/messages`, {
    prompt: "An original precision question",
    mode: "chat",
    client_id: "browser-weights-first-0001",
  });
  assert.equal(first.request.profile.conversation_options.weights, "w3a4");
  complete(first, "A synthetic 3-bit reply.");
  await page.goto(base + "/#chat");
  await page
    .getByRole("button", { name: "Precision history fixture", exact: true })
    .click();
  const receipt = page.locator(".chat-runtime-receipt").first();
  await receipt.locator("summary").click();
  assert.match(await receipt.innerText(), /W3A4 3-bit/);
  assert.match(await receipt.innerText(), /65,536/);
  assert.match(await receipt.innerText(), /393,216/);
  assert.match(await receipt.innerText(), /KV4 \(4-bit\)/);
  const exported = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export conversation", exact: true })
    .click();
  const exportedFile = await exported;
  assert.match(
    await fs.readFile(await exportedFile.path(), "utf8"),
    /Model: .*W3A4 3-bit/,
  );

  await openTechnical();
  assert.match(
    await page
      .getByRole("combobox", { name: "Conversation model" })
      .getAttribute("title"),
    /W3A4 3-bit/,
  );
  assert.equal(
    await page
      .getByRole("combobox", { name: "Weights for this chat" })
      .inputValue(),
    "w3a4",
  );
  const copied = page.waitForResponse(
    (r) =>
      r.url().endsWith("/options") &&
      r.request().method() === "PUT" &&
      r.status() === 200,
  );
  await page
    .getByRole("button", { name: "New with this setup", exact: true })
    .click();
  const copiedResponse = await copied;
  const copiedId = new URL(copiedResponse.url()).pathname.split("/").at(-2);
  assert.notEqual(copiedId, chat.id);
  const cloned = await api(`/chats/${copiedId}`);
  assert.equal(
    cloned.options.conversation.weights,
    "w3a4",
    "New with this setup keeps the saved precision even when the package default is off.",
  );
  assert.equal(cloned.settings.profile_id, "qwen38-mxfp4-chat");
  await page
    .getByRole("button", { name: "Precision history fixture", exact: true })
    .click();
  await openTechnical();
  await selectWeights("mxfp4");
  assert.equal(
    (await api(`/chats/${chat.id}`)).options.conversation.weights,
    "mxfp4",
  );
  if (!(await receipt.evaluate((element) => element.open)))
    await receipt.locator("summary").click();
  assert.match(
    await receipt.innerText(),
    /W3A4 3-bit/,
    "Changing the chat must not relabel an old reply.",
  );
  assert.match(
    await page
      .getByRole("combobox", { name: "Conversation model" })
      .getAttribute("title"),
    /MXFP4/,
  );
  await selectWeights("w3a4");
  const changed = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/chats/${chat.id}/options`) &&
      r.request().method() === "PUT" &&
      r.status() === 200,
  );
  await page
    .getByRole("checkbox", { name: "Extra-long context", exact: false })
    .check();
  await changed;
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="Weights for this chat"]')
        ?.disabled === false,
  );
  let current = await api(`/chats/${chat.id}`);
  assert.equal(
    current.options.conversation.weights,
    "w3a4",
    "Extra-long preserves the saved W3 precision.",
  );
  assert.equal(current.conversation_details.context, 200000);
  assert.equal(current.conversation_details.kv_cache_mode, "fp8");
  assert.equal(current.conversation_details.prefix_caching, true);
  assert.equal(
    await page
      .getByRole("combobox", { name: "Weights for this chat" })
      .locator('option[value="w3a4"]')
      .isDisabled(),
    false,
  );
  const cache = page.getByRole("checkbox", {
    name: "Reuse conversation cache",
    exact: false,
  });
  assert.equal(await cache.isChecked(), true);
  assert.equal(await cache.isDisabled(), true);
  assert.match(
    await page.locator(".conversation-controls").innerText(),
    /APC on/,
  );
  assert.match(await page.locator(".conversation-controls").innerText(), /FP8/);
  const setup = page.locator(".chat-reply-setup");
  await setup.locator(":scope > summary").click();
  const prompt = page.getByRole("textbox", { name: "Message Chat" });
  await prompt.fill("The unified runtime supports W3 at 200K.");
  const send = page.getByRole("button", { name: "Send message", exact: true });
  assert.equal(await send.isEnabled(), true);
  setupUnavailable = true;
  await page.reload();
  await page
    .getByRole("button", { name: "Precision history fixture", exact: true })
    .click();
  assert.equal(
    await send.isDisabled(),
    true,
    "Missing unified target blocks new200K work.",
  );
  await openTechnical();
  const shorten = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/chats/${chat.id}/options`) &&
      r.request().method() === "PUT" &&
      r.status() === 200,
  );
  await page
    .getByRole("checkbox", { name: "Longer context", exact: false })
    .uncheck();
  await shorten;
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="Weights for this chat"]')
        ?.disabled === false,
  );
  current = await api(`/chats/${chat.id}`);
  assert.equal(current.options.conversation.weights, "w3a4");
  assert.equal(current.conversation_details.kv_cache_mode, "kv4");
  await setup.locator(":scope > summary").click();
  assert.equal(
    await send.isDisabled(),
    true,
    "Missing unified target also blocks newshort-context work.",
  );
  const saved = await api(`/chats/${chat.id}`);
  assert.equal(saved.turns.length, 1);
  assert.equal(
    saved.turns[0].job.request.profile.conversation_options.weights,
    "w3a4",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await openTechnical();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.screenshot({
    path: path.join(process.env.STUDIO_CAPTURE_DIR, "chat-weights-mobile.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "Chat weights precision receipts, preset copying, explicit switches, 200K W3, effective KV/APC settings, shared runtime readiness and mobile layout passed; synthetic CPU completions only.",
  );
} finally {
  await browser.close();
}
