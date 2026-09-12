// Explicit UI fixtures only. All API calls are intercepted; no inference,
// models, Docker, or live Studio state are touched.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
const base = process.env.STUDIO_TEST_URL || "http://127.0.0.1:8896";
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
  unexpected = [];
page.on("pageerror", (e) => errors.push(e.message));
let project = {
  id: "a".repeat(32),
  name: "Notification UI fixture",
  revision: 0,
  updated: Date.now() / 1000,
  state: {
    buildMode: "website",
    websiteDraft: {
      brief: "A manually simulated browser test, not inference.",
    },
  },
};
let runs = [],
  jobs = [],
  generationRequests = 0,
  applyRequests = 0;
const settings = {
  defaults: {},
  appearance: { show_gpu_details: false },
  generation: { seed: 771 },
  storage: {},
};
await page.route("**/api/**", async (route) => {
  const req = route.request(),
    path = new URL(req.url()).pathname,
    method = req.method();
  let data,
    status = 200;
  if (path === "/api/session") data = { token: "ui-fixture-token" };
  else if (path === "/api/settings") data = settings;
  else if (path === "/api/tools") data = [];
  else if (path === "/api/status")
    data = {
      jobs,
      gpu: {
        available: jobs.every((j) => j.state === "completed"),
        supported: true,
        name: "CPU UI fixture · no real GPU work",
        total: 32 * 1024 ** 3,
        used: 0,
        message: "UI fixture only",
      },
      worker: { state: "idle" },
    };
  else if (path === "/api/projects") data = [project];
  else if (path === "/api/projects/" + project.id) {
    if (method === "PUT") {
      const body = req.postDataJSON();
      project = { ...project, ...body, revision: project.revision + 1 };
    }
    data = { ...project, assets: [] };
  } else if (path === `/api/projects/${project.id}/website`)
    data = { site: null, runs };
  else if (path === `/api/projects/${project.id}/website/generate`) {
    generationRequests++;
    const id = (generationRequests === 1 ? "b" : "e").repeat(32);
    const created = Date.now() / 1000 - 133;
    const run = {
      id,
      project: project.id,
      state: "planning",
      created,
      updated: created,
      request: { page_count: 2, artwork_count: 1 },
      jobs: ["c".repeat(32)],
      job_details: [
        {
          id: "c".repeat(32),
          state: "loading",
          message: "Loading the creation tool.",
        },
      ],
      progress: { completed: 0, total: 2 },
      result: null,
    };
    runs = [run, ...runs];
    jobs = [
      {
        id: run.jobs[0],
        project: project.id,
        state: "loading",
        message: "Loading the creation tool.",
        created,
        updated: created + 1,
        request: { task: "write", website_run: id },
        progress: null,
      },
    ];
    data = run;
  } else if (path.includes("/apply")) {
    applyRequests++;
    status = 400;
    data = { error: "This test must not apply a draft automatically." };
  } else {
    unexpected.push(method + " " + path);
    status = 404;
    data = { error: "Unexpected fixture request" };
  }
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { Date: new Date().toUTCString() },
    body: JSON.stringify(data),
  });
});
try {
  await page.goto(base);
  await page.getByRole("heading", { name: "Create without limits." }).waitFor();
  await page.getByRole("button", { name: "Build Page", exact: true }).click();
  await page.getByRole("heading", { name: "Build your website" }).waitFor();
  await page
    .getByRole("button", { name: "Generate website", exact: true })
    .click();
  const accepted = page.getByRole("complementary", { name: "Website queued" });
  await accepted.waitFor();
  assert.match(await accepted.innerText(), /several minutes/);
  assert.match(await accepted.innerText(), /Keep browsing/);
  assert.match(await accepted.innerText(), /local/);
  await page.screenshot({
    path: ".local/progress-queued-fixture.png",
    fullPage: true,
  });
  await accepted.getByRole("button", { name: "Continue browsing" }).click();
  const progress = page.locator(".website-active-run progress");
  await progress.waitFor();
  assert.equal(await progress.getAttribute("value"), null);
  assert.match(
    await page.locator(".website-stage-heading").innerText(),
    /Loading model/,
  );
  await page.getByRole("button", { name: "Home", exact: true }).click();
  assert.match(
    await page.locator(".creation-status").innerText(),
    /Loading model/,
  );
  // Finishing the planning child cannot finish the whole design.
  runs[0] = {
    ...runs[0],
    state: "artwork",
    jobs: [runs[0].jobs[0], "d".repeat(32)],
    job_details: [
      { id: "c".repeat(32), state: "completed" },
      { id: "d".repeat(32), state: "loading" },
    ],
    progress: { completed: 1, total: 2 },
  };
  jobs = [
    { ...jobs[0], state: "completed" },
    {
      ...jobs[0],
      id: "d".repeat(32),
      state: "loading",
      request: { task: "image", website_run: runs[0].id },
    },
  ];
  await page.reload();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await page.getByRole("heading", { name: "Create without limits." }).waitFor();
  assert.equal(
    await page.getByRole("complementary", { name: "Design finished" }).count(),
    0,
  );
  await page.getByRole("button", { name: "Build Page", exact: true }).click();
  await page
    .getByText("1 of 2 creation tasks complete", { exact: false })
    .waitFor();
  await page.screenshot({
    path: ".local/progress-loading-fixture.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Home", exact: true }).click();
  const run = runs[0];
  run.state = "completed";
  run.updated = run.created + 133;
  run.progress = { completed: 2, total: 2 };
  run.job_details = run.job_details.map((j) => ({ ...j, state: "completed" }));
  run.result = {
    title: "Browser fixture design",
    pages: [
      { slug: "index", title: "Home", sections: [] },
      { slug: "about", title: "About", sections: [] },
    ],
  };
  jobs = jobs.map((j) => ({ ...j, state: "completed" }));
  const finished = page.getByRole("complementary", { name: "Design finished" });
  await finished.waitFor({ timeout: 10000 });
  await finished.getByText("2 min 13 sec", { exact: true }).waitFor();
  await finished.getByText("2 pages", { exact: true }).waitFor();
  await finished.getByText("About this timing", { exact: true }).click();
  assert.match(await finished.innerText(), /baseline has not been recorded/);
  assert.ok(!(await finished.innerText()).includes("minutes longer"));
  await page.screenshot({
    path: ".local/progress-finished-fixture.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.screenshot({
    path: ".local/progress-finished-mobile-fixture.png",
    fullPage: true,
  });
  await finished.getByRole("button", { name: "Review design" }).click();
  await page.getByRole("heading", { name: "Build your website" }).waitFor();
  await page.getByRole("button", { name: "Apply generated draft" }).waitFor();
  assert.equal(applyRequests, 0);
  await page.reload();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await page.getByRole("heading", { name: "Create without limits." }).waitFor();
  assert.equal(
    await page.getByRole("complementary", { name: "Design finished" }).count(),
    0,
  );
  assert.equal(generationRequests, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  fs.writeFileSync(
    ".local/progress-browser.json",
    JSON.stringify(
      {
        passed: true,
        inference: "none; API-intercepted UI fixtures",
        checks: [
          "accepted background message",
          "indeterminate loading",
          "all-route activity",
          "pending notification survives reload",
          "child completion is not design completion",
          "exact server elapsed duration",
          "no invented baseline",
          "mobile layout",
          "review without auto-apply",
          "acknowledged notification stays dismissed",
        ],
        errors,
        unexpected,
      },
      null,
      2,
    ),
  );
  console.log(
    "Website progress browser fixture checks passed. No real inference or live API requests.",
  );
} finally {
  await browser.close();
}
