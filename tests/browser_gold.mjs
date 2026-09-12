// Real API navigation/persistence checks on an isolated worker-disabled Studio.
import { chromium } from "playwright";
import assert from "node:assert/strict";
const base = process.env.STUDIO_TEST_URL || "http://127.0.0.1:8897";
assert.notEqual(new URL(base).port, "8877");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } }),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(base + "/#home");
  await page.locator(".new-project-tile").click();
  await page.locator("main[data-studio-page=image]").waitFor();
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Gold identity regression");
  await page.getByLabel("Project name", { exact: true }).blur();
  await page.waitForTimeout(900);
  await page.goto(base + "/#home");
  await page
    .locator(".home-idea input")
    .fill("A quiet forest in morning light");
  await page
    .locator(".home-idea .command-menu")
    .getByRole("button", { name: /Create an image/ })
    .click();
  assert.equal(
    await page.locator("#creation-prompt").inputValue(),
    "A quiet forest in morning light",
  );
  await page.waitForTimeout(900);
  await page.reload();
  await page.locator("#creation-prompt").waitFor();
  assert.equal(
    await page.locator("#creation-prompt").inputValue(),
    "A quiet forest in morning light",
  );
  for (const [width, height] of [
    [2560, 1440],
    [1920, 1080],
    [1600, 900],
    [1440, 900],
    [1366, 768],
    [850, 900],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    for (const route of [
      "home",
      "projects",
      "image",
      "video",
      "chat",
      "agents",
      "mcp",
      "meetings",
      "delivery",
      "write",
      "page",
      "library",
      "tools",
      "settings",
      "wiki",
    ]) {
      await page.goto(base + "/#" + route);
      await page.locator(`main[data-studio-page="${route}"]`).waitFor();
      await page.waitForTimeout(80);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      );
      assert.equal(overflow, false, `${route}: overflow at ${width}`);
      if (route === "home" && width > 1150) {
        const hardware = await page
          .locator(".creative-journey .machine-details")
          .boundingBox();
        assert.ok(
          hardware.y + hardware.height <= height + 1,
          `Hardware outside viewport at ${width}x${height}`,
        );
        const aside = await page.locator(".creative-journey").boundingBox(),
          shelf = await page.locator(".creative-project-grid").boundingBox();
        assert.ok(
          shelf.y >= aside.y + aside.height - 1,
          `Projects overlap machine at ${width}`,
        );
      }
    }
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(base + "/#settings");
  await page
    .getByRole("button", { name: "System & drivers", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Operating system & driver", exact: true })
    .waitFor();
  await page.goto(base + "/#home");
  await page
    .getByRole("button", { name: /^Queue/ })
    .first()
    .click();
  await page.getByRole("heading", { name: /Creation queue/ }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Gold UI passed: real project creation, idea handoff, local save/reload, all 15 routes at seven widths, no shelf overlap, hardware, queue and no JS errors. No inference submitted.",
  );
} finally {
  await browser.close();
}
