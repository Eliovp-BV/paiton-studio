// Real conversation APIs on disposable CPU fixtures. Completion is synthesized
// directly in the isolated store; the backend worker always remains disabled.
import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const base = process.env.STUDIO_URL;
const project = process.env.STUDIO_PROJECT;
const data = path.resolve(process.env.STUDIO_TEST_DATA);
assert.ok(data.startsWith(path.resolve(".local/ui-tests") + path.sep));
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 1100 },
  reducedMotion: "reduce",
});
page.setDefaultTimeout(15000);
const errors = [],
  regenerationBodies = [],
  externalRequests = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript((selectedProject) => {
  localStorage.setItem("studio-project", selectedProject);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      async writeText(text) {
        window.replyCopiedText = text;
      },
    },
  });
}, project);
await page.route(/\/api\/status(?:\?.*)?$/, async (route) => {
  const response = await route.fetch();
  const snapshot = await response.json();
  // UI controls are enabled against fake-ready tools; no execution worker starts.
  await route.fulfill({
    json: { ...snapshot, worker: { ...snapshot.worker, state: "idle" } },
  });
});
await page.route("https://example.test/**", async (route) => {
  externalRequests.push(route.request().url());
  await route.abort();
});
let failRegeneration = true;
await page.route("**/api/chats/*/regenerate/*", async (route) => {
  regenerationBodies.push(route.request().postDataJSON());
  if (failRegeneration) {
    failRegeneration = false;
    await route.fulfill({
      status: 503,
      json: { detail: "Synthetic transient request failure." },
    });
  } else await route.continue();
});
const session = await (await page.request.get(base + "/api/session")).json();
const headers = { "X-Studio-Token": session.token };
async function api(endpoint, body, method = "POST") {
  const response = await page.request.fetch(base + "/api" + endpoint, {
    method: body === undefined ? "GET" : method,
    headers,
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
store=Store(Path(sys.argv[1]))
asset=store.add_asset(sys.argv[2],'text','Synthetic reply',sys.argv[4].encode(),'.md',{})
store.status(sys.argv[3],'completed','Saved synthetic reply',asset=asset['id'])
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
const markdown =
  "# A synthetic reply\n\nA **clear** answer with *emphasis* and `inline code`.\n\n- First item\n  - Nested item\n- Second item\n\n3. Third item\n4. Fourth item\n\n> A quoted idea.\n\n| Name | Value |\n| --- | ---: |\n| Cedar | 42 |\n\n[Safe link](https://example.test/reference) and [Unsafe link](javascript:alert(1)).\n\n<img src=x onerror=\"window.replyInjected=true\">\n<script>window.replyInjected=true</script>\n![Remote image](https://example.test/tracking.png)\n\n```python\nprint('<literal>')\n```\n";

try {
  let chat = await api(`/projects/${project}/chats`, {
    title: "Reply controls fixture",
  });
  const first = await api(`/chats/${chat.id}/messages`, {
    prompt: "Original question",
    mode: "chat",
    client_id: "browser-reply-initial-001",
  });
  complete(first, markdown);
  await page.goto(base + "/#chat");
  await page
    .getByRole("button", { name: "Reply controls fixture", exact: true })
    .click();
  const answer = page.locator(".gpt-markdown").first();
  await answer
    .getByRole("heading", { name: "A synthetic reply", exact: true })
    .waitFor();
  assert.equal(await answer.locator("strong").textContent(), "clear");
  assert.equal(await answer.locator("em").textContent(), "emphasis");
  assert.equal(await answer.locator("ul ul li").textContent(), "Nested item");
  assert.equal(await answer.locator("ol").getAttribute("start"), "3");
  assert.equal(
    await answer.locator("blockquote").textContent(),
    "A quoted idea.",
  );
  await answer.getByRole("cell", { name: "42", exact: true }).waitFor();
  assert.equal(
    await answer.getByRole("link", { name: "Safe link" }).getAttribute("href"),
    "https://example.test/reference",
  );
  assert.equal(
    await answer.getByRole("link", { name: "Unsafe link" }).count(),
    0,
  );
  assert.equal(await answer.locator("img,script").count(), 0);
  assert.equal(await page.evaluate(() => window.replyInjected), undefined);
  await answer.getByRole("button", { name: "Copy code", exact: true }).click();
  assert.equal(
    await page.evaluate(() => window.replyCopiedText),
    "print('<literal>')\n",
  );
  await page.getByRole("button", { name: "Copy reply", exact: true }).click();
  assert.equal(await page.evaluate(() => window.replyCopiedText), markdown);

  await page.locator(".chat-reply-setup > summary").click();
  await page.getByText("Sampling & role", { exact: true }).click();
  assert.equal(
    await page.getByLabel("Temperature", { exact: true }).inputValue(),
    "",
  );
  await page.getByLabel("Maximum output tokens", { exact: true }).fill("2049");
  await page
    .getByRole("alert")
    .getByText(
      "Use the displayed sampling ranges and a whole-number seed and output limit.",
    )
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Save reply setup", exact: true })
      .isEnabled(),
    false,
  );
  await page.getByLabel("Maximum output tokens", { exact: true }).fill("128");
  await page.getByLabel("Temperature", { exact: true }).fill("0.6");
  await page.getByLabel("Top p", { exact: true }).fill("0.85");
  await page.getByLabel("Seed", { exact: true }).fill("45");
  await page.getByLabel("System role", { exact: true }).fill("A patient tutor");
  await page.getByLabel("Response preset").selectOption("explain");
  await page
    .getByRole("button", { name: "Save reply setup", exact: true })
    .click();
  await page
    .getByText("Reply setup saved for this conversation.", { exact: true })
    .waitFor();
  chat = await api(`/chats/${chat.id}`);
  assert.equal(chat.settings.temperature, 0.6);
  assert.equal(chat.settings.max_output_tokens, 128);
  assert.equal(chat.settings.system_role, "A patient tutor");
  await page.locator(".chat-reply-setup > summary").click();
  const receipt = page.locator(".chat-sampling-receipt").first();
  await receipt.locator("summary").click();
  assert.match(await receipt.textContent(), /Temperature0/);
  assert.match(await receipt.textContent(), /Top pRuntime default/);
  assert.match(await receipt.textContent(), /Seed771/);
  assert.match(await receipt.textContent(), /Maximum output tokens2048/);
  await page.getByRole("button", { name: "Regenerate", exact: true }).click();
  await page
    .getByRole("alert")
    .getByText("Synthetic transient request failure.")
    .waitFor();
  await page.getByRole("button", { name: "Regenerate", exact: true }).click();
  await page
    .getByText(
      "New reply queued with the saved sources and current reply setup. The earlier reply is kept.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    regenerationBodies[0].client_id,
    regenerationBodies[1].client_id,
    "A retry must reuse its request identity.",
  );
  chat = await api(`/chats/${chat.id}`);
  assert.equal(chat.turns.length, 2);
  const replacement = chat.turns[1].job;
  assert.equal(replacement.request.sampling.temperature, 0.6);
  assert.equal(replacement.request.sampling.top_p, 0.85);
  assert.equal(replacement.request.sampling.max_output_tokens, 128);
  assert.equal(chat.turns[0].answer, markdown);
  assert.ok(
    !JSON.stringify(replacement.request.messages).includes("A synthetic reply"),
  );
  assert.equal(
    await page.getByRole("button", { name: "Regenerate", exact: true }).count(),
    0,
  );
  complete(replacement, "A regenerated answer.");
  await page.getByText("A regenerated answer.", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Edit and resend", exact: true })
    .click();
  await page
    .getByLabel("Edit latest prompt", { exact: true })
    .fill("Revised question");
  await page
    .getByRole("button", { name: "Send edited prompt", exact: true })
    .click();
  await page
    .getByLabel("Edit latest prompt", { exact: true })
    .waitFor({ state: "detached" });
  chat = await api(`/chats/${chat.id}`);
  assert.equal(chat.turns.length, 3);
  assert.equal(chat.turns[2].prompt, "Revised question");
  assert.ok(
    !JSON.stringify(chat.turns[2].job.request.messages).includes(
      "A regenerated answer.",
    ),
  );
  complete(chat.turns[2].job, "The revised answer.");
  await page.getByText("The revised answer.", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByText(
        "Earlier reply kept · a newer reply is used for future context.",
        { exact: true },
      )
      .count(),
    2,
  );

  await page.locator(".chat-reply-setup > summary").click();
  const copiedSetupSaved = page.waitForResponse(
    (response) =>
      /\/api\/chats\/[a-f0-9]+$/.test(new URL(response.url()).pathname) &&
      response.request().method() === "PATCH" &&
      response.status() === 200,
  );
  await page
    .getByRole("button", { name: "New with this setup", exact: true })
    .click();
  await copiedSetupSaved;
  const collection = await api(`/projects/${project}/chats`);
  const copied = collection.find((item) => item.id !== chat.id);
  assert.equal(copied.settings.seed, 45);
  assert.equal(copied.settings.preset, "explain");
  assert.equal(copied.settings.system_role, "A patient tutor");
  await page
    .getByRole("button", { name: "Reply controls fixture", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.screenshot({
    path: path.join(
      process.env.STUDIO_CAPTURE_DIR,
      "reply-controls-mobile.png",
    ),
    fullPage: true,
  });
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
  console.log(
    "Reply controls browser checks passed: safe Markdown, copy, sampling validation/receipts, idempotent regeneration, saved edit history and setup reuse.",
  );
} finally {
  await browser.close();
}
