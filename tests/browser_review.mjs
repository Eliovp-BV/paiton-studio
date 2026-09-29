// Synthetic delivery UI fixtures and real isolated project conflict handling; no encode or inference.
import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
const base = process.env.STUDIO_URL;
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
  await page
    .getByRole("heading", { name: "Create without the cloud." })
    .waitFor();
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim(),
    ),
    "#f1c66d",
  );
  await page.screenshot({ path: ".local/review-home.png", fullPage: true });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .locator("main .settings-tabs")
    .getByRole("button", { name: "System & drivers", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Operating system & driver" })
    .waitFor();
  await page
    .getByRole("heading", { name: "Detected graphics devices" })
    .waitFor();
  await page.screenshot({ path: ".local/review-system.png", fullPage: true });
  const projectResponse = await page.request.get(
    base + "/api/projects/" + process.env.STUDIO_PROJECT,
  );
  const deliveryProject = await projectResponse.json();
  const sourceId = "synthetic-delivery-source";
  deliveryProject.assets.push({
    id: sourceId,
    kind: "video",
    name: "Synthetic landscape clip",
    metadata: { width: 1024, height: 576, duration: 5.5 },
  });
  let deliveryJobs = [];
  const deliveryRequests = [];
  await page.route("**/api/projects/" + deliveryProject.id, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: deliveryProject });
  });
  await page.route("**/api/assets/" + sourceId, (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route(
    "**/api/projects/" + deliveryProject.id + "/renditions",
    (route) => {
      if (route.request().method() === "POST") {
        const request = route.request().postDataJSON();
        deliveryRequests.push(request);
        deliveryJobs = [
          {
            id: "fixture-rendition",
            state: "queued",
            request: { ...request, source_name: "Synthetic landscape clip" },
            message: "CPU encode queued — browser fixture",
            asset: null,
          },
        ];
        return route.fulfill({ json: deliveryJobs[0] });
      }
      return route.fulfill({ json: deliveryJobs });
    },
  );
  await page.route("**/api/renditions/fixture-rendition/cancel", (route) => {
    deliveryJobs[0] = {
      ...deliveryJobs[0],
      state: "cancelled",
      message: "Cancelled browser fixture",
    };
    return route.fulfill({ json: deliveryJobs[0] });
  });
  await page.evaluate(
    (id) => localStorage.setItem("studio-project", id),
    process.env.STUDIO_PROJECT,
  );
  await page.reload();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Create without the cloud." })
    .waitFor();
  await page.evaluate(() => {
    location.hash = "delivery";
  });
  await page
    .getByRole("heading", { name: "Reels & shorts", exact: true })
    .waitFor();
  await page.getByLabel("Delivery format").selectOption("portrait");
  await page
    .getByRole("combobox", { name: "Framing", exact: true })
    .selectOption("cover");
  await page.getByText(/retains about 32%/).waitFor();
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
  const result = page.locator(".delivery-results article").first();
  await result
    .getByText("CPU encode queued — browser fixture", { exact: true })
    .waitFor();
  assert.deepEqual(deliveryRequests, [
    {
      source_id: sourceId,
      preset: "portrait",
      fit: "contain",
      focal_x: 0.5,
      audio: "preserve",
    },
  ]);
  await result
    .getByRole("button", { name: "Cancel copy", exact: true })
    .click();
  await result
    .getByText("Cancelled browser fixture", { exact: true })
    .waitFor();
  assert.equal(
    await result
      .getByRole("button", { name: "Cancel copy", exact: true })
      .count(),
    0,
  );
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
  await page
    .getByRole("heading", { name: "Create without the cloud." })
    .waitFor();
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
        deliveryRequests,
        errors,
        external,
        checks: [
          "theme accent",
          "system details",
          "exact portrait crop preview",
          "synthetic CPU delivery queue and cancel controls",
          "390px mobile layout",
          "two-window conflict and draft recovery",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "Review browser checks passed: delivery framing, queued/cancelled fixture, responsive layout and saved-project conflict recovery; no encoding or inference.",
  );
} finally {
  await browser.close();
}
