// Clean-install UI fixtures only: no download or generation action is submitted.
import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
assert.equal(process.env.STUDIO_UI_HARNESS, "1", "Use npm run test:ui.");
fs.mkdirSync(".local", { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.STUDIO_CHROMIUM,
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const errors = [],
    writes = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (["POST", "PUT", "DELETE"].includes(request.method()))
      writes.push(request.url());
  });
  await page.route("**/api/tools", (route) => route.fulfill({ json: [] }));
  await page.request.get(process.env.STUDIO_URL + "/api/session");
  const response = await page.request.get(
    process.env.STUDIO_URL + "/api/setup",
  );
  assert.equal(response.status(), 200);
  const setup = await response.json();
  assert.ok(
    setup.tools.length >= 4,
    "The complete installer catalog is available.",
  );
  await page.goto(process.env.STUDIO_URL);
  await page
    .getByRole("heading", { name: "Prepare your local creation tools" })
    .waitFor();
  await page
    .getByRole("button", { name: "Set up Studio", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Set up creation tools", exact: true })
    .waitFor();
  await page.locator(".setup-tool").first().waitFor();
  assert.equal(await page.locator(".setup-tool").count(), setup.tools.length);
  for (const tool of setup.tools) {
    const card = page.locator(".setup-tool").filter({
      has: page.getByRole("heading", { name: tool.title, exact: true }),
    });
    assert.equal(await card.count(), 1, tool.id);
    if (tool.state !== "ready") {
      assert.match(
        await card.locator(".setup-download-details").innerText(),
        /Download.*Disk required.*License/s,
      );
      if (tool.source_url)
        assert.ok(await card.locator(`a[href="${tool.source_url}"]`).count());
    }
  }
  assert.match(await page.locator(".setup-system").innerText(), /Studio host/);
  assert.deepEqual(writes, [], "Browsing setup must never start downloads.");
  await page.screenshot({ path: ".local/ui-clean-setup.png", fullPage: true });
  await page
    .locator("main .settings-tabs")
    .getByRole("button", { name: "Default choices", exact: true })
    .click();
  await page.getByRole("heading", { name: "Default creation tools" }).waitFor();
  assert.deepEqual(
    await page
      .getByLabel("Writing model", { exact: true })
      .locator("option")
      .allTextContents(),
    ["Recommended automatically"],
  );
  await page
    .locator("main .settings-tabs")
    .getByRole("button", { name: "Setup & downloads", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Set up creation tools", exact: true })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.screenshot({
    path: ".local/ui-clean-setup-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  console.log(
    `Clean setup passed: ${setup.tools.length} catalog cards, source/license/size disclosures, no unavailable defaults, mobile layout and no downloads.`,
  );
} finally {
  await browser.close();
}
