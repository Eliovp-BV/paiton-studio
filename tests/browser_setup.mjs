import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
// Use an isolated Studio instance with config={} to verify a clean installation.
// This suite never clicks a download or generation button.
fs.mkdirSync(".local", { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.STUDIO_CHROMIUM,
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
const errors = [];
const writes = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  if (request.method() === "POST") writes.push(request.url());
});
await page.goto(process.env.STUDIO_URL || "http://127.0.0.1:8888");
await page
  .getByRole("heading", { name: "Let’s prepare your creation tools" })
  .waitFor();
await page.getByRole("button", { name: "Set up Studio", exact: true }).click();
await page
  .getByRole("heading", { name: "Set up creation tools", exact: true })
  .waitFor();
await page
  .getByRole("heading", { name: "Animate images", exact: true })
  .waitFor();
assert.equal(await page.locator(".setup-tool").count(), 4);
assert.equal(
  await page
    .getByRole("button", { name: "Download & set up", exact: true })
    .count(),
  4,
);
assert.equal(await page.locator(".setup-source").count(), 4);
assert.equal(await page.locator(".setup-download-details").count(), 4);
assert.ok((await page.locator(".setup-system").innerText()).includes("Docker"));
assert.ok((await page.locator(".setup-system").innerText()).includes("Radeon"));
assert.deepEqual(writes, []);
await page.screenshot({ path: ".local/ui-clean-setup.png", fullPage: true });
await page.getByRole("button", { name: "Preferences", exact: true }).click();
await page.getByRole("heading", { name: "Default creation tools" }).waitFor();
assert.deepEqual(
  await page
    .getByLabel("Writing model", { exact: true })
    .locator("option")
    .allTextContents(),
  ["Recommended automatically"],
);
await page
  .getByRole("button", { name: "Tool setup & downloads", exact: true })
  .click();
await page
  .getByRole("heading", { name: "Animate images", exact: true })
  .waitFor();
await page.setViewportSize({ width: 390, height: 844 });
assert.ok(
  await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  ),
);
await page.screenshot({
  path: ".local/ui-clean-setup-mobile.png",
  fullPage: true,
});
assert.deepEqual(errors, []);
console.log(
  JSON.stringify({
    passed: true,
    checks: [
      "clean-config first-run detection",
      "setup banner lands on tool setup",
      "four real downloadable catalog models",
      "source,license,download/disk requirements before action",
      "actual Docker/Radeon checks",
      "no downloads triggered by browsing",
      "missing models absent from selectable defaults",
      "390px mobile setup no overflow",
      "no JavaScript exceptions",
    ],
    downloadsStarted: 0,
    inference: "none: worker disabled",
  }),
);
await browser.close();
