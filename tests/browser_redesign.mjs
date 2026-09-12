// Run against an isolated worker-disabled Studio. Real API persistence; no inference.
import { chromium } from "playwright";
import assert from "node:assert/strict";
const base = process.env.STUDIO_TEST_URL || "http://127.0.0.1:8897";
assert.notEqual(new URL(base).port, "8877", "Use an isolated test workspace.");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
});
const errors = [],
  bad = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (r) => {
  if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`);
});
const nav = (label) =>
  page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: label, exact: true });
try {
  await page.goto(base + "/#home");
  await page
    .getByRole("heading", { name: "Create without the cloud." })
    .waitFor();
  await page.locator(".new-project-tile").click();
  await page.locator("main[data-studio-page=image]").waitFor();
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Redesign workflow checks");
  await page.getByLabel("Project name", { exact: true }).blur();
  await page
    .getByLabel("Describe your idea", { exact: true })
    .fill("A yellow ceramic teapot in a cinematic studio");
  await page
    .locator(".command-menu")
    .getByRole("button", { name: /Create an image/ })
    .click();
  assert.equal(
    await page.locator("#creation-prompt").inputValue(),
    "A yellow ceramic teapot in a cinematic studio",
  );
  await page.waitForTimeout(900);
  await page.reload();
  await page.locator("#creation-prompt").waitFor();
  assert.equal(new URL(page.url()).hash, "#image");
  assert.equal(
    await page.locator("#creation-prompt").inputValue(),
    "A yellow ceramic teapot in a cinematic studio",
  );
  await page
    .getByLabel("Describe your idea", { exact: true })
    .fill("Help me plan a short product story.");
  await page
    .locator(".command-menu")
    .getByRole("button", { name: /Explore with GPTPaiton/ })
    .click();
  await page.getByLabel("Message GPTPaiton").waitFor();
  assert.equal(
    await page.getByLabel("Message GPTPaiton").inputValue(),
    "Help me plan a short product story.",
  );
  await page
    .getByRole("button", { name: "Quick replies", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Reply model", { exact: true }).inputValue(),
    "minicpm5-chat",
  );
  assert.equal(await page.getByLabel("Reasoning effort").isDisabled(), true);
  await page.getByText(/Expect lower quality on complex questions/).waitFor();
  await page.getByRole("button", { name: "Deeper work", exact: true }).click();
  assert.equal(await page.getByLabel("Reasoning effort").isDisabled(), false);
  await page
    .getByRole("button", { name: "Creation tools", exact: true })
    .click();
  await page.locator(".installed-packages > summary").click();
  await page
    .locator(".tool")
    .filter({ hasText: "Small local chat & code" })
    .getByRole("button", { name: "Open workspace", exact: true })
    .click();
  await page.getByLabel("Reply model", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Reply model", { exact: true }).inputValue(),
    "minicpm5-chat",
  );
  await nav("Home").click();
  for (const [width, height] of [
    [2560, 1440],
    [1920, 1080],
    [1600, 900],
    [1440, 900],
    [1366, 768],
  ]) {
    await page.setViewportSize({ width, height });
    const box = await page
      .locator(".creative-journey .machine-details")
      .boundingBox();
    assert.ok(box.y + box.height <= height, `Hardware visible at ${width}`);
    const shelf = await page.locator(".creative-project-grid").boundingBox();
    const create = await page.locator(".new-project-tile").boundingBox();
    const journey = await page.locator(".creative-journey").boundingBox();
    assert.ok(
      create.x + create.width <= shelf.x + shelf.width + 1,
      `New-project control stays inside shelf at ${width}`,
    );
    assert.ok(
      shelf.y >= journey.y + journey.height - 1,
      `Journey cannot cover project actions at ${width}`,
    );

    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      true,
    );
  }
  await page
    .getByRole("button", { name: /System details & compatibility/ })
    .click();
  await page
    .getByRole("heading", { name: "Operating system & driver", exact: true })
    .waitFor();
  await nav("Home").click();
  await page.getByRole("button", { name: "Toggle navigation rail" }).click();
  assert.equal(
    await page
      .locator(".studio-shell")
      .evaluate((e) => e.classList.contains("nav-collapsed")),
    true,
  );
  await page.getByRole("button", { name: "Toggle navigation rail" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [route, label] of [
    ["home", "Home"],
    ["image", "Image"],
    ["video", "Video"],
    ["write", "Write"],
    ["chat", "GPT"],
    ["page", "Build Page"],
    ["library", "Library"],
    ["delivery", "Reels & shorts"],
  ]) {
    await nav(label).click();
    await page.locator(`main[data-studio-page=${route}]`).waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      true,
      route + " mobile overflow",
    );
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(bad, []);
  console.log(
    "Redesign passed: new project, launcher handoff, autosave/deep-link reload, MiniCPM speed/quality controls, capability routing, visible hardware at five desktop sizes, collapsed rail, mobile tool layouts; no inference.",
  );
} finally {
  await browser.close();
}
