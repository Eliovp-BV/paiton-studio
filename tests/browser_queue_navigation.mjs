// Every API request is intercepted. These navigation checks never submit inference.
import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [],
  unexpected = [],
  retried = [],
  inboxReads = [];
page.on("pageerror", (error) => errors.push(error.message));
const now = Date.now() / 1000;
const projects = ["a", "b"].map((key) => ({
  id: key.repeat(32),
  name: `Queue project ${key.toUpperCase()}`,
  revision: 0,
  updated: now,
  state: { selected: `${key}-old` },
}));
const assets = projects.flatMap((project) =>
  ["old", "result"].map((kind) => ({
    id: `${project.id[0]}-${kind}`,
    project: project.id,
    kind: "image",
    name: `${project.name} ${kind}`,
    created: now,
    favorite: false,
    metadata: { origin: "imported", width: 1, height: 1, source_ids: [] },
  })),
);
const profile = {
  id: "chat-fixture",
  model: "CPU fixture",
  roles: ["chat", "code"],
  task: "write",
};
const jobs = [
  {
    id: "a-image",
    project: projects[0].id,
    asset: "a-result",
    state: "completed",
    message: "Image result in project A",
    request: { task: "image", profile },
  },
  {
    id: "b-image",
    project: projects[1].id,
    asset: "b-result",
    state: "completed",
    message: "Image result in project B",
    request: { task: "image", profile },
  },
  {
    id: "failed-chat",
    project: projects[1].id,
    state: "failed",
    message: "Failed conversation in project B",
    request: { task: "write", chat_id: "b-target", profile },
  },
  {
    id: "cancelled-chat",
    project: projects[0].id,
    state: "cancelled",
    message: "Cancelled conversation in project A",
    request: { task: "write", chat_id: "a-target", profile },
  },
  {
    id: "completed-chat",
    project: projects[1].id,
    asset: "b-answer",
    state: "completed",
    message: "Completed conversation in project B",
    request: { task: "write", chat_id: "b-target", profile },
  },
  {
    id: "failed-image",
    project: projects[0].id,
    state: "failed",
    message: "Independent failed image",
    request: { task: "image", profile },
  },
].map((job) => ({ ...job, created: now, updated: now }));
// This terminal request is deliberately outside the bounded /status jobs list.
const olderJob = {
  id: "7".repeat(32),
  project: projects[1].id,
  state: "failed",
  message: "Older recording needs review outside recent queue history",
  request: { task: "meeting", profile },
  created: now - 86400,
  updated: now - 86000,
};
const inboxEvent = {
  id: `job:${olderJob.id}:${"8".repeat(16)}`,
  kind: "job",
  state: "failed",
  title: "Recording failed",
  summary: "Open the older recording outcome.",
  project_id: olderJob.project,
  project_name: projects[1].name,
  updated: olderJob.updated,
  read: false,
  target: { kind: "job", job_id: olderJob.id, project_id: olderJob.project },
};
assets.push({
  id: "b-answer",
  project: projects[1].id,
  kind: "text",
  name: "Saved conversation answer",
  created: now,
  metadata: { origin: "generated" },
});
const chats = projects.flatMap((project) =>
  ["latest", "target"].map((suffix) => {
    const id = `${project.id[0]}-${suffix}`;
    return {
      id,
      project: project.id,
      title: `${project.name} ${suffix} conversation`,
      turns: jobs
        .filter((job) => job.request.chat_id === id)
        .map((job) => ({
          id: `${job.id}-turn`,
          prompt: `${job.message} prompt`,
          mode: "chat",
          documents: [],
          job,
          answer: job.state === "completed" ? "The exact saved answer." : null,
          asset: job.asset
            ? assets.find((asset) => asset.id === job.asset)
            : null,
        })),
    };
  }),
);
const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/S9sAAAAASUVORK5CYII=",
  "base64",
);
let heldProject = null;
await page.route("**/api/**", async (route) => {
  const request = route.request(),
    path = new URL(request.url()).pathname;
  const project = projects.find((item) => path === `/api/projects/${item.id}`);
  let data;
  if (path.startsWith("/api/assets/")) {
    await route.fulfill({ contentType: "image/png", body: imageBytes });
    return;
  }
  if (path === "/api/session") data = { token: "queue-fixture" };
  else if (path === "/api/inbox")
    data = {
      events: [inboxEvent],
      unread: inboxEvent.read ? 0 : 1,
      has_more: false,
      limit: 100,
      project_id: null,
    };
  else if (path === "/api/inbox/read") {
    inboxReads.push(request.postDataJSON().event_ids);
    inboxEvent.read = true;
    data = { read_ids: [inboxEvent.id], unavailable_ids: [] };
  } else if (path === `/api/projects/${olderJob.project}/jobs/${olderJob.id}`)
    data = olderJob;
  else if (path === "/api/meetings/readiness") data = { ready: false };
  else if (path === "/api/host-guidance")
    data = { needs_attention: false, checks: [] };
  else if (path === "/api/settings")
    data = {
      defaults: {},
      appearance: {},
      generation: { seed: 771 },
      storage: {},
    };
  else if (path === "/api/tools")
    data = [
      {
        id: "chat-fixture",
        name: "Chat fixture",
        model: "CPU fixture",
        state: "ready",
        compatibility: { compatible: true },
        profiles: [profile],
      },
    ];
  else if (path === "/api/status")
    data = {
      jobs,
      gpu: { available: false, message: "CPU-only fixture" },
      worker: { state: "idle" },
    };
  else if (path === "/api/projects") data = projects;
  else if (project) {
    if (request.method() === "PUT") {
      Object.assign(project, request.postDataJSON());
      project.revision++;
    } else if (heldProject?.id === project.id) {
      heldProject.arrived();
      await heldProject.release;
    }
    data = {
      ...project,
      assets: assets.filter((asset) => asset.project === project.id),
    };
  } else if (path.endsWith("/website")) data = { site: null, runs: [] };
  else if (path.endsWith("/brief") && path.startsWith("/api/projects/"))
    data = {
      project: path.split("/")[3],
      content: "",
      revision: 0,
      updated: null,
    };
  else if (path.endsWith("/chats") && path.startsWith("/api/projects/"))
    data = chats.filter(
      (chat) => path === `/api/projects/${chat.project}/chats`,
    );
  else if (path.startsWith("/api/chats/"))
    data = chats.find((chat) => path === `/api/chats/${chat.id}`);
  else if (path === "/api/chat-presence") data = { ok: true };
  else if (path === "/api/jobs/failed-image/retry") {
    retried.push("failed-image");
    data = {};
  } else {
    unexpected.push(`${request.method()} ${path}`);
    data = { error: "Unexpected fixture request" };
  }
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(data),
  });
});
const queue = page.getByRole("complementary", { name: "Activity" });
const row = (message) =>
  queue.locator(".queue-job").filter({ hasText: message });
async function openQueue() {
  if (!(await queue.isVisible()))
    await page.getByRole("button", { name: "Activity", exact: true }).click();
}
async function result(message) {
  await openQueue();
  await row(message)
    .getByRole("button", { name: "View result", exact: true })
    .click();
}
async function selectedAsset(name) {
  await page
    .locator(`.project-overview .feature-media img[alt="${name}"]`)
    .waitFor();
  assert.equal(
    await page.locator("main").getAttribute("data-studio-page"),
    "projects",
  );
}
async function selectedChat(title) {
  await page
    .locator('.gpt-chat-list button[aria-current="true"]')
    .filter({ hasText: title })
    .waitFor();
  assert.equal(
    await page.locator("main").getAttribute("data-studio-page"),
    "chat",
  );
}
try {
  await page.goto(
    (process.env.STUDIO_TEST_URL || "http://127.0.0.1:8897") + "/#projects",
  );
  await page.getByLabel("Project name").waitFor();
  assert.deepEqual(
    await page
      .locator(".navigation-parent > .nav")
      .evaluateAll((items) =>
        items.map((item) => item.getAttribute("aria-label")),
      ),
    ["Home", "Chat", "Create", "Projects", "Models", "Connect", "Settings"],
  );
  assert.equal(
    await page.getByRole("button", { name: "Activity", exact: true }).count(),
    1,
  );
  assert.equal(
    await page.getByRole("button", { name: /Completion inbox/ }).count(),
    0,
  );
  assert.equal(await page.locator(".hardware").count(), 1);
  assert.equal(await page.locator(".machine-status").count(), 0);
  await openQueue();
  await page.keyboard.press("Escape");
  await queue.waitFor({ state: "hidden" });
  assert.ok(
    await page
      .getByRole("button", { name: "Activity", exact: true })
      .evaluate((element) => element === document.activeElement),
  );
  await result("Image result in project A");
  await selectedAsset("Queue project A result");
  await result("Image result in project B");
  await selectedAsset("Queue project B result");

  await openQueue();
  for (const message of [
    "Failed conversation in project B",
    "Cancelled conversation in project A",
  ])
    assert.equal(
      await row(message)
        .getByRole("button", { name: "Retry same request" })
        .count(),
      0,
    );
  await row("Failed conversation in project B")
    .getByRole("button", { name: "Open conversation" })
    .click();
  await selectedChat("Queue project B target conversation");
  await page
    .getByText("Failed conversation in project B prompt", { exact: true })
    .waitFor();
  await openQueue();
  await row("Cancelled conversation in project A")
    .getByRole("button", { name: "Open conversation" })
    .click();
  await selectedChat("Queue project A target conversation");
  await result("Completed conversation in project B");
  await selectedChat("Queue project B target conversation");
  await page.getByText("The exact saved answer.", { exact: true }).waitFor();

  // Queue navigation also targets the right conversation while Chat is already open.
  await page
    .getByRole("button", {
      name: "Queue project B latest conversation",
      exact: true,
    })
    .click();
  await selectedChat("Queue project B latest conversation");
  await openQueue();
  await row("Failed conversation in project B")
    .getByRole("button", { name: "Open conversation" })
    .click();
  await selectedChat("Queue project B target conversation");

  await openQueue();
  await row("Independent failed image")
    .getByRole("button", { name: "Retry same request" })
    .click();
  assert.deepEqual(retried, ["failed-image"]);
  await result("Image result in project A");
  await selectedAsset("Queue project A result");

  // A slow old queue navigation must not overwrite a newer destination.
  let arrive, release;
  const arrived = new Promise((resolve) => {
    arrive = resolve;
  });
  heldProject = {
    id: projects[1].id,
    arrived: arrive,
    release: new Promise((resolve) => {
      release = resolve;
    }),
  };
  await openQueue();
  await row("Image result in project B")
    .getByRole("button", { name: "View result" })
    .click();
  await arrived;
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Home", exact: true })
    .click();
  const response = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/projects/${projects[1].id}`,
  );
  release();
  await response;
  await page.waitForTimeout(100);
  assert.equal(
    await page.locator("main").getAttribute("data-studio-page"),
    "home",
  );
  assert.equal(
    await page.getByLabel("Project name").inputValue(),
    "Queue project A",
  );
  heldProject = null;
  // Opening an inbox outcome keeps the exact fetched task even when the status
  // window never includes it. The task is focused and clearly marked.
  await openQueue();
  await page
    .locator(".activity-tabs")
    .getByRole("button", { name: /^Completed/ })
    .click();
  await page
    .getByRole("region", { name: "Completion inbox", exact: true })
    .getByRole("button", {
      name: /Recording failed Open the older recording outcome/,
    })
    .click();
  const older = queue.locator(`[data-job-id="${olderJob.id}"]`);
  await older.waitFor();
  await page.waitForFunction(
    (identity) =>
      document.activeElement?.getAttribute("data-job-id") === identity,
    olderJob.id,
  );
  assert.equal(await older.count(), 1);
  assert.equal(
    await older.getByText("Meeting transcription", { exact: true }).count(),
    1,
  );
  assert.match(await older.getAttribute("class"), /queue-job-focused/);
  assert.equal(
    await older
      .getByText("Opened task · Queue project B", { exact: true })
      .count(),
    1,
  );
  assert.equal(
    await page.getByLabel("Project name").inputValue(),
    "Queue project B",
  );
  assert.deepEqual(
    inboxReads,
    [[inboxEvent.id]],
    "ack follows successful exact task navigation",
  );
  await page
    .getByRole("button", { name: "Close activity", exact: true })
    .click();
  await openQueue();
  await older.waitFor();
  assert.equal(
    await older.count(),
    1,
    "the fetched historical task survives reopening the queue",
  );
  // Another project navigation clears the retained task and its marker.
  await result("Image result in project A");
  await selectedAsset("Queue project A result");
  await openQueue();
  assert.equal(await queue.locator(".queue-job-focused").count(), 0);
  assert.equal(
    await queue.locator(`[data-job-id="${olderJob.id}"]`).count(),
    0,
  );
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  console.log(
    "Queue navigation passed: exact assets/conversations, historical inbox task focus, scoped retention, valid retries, and stale navigation protection.",
  );
} finally {
  await browser.close();
}
