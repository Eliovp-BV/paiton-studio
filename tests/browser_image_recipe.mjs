// Isolated UI fixtures: all API requests intercepted; no inference or live data.
import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [],
  unexpected = [],
  submissions = [];
page.on("pageerror", (error) => errors.push(error.message));
const projectId = "a".repeat(32);
const profile = {
  id: "qwen-image-fixture",
  label: "High quality · 2048 × 2048",
  task: "image",
  roles: ["image"],
  mode: "text-to-image",
  width: 2048,
  height: 2048,
  steps: 40,
  max_prompt_length: 512,
};
const draftProfile = {
  ...profile,
  id: "qwen-image-draft-fixture",
  label: "Draft / Preview · 1024 × 1024",
  width: 1024,
  height: 1024,
};
const legacy = { ...profile, id: "legacy-fixture", max_prompt_length: 2500 };
const editProfile = {
  ...profile,
  id: "qwen-image21-edit",
  label: "Edit image · 1024 × 1024",
  roles: ["image_edit"],
  mode: "edit",
  width: 1024,
  height: 1024,
  checkpoint_variant: "original",
};
const uncensoredEdit = {
  ...editProfile,
  id: "qwen-image21-uncensored-edit",
  checkpoint_variant: "uncensored",
  requires_explicit_selection: true,
};
const tools = [
  {
    id: "image-fixture",
    name: "Image fixture",
    model: "Image fixture model",
    state: "ready",
    compatibility: { compatible: true },
    default_for: ["image"],
    profiles: [profile, draftProfile, legacy, editProfile],
  },
  {
    id: "qwen-image21-uncensored",
    name: "Uncensored fixture",
    model: "Qwen-Image-2.1 Uncensored",
    state: "ready",
    requires_explicit_selection: true,
    profiles: [
      uncensoredEdit,
      {
        ...profile,
        id: "uncensored-create",
        checkpoint_variant: "uncensored",
        requires_explicit_selection: true,
      },
    ],
  },
];
const request = {
  task: "image",
  prompt: "A cabin beside a lake",
  seed: 0,
  runtime_image: "sha256:" + "b".repeat(64),
  runtime_ref: "ghcr.io/eliovp/paiton-vllm-plugin:fixture",
  profile: {
    ...profile,
    model: "Image fixture model",
    package: "image-fixture",
  },
};
const assets = [
  {
    id: "b".repeat(32),
    project: projectId,
    kind: "image",
    name: "Saved image",
    metadata: {
      width: 2048,
      height: 2048,
      origin: "generated",
      request,
      precision_profile: "exact",
    },
  },
  {
    id: "c".repeat(32),
    project: projectId,
    kind: "image",
    name: "Retired model image",
    metadata: {
      width: 1024,
      height: 1024,
      origin: "generated",
      request: {
        ...request,
        profile: { ...request.profile, id: "retired-fixture" },
      },
    },
  },
  {
    id: "5".repeat(32),
    project: projectId,
    kind: "image",
    name: "Draft image",
    metadata: {
      width: 1024,
      height: 1024,
      origin: "generated",
      request: {
        ...request,
        prompt: "A cabin beside a lake, product style",
        style: "product",
        seed: 5,
        profile: {
          ...draftProfile,
          model: "Image fixture model",
          package: "image-fixture",
        },
      },
    },
  },
  {
    id: "d".repeat(32),
    project: projectId,
    kind: "image",
    name: "Imported image",
    metadata: { width: 1024, height: 1024, origin: "imported" },
  },
];
assets.push({
  id: "f".repeat(32),
  project: projectId,
  kind: "image",
  name: "Large photograph",
  metadata: { width: 4097, height: 1024, origin: "imported" },
});
assets.push({
  id: "1".repeat(32),
  project: projectId,
  kind: "image",
  name: "Saved edit",
  metadata: {
    width: 1024,
    height: 1024,
    origin: "generated",
    request: {
      ...request,
      prompt: "Change the sky to sunset",
      profile: { ...uncensoredEdit, model: "Qwen-Image-2.1 Uncensored" },
      source: { id: assets[3].id, project: projectId, name: assets[3].name },
    },
  },
});
assets.push({
  id: "2".repeat(32),
  project: "other-project",
  kind: "image",
  name: "Foreign image",
  metadata: { width: 1024, height: 1024 },
});
const importedImage = assets.find((asset) => asset.name === "Imported image");
const largeImage = assets.find((asset) => asset.name === "Large photograph");
const foreignImage = assets.find((asset) => asset.name === "Foreign image");
let workerState = "idle";
let project = {
  id: projectId,
  name: "Image recipe fixture",
  revision: 0,
  updated: Date.now() / 1000,
  state: { image: { profile: legacy.id, prompt: "x".repeat(600), seed: 771 } },
};
const settings = {
  defaults: { image: profile.id, image_edit: "auto" },
  appearance: { show_gpu_details: false },
  generation: { seed: 771 },
  storage: {},
};
const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/S9sAAAAASUVORK5CYII=",
  "base64",
);
await page.route("**/api/**", async (route) => {
  const req = route.request();
  const path = new URL(req.url()).pathname;
  const method = req.method();
  let data,
    status = 200;
  if (path.startsWith("/api/assets/")) {
    await route.fulfill({ contentType: "image/png", body: imageBytes });
    return;
  }
  if (path === "/api/session") data = { token: "image-recipe-fixture" };
  else if (path === "/api/meetings/readiness")
    data = {
      ready: false,
      message: "Meeting inference is unavailable in this CPU fixture.",
    };
  else if (path === "/api/host-guidance")
    data = { needs_attention: false, checks: [] };
  else if (path === "/api/settings") data = settings;
  else if (path === "/api/tools") data = tools;
  else if (path === "/api/inbox")
    data = { events: [], unread: 0, has_more: false, limit: 100 };
  else if (path === "/api/status")
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
      worker: { state: workerState },
    };
  else if (path === "/api/projects") data = [project];
  else if (path === `/api/projects/${projectId}`) {
    if (method === "PUT")
      project = {
        ...project,
        ...req.postDataJSON(),
        revision: project.revision + 1,
      };
    data = { ...project, assets };
  } else if (
    path === `/api/projects/${projectId}/import` &&
    method === "POST"
  ) {
    data = {
      id: "3".repeat(32),
      project: projectId,
      kind: "image",
      name: "Uploaded photograph",
      metadata: { width: 1024, height: 1024, origin: "imported" },
    };
    assets.push(data);
  } else if (path === `/api/projects/${projectId}/website`)
    data = { site: null, runs: [] };
  else if (path === `/api/projects/${projectId}/brief`)
    data = { project: projectId, content: "", revision: 1, updated: 0 };
  else if (path === `/api/projects/${projectId}/jobs` && method === "POST") {
    const body = req.postDataJSON();
    submissions.push(body);
    data = {
      id: "e".repeat(32),
      project: projectId,
      state: "queued",
      request: body,
      created: Date.now() / 1000,
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
    (process.env.STUDIO_TEST_URL || "http://127.0.0.1:8897") + "/#image",
  );
  const prompt = page.getByRole("textbox", { name: "Describe your image" });
  await prompt.waitFor();
  const choice = page.getByRole("combobox", { name: "Creation profile" });
  const generate = page.getByRole("button", {
    name: "Generate image",
    exact: true,
  });
  assert.equal(await prompt.getAttribute("maxlength"), "5000");
  await choice.selectOption(profile.id);
  assert.equal(await prompt.getAttribute("maxlength"), "1024");
  assert.equal(
    (await prompt.inputValue()).length,
    600,
    "Changing profiles preserves long drafts",
  );
  assert.equal(await generate.isDisabled(), true);
  assert.match(
    await page.locator("#image-prompt-limit").innerText(),
    /Your draft is kept/,
  );

  // Browser maxlength counts UTF-16 units; the API counts Unicode code points.
  await prompt.fill("🌲".repeat(512));
  assert.match(
    await page.locator("#image-prompt-limit").innerText(),
    /512 \/ 512/,
  );
  assert.equal(await generate.isDisabled(), false);
  await prompt.fill("x".repeat(513));
  assert.equal(await generate.isDisabled(), true);
  assert.deepEqual(submissions, [], "Overlong drafts never submit a job");

  await prompt.fill("A new landscape");
  // Style chips are a single selection stored with the draft; the prompt text
  // never changes and the style phrase is reserved out of the counter.
  const chip = (name) =>
    page
      .locator(".style-suggestions")
      .getByRole("button", { name, exact: true });
  await chip("Cinematic").click();
  assert.equal(await chip("Cinematic").getAttribute("aria-pressed"), "true");
  assert.equal(await prompt.inputValue(), "A new landscape");
  assert.match(
    await page.locator("#image-prompt-limit").innerText(),
    /15 \/ 495 characters · 17 reserved for the Cinematic style/,
  );
  await chip("Product").click();
  assert.equal(await chip("Cinematic").getAttribute("aria-pressed"), "false");
  assert.equal(await chip("Product").getAttribute("aria-pressed"), "true");
  await prompt.fill("x".repeat(498));
  assert.equal(await generate.isDisabled(), true, "Style phrase counts");
  assert.match(
    await page.locator("#image-prompt-limit").innerText(),
    /clear the style/,
  );
  await prompt.fill("A new landscape");
  await chip("Product").click();
  assert.equal(await chip("Product").getAttribute("aria-pressed"), "false");
  assert.match(
    await page.locator("#image-prompt-limit").innerText(),
    /15 \/ 512 characters$/,
  );
  await page
    .locator("summary")
    .filter({ hasText: /^Advanced$/ })
    .click();
  const seed = page.getByRole("spinbutton", { name: "Seed", exact: true });
  await page.getByRole("button", { name: "New seed", exact: true }).click();
  const shuffled = Number(await seed.inputValue());
  assert.ok(
    Number.isSafeInteger(shuffled) && shuffled >= 0 && shuffled !== 771,
  );

  const saved = page
    .locator(".results article")
    .filter({ has: page.getByText("Saved image", { exact: true }) });
  await saved.getByText("Use this result", { exact: true }).click();
  await saved.getByText("Generation details", { exact: true }).click();
  assert.match(await saved.locator(".image-recipe").innerText(), /2048 × 2048/);
  assert.match(
    await saved.locator(".image-recipe").innerText(),
    /Exact \(BF16 activations\)/,
  );
  assert.match(await saved.locator(".image-recipe").innerText(), /Steps\s+40/);
  assert.match(
    await saved.locator(".image-recipe").innerText(),
    /ghcr\.io\/eliovp/,
  );
  assert.ok(
    (await saved.locator(".image-recipe").innerText()).includes(
      request.runtime_image,
    ),
  );
  await saved
    .getByRole("button", { name: "Reuse settings", exact: true })
    .click();
  assert.equal(await prompt.inputValue(), request.prompt);
  assert.equal(await choice.inputValue(), profile.id);
  assert.equal(await seed.inputValue(), "0");
  assert.deepEqual(submissions, [], "Reuse must not submit a job");

  const variationSaved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === `/api/projects/${projectId}`,
  );
  await saved
    .getByRole("button", { name: "New variation", exact: true })
    .click();
  const variation = Number(await seed.inputValue());
  assert.ok(Number.isSafeInteger(variation) && variation > 0);
  assert.equal(await prompt.inputValue(), request.prompt);
  assert.equal(await choice.inputValue(), profile.id);
  assert.deepEqual(submissions, []);
  await variationSaved;
  // Route changes flush and retain the draft through the existing autosave path.
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Projects", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Image", exact: true })
    .click();
  await page
    .locator("summary")
    .filter({ hasText: /^Advanced$/ })
    .click();
  assert.equal(Number(await seed.inputValue()), variation);
  assert.deepEqual(project.state.image, {
    prompt: request.prompt,
    profile: profile.id,
    seed: variation,
    style: null,
  });

  // Promote to 2048 restores a finished 1024 result with the same seed and
  // style on the package's 2048 profile and focuses Generate.
  const draftCard = page
    .locator(".results article")
    .filter({ has: page.getByText("Draft image", { exact: true }) });
  await draftCard.getByText("Use this result", { exact: true }).click();
  await draftCard
    .getByRole("button", { name: "Promote to 2048", exact: true })
    .click();
  assert.equal(await choice.inputValue(), profile.id);
  assert.equal(await prompt.inputValue(), "A cabin beside a lake");
  assert.equal(await chip("Product").getAttribute("aria-pressed"), "true");
  assert.equal(await seed.inputValue(), "5");
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent?.trim()),
    "Generate image",
  );
  assert.deepEqual(submissions, [], "Promotion never submits a job");
  assert.equal(
    await saved.getByRole("button", { name: "Promote to 2048" }).count(),
    0,
    "A 2048 result offers no promotion",
  );

  const retired = page
    .locator(".results article")
    .filter({ has: page.getByText("Retired model image", { exact: true }) });
  await retired.getByText("Use this result", { exact: true }).click();
  await retired
    .getByRole("button", { name: "Reuse settings", exact: true })
    .click();
  assert.equal(await choice.inputValue(), "retired-fixture");
  assert.match(
    await choice.locator("option:checked").innerText(),
    /unavailable/,
  );
  const imported = page.locator(".results article").filter({
    has: page.getByRole("button", {
      name: "Preview Imported image",
      exact: true,
    }),
  });
  assert.equal(
    await imported.getByRole("button", { name: "Reuse settings" }).count(),
    0,
  );

  await choice.selectOption(profile.id);
  const nextSubmission = () =>
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/projects/${projectId}/jobs`,
    );
  // A selected style is applied when the request is built and recorded beside it.
  await chip("Cinematic").click();
  let submitted = nextSubmission();
  await generate.click();
  await submitted;
  assert.deepEqual(submissions, [
    {
      task: "image",
      profile_id: profile.id,
      prompt: request.prompt + ", cinematic style",
      seed: 0,
      style: "cinematic",
    },
  ]);
  assert.equal(await prompt.inputValue(), request.prompt);
  await page
    .getByRole("button", { name: "Close activity", exact: true })
    .click();
  await chip("Cinematic").click();
  submissions.length = 0;
  submitted = nextSubmission();
  await generate.click();
  await submitted;
  assert.deepEqual(submissions, [
    { task: "image", profile_id: profile.id, prompt: request.prompt, seed: 0 },
  ]);
  assert.equal(assets[0].metadata.request.seed, 0);
  await page
    .getByRole("button", { name: "Close activity", exact: true })
    .click();

  // Count queues one ordinary request per seed, counting up from the seed shown.
  const count = page.getByRole("combobox", { name: "Count", exact: true });
  await count.selectOption("2");
  assert.match(
    await page.locator("#creation-count-help").innerText(),
    /2 separate requests with seeds 0, 1/,
  );
  submissions.length = 0;
  await generate.click();
  for (let i = 0; i < 50 && submissions.length < 2; i++)
    await page.waitForTimeout(100);
  assert.deepEqual(
    submissions.map((body) => body.seed),
    [0, 1],
  );
  assert.ok(submissions.every((body) => body.profile_id === profile.id));
  await page
    .getByRole("button", { name: "Close activity", exact: true })
    .click();
  await count.selectOption("1");

  // Editing preserves both drafts and scopes model selection to edit profiles.
  await page
    .getByRole("button", { name: "Edit existing", exact: true })
    .click();
  const editPrompt = page.getByRole("textbox", {
    name: "Describe your changes",
  });
  const editGenerate = page.getByRole("button", {
    name: "Generate edit",
    exact: true,
  });
  const sourceChoice = page.getByRole("combobox", {
    name: "Source image",
    exact: true,
  });
  await editPrompt.fill("Make the background a sunny garden");
  assert.equal(
    await editGenerate.isDisabled(),
    true,
    "A source must be chosen first",
  );
  assert.equal(
    await choice.locator('option[value="' + profile.id + '"]').count(),
    0,
    "Create profiles cannot be used for edits",
  );
  assert.equal(
    await sourceChoice
      .locator('option[value="' + foreignImage.id + '"]')
      .count(),
    0,
    "Foreign project images cannot become sources",
  );
  await sourceChoice.selectOption(largeImage.id);
  assert.equal(
    await page.locator(".generation-source").innerText(),
    `Source: ${largeImage.name}`,
    "The selected original remains named beside Generate",
  );
  assert.equal(
    await editGenerate.isDisabled(),
    true,
    "Oversized originals remain intact and cannot submit",
  );
  assert.match(
    await page.locator(".image-edit-source").innerText(),
    /smaller copy/,
  );
  await sourceChoice.selectOption(importedImage.id);
  await choice.selectOption(uncensoredEdit.id);
  assert.match(
    await page.locator(".model-choice").innerText(),
    /selected explicitly/,
  );
  assert.equal(
    await page.getByAltText("Original image to edit").getAttribute("src"),
    "/api/assets/" + importedImage.id,
  );
  await page.getByRole("button", { name: "Create new", exact: true }).click();
  assert.equal(await prompt.inputValue(), request.prompt);
  assert.equal(await choice.inputValue(), profile.id);
  await page
    .getByRole("button", { name: "Edit existing", exact: true })
    .click();
  assert.equal(
    await editPrompt.inputValue(),
    "Make the background a sunny garden",
  );
  assert.equal(await choice.inputValue(), uncensoredEdit.id);
  assert.equal(await sourceChoice.inputValue(), importedImage.id);
  const editedSubmit = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/projects/${projectId}/jobs`,
  );
  await Promise.all([editedSubmit, editGenerate.click()]);
  assert.equal(submissions.length, 3);
  assert.deepEqual(submissions.at(-1), {
    task: "image",
    profile_id: uncensoredEdit.id,
    prompt: "Make the background a sunny garden",
    seed: 771,
    source_id: importedImage.id,
  });
  assert.equal(
    importedImage.metadata.origin,
    "imported",
    "Submitting an edit never mutates the original asset",
  );
  await page
    .getByRole("button", { name: "Close activity", exact: true })
    .click();

  // Saved edits reopen their original source and model; regular reuse returns to creation.
  const savedEdit = page
    .locator(".results article")
    .filter({ has: page.getByText("Saved edit", { exact: true }) });
  await savedEdit.getByText("Use this result", { exact: true }).click();
  await savedEdit
    .getByRole("button", { name: "Reuse settings", exact: true })
    .click();
  assert.equal(await editPrompt.inputValue(), "Change the sky to sunset");
  assert.equal(await sourceChoice.inputValue(), importedImage.id);
  assert.equal(await choice.inputValue(), uncensoredEdit.id);
  await saved.getByText("Use this result", { exact: true }).click();
  await saved
    .getByRole("button", { name: "Reuse settings", exact: true })
    .click();
  assert.equal(await prompt.inputValue(), request.prompt);
  assert.equal(
    await page
      .getByRole("button", { name: "Create new", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );

  await imported.getByText("Use this result", { exact: true }).click();
  await imported
    .getByRole("button", { name: "Edit image", exact: true })
    .click();
  assert.equal(await sourceChoice.inputValue(), importedImage.id);
  assert.equal(await editPrompt.inputValue(), "Change the sky to sunset");
  // The visible import action records the intended workspace before uploading.
  const chooserPromise = page.waitForEvent("filechooser");
  const uploadedDraftSaved = page.waitForResponse((response) => {
    if (
      response.request().method() !== "PUT" ||
      new URL(response.url()).pathname !== `/api/projects/${projectId}`
    )
      return false;
    return (
      response.request().postDataJSON()?.state?.image?.edit?.source ===
      "3".repeat(32)
    );
  });
  await page.getByRole("button", { name: "Change image", exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: imageBytes,
  });
  await page.getByRole("textbox", { name: "Describe your changes" }).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Source image"]')?.value ===
      "3".repeat(32),
  );
  await uploadedDraftSaved;
  assert.equal(
    submissions.length,
    3,
    "Picking, reusing and importing only prepare drafts",
  );

  workerState = "stopped";
  await page.reload();
  await editPrompt.waitFor();
  assert.equal(
    await sourceChoice.inputValue(),
    "3".repeat(32),
    "The imported edit source survives reload after saving",
  );
  assert.equal(
    await editPrompt.inputValue(),
    "Change the sky to sunset",
    "Reload preserves the independent edit draft",
  );
  assert.equal(
    await editGenerate.isDisabled(),
    true,
    "Paused execution cannot submit an edit",
  );
  assert.match(
    await page.locator(".creation-form").innerText(),
    /AI is paused/,
  );
  if (process.env.STUDIO_CAPTURE_DIR) {
    await mkdir(process.env.STUDIO_CAPTURE_DIR, { recursive: true });
    await page.screenshot({
      path: `${process.env.STUDIO_CAPTURE_DIR}/image-edit-desktop.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const width = await page.evaluate(() => ({
    viewport: innerWidth,
    actual: document.documentElement.scrollWidth,
  }));
  assert.ok(
    width.actual <= width.viewport + 1,
    "Editing must fit a phone viewport",
  );
  if (process.env.STUDIO_CAPTURE_DIR)
    await page.screenshot({
      path: `${process.env.STUDIO_CAPTURE_DIR}/image-edit-mobile.png`,
      fullPage: true,
    });
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(
    "Image creation/edit drafts, scoped uncensored profiles, original-preserving upload/reuse, pixel guards, paused/mobile UI, recipes and prompt bounds passed. Intercepted fixtures; no GPU work.",
  );
} catch (error) {
  console.error(
    "Image fixture failure state:",
    await page
      .locator(".notice, .creation-form, .image-edit-source")
      .allTextContents(),
  );
  throw error;
} finally {
  await context.close();
  await browser.close();
}
