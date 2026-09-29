// Synthetic browser fixtures only. Every API request is intercepted; no backend,
// container download, model load, or GPU operation is performed by this test.
import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
const errors = [],
  unexpected = [],
  writes = [];
page.on("pageerror", (error) => errors.push(error.message));
const repository = "ghcr.io/eliovp/paiton-vllm-plugin";
const packageId = "image-fixture";
const references = {
  stable: `${repository}:image-stable-fixture`,
  installed: `${repository}:image-installed-fixture`,
  download: `${repository}:image-candidate-fixture`,
  cancel: `${repository}:image-cancel-fixture`,
  wrong: `${repository}:different-model-fixture`,
};
const labels = {
  stable: "Stable fixture",
  installed: "Installed candidate fixture",
  download: "Downloaded candidate fixture",
  cancel: "Cancellable candidate fixture",
};
const imageIds = {
  stable: "sha256:" + "a".repeat(64),
  installed: "sha256:" + "b".repeat(64),
  download: "sha256:" + "c".repeat(64),
  cancel: "sha256:" + "d".repeat(64),
};
let selected = "stable",
  installed = new Set(["stable", "installed"]);
let jobs = [],
  blocked = false,
  completeDownload = false;
let runtimeReads = 0,
  toolReads = 0;
let retainedIdentity = imageIds.stable;
const tools = [
  {
    id: packageId,
    model: "Qwen Image package fixture",
    state: "ready",
    compatibility: { compatible: true },
    profiles: [],
  },
  {
    id: "setup-fixture",
    model: "Small writing setup fixture",
    state: "missing",
    compatibility: { compatible: true },
    profiles: [],
  },
  {
    id: "gpu-fixture",
    model: "Video incompatible GPU fixture",
    state: "unavailable",
    compatibility: {
      compatible: false,
      reason: "This fixture requires a different GPU.",
    },
    profiles: [],
  },
  {
    id: "ready-fixture",
    model: "Ready writing fixture",
    state: "ready",
    compatibility: { compatible: true },
    profiles: [],
  },
];
const extraPackages = [
  {
    id: "setup-fixture",
    model: "Small writing setup fixture",
    current: {
      reference: `${repository}:small-writing-fixture`,
      image_id: null,
      digests: [],
    },
    versions: [],
    can_switch: false,
    can_pull: false,
    message: "Download required for this fixture.",
  },
  {
    id: "gpu-fixture",
    model: "Video incompatible GPU fixture",
    current: {
      reference: `${repository}:video-fixture`,
      image_id: "sha256:" + "e".repeat(64),
      digests: [],
    },
    versions: [],
    can_switch: false,
    can_pull: false,
    message: "The package is installed on disk.",
  },
  {
    id: "ready-fixture",
    model: "Ready writing fixture",
    current: {
      reference: `${repository}:ready-writing-fixture`,
      image_id: "sha256:" + "f".repeat(64),
      digests: [],
    },
    versions: [],
    can_switch: false,
    can_pull: false,
    message: "Qualified writing package fixture.",
  },
];
let showQwen = false,
  completeWeights = false,
  weightsJob = null,
  rejectWeightsToggle = false,
  baseVerificationJob = null;
const weightsComponent = {
  id: "w3a4",
  label: "Faster 3-bit weights",
  state: "not_installed",
  installed: false,
  verified: false,
  download_bytes: 9550285694,
  revision: "278486debe64e21e5e9d45ac8d02798d72fbdf83",
  license: "Apache-2.0",
  license_url:
    "https://huggingface.co/EliovpAI/Qwen3.8-27B-W3Rot-INT3-Paiton-RDNA4/blob/278486debe64e21e5e9d45ac8d02798d72fbdf83/LICENSE",
  enabled_default: false,
  can_install: true,
  can_toggle: false,
  quality_note:
    "Earlier FP8-cache benchmarks: decode about 20% faster; MMLU-Pro −2.9 points; GSM8K and HumanEval within noise. KV4 results differ.",
  message: "Optional weights are not installed.",
};
const qwenTool = () => ({
  id: "qwen38-mxfp4",
  title: "Qwen3.8 chat",
  model: "Qwen3.8 MXFP4 + DFlash2",
  name: "Balanced chat",
  state: "ready",
  can_install: false,
  can_verify: baseVerificationJob?.state !== "verifying",
  compatibility: { compatible: true },
  profiles: [],
  optional_components: [{ ...weightsComponent, job: weightsJob }],
});
const qwenPackage = () => ({
  id: "qwen38-mxfp4",
  model: "Qwen3.8 MXFP4 + DFlash2",
  pinned: true,
  current: {
    reference: `${repository}:qwen38-w3a4`,
    image_id: "sha256:" + "8".repeat(64),
    digests: [],
  },
  versions: [
    {
      reference: `${repository}:qwen38-w3a4`,
      label: "Unified release · MXFP4 or optional W3A4",
      installed: true,
    },
  ],
  can_switch: false,
  can_pull: false,
  optional_components: [
    {
      ...weightsComponent,
      can_install: undefined,
      can_toggle: undefined,
      job: weightsJob,
    },
  ],
});
function settleWeights() {
  if (completeWeights && weightsJob?.state === "downloading") {
    weightsJob = {
      ...weightsJob,
      state: "completed",
      message: "3-bit weights verified.",
    };
    Object.assign(weightsComponent, {
      state: "ready",
      installed: true,
      verified: true,
      can_toggle: true,
      enabled_default: true,
      message: "Installed and verified.",
    });
    completeWeights = false;
  }
}
const project = {
  id: "a".repeat(32),
  name: "Runtime package browser fixture",
  revision: 0,
  state: {},
  updated: Date.now() / 1000,
};
const settings = {
  defaults: {},
  appearance: { show_gpu_details: false },
  generation: { seed: 771 },
  storage: {},
};
function settleDownload() {
  if (completeDownload && jobs[0]?.state === "downloading") {
    selected = "download";
    installed.add(selected);
    jobs = [
      {
        ...jobs[0],
        state: "completed",
        message: "Verified candidate package is ready.",
      },
    ];
    completeDownload = false;
  }
}
function snapshot() {
  const active = jobs.some((job) => job.state === "downloading");
  const blockedReason = blocked
    ? "A queued creation request keeps its current package. Finish or cancel it before switching."
    : active
      ? "Wait for the active package download."
      : "";
  return {
    repository,
    available: true,
    message: "",
    packages: [
      {
        id: packageId,
        model: "Qwen Image package fixture",
        current: {
          reference: references[selected],
          image_id: imageIds[selected],
          digests: [`${repository}@${imageIds[selected]}`],
        },
        versions: Object.keys(labels).map((key) => ({
          reference: references[key],
          label: labels[key],
          channel: key === "stable" ? "stable" : "candidate",
          selected: key === selected,
          installed: installed.has(key),
          size_bytes: installed.has(key) ? 3 * 1024 ** 3 : null,
          can_pull: true,
        })),
        blocked_reason: blockedReason,
        can_switch: !blockedReason,
        can_pull: !blockedReason,
      },
      ...extraPackages,
      ...(showQwen ? [qwenPackage()] : []),
    ],
  };
}

await page.route("**/api/**", async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const method = request.method();
  let data,
    status = 200;
  if (method !== "GET")
    writes.push({ method, path, body: request.postDataJSON() });
  if (path === "/api/session") data = { token: "runtime-package-fixture" };
  else if (path === "/api/inbox")
    data = { events: [], unread: 0, has_more: false, limit: 100 };
  else if (path === "/api/meetings/readiness")
    data = {
      ready: false,
      message: "Meeting inference is unavailable in this CPU fixture.",
    };
  else if (path === "/api/host-guidance")
    data = { needs_attention: false, checks: [] };
  else if (path === "/api/settings") data = settings;
  else if (path === "/api/tools") {
    toolReads++;
    data = showQwen ? [...tools, qwenTool()] : tools;
  } else if (path === "/api/status")
    data = {
      jobs: [],
      gpu: {
        available: true,
        supported: true,
        used: 0,
        total: 32 * 1024 ** 3,
        name: "CPU fixture",
        message: "No GPU work",
      },
      worker: { state: "idle" },
      model_memory: {
        keep_ready_minutes: 15,
        retained_model: {
          package: packageId,
          model: "Qwen Image package fixture",
          state: "ready",
          runtime_image: retainedIdentity,
        },
      },
    };
  else if (path === "/api/projects") data = [project];
  else if (path === `/api/projects/${project.id}`)
    data = { ...project, assets: [] };
  else if (path === `/api/projects/${project.id}/website`)
    data = { site: null, runs: [] };
  else if (path === "/api/runtime-packages" && method === "GET") {
    runtimeReads++;
    settleDownload();
    settleWeights();
    data = snapshot();
  } else if (path === "/api/setup" && method === "GET") {
    settleDownload();
    settleWeights();
    data = {
      jobs: [
        ...jobs,
        ...(baseVerificationJob ? [baseVerificationJob] : []),
        ...(weightsJob ? [weightsJob] : []),
      ],
      tools: showQwen
        ? [
            qwenTool(),
            { ...tools[3], title: tools[3].model, can_install: false },
          ]
        : [],
      checks: [],
      system: {
        disk_free_bytes: 100 * 1024 ** 3,
        message: "CPU fixture only.",
        checks: [],
      },
    };
  } else if (
    path === `/api/runtime-packages/${packageId}/select` &&
    method === "POST"
  ) {
    assert.equal(request.postDataJSON().reference, references.installed);
    assert.equal(blocked, false);
    selected = "installed";
    data = snapshot();
  } else if (
    path === `/api/runtime-packages/${packageId}/pull` &&
    method === "POST"
  ) {
    const reference = request.postDataJSON().reference;
    if (reference === references.wrong) {
      status = 400;
      data = {
        error:
          "This package belongs to a different model. Your current package is unchanged.",
      };
    } else {
      assert.ok([references.download, references.cancel].includes(reference));
      assert.equal(blocked, false);
      jobs = [
        {
          id:
            reference === references.cancel
              ? "cancel-download-fixture"
              : "approved-download-fixture",
          package: packageId,
          state: "downloading",
          message: "Downloading fixture package; current selection retained.",
        },
      ];
      data = jobs[0];
    }
  } else if (
    path === "/api/setup-jobs/cancel-download-fixture/cancel" &&
    method === "POST"
  ) {
    jobs = [
      {
        ...jobs[0],
        state: "cancelled",
        message: "Package download cancelled. Current package retained.",
      },
    ];
    data = jobs[0];
  } else if (path === "/api/setup/qwen38-mxfp4/install" && method === "POST") {
    assert.equal(baseVerificationJob, null);
    assert.deepEqual(request.postDataJSON(), {});
    baseVerificationJob = {
      id: "qwen-base-verification",
      package: "qwen38-mxfp4",
      state: "verifying",
      message: "Checking pinned checkpoint file hashes.",
      completed_bytes: 1024,
      total_bytes: 2048,
    };
    data = baseVerificationJob;
  } else if (
    path === "/api/setup/qwen38-mxfp4/components/w3a4/install" &&
    method === "POST"
  ) {
    weightsJob = {
      id: "optional-weights-download",
      package: "qwen38-mxfp4",
      component: "w3a4",
      state: "downloading",
      message: "Downloading verified revision.",
      completed_bytes: 1024 ** 3,
      total_bytes: 9550285694,
    };
    weightsComponent.state = "installing";
    data = weightsJob;
  } else if (
    path === "/api/setup/qwen38-mxfp4/components/w3a4" &&
    method === "PUT"
  ) {
    const { enabled } = request.postDataJSON();
    assert.equal(typeof enabled, "boolean");
    assert.ok(!enabled || weightsComponent.verified);
    if (rejectWeightsToggle) {
      rejectWeightsToggle = false;
      status = 409;
      data = { error: "Synthetic preference save failed." };
    } else {
      weightsComponent.enabled_default = enabled;
      data = { ...weightsComponent, job: weightsJob };
    }
  } else if (
    path === "/api/setup-jobs/optional-weights-download/cancel" &&
    method === "POST"
  ) {
    weightsJob = {
      ...weightsJob,
      state: "cancelled",
      message: "Optional download stopped; MXFP4 remains ready.",
    };
    weightsComponent.state = "not_installed";
    data = weightsJob;
  } else if (
    path === "/api/setup-jobs/optional-weights-download/diagnostics" &&
    method === "GET"
  ) {
    data = {
      log: {
        available: true,
        text: "Optional fixture verification failed.",
        truncated: false,
      },
      diagnostics: { package: "qwen38-mxfp4", component: "w3a4" },
      copy_text: "Optional fixture diagnostic.",
    };
  } else {
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

try {
  await page.goto(
    (process.env.STUDIO_TEST_URL || "http://127.0.0.1:8897") +
      "/#runtime-packages",
  );
  const section = page.locator(".runtime-packages");
  const card = section.locator(".runtime-package-card").filter({
    has: page.getByRole("heading", {
      name: "Qwen Image package fixture",
      exact: true,
    }),
  });
  const choice = card.getByRole("combobox", { name: "Package version" });
  await choice.waitFor();
  assert.equal(await choice.inputValue(), references.stable);
  assert.match(
    await card.locator(".runtime-current").innerText(),
    /Stable fixture/,
  );
  const visibleModels = async () =>
    (await section.locator(".runtime-package-card h3").allTextContents()).map(
      (name) => name.trim(),
    );
  const allModels = tools.map((tool) => tool.model);
  const search = section.getByRole("searchbox", {
    name: "Find a model or package",
  });
  const filterButton = (name) =>
    section.getByRole("button", { name, exact: true });
  assert.deepEqual(await visibleModels(), allModels);
  assert.match(
    await section.getByLabel("Model library status").innerText(),
    /3 runtimes installed/,
  );
  assert.match(
    await section.getByLabel("Model library status").innerText(),
    /2 models ready to create/,
  );
  assert.equal(
    await card.locator(".runtime-model-state").innerText(),
    "Loaded · kept ready for another request",
  );
  await search.fill(" qWeN IMAGE-STABLE-fixture ");
  assert.deepEqual(
    await visibleModels(),
    [tools[0].model],
    "Search matches multiple words across model and package reference, without case sensitivity",
  );
  await filterButton("Needs setup").click();
  assert.deepEqual(await visibleModels(), []);
  await section
    .getByText("No packages match these filters.", { exact: true })
    .waitFor();
  await filterButton("Clear filters").click();
  assert.equal(await search.inputValue(), "");
  assert.equal(
    await filterButton("All models").getAttribute("aria-pressed"),
    "true",
  );
  assert.deepEqual(await visibleModels(), allModels);
  await filterButton("Installed runtimes").click();
  assert.deepEqual(await visibleModels(), [
    tools[0].model,
    tools[2].model,
    tools[3].model,
  ]);
  await filterButton("Ready to create").click();
  assert.deepEqual(await visibleModels(), [tools[0].model, tools[3].model]);
  await filterButton("Compatible GPU").click();
  assert.deepEqual(await visibleModels(), [
    tools[0].model,
    tools[1].model,
    tools[3].model,
  ]);
  await filterButton("Needs setup").click();
  assert.deepEqual(await visibleModels(), [tools[1].model, tools[2].model]);
  await filterButton("All models").click();
  assert.deepEqual(
    writes,
    [],
    "Searching and filtering never loads or changes a model",
  );

  retainedIdentity = undefined;
  await card
    .getByText("Ready to create · loads on your next request", { exact: true })
    .waitFor({ timeout: 6000 });
  retainedIdentity = imageIds.stable;
  await card
    .getByText("Loaded · kept ready for another request", { exact: true })
    .waitFor({ timeout: 6000 });
  const summaryContrast = await section
    .getByLabel("Model library status")
    .evaluate((element) => {
      const luminance = (color) => {
        const channels = color
          .match(/[\d.]+/g)
          .slice(0, 3)
          .map((value) => {
            const normalized = Number(value) / 255;
            return normalized <= 0.04045
              ? normalized / 12.92
              : ((normalized + 0.055) / 1.055) ** 2.4;
          });
        return (
          channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
        );
      };
      const foreground = luminance(
        getComputedStyle(element.querySelector("span")).color,
      );
      const background = luminance(getComputedStyle(element).backgroundColor);
      return (
        (Math.max(foreground, background) + 0.05) /
        (Math.min(foreground, background) + 0.05)
      );
    });
  assert.ok(
    summaryContrast >= 4.5,
    `Library summary text must remain readable in the active theme; contrast was ${summaryContrast.toFixed(2)}:1`,
  );
  const output = process.env.STUDIO_CAPTURE_DIR || ".local/ui-tests";
  fs.mkdirSync(output, { recursive: true });
  await page.screenshot({
    path: `${output}/runtime-packages.png`,
    fullPage: true,
  });
  const initialReads = runtimeReads,
    initialTools = toolReads;

  await choice.selectOption(references.installed);
  await card.getByRole("button", { name: "Use package", exact: true }).click();
  await section
    .getByText("Package selected. New requests will use this version.", {
      exact: true,
    })
    .waitFor();
  assert.equal(selected, "installed");
  assert.equal(
    await card.locator(".runtime-model-state").innerText(),
    "Ready to create · loads on your next request",
    "A retained older image must not label the newly selected package as loaded",
  );
  assert.match(
    await card.locator(".runtime-current").innerText(),
    /Installed candidate fixture/,
  );
  assert.ok(
    runtimeReads > initialReads && toolReads > initialTools,
    "Switch refreshes package and creation-tool state",
  );
  assert.equal(
    await card
      .getByRole("button", { name: "In use", exact: true })
      .isDisabled(),
    true,
  );

  await choice.selectOption(references.download);
  await card
    .getByRole("button", { name: "Download & use", exact: true })
    .click();
  await card
    .getByRole("button", { name: "Cancel download", exact: true })
    .waitFor();
  assert.equal(
    selected,
    "installed",
    "Download does not prematurely replace the installed package",
  );
  assert.equal(await choice.isDisabled(), true);
  const pendingReads = runtimeReads,
    pendingTools = toolReads;
  completeDownload = true;
  await card
    .getByText("Verified candidate package is ready.", { exact: true })
    .waitFor({ timeout: 9000 });
  assert.equal(selected, "download");
  assert.ok(
    runtimeReads > pendingReads && toolReads > pendingTools,
    "Terminal polling refreshes the package and model choices",
  );
  assert.match(
    await card.locator(".runtime-current").innerText(),
    /Downloaded candidate fixture/,
  );

  await card.locator("summary").click();
  const custom = card.getByRole("textbox", { name: "Full GHCR tag or digest" });
  await custom.fill(references.wrong);
  await card
    .getByRole("button", { name: "Download & verify", exact: true })
    .click();
  await section.getByRole("alert").waitFor();
  assert.match(await section.getByRole("alert").innerText(), /different model/);
  assert.equal(selected, "download");
  assert.match(
    await card.locator(".runtime-current").innerText(),
    /Downloaded candidate fixture/,
  );

  await choice.selectOption(references.cancel);
  await card
    .getByRole("button", { name: "Download & use", exact: true })
    .click();
  await card
    .getByRole("button", { name: "Cancel download", exact: true })
    .click();
  await card
    .getByText("Package download cancelled. Current package retained.", {
      exact: true,
    })
    .waitFor();
  assert.equal(selected, "download");
  assert.equal(
    writes.filter(
      (write) =>
        write.path === "/api/setup-jobs/cancel-download-fixture/cancel",
    ).length,
    1,
  );

  blocked = true;
  await section
    .getByRole("button", { name: "Refresh runtime packages" })
    .click();
  await card
    .getByText(/A queued creation request keeps its current package/)
    .waitFor();
  const writesBeforeBlocked = writes.length;
  await choice.selectOption(references.stable);
  assert.equal(
    await card
      .getByRole("button", { name: "Use package", exact: true })
      .isDisabled(),
    true,
  );
  await choice.selectOption(references.cancel);
  assert.equal(
    await card
      .getByRole("button", { name: "Download & use", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await card
      .getByRole("button", { name: "Download & verify", exact: true })
      .count(),
    0,
  );
  assert.equal(
    writes.length,
    writesBeforeBlocked,
    "Queue-blocked controls send no mutations",
  );

  blocked = false;
  await section
    .getByRole("button", { name: "Refresh runtime packages" })
    .click();
  await custom.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await custom.fill(`${repository}@sha256:${"f".repeat(64)}`);
  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    packages: document
      .querySelector(".runtime-packages")
      .getBoundingClientRect().right,
  }));
  assert.ok(
    overflow.document <= overflow.viewport + 1,
    `Narrow Settings page must not overflow: ${JSON.stringify(overflow)}`,
  );
  assert.ok(
    overflow.packages <= overflow.viewport + 1,
    "Package controls stay inside the narrow viewport",
  );
  await page.setViewportSize({ width: 1440, height: 1100 });
  showQwen = true;
  await section
    .getByRole("button", { name: "Refresh runtime packages" })
    .click();
  const qwenCard = section.locator(".runtime-package-card").filter({
    has: page.getByRole("heading", {
      name: "Qwen3.8 MXFP4 + DFlash2",
      exact: true,
    }),
  });
  const optional = qwenCard.getByRole("region", {
    name: "Faster 3-bit weights",
  });
  const toggle = optional.getByRole("checkbox", {
    name: "Use 3-bit weights for new chats",
  });
  await toggle.waitFor();
  assert.equal(await toggle.isChecked(), false);
  assert.equal(await toggle.isDisabled(), true);
  assert.match(await optional.innerText(), /8.9 GiB download/);
  assert.match(await optional.innerText(), /MMLU-Pro −2.9/);
  assert.equal(
    await optional
      .getByRole("link", { name: "Apache-2.0" })
      .getAttribute("href"),
    weightsComponent.license_url,
  );
  await optional
    .getByRole("button", { name: "Download 3-bit weights" })
    .click();
  await optional.getByRole("progressbar").waitFor();
  assert.equal(
    await optional.getByRole("progressbar").getAttribute("max"),
    "9550285694",
  );
  assert.equal(
    await qwenCard.locator(":scope > .runtime-download-status").count(),
    0,
    "Optional download does not replace base package status.",
  );
  await optional.getByRole("button", { name: "Cancel download" }).click();
  await optional.getByRole("button", { name: "Resume download" }).click();
  completeWeights = true;
  await optional
    .getByText("Installed & verified", { exact: true })
    .waitFor({ timeout: 9000 });
  assert.equal(
    await toggle.isChecked(),
    true,
    "First verified optional installation enables the new-chat default.",
  );
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/setup") && response.status() === 200,
    ),
    toggle.uncheck(),
  ]);
  assert.equal(weightsComponent.enabled_default, false);
  rejectWeightsToggle = true;
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/components/w3a4") &&
        response.status() === 409,
    ),
    toggle.click(),
  ]);
  await optional
    .getByRole("alert")
    .getByText("Synthetic preference save failed.", { exact: true })
    .waitFor();
  assert.equal(
    await toggle.isChecked(),
    false,
    "A rejected preference restores the saved switch value.",
  );
  assert.equal(weightsComponent.enabled_default, false);
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/setup") && response.status() === 200,
    ),
    toggle.check(),
  ]);
  assert.equal(weightsComponent.enabled_default, true);
  Object.assign(weightsComponent, {
    state: "verification_required",
    verified: false,
    can_toggle: false,
    message: "Verify after restart.",
  });
  weightsJob = {
    ...weightsJob,
    state: "failed",
    message: "Optional fixture verification failed.",
  };
  await section
    .getByRole("button", { name: "Refresh runtime packages" })
    .click();
  await optional.getByText("Verification needed", { exact: true }).waitFor();
  assert.equal(
    await toggle.isDisabled(),
    false,
    "A stored default can still be turned off while verification is cold.",
  );
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/setup") && response.status() === 200,
    ),
    toggle.uncheck(),
  ]);
  assert.equal(await toggle.isDisabled(), true);
  await page
    .locator("main .settings-tabs")
    .getByRole("button", { name: "Setup & downloads", exact: true })
    .click();
  const setupCard = page.locator(".setup-tool").filter({
    has: page.getByRole("heading", { name: "Qwen3.8 chat", exact: true }),
  });
  const setupOptional = setupCard.getByRole("region", {
    name: "Faster 3-bit weights",
  });
  await setupOptional.getByRole("button", { name: "Verify weights" }).waitFor();
  assert.match(
    await setupCard.locator(":scope > .section-heading .badge").innerText(),
    /Ready to create/,
  );
  assert.equal(
    await setupCard.locator(":scope > .setup-last").count(),
    0,
    "Optional failure does not mark the base install as failed.",
  );
  await setupOptional.getByText("Show details", { exact: true }).click();
  await setupOptional
    .locator("pre")
    .getByText("Optional fixture verification failed.", { exact: true })
    .waitFor();
  const verifyBase = setupCard.getByRole("button", {
    name: "Verify & repair",
    exact: true,
  });
  await verifyBase.waitFor();
  assert.equal(await verifyBase.isDisabled(), false);
  const ordinaryReady = page.locator(".setup-tool").filter({
    has: page.getByRole("heading", {
      name: "Ready writing fixture",
      exact: true,
    }),
  });
  assert.equal(
    await ordinaryReady.locator(".setup-install").count(),
    0,
    "An ordinary ready model does not gain a setup action.",
  );
  await verifyBase.click();
  const baseProgress = setupCard.locator(":scope > .setup-job");
  await baseProgress
    .getByText("Checking pinned checkpoint file hashes.", { exact: true })
    .waitFor();
  assert.equal(
    await verifyBase.count(),
    0,
    "Active verification cannot be submitted twice.",
  );
  assert.equal(
    await baseProgress.getByRole("progressbar").getAttribute("max"),
    "2048",
  );
  assert.equal(
    await baseProgress
      .getByRole("button", { name: "Cancel setup" })
      .isDisabled(),
    false,
  );
  baseVerificationJob.state = "completed";
  baseVerificationJob.message = "Pinned checkpoint hashes verified.";
  await verifyBase.waitFor({ timeout: 6000 });
  assert.equal(await verifyBase.isDisabled(), false);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "Optional component fits on mobile.",
  );
  await page.screenshot({
    path: `${output}/runtime-optional-weights-mobile.png`,
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(
    writes.map(({ path }) => path),
    [
      `/api/runtime-packages/${packageId}/select`,
      `/api/runtime-packages/${packageId}/pull`,
      `/api/runtime-packages/${packageId}/pull`,
      `/api/runtime-packages/${packageId}/pull`,
      "/api/setup-jobs/cancel-download-fixture/cancel",
      "/api/setup/qwen38-mxfp4/components/w3a4/install",
      "/api/setup-jobs/optional-weights-download/cancel",
      "/api/setup/qwen38-mxfp4/components/w3a4/install",
      "/api/setup/qwen38-mxfp4/components/w3a4",
      "/api/setup/qwen38-mxfp4/components/w3a4",
      "/api/setup/qwen38-mxfp4/components/w3a4",
      "/api/setup/qwen38-mxfp4/components/w3a4",
      "/api/setup/qwen38-mxfp4/install",
    ],
  );
  console.log(
    "Runtime package search/filters, loaded identity, selection, download polling, incompatible package recovery, queue blocking, cancellation and narrow layout passed. Synthetic APIs only; no GPU work.",
  );
} finally {
  await context.close();
  await browser.close();
}
