// Capture every Create route before changing its layout. Geometry accompanies
// the private screenshots so the gate can run from a clean source checkout.
import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const baselinePath = new URL("./create-layout-baseline.json", import.meta.url);
const output = process.env.STUDIO_CAPTURE_DIR;
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const measurements = {};
const errors = [];
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(
    (project) => localStorage.setItem("studio-project", project),
    process.env.STUDIO_PROJECT,
  );
  const routes = [
    ["image", "#creation-prompt", "Generate image"],
    ["video", "#creation-prompt", "Generate video"],
    ["write", "textarea", "Generate a new draft"],
    ["page", ".site-brief-input", "Generate website"],
  ];
  for (const [width, height] of [
    [1440, 900],
    [1024, 700],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    for (const [route, selector, action] of routes) {
      await page.goto(`${process.env.STUDIO_TEST_URL}/#${route}`);
      await page.locator(`main[data-studio-page="${route}"]`).waitFor();
      if (route === "page")
        await page
          .getByRole("button", { name: "Full website", exact: true })
          .click();
      const prompt = page.locator(`main ${selector}`).first();
      const generate = page.getByRole("button", { name: action, exact: true });
      await prompt.waitFor();
      await generate.waitFor();
      if (route === "video") {
        const selectedSource = await page
          .getByLabel("Source image", { exact: true })
          .locator("option:checked")
          .textContent();
        assert.equal(
          await page.locator(".generation-source").innerText(),
          `Source: ${selectedSource}`,
        );
      }
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(
          [...document.images].map((image) => image.decode().catch(() => {})),
        );
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        scrollTo(0, 0);
      });
      const key = `${route}-${width}x${height}`;
      const rounded = (box) =>
        Object.fromEntries(
          Object.entries(box).map(([key, value]) => [key, Math.round(value)]),
        );
      measurements[key] = {
        prompt: rounded(await prompt.boundingBox()),
        generate: rounded(await generate.boundingBox()),
        pageWidth: await page.evaluate(
          () => document.documentElement.scrollWidth,
        ),
      };
      await page.screenshot({
        path: path.join(output, `${key}.png`),
        animations: "disabled",
        fullPage: true,
      });
    }
  }
  await writeFile(
    path.join(output, "create-layout.json"),
    JSON.stringify(measurements, null, 2) + "\n",
  );
  for (const [key, actual] of Object.entries(measurements)) {
    const [width, height] = key.split("-")[1].split("x").map(Number);
    for (const element of ["prompt", "generate"]) {
      const box = actual[element];
      assert.ok(
        box.y >= 0 && box.y + box.height <= height,
        `${key} ${element} must fit in the first viewport: ${box.y}–${box.y + box.height}`,
      );
      assert.ok(
        box.x >= 0 && box.x + box.width <= width,
        `${key} ${element} must fit horizontally`,
      );
    }
    assert.ok(actual.pageWidth <= width + 1, `${key} has horizontal overflow`);
  }
  if (process.env.STUDIO_UPDATE_LAYOUT === "1") {
    await writeFile(baselinePath, JSON.stringify(measurements, null, 2) + "\n");
  } else if (process.env.STUDIO_CAPTURE_LAYOUT !== "1") {
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    assert.deepEqual(Object.keys(measurements), Object.keys(baseline));
    for (const [key, actual] of Object.entries(measurements)) {
      for (const element of ["prompt", "generate"]) {
        for (const coordinate of ["x", "y", "width", "height"]) {
          assert.ok(
            Math.abs(
              actual[element][coordinate] - baseline[key][element][coordinate],
            ) <= 3,
            `${key} ${element}.${coordinate} changed: ${baseline[key][element][coordinate]} → ${actual[element][coordinate]}; review screenshots before updating the layout gate.`,
          );
        }
      }
      assert.ok(
        actual.pageWidth <= baseline[key].pageWidth + 1,
        `${key} gained horizontal overflow`,
      );
    }
  }
  await page.goto(`${process.env.STUDIO_TEST_URL}/#home`);
  const launcher = page.getByLabel("Describe your idea", { exact: true });
  assert.equal(await launcher.count(), 1, "Studio has one creative launcher");
  await page.keyboard.press("Control+k");
  assert.ok(
    await launcher.evaluate((element) => element === document.activeElement),
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".command-menu").count(), 0);
  await page.keyboard.press("Control+Shift+k");
  await page.getByRole("dialog", { name: /^Search / }).waitFor();
  assert.equal(
    await page.locator(".command-menu").count(),
    0,
    "The project-search shortcut must not open the creative launcher",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Create layout gate passed: 12 route/viewport screenshots and prompt/action geometry.",
  );
} finally {
  await browser.close();
}
