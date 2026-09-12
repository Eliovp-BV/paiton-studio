// Browser regression fixtures only. Every API request is intercepted: no live
// Studio data, generation, containers, or GPU work is used by this test.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";

const base = process.env.STUDIO_TEST_URL || "http://127.0.0.1:8896";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const results = [];

function website(title, revision = 1) {
  return {
    title,
    theme: "light",
    revision,
    pages: [
      {
        slug: "index",
        title: "Home",
        description: "Isolated browser fixture",
        sections: [{ heading: title, body: "Fixture text", asset_ids: [] }],
      },
      {
        slug: "about",
        title: "About",
        description: "Browser fixture second page",
        sections: [
          { heading: "About", body: "More fixture text", asset_ids: [] },
        ],
      },
    ],
  };
}

async function checkDelayedResponse(operation) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors = [],
    unexpected = [],
    projectWrites = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const firstId = "a".repeat(32),
    secondId = "b".repeat(32);
  const runId = "c".repeat(32),
    now = Date.now() / 1000;
  const secondEditor = website("Second project editor must survive");
  const projects = [
    {
      id: firstId,
      name: "First browser fixture",
      revision: 0,
      updated: now,
      state: {
        buildMode: "website",
        websiteDraft: {
          brief: "First project fixture",
          editor: website("First project edited draft"),
          siteReady: false,
        },
      },
    },
    {
      id: secondId,
      name: "Second browser fixture",
      revision: 0,
      updated: now,
      state: {
        buildMode: "website",
        websiteDraft: {
          brief: "Second project fixture",
          editor: structuredClone(secondEditor),
          siteReady: false,
        },
      },
    },
  ];
  const sites = {
    [firstId]: website("First saved website"),
    [secondId]: website("Second saved website"),
  };
  const completedRun = {
    id: runId,
    project: firstId,
    created: now - 120,
    updated: now,
    state: "completed",
    result: website("First generated website"),
    jobs: [],
    job_details: [],
    progress: { completed: 1, total: 1 },
  };
  let releaseResponse, markPending;
  const responseGate = new Promise((resolve) => {
    releaseResponse = resolve;
  });
  const requestPending = new Promise((resolve) => {
    markPending = resolve;
  });
  let delayedRequests = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname,
      method = request.method();
    let data,
      status = 200;
    if (path.startsWith("/api/website-preview/")) {
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Browser fixture preview</title><p>Fixture preview only</p>",
      });
      return;
    }
    if (path === "/api/session") data = { token: "project-switch-fixture" };
    else if (path === "/api/settings")
      data = {
        defaults: {},
        appearance: { show_gpu_details: false },
        generation: { seed: 771 },
        storage: {},
      };
    else if (path === "/api/tools") data = [];
    else if (path === "/api/status")
      data = {
        jobs: [],
        gpu: {
          available: true,
          supported: true,
          used: 0,
          total: 32 * 1024 ** 3,
          name: "CPU browser fixture",
          message: "No real GPU work",
        },
        worker: { state: "idle" },
      };
    else if (path === "/api/projects") data = projects;
    else if (
      projects.some((project) => path === `/api/projects/${project.id}`)
    ) {
      const index = projects.findIndex(
        (project) => path === `/api/projects/${project.id}`,
      );
      if (method === "PUT") {
        const body = request.postDataJSON();
        projectWrites.push({ id: projects[index].id, body });
        projects[index] = {
          ...projects[index],
          ...body,
          revision: projects[index].revision + 1,
        };
      }
      data = { ...projects[index], assets: [] };
    } else if (
      path === `/api/website-runs/${runId}/apply` &&
      method === "POST" &&
      operation === "apply"
    ) {
      delayedRequests++;
      sites[firstId] = { ...completedRun.result, revision: 2 };
      completedRun.state = "applied";
      data = sites[firstId];
      markPending();
      await responseGate;
    } else if (
      projects.some((project) => path === `/api/projects/${project.id}/website`)
    ) {
      const id = projects.find(
        (project) => path === `/api/projects/${project.id}/website`,
      ).id;
      if (method === "PUT" && id === firstId && operation === "save") {
        delayedRequests++;
        sites[id] = { ...request.postDataJSON(), revision: 2 };
        data = sites[id];
        markPending();
        await responseGate;
      } else if (method === "GET")
        data = {
          site: sites[id],
          runs: id === firstId && operation === "apply" ? [completedRun] : [],
        };
      else {
        unexpected.push(method + " " + path);
        status = 400;
        data = { error: "Unexpected fixture mutation" };
      }
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
    await page
      .getByRole("heading", { name: "Create without limits." })
      .waitFor();
    await page.getByRole("button", { name: "Build Page", exact: true }).click();
    await page.getByRole("heading", { name: "Build your website" }).waitFor();
    await page
      .getByRole("button", {
        name:
          operation === "save"
            ? "Save website changes"
            : "Apply generated draft",
        exact: true,
      })
      .click();
    await requestPending;
    // Keep the first project's save/apply response pending while the user
    // browses to a different project's full website and existing draft.
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Project", exact: true })
      .selectOption(secondId);
    await page
      .getByRole("heading", { name: "Second browser fixture", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Build Page", exact: true }).click();
    await page.getByRole("heading", { name: "Build your website" }).waitFor();
    assert.equal(
      await page
        .getByRole("textbox", { name: "Site title", exact: true })
        .inputValue(),
      secondEditor.title,
    );
    const completedResponse = page.waitForResponse((response) => {
      const path = new URL(response.url()).pathname;
      return operation === "apply"
        ? path === `/api/website-runs/${runId}/apply`
        : path === `/api/projects/${firstId}/website` &&
            response.request().method() === "PUT";
    });
    releaseResponse();
    await completedResponse;
    // Let the rejected stale callback and any accidental autosave debounce
    // execute before verifying both visible and persisted project state.
    await page.waitForTimeout(750);
    assert.equal(
      await page
        .getByRole("textbox", { name: "Site title", exact: true })
        .inputValue(),
      secondEditor.title,
    );
    assert.deepEqual(projects[1].state.websiteDraft.editor, secondEditor);
    assert.equal(projects[1].state.websiteDraft.siteReady, false);
    assert.equal(
      projectWrites.filter((write) => write.id === secondId).length,
      0,
    );
    await page.reload();
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Home", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Create without limits." })
      .waitFor();
    await page.getByRole("button", { name: "Build Page", exact: true }).click();
    await page.getByRole("heading", { name: "Build your website" }).waitFor();
    assert.equal(
      await page
        .getByRole("textbox", { name: "Site title", exact: true })
        .inputValue(),
      secondEditor.title,
    );
    assert.equal(delayedRequests, 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    results.push({
      operation,
      passed: true,
      delayedRequests,
      secondProjectWrites: 0,
    });
  } finally {
    releaseResponse();
    await context.close();
  }
}

try {
  await checkDelayedResponse("save");
  await checkDelayedResponse("apply");
  fs.mkdirSync(".local", { recursive: true });
  fs.writeFileSync(
    ".local/progress-project-switch-browser.json",
    JSON.stringify(
      {
        passed: true,
        inference: "none; intercepted browser fixtures only",
        checks: results,
      },
      null,
      2,
    ),
  );
  console.log(
    "Pending website save/apply project-switch checks passed. No live APIs or GPU work.",
  );
} finally {
  await browser.close();
}
