import { chromium } from "playwright";
import assert from "node:assert/strict";
const base = process.env.STUDIO_TEST_URL || "http://127.0.0.1:8897";
assert.notEqual(new URL(base).port, "8877");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(base + "/#home");
  await page.locator(".new-project-tile").click();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Agents", exact: true })
    .click();
  await page.getByRole("heading", { name: "What is your purpose?" }).waitFor();
  await page.locator(".agent-templates button").first().click();
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await page
    .getByLabel("What should this agent work on?")
    .fill("Summarise these facts: our workshop opens Monday at 9.");
  await page.getByRole("button", { name: "Run agent", exact: true }).click();
  await page.getByRole("heading", { name: "Drafting", exact: true }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "Drafting", exact: true }).waitFor();
  await page.getByRole("button", { name: /Stop/ }).click();
  await page.getByText("cancelled", { exact: true }).first().waitFor();
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSize,
    ),
    "16px",
  );
  await page.screenshot({ path: ".local/agents-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.screenshot({ path: ".local/agents-mobile.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    "Agents passed: purpose template, create, durable queue, refresh, cancel, readable typography, narrow layout.",
  );
} finally {
  await browser.close();
}
