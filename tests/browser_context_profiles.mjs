// Real isolated Studio API and UI. Does not mock model output or start inference.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
const url = process.env.STUDIO_URL;
assert.ok(url, "Set STUDIO_URL to an isolated Studio workspace");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const output = process.env.STUDIO_CAPTURE_DIR || ".local/qualification/ui";
fs.mkdirSync(output, { recursive: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (r.url().includes("/api/") && r.status() >= 500)
      errors.push(r.status() + " " + r.url());
  });
  await page.goto(url + "/#chat");
  const api = async (path, data, method = "POST") =>
    page.evaluate(
      async ({ path, data, method }) => {
        const session = await (await fetch("/api/session")).json();
        const response = await fetch("/api" + path, {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-Studio-Token": session.token,
          },
          body: data === undefined ? undefined : JSON.stringify(data),
        });
        const result = await response.json();
        if (!response.ok) throw Error(JSON.stringify(result));
        return result;
      },
      { path, data, method },
    );
  const projects = await api("/projects", undefined, "GET");
  assert.ok(projects.length);
  await page.evaluate(
    (id) => localStorage.setItem("studio-project", id),
    projects[0].id,
  );
  await page.reload();
  const controls = page.locator(".gpt-context .conversation-controls");
  await controls.waitFor();
  const longer = controls
    .locator("label")
    .filter({ has: page.getByText("Longer context", { exact: true }) })
    .locator("input");
  const cache = controls
    .locator("label")
    .filter({
      has: page.getByText("Reuse conversation cache", { exact: true }),
    })
    .locator("input");
  await longer.check();
  await page.waitForTimeout(800);
  await cache.check();
  await page.waitForTimeout(800);
  await page.reload();
  await controls.waitFor();
  assert.ok(await longer.isChecked());
  assert.ok(await cache.isChecked());
  await controls
    .getByText("Advanced & technical details", { exact: true })
    .click();
  const extra = controls
    .locator("label")
    .filter({ has: page.getByText("Extra-long context", { exact: true }) })
    .locator("input");
  assert.ok(await extra.isDisabled());
  await cache.uncheck();
  await page.waitForTimeout(500);
  await extra.check();
  await page.waitForTimeout(500);
  assert.ok(await cache.isDisabled());
  await extra.uncheck();
  await page.waitForTimeout(500);
  await cache.check();
  await page.waitForTimeout(600);
  await page.screenshot({
    path: output + "/chat-context-1600.png",
    fullPage: true,
  });
  // A queued request retains its submitted profile while later preferences change.
  const chats = await api(
    "/projects/" + projects[0].id + "/chats",
    undefined,
    "GET",
  );
  const chat = chats[0];
  const job = await api("/chats/" + chat.id + "/messages", {
    prompt: "UI queue test: keep this saved until explicitly cancelled.",
    mode: "chat",
    profile_id: "qwen38-mxfp4-chat",
    client_id: "ui-profile-" + Date.now(),
  });
  try {
    await api(
      "/chats/" + chat.id + "/options",
      {
        conversation: { context_mode: "short", reuse_cache: false },
        tools_enabled: false,
      },
      "PUT",
    );
    const current = await api("/chats/" + chat.id, undefined, "GET");
    assert.ok(current.profile_change_pending);
    assert.equal(current.turns.at(-1).job.request.profile.context, 65536);
  } finally {
    await api("/jobs/" + job.id + "/cancel", {});
  }
  await page.reload();
  await controls.waitFor();
  assert.equal(await longer.isChecked(), false);
  assert.ok(await cache.isDisabled());
  await page.goto(url + "/#settings");
  await page
    .getByRole("heading", { name: "Chat & coding memory", exact: true })
    .waitFor();
  await page.screenshot({
    path: output + "/settings-context-1600.png",
    fullPage: true,
  });
  await page.goto(url + "/#agents");
  await page.getByRole("button", { name: /New agent/ }).click();
  await page.getByRole("button", { name: /Project coding partner/ }).click();
  await page
    .getByText("Conversation memory · Qwen3.8", { exact: true })
    .click();
  await page.screenshot({
    path: output + "/coding-agent-1600.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(url + "/#chat");
  await controls.waitFor();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.screenshot({
    path: output + "/chat-context-1366.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: persistence, supported combinations, queued snapshot, settings, coding-agent controls, narrow desktop, no console/server errors",
  );
} finally {
  await browser.close();
}
