// Intercepted browser fixtures. No GPU work, downloads or live project mutations.
import { chromium } from "playwright";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.addInitScript(() => {
  Object.defineProperty(navigator, "clipboard", { value: undefined });
  Object.defineProperty(crypto, "randomUUID", { value: undefined });
});
let presence = 0;
await page.addInitScript(() => {
  const interval = window.setInterval.bind(window);
  window.setInterval = (fn, ms, ...args) =>
    interval(fn, ms === 30000 ? 50 : ms, ...args);
});
const errors = [],
  unexpected = [],
  sent = [];
page.on("pageerror", (e) => errors.push(e.message));
const project = {
  id: "a".repeat(32),
  name: "Chat browser fixture",
  revision: 0,
  updated: Date.now() / 1000,
  state: {},
};
let chat = {
  id: "b".repeat(32),
  project: project.id,
  title: "Browser fixture",
  turns: [],
};
const tools = [
  {
    id: "gptoss",
    name: "GPT-OSS",
    model: "GPT-OSS-20B",
    reasoning_efforts: ["low", "medium", "high"],
    state: "ready",
    compatibility: { compatible: true },
    profiles: [
      {
        id: "gptoss-chat",
        label: "Conversation",
        task: "write",
        roles: ["chat", "code"],
      },
    ],
  },
  {
    id: "flux",
    name: "Image fixture",
    model: "Image fixture",
    state: "ready",
    compatibility: { compatible: true },
    profiles: [
      {
        id: "image-fixture",
        label: "Image fixture",
        task: "image",
        roles: ["image"],
      },
    ],
  },
];
for (const [id, roles] of [
  ["wan", ["video", "video_text"]],
  ["fastwan", ["video_text"]],
])
  tools.push({
    id,
    name: id,
    model: id,
    state: "ready",
    compatibility: { compatible: true },
    profiles: [
      {
        id: id + "-fixture",
        label: id,
        task: "video",
        roles,
        width: 832,
        height: 480,
        fps: 24,
        audio: false,
      },
    ],
  });
await page.route("**/api/**", async (route) => {
  const r = route.request(),
    p = new URL(r.url()).pathname;
  let data,
    status = 200;
  if (p === "/api/chat-presence") {
    presence++;
    data = { ok: true };
  } else if (p === "/api/session") data = { token: "fixture" };
  else if (p === "/api/host-guidance")
    data = { needs_attention: false, checks: [] };
  else if (p === "/api/settings")
    data = {
      defaults: { chat: "auto", code: "auto", image: "auto" },
      appearance: {},
      generation: { seed: 771 },
      storage: {},
    };
  else if (p === "/api/tools") data = tools;
  else if (p === "/api/status")
    data = {
      jobs: [],
      gpu: {
        available: true,
        supported: true,
        total: 32 * 1024 ** 3,
        used: 0,
        name: "CPU fixture",
      },
      worker: { state: "idle" },
    };
  else if (p === "/api/projects") data = [project];
  else if (p === `/api/projects/${project.id}`)
    data = { ...project, assets: [] };
  else if (p === `/api/projects/${project.id}/website`)
    data = { site: null, runs: [] };
  else if (p === `/api/projects/${project.id}/chats`)
    data = r.method() === "POST" ? chat : [chat];
  else if (p === `/api/chats/${chat.id}`) data = chat;
  else if (p === `/api/chats/${chat.id}/messages`) {
    const body = r.postDataJSON();
    sent.push(body);
    const job = {
      id: "c".repeat(32),
      state: "generating",
      message: "Reasoning locally.",
      created: Date.now() / 1000 - 90,
      updated: Date.now() / 1000,
      request: { profile: { id: "gptoss-chat", model: "GPT-OSS-20B" } },
    };
    chat.turns = [
      {
        id: "d".repeat(32),
        prompt: body.prompt,
        mode: body.mode,
        documents: [],
        partial: "Real-delta UI fixture",
        job,
      },
    ];
    data = job;
  } else {
    unexpected.push(p);
    status = 404;
    data = { error: "Unexpected fixture route" };
  }
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(data),
  });
});
try {
  await page.goto(process.env.STUDIO_TEST_URL || "http://127.0.0.1:8897");
  await page.getByRole("button", { name: "GPT", exact: true }).click();
  await page.getByRole("heading", { name: /Think deeper/ }).waitFor();
  await page.getByLabel("Message GPTPaiton").fill("Explain local models.");
  await page.getByLabel("Reasoning effort").selectOption("medium");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByText("Real-delta UI fixture", { exact: true }).waitFor();
  await page
    .getByText("There is no other ready, compatible model for this task yet.")
    .waitFor();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].reasoning_effort, "medium");
  assert.match(sent[0].client_id, /^[a-f0-9]{32}$/);
  chat.turns[0] = {
    ...chat.turns[0],
    answer:
      "Saved answer.\n```html\n<script>window.injected=true</script>\n```",
    partial: null,
    job: { ...chat.turns[0].job, state: "completed" },
  };
  await page.getByText("Saved answer.", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.getByRole("button", { name: "Copy code" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  await page.screenshot({
    path: ".local/gptpaiton-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: ".local/gptpaiton-desktop.png",
    fullPage: true,
  });
  chat.turns[0] = {
    ...chat.turns[0],
    answer: null,
    asset: { id: "image-fixture", kind: "image" },
  };
  await page.route("**/api/assets/image-fixture", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="yellow"/></svg>',
    }),
  );
  await page.getByText(/Done — your image is saved/).waitFor();
  await page.getByRole("button", { name: "Video", exact: true }).click();
  await page.waitForTimeout(150);
  const stoppedPresence = presence;
  assert.ok(stoppedPresence >= 2);
  await page.waitForTimeout(200);
  assert.equal(presence, stoppedPresence);
  const videoChoice = page.getByRole("combobox", {
    name: "Creation profile",
    exact: true,
  });
  assert.deepEqual(
    await videoChoice
      .locator("option")
      .evaluateAll((options) => options.map((o) => o.value)),
    ["auto", "wan-fixture"],
  );
  await page.getByRole("button", { name: "From text", exact: true }).click();
  assert.deepEqual(
    await videoChoice
      .locator("option")
      .evaluateAll((options) => options.map((o) => o.value)),
    ["auto", "wan-fixture", "fastwan-fixture"],
  );
  await videoChoice.selectOption("fastwan-fixture");
  await page.getByRole("button", { name: "From image", exact: true }).click();
  assert.equal(await videoChoice.inputValue(), "auto");
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(
    "GPTPaiton fixture UI: send, reasoning, partial reply, safe code rendering, copy, mobile passed.",
  );
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
