// Real read-only API on an isolated Studio; no downloads of models or inference.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const base = process.env.STUDIO_TEST_URL || "http://127.0.0.1:8897";
assert.notEqual(new URL(base).port, "8877");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [],
  writes = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (r.url().includes("/api/") && r.method() !== "GET") writes.push(r.url());
});
try {
  await page.goto(base + "/#home");
  await page
    .getByRole("button", { name: "System details", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "What can you create here?" })
    .waitFor();
  await page.locator(".readiness-capability").first().waitFor();
  assert.equal(await page.locator(".readiness-capability").count(), 7);
  await page
    .locator(".readiness-model")
    .filter({ hasText: "MiniCPM5" })
    .locator("summary")
    .click();
  await page.getByText(/4.8 GiB sampled driver peak/).waitFor();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save compatibility report" }).click();
  const saved = await download;
  assert.equal(saved.suggestedFilename(), "paiton-compatibility-report.json");
  const report = JSON.parse(await fs.readFile(await saved.path(), "utf8"));
  assert.equal(report.schema_version, 1);
  assert.ok(report.device.name);
  assert.ok(
    report.models.find((m) => m.id === "minicpm5-2b").hardware.checks.length >=
      5,
  );
  assert.equal("projects" in report, false);
  await page.screenshot({
    path: ".local/readiness-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.screenshot({
    path: ".local/readiness-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, []);
  console.log(
    "Readiness passed: seven capabilities, per-model qualification, safe report download, narrow layout, no mutations or inference.",
  );
} finally {
  await browser.close();
}
