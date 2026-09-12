import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(process.env.STUDIO_URL || "http://127.0.0.1:8877");
await page
  .getByRole("heading", { name: "Create without the cloud." })
  .waitFor();
await page.screenshot({ path: ".local/home.png", fullPage: true });
const target = await page.evaluate(async () => {
  const projects = await (await fetch("/api/projects")).json();
  for (const p of projects) {
    const detail = await (await fetch("/api/projects/" + p.id)).json();
    const source = detail.assets.find((a) => a.kind === "image");
    if (source) {
      const token = (await (await fetch("/api/session")).json()).token;
      const headers = {
        "X-Studio-Token": token,
        "Content-Type": "application/json",
      };
      const created = await (
        await fetch("/api/projects", { method: "POST", headers, body: "{}" })
      ).json();
      await fetch("/api/projects/" + created.id, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          name: "Browser verification",
          state: {},
          revision: created.revision,
        }),
      });
      const body = new FormData();
      body.append(
        "file",
        await (await fetch("/api/assets/" + source.id)).blob(),
        "verified-source.png",
      );
      await fetch("/api/projects/" + created.id + "/import", {
        method: "POST",
        headers: { "X-Studio-Token": token },
        body,
      });
      localStorage.setItem("studio-project", created.id);
      return created.id;
    }
  }
  return null;
});
assert.ok(target, "Browser test needs a project with a real image");
await page.reload();
await page
  .getByRole("navigation", { name: "Main navigation" })
  .getByRole("button", { name: "Home", exact: true })
  .click();
await page
  .getByRole("heading", { name: "Create without the cloud." })
  .waitFor();
await page
  .getByRole("navigation")
  .getByRole("button", { name: "Projects", exact: true })
  .click();
await page.getByLabel("Project", { exact: true }).selectOption(target);
await page.waitForTimeout(500);
await page
  .getByRole("navigation")
  .getByRole("button", { name: "Image", exact: true })
  .click();
await page
  .locator("#creation-prompt")
  .fill("A quiet woodland scene for a small campaign");
await page.waitForTimeout(700);
await page.getByRole("button", { name: "Generate image", exact: true }).click();
const imageJob = page
  .locator(".queue-job")
  .filter({ has: page.getByText("Image", { exact: true }) })
  .first();
await imageJob.getByRole("button", { name: "Cancel", exact: true }).click();
await page.getByRole("button", { name: "Close queue", exact: true }).click();
await page
  .getByRole("navigation")
  .getByRole("button", { name: "Write", exact: true })
  .click();
await page
  .getByRole("textbox", { name: "Document editor" })
  .fill(
    "A quiet moment in the forest. This text was entered during a browser integration test.",
  );
await page.getByRole("button", { name: "Save revision", exact: true }).click();
await page.waitForTimeout(700);
await page
  .getByRole("navigation")
  .getByRole("button", { name: "Image", exact: true })
  .click();
assert.equal(
  await page.locator("#creation-prompt").inputValue(),
  "A quiet woodland scene for a small campaign",
);
await page
  .getByRole("button", { name: "Animate this", exact: true })
  .first()
  .click();
await page.getByAltText("Source image fitted to the video canvas").waitFor();
await page.waitForFunction(() => {
  const img = document.querySelector(".source-preview img");
  return img?.complete && img.naturalWidth > 0;
});
assert.ok(
  (await page.getByLabel("Source image", { exact: true }).inputValue()).length >
    0,
);
await page.screenshot({ path: ".local/video.png", fullPage: true });
await page
  .getByRole("navigation")
  .getByRole("button", { name: "Build Page", exact: true })
  .click();
await page.getByRole("button", { name: "Single page", exact: true }).click();
await page.getByLabel("Title", { exact: true }).fill("Woodland story");
await page
  .getByLabel("Page text", { exact: true })
  .fill("A locally saved story.");
await page.getByRole("checkbox").first().check();
await page.waitForTimeout(1000);
await page
  .getByRole("button", { name: "Refresh preview", exact: true })
  .click();
await page.waitForTimeout(700);
assert.equal(
  await page.frameLocator("iframe").getByRole("heading").innerText(),
  "Woodland story",
);
await page.getByRole("button", { name: "Preview mobile", exact: true }).click();
const download = page.waitForEvent("download");
await page
  .getByRole("button", { name: "Export page & project", exact: true })
  .click();
await (await download).saveAs(".local/browser-export.zip");
await page.screenshot({ path: ".local/page.png", fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
await page
  .getByRole("navigation")
  .getByRole("button", { name: "Home", exact: true })
  .click();
await page.screenshot({ path: ".local/mobile.png", fullPage: true });
assert.ok(
  await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  ),
);
await page.keyboard.press("Tab");
assert.ok(await page.evaluate(() => document.activeElement !== document.body));
assert.deepEqual(errors, []);
fs.writeFileSync(
  ".local/browser-results.json",
  JSON.stringify({
    passed: true,
    checks: [
      "navigation",
      "generation submission and cancellation",
      "isolated browser-test project",
      "draft persistence",
      "document revision",
      "real image handoff",
      "page selection",
      "sandbox preview",
      "ZIP download",
      "mobile overflow",
      "keyboard focus",
      "no JS exceptions",
    ],
  }),
);
await browser.close();
console.log("Browser workflow passed.");
