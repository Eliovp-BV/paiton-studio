import { chromium } from "playwright";
import assert from "node:assert/strict";
const base = process.env.STUDIO_TEST_URL || "http://127.0.0.1:8897";
assert.notEqual(new URL(base).port, "8877");
const b = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
let onlineChecks = 0;
try {
  await p.goto(base + "/#home");
  await p.locator(".new-project-tile").click();
  await p
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Agents", exact: true })
    .click();
  await p.getByRole("heading", { name: "What is your purpose?" }).waitFor();
  for (const width of [2560, 1920, 1440, 1366, 390]) {
    await p.setViewportSize({ width, height: 900 });
    const section = await p.locator(".agents-studio").boundingBox();
    const form = await p.locator(".agent-builder").boundingBox();
    assert.ok(
      Math.abs(section.width - form.width) < 3,
      "Agent builder must use available workspace width at " + width,
    );
    assert.ok(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
  }
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.screenshot({ path: ".local/agents-full-width.png", fullPage: true });
  await p.route("**/api/host-guidance", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.needs_attention = true;
    data.checks = [
      {
        id: "gpu_detection",
        severity: "warning",
        title: "Radeon compute is not detected",
        message: "Check the GPU driver and passthrough on the Studio host.",
      },
    ];
    data.source.os_matches_documentation = false;
    data.source.os_message =
      "This fixture OS is not supported by the referenced installer.";
    await route.fulfill({ json: data });
  });
  await p.route("**/api/host-guidance/check-source", async (route) => {
    onlineChecks++;
    await route.fulfill({
      json: {
        state: "unavailable",
        message:
          "Online source check unavailable. Your local creation tools are unaffected.",
      },
    });
  });
  await p.reload();
  await p.locator(".host-notice").waitFor();
  assert.equal(onlineChecks, 0);
  await p.getByRole("button", { name: "Review system setup" }).click();
  await p
    .getByRole("heading", { name: "System setup & driver guidance" })
    .waitFor();
  await p.locator(".host-source summary").click();
  assert.equal(onlineChecks, 0);
  assert.equal(
    await p
      .getByRole("button", { name: /Install driver|Run installer/ })
      .count(),
    0,
  );
  await p
    .getByRole("button", { name: "Check community source online" })
    .click();
  await p.locator(".host-source-result").waitFor();
  assert.equal(onlineChecks, 1);
  await p.screenshot({
    path: ".local/host-guidance-warning.png",
    fullPage: true,
  });
  await p.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await p.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "Passed: full-width Agents at five sizes; simulated missing GPU warning, setup routing, unsupported OS, explicit online check, offline result, no installer execution.",
  );
} finally {
  await b.close();
}
