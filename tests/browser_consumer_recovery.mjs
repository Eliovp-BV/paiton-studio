// Intercepted consumer-flow regressions. Every API request is local fixture data:
// no live project writes, downloads, GPU jobs, or simulated inference claims.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const base = process.env.STUDIO_URL || "http://127.0.0.1:8897";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const ids = ["a", "b", "c"].map((letter) => letter.repeat(32));
const results = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(15);
  }
  throw Error(message);
}

function project(id, name) {
  return { id, name, revision: 0, state: {}, updated: Date.now() / 1000 };
}

async function fixture(name, run, { empty = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  // Speed up only the status polling interval, preserving autosave ordering.
  await page.addInitScript(() => {
    const timeout = window.setTimeout.bind(window);
    window.setTimeout = (fn, ms, ...args) =>
      timeout(fn, ms === 1800 ? 100 : ms, ...args);
  });
  const state = {
    projects: empty ? [] : ids.map((id, i) => project(id, `Project ${i + 1}`)),
    assets: new Map(),
    jobs: [],
    calls: new Map(),
    writes: [],
    enqueued: [],
    errors: [],
    unexpected: [],
    releases: [],
    intercept: null,
    count(method, path) {
      return this.calls.get(method + " " + path) || 0;
    },
    gate() {
      let release;
      const waiting = new Promise((resolve) => {
        release = resolve;
      });
      this.releases.push(release);
      return { waiting, release };
    },
  };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const key = method + " " + path;
    state.calls.set(key, state.count(method, path) + 1);
    let response = await state.intercept?.({ request, path, method, state });
    if (!response) {
      let body;
      if (path === "/api/session" && method === "GET")
        body = { token: "consumer-fixture" };
      else if (path === "/api/status" && method === "GET")
        body = {
          jobs: state.jobs,
          gpu: {
            available: true,
            supported: true,
            name: "CPU browser fixture",
            used: 0,
            total: 32 * 1024 ** 3,
            utilization_percent: 0,
          },
          worker: { state: "idle" },
        };
      else if (path === "/api/tools" && method === "GET")
        body = [
          {
            id: "flux",
            name: "Image fixture",
            model: "Image fixture",
            state: "ready",
            compatibility: { compatible: true },
            profiles: [
              {
                id: "image-standard",
                task: "image",
                roles: ["image"],
                label: "Image fixture",
                width: 1024,
                height: 1024,
              },
            ],
          },
        ];
      else if (path === "/api/settings" && method === "GET")
        body = {
          defaults: { image: "image-standard" },
          appearance: { show_gpu_details: false },
          generation: { seed: 771 },
          storage: {},
        };
      else if (path === "/api/host-guidance" && method === "GET")
        body = { needs_attention: false, checks: [] };
      else if (path === "/api/projects" && method === "GET")
        body = state.projects;
      else if (path === "/api/projects" && method === "POST") {
        const created = project("d".repeat(32), "New browser project");
        state.projects.push(created);
        body = created;
      } else {
        const matched = /^\/api\/projects\/([a-f0-9]{32})(\/jobs)?$/.exec(path);
        const found =
          matched && state.projects.find((item) => item.id === matched[1]);
        if (found && matched[2] && method === "POST") {
          const input = request.postDataJSON();
          state.enqueued.push(input);
          const job = {
            id: "e".repeat(32),
            project: found.id,
            request: input,
            state: "queued",
            message: "Browser queue fixture only",
            created: Date.now() / 1000,
            updated: Date.now() / 1000,
          };
          state.jobs.push(job);
          body = job;
        } else if (found && !matched[2] && ["GET", "PUT"].includes(method)) {
          if (method === "PUT") {
            const input = request.postDataJSON();
            assert.equal(
              input.revision,
              found.revision,
              "The save must use the latest project revision",
            );
            state.writes.push({ id: found.id, input });
            Object.assign(found, input, { revision: found.revision + 1 });
          }
          body = { ...found, assets: state.assets.get(found.id) || [] };
        } else if (
          /^\/api\/assets\/[a-f0-9]{32}(\/thumbnail)?$/.test(path) &&
          method === "GET"
        ) {
          await route.fulfill({
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><title>CPU browser fixture</title><rect width="64" height="32" fill="#dfb76b"/></svg>',
          });
          return;
        } else {
          state.unexpected.push(key);
          response = {
            status: 404,
            body: { error: "Unexpected browser fixture route" },
          };
        }
      }
      response ||= { body };
    }
    await route.fulfill({
      status: response.status || 200,
      contentType: "application/json",
      body: JSON.stringify(response.body),
    });
  });
  try {
    await run(page, state);
    assert.deepEqual(state.errors, [], `${name}: frontend exceptions`);
    assert.deepEqual(state.unexpected, [], `${name}: unexpected API calls`);
    results.push(name);
    console.log(`Passed: ${name}`);
  } finally {
    state.releases.forEach((release) => release());
    await page.unrouteAll({ behavior: "wait" });
    await context.close();
  }
}

try {
  await fixture(
    "Startup failure offers a working retry",
    async (page, state) => {
      state.intercept = ({ path, method }) =>
        path === "/api/projects" &&
        method === "GET" &&
        state.count(method, path) === 1
          ? {
              status: 503,
              body: { error: "The Studio host is restarting. Retry shortly." },
            }
          : undefined;
      await page.goto(base + "/#home");
      await page
        .getByRole("button", { name: "Retry connection", exact: true })
        .click();
      await page.locator('main[data-studio-page="home"]').waitFor();
      assert.equal(state.count("GET", "/api/projects"), 2);
      assert.equal(state.count("GET", `/api/projects/${ids[0]}`), 1);
    },
  );

  await fixture(
    "Initial project list and selected project load once",
    async (page, state) => {
      await page.goto(base + "/#home");
      await page.locator('main[data-studio-page="home"]').waitFor();
      await until(
        () => state.count("GET", "/api/status") >= 3,
        "Status polling did not start",
      );
      assert.equal(state.count("GET", "/api/projects"), 1);
      assert.equal(state.count("GET", `/api/projects/${ids[0]}`), 1);
    },
  );

  await fixture(
    "Double generate submits once and a failed status poll preserves confirmation",
    async (page, state) => {
      const gate = state.gate();
      let failStatus = false;
      state.intercept = async ({ path, method }) => {
        if (path.endsWith("/jobs") && method === "POST") await gate.waiting;
        if (path === "/api/status" && failStatus)
          return {
            status: 503,
            body: { error: "Temporary status outage fixture" },
          };
      };
      await page.goto(base + "/#image");
      await page
        .getByLabel("Describe your image", { exact: true })
        .fill("A mountain cabin — browser fixture only");
      await page
        .getByRole("button", { name: "Generate image", exact: true })
        .evaluate((button) => {
          button.click();
          button.click();
        });
      await until(
        () => state.count("POST", `/api/projects/${ids[0]}/jobs`) === 1,
        "The request was not submitted",
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Adding to queue…", exact: true })
          .isDisabled(),
        true,
      );
      failStatus = true;
      gate.release();
      await page
        .getByText("Request saved in the queue. You can keep editing.", {
          exact: true,
        })
        .waitFor();
      await page
        .getByText("Reconnecting to your Studio", { exact: true })
        .waitFor();
      assert.equal(await page.locator(".queue-panel .queue-job").count(), 1);
      assert.equal(state.enqueued.length, 1);
      assert.equal(
        state.enqueued[0].prompt,
        "A mountain cabin — browser fixture only",
      );
      assert.equal(state.count("POST", `/api/projects/${ids[0]}/jobs`), 1);
    },
  );

  await fixture(
    "Rapid project switches keep the latest choice",
    async (page, state) => {
      const gate = state.gate();
      state.intercept = async ({ path, method }) => {
        if (method === "GET" && path === `/api/projects/${ids[1]}`)
          await gate.waiting;
      };
      await page.goto(base + "/#projects");
      await page
        .getByRole("combobox", { name: "Project", exact: true })
        .selectOption(ids[1]);
      await until(
        () => state.count("GET", `/api/projects/${ids[1]}`) === 1,
        "Second project request did not start",
      );
      await page
        .getByRole("combobox", { name: "Project", exact: true })
        .selectOption(ids[2]);
      await page
        .getByRole("heading", { name: "Project 3", exact: true })
        .waitFor();
      const response = page.waitForResponse(
        (item) => new URL(item.url()).pathname === `/api/projects/${ids[1]}`,
      );
      gate.release();
      await response;
      await pause(100);
      assert.equal(
        await page
          .getByRole("combobox", { name: "Project", exact: true })
          .inputValue(),
        ids[2],
      );
      assert.equal(
        await page.getByLabel("Project name", { exact: true }).inputValue(),
        "Project 3",
      );
      assert.equal(
        await page.evaluate(() => localStorage.getItem("studio-project")),
        ids[2],
      );
      assert.equal(state.writes.length, 0);
    },
  );

  await fixture(
    "Edits during a slow project switch save to the outgoing project",
    async (page, state) => {
      const gate = state.gate();
      state.intercept = async ({ path, method }) => {
        if (method === "GET" && path === `/api/projects/${ids[1]}`)
          await gate.waiting;
      };
      await page.goto(base + "/#projects");
      await page
        .getByRole("combobox", { name: "Project", exact: true })
        .selectOption(ids[1]);
      await until(
        () => state.count("GET", `/api/projects/${ids[1]}`) === 1,
        "Delayed project fetch did not start",
      );
      const name = "Edited while another project opens";
      await page.getByLabel("Project name", { exact: true }).fill(name);
      gate.release();
      await page
        .getByRole("heading", { name: "Project 2", exact: true })
        .waitFor();
      assert.equal(state.projects[0].name, name);
      assert.equal(
        state.writes.filter((write) => write.id === ids[0]).length,
        1,
      );
      assert.equal(
        state.writes.filter((write) => write.id === ids[1]).length,
        0,
      );
      await page
        .getByRole("combobox", { name: "Project", exact: true })
        .selectOption(ids[0]);
      await page.getByRole("heading", { name, exact: true }).waitFor();
    },
  );

  await fixture(
    "An empty workspace opens an image deep link with one project creation",
    async (page, state) => {
      await page.goto(base + "/#image");
      await page
        .getByLabel("Describe your image", { exact: true })
        .fill("The first idea in a new workspace");
      assert.equal(state.count("POST", "/api/projects"), 1);
      assert.equal(state.projects.length, 1);
      await until(
        () => state.writes.length === 1,
        "The first project draft was not saved",
      );
      assert.equal(
        state.projects[0].state.image.prompt,
        "The first idea in a new workspace",
      );
      assert.equal(state.count("POST", "/api/projects"), 1);
    },
    { empty: true },
  );

  await fixture(
    "Double New project creates and opens only one project",
    async (page, state) => {
      const gate = state.gate();
      state.intercept = async ({ path, method }) => {
        if (path === "/api/projects" && method === "POST") await gate.waiting;
      };
      await page.goto(base + "/#projects");
      await page
        .getByRole("button", { name: "New project", exact: true })
        .evaluate((button) => {
          button.click();
          button.click();
        });
      await until(
        () => state.count("POST", "/api/projects") >= 1,
        "Project creation did not start",
      );
      assert.equal(state.count("POST", "/api/projects"), 1);
      gate.release();
      await page.getByLabel("Describe your image", { exact: true }).waitFor();
      assert.equal(state.projects.length, 4);
      assert.equal(state.count("POST", "/api/projects"), 1);
      assert.equal(state.count("GET", `/api/projects/${"d".repeat(32)}`), 1);
      assert.equal(
        await page.getByLabel("Project name", { exact: true }).inputValue(),
        "New browser project",
      );
    },
  );

  await fixture(
    "Completed assets retry after a failed refresh",
    async (page, state) => {
      let failAssetReads = 0;
      state.intercept = ({ path, method }) => {
        if (
          path === `/api/projects/${ids[0]}` &&
          method === "GET" &&
          failAssetReads > 0
        ) {
          failAssetReads--;
          return {
            status: 503,
            body: { error: "Temporary asset refresh outage fixture" },
          };
        }
      };
      await page.goto(base + "/#image");
      await page.getByLabel("Describe your image", { exact: true }).waitFor();
      const asset = {
        id: "f".repeat(32),
        project: ids[0],
        kind: "image",
        name: "Recovered preview fixture",
        metadata: { width: 64, height: 32 },
        created: Date.now() / 1000,
      };
      state.assets.set(ids[0], [asset]);
      failAssetReads = 1;
      state.jobs = [
        {
          id: "e".repeat(32),
          project: ids[0],
          state: "completed",
          asset: asset.id,
          message: "Browser fixture completed",
          request: { task: "image", prompt: "Fixture only", profile: {} },
          created: Date.now() / 1000 - 10,
          updated: Date.now() / 1000,
        },
      ];
      await page
        .getByRole("button", {
          name: "Preview Recovered preview fixture",
          exact: true,
        })
        .waitFor();
      assert.equal(failAssetReads, 0);
      assert.ok(
        state.count("GET", `/api/projects/${ids[0]}`) >= 3,
        "The failed completion refresh was not retried",
      );
      await page.waitForFunction(() =>
        [
          ...document.querySelectorAll('img[alt="Recovered preview fixture"]'),
        ].some((image) => image.complete && image.naturalWidth > 0),
      );
      assert.equal(state.enqueued.length, 0);
    },
  );
  console.log(
    `Consumer recovery browser checks passed: ${results.length}. All APIs intercepted; no GPU work.`,
  );
} finally {
  await browser.close();
}
