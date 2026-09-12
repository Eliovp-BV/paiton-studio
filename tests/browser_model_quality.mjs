// Intercepted UI fixtures only. No inference, live Studio data or model setup.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";

const base = process.env.STUDIO_TEST_URL || "http://127.0.0.1:8897";
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
  unexpected = [],
  settingsWrites = [];
page.on("pageerror", (error) => errors.push(error.message));

const packageNote =
  "Smaller model for short first drafts. Review facts carefully; a larger writing model is better suited to detailed work.";
const profileNote = "Writing profile note from this isolated browser fixture.";
const inactiveNote =
  "Unqualified fixture must never be offered for generation.";
const tools = [
  {
    id: "larger-fixture",
    name: "Writing & website fixture",
    model: "Larger fixture model",
    state: "ready",
    compatibility: { compatible: true },
    profiles: [
      {
        id: "larger-writing",
        label: "Detailed draft",
        task: "write",
        roles: ["write"],
        quality_note: profileNote,
      },
      {
        id: "larger-website",
        label: "Website plan",
        task: "write",
        roles: ["website"],
      },
    ],
  },
  {
    id: "short-fixture",
    name: "Short writing fixture",
    model: "Small fixture model",
    state: "ready",
    compatibility: { compatible: true },
    quality_note: packageNote,
    profiles: [
      {
        id: "short-writing",
        label: "Short first draft",
        task: "write",
        roles: ["write"],
      },
    ],
  },
  {
    id: "inactive-fixture",
    name: "Unqualified fixture",
    model: "Inactive fixture model",
    integrated: false,
    state: "unsupported",
    compatibility: { compatible: true },
    quality_note: inactiveNote,
    profiles: [
      {
        id: "inactive-writing",
        label: "Unqualified short draft",
        task: "write",
        roles: ["write"],
      },
    ],
  },
];
const settings = {
  defaults: { write: "larger-writing", website: "larger-website" },
  appearance: { show_gpu_details: false },
  generation: { seed: 771 },
  storage: {},
};
let project = {
  id: "a".repeat(32),
  name: "Model quality browser fixture",
  revision: 0,
  updated: Date.now() / 1000,
  state: { buildMode: "website" },
};
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const method = request.method();
  let data,
    status = 200;
  if (path === "/api/session") data = { token: "quality-note-fixture" };
  else if (path === "/api/host-guidance" && method === "GET")
    data = { needs_attention: false, checks: [] };
  else if (path === "/api/settings" && method === "GET") data = settings;
  else if (path === "/api/settings" && method === "PUT") {
    settingsWrites.push(request.postDataJSON());
    data = settings;
  } else if (path === "/api/tools") data = tools;
  else if (path === "/api/status")
    data = {
      jobs: [],
      gpu: {
        available: true,
        supported: true,
        used: 0,
        total: 32 * 1024 ** 3,
        name: "CPU browser fixture",
        message: "No GPU work",
      },
      worker: { state: "idle" },
    };
  else if (path === "/api/projects") data = [project];
  else if (path === `/api/projects/${project.id}`) {
    if (method === "PUT")
      project = {
        ...project,
        ...request.postDataJSON(),
        revision: project.revision + 1,
      };
    data = { ...project, assets: [] };
  } else if (path === `/api/projects/${project.id}/website`)
    data = { site: null, runs: [] };
  else {
    unexpected.push(`${method} ${path}`);
    status = 404;
    data = { error: "Unexpected fixture request" };
  }
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(data),
  });
});

async function optionValues(select) {
  return select
    .locator("option")
    .evaluateAll((options) => options.map((option) => option.value));
}

async function describedNote(select, expected) {
  const id = await select.getAttribute("aria-describedby");
  assert.ok(id, "The quality note must describe its associated model select");
  const text = await page.evaluate(
    (identity) => document.getElementById(identity)?.textContent,
    id,
  );
  assert.ok(text?.includes(expected));
}

try {
  await page.goto(base);
  await page
    .getByRole("heading", { name: "Create without the cloud." })
    .waitFor();
  await page.getByRole("button", { name: "Write", exact: true }).click();
  const writing = page.getByRole("combobox", {
    name: "Writing model",
    exact: true,
  });
  await writing.waitFor();
  assert.equal(await writing.inputValue(), "auto");
  await describedNote(writing, profileNote);
  assert.deepEqual(await optionValues(writing), [
    "auto",
    "larger-writing",
    "short-writing",
  ]);
  await writing.selectOption("short-writing");
  await describedNote(writing, packageNote);
  assert.equal(await page.getByText(inactiveNote, { exact: true }).count(), 0);
  await writing.selectOption("auto");
  await describedNote(writing, profileNote);
  assert.equal(await page.getByText(packageNote, { exact: true }).count(), 0);

  await page.getByRole("button", { name: "Build Page", exact: true }).click();
  await page.getByRole("heading", { name: "Build your website" }).waitFor();
  await page.getByText("Tools & appearance", { exact: true }).click();
  const website = page.getByRole("combobox", {
    name: "Website writing model",
    exact: true,
  });
  assert.deepEqual(await optionValues(website), ["auto", "larger-website"]);
  assert.equal(await website.getAttribute("aria-describedby"), null);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("heading", { name: "Make Studio yours.", exact: true })
    .waitFor();
  const defaultWriting = page.getByRole("combobox", {
    name: "Writing model",
    exact: true,
  });
  assert.equal(await defaultWriting.inputValue(), "larger-writing");
  await describedNote(defaultWriting, profileNote);
  await defaultWriting.selectOption("short-writing");
  await describedNote(defaultWriting, packageNote);
  assert.deepEqual(
    await optionValues(
      page.getByRole("combobox", {
        name: "Website planning & writing model",
        exact: true,
      }),
    ),
    ["auto", "larger-website"],
  );
  assert.deepEqual(
    await optionValues(
      page.getByRole("combobox", { name: "Video creation model", exact: true }),
    ),
    ["auto"],
  );
  assert.deepEqual(
    settingsWrites,
    [],
    "Inspecting or selecting a note must not save preferences automatically",
  );
  assert.deepEqual(settings.defaults, {
    write: "larger-writing",
    website: "larger-website",
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  fs.mkdirSync(".local", { recursive: true });
  fs.writeFileSync(
    ".local/model-quality-browser.json",
    JSON.stringify(
      {
        passed: true,
        scope:
          "Intercepted browser fixtures; no live APIs, inference or model qualification",
        checks: [
          "Profile note describes the automatic effective writing choice",
          "Explicit writing selection falls back to package quality note",
          "Returning to automatic restores the default profile note",
          "Unqualified profile is unavailable",
          "Write-only choices stay absent from website and video selectors",
          "Settings shows notes without changing or automatically saving defaults",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "Model quality notes and role-filtered selectors passed. No live APIs or GPU work.",
  );
} finally {
  await context.close();
  await browser.close();
}
