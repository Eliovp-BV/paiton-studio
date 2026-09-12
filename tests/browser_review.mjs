// Verifies the real saved clip supplied through STUDIO_PROJECT; never generates.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
const base = process.env.STUDIO_URL || "http://127.0.0.1:8877";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
const errors = [],
  external = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (/^https?:/.test(r.url()) && !r.url().startsWith(base))
    external.push(r.url());
});
try {
  await page.goto(base);
  await page.getByRole("heading", { name: "Create without limits." }).waitFor();
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim(),
    ),
    "#cef793",
  );
  await page.screenshot({ path: ".local/review-home.png", fullPage: true });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "System & drivers", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Operating system & driver" })
    .waitFor();
  await page
    .getByRole("heading", { name: "Detected graphics devices" })
    .waitFor();
  await page.screenshot({ path: ".local/review-system.png", fullPage: true });
  await page.evaluate(
    (id) => localStorage.setItem("studio-project", id),
    process.env.STUDIO_PROJECT,
  );
  await page.reload();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await page.getByRole("heading", { name: "Create without limits." }).waitFor();
  await page
    .getByRole("button", { name: "Reels & shorts", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Reels & shorts", exact: true })
    .waitFor();
  await page.getByLabel("Delivery format").selectOption("portrait");
  await page
    .getByRole("combobox", { name: "Framing", exact: true })
    .selectOption("cover");
  await page.getByText(/retains about 31%/).waitFor();
  const frame = await page.locator(".delivery-frame").boundingBox();
  assert.ok(
    Math.abs(frame.width / frame.height - 9 / 16) < 0.01,
    "portrait preview has exact ratio",
  );
  await page.screenshot({
    path: ".local/review-delivery-crop.png",
    fullPage: true,
  });
  await page
    .getByRole("combobox", { name: "Framing", exact: true })
    .selectOption("contain");
  await page
    .getByRole("button", { name: "Create delivery copy", exact: true })
    .click();
  await page
    .getByText("Delivery copy saved in your project.", { exact: true })
    .first()
    .waitFor({ timeout: 90000 });
  const result = page.locator(".delivery-results article").first();
  const media = result.locator("video");
  await media.evaluate(
    (v) =>
      new Promise((resolve, reject) => {
        v.muted = true;
        const done = () => resolve();
        if (v.readyState >= 1) done();
        else {
          v.onloadedmetadata = done;
          v.onerror = () => reject(Error("MP4 failed to load"));
          v.load();
        }
      }),
  );
  const info = await media.evaluate((v) => ({
    width: v.videoWidth,
    height: v.videoHeight,
    duration: v.duration,
  }));
  assert.equal(info.width, 720);
  assert.equal(info.height, 1280);
  assert.ok(info.duration > 5 && info.duration < 6);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    result.getByRole("link", { name: "Download MP4" }).click(),
  ]);
  await download.saveAs(".local/review-browser-copy.mp4");
  await page.screenshot({ path: ".local/review-delivery.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "no mobile overflow",
  );
  await page.screenshot({
    path: ".local/review-delivery-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  // A second writer changes only a dedicated test project to exercise the UI conflict.
  const fixture = await page.evaluate(async () => {
    const token = (await (await fetch("/api/session")).json()).token;
    const p = await (
      await fetch("/api/projects", {
        method: "POST",
        headers: {
          "X-Studio-Token": token,
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).json();
    localStorage.setItem("studio-project", p.id);
    return p;
  });
  await page.reload();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await page.getByRole("heading", { name: "Create without limits." }).waitFor();
  await page.evaluate(async (id) => {
    const token = (await (await fetch("/api/session")).json()).token;
    const p = await (await fetch("/api/projects/" + id)).json();
    const r = await fetch("/api/projects/" + id, {
      method: "PUT",
      headers: { "X-Studio-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Other window saved",
        state: {},
        revision: p.revision,
      }),
    });
    if (!r.ok) throw Error("second window save failed");
  }, fixture.id);
  await page
    .getByRole("textbox", { name: "Project name" })
    .fill("My unsaved draft");
  await page
    .getByText("Another window saved this project.", { exact: true })
    .waitFor();
  const [draftDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download my draft" }).click(),
  ]);
  await draftDownload.saveAs(".local/review-conflict-draft.json");
  assert.equal(
    JSON.parse(fs.readFileSync(".local/review-conflict-draft.json")).name,
    "My unsaved draft",
  );
  await page.getByRole("button", { name: "Load saved version" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('input[aria-label="Project name"]').value ===
      "Other window saved",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  fs.writeFileSync(
    ".local/review-browser.json",
    JSON.stringify(
      {
        passed: true,
        media: info,
        errors,
        external,
        checks: [
          "ELIOVP accent",
          "system details",
          "exact portrait crop preview",
          "real CPU delivery",
          "playable download",
          "390px mobile layout",
          "two-window conflict and draft recovery",
        ],
      },
      null,
      2,
    ),
  );
  console.log("Review browser checks passed", info);
} finally {
  await browser.close();
}
