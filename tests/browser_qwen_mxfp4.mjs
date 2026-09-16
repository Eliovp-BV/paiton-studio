// Run against an isolated Studio workspace with the prepared MXFP4 package.
// Real API/UI checks; no generation requests or mocked inference responses.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";

assert.ok(process.env.STUDIO_URL, "Set STUDIO_URL to an isolated test Studio");
assert.ok(
  process.env.STUDIO_PROJECT,
  "Set STUDIO_PROJECT to its test project ID",
);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400)
      errors.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  await page.addInitScript((project) => {
    localStorage.setItem("studio-project", project);
  }, process.env.STUDIO_PROJECT);
  await page.goto(process.env.STUDIO_URL + "/#chat");
  const model = page.getByLabel("Reply model", { exact: true });
  const effort = page.getByLabel("Reasoning effort");
  const recommended = page.getByRole("button", {
    name: "Recommended",
    exact: true,
  });
  await recommended.waitFor();
  assert.equal(await model.inputValue(), "auto");
  assert.equal(await recommended.getAttribute("aria-pressed"), "true");
  assert.ok(await effort.isDisabled());
  assert.match(
    await effort.locator("option:checked").textContent(),
    /Direct answers/,
  );
  await page
    .getByLabel("Conversation mode", { exact: true })
    .selectOption("code");
  assert.equal(await recommended.getAttribute("aria-pressed"), "true");
  await model.selectOption("gptoss-chat");
  assert.ok(await effort.isEnabled());
  await effort.selectOption("high");
  await recommended.click();
  assert.equal(await model.inputValue(), "qwen38-mxfp4-chat");
  assert.ok(await effort.isDisabled());
  assert.equal(
    await effort.inputValue(),
    "low",
    "Do not imply DFlash2 runs deeper reasoning",
  );
  await model.selectOption("minicpm5-chat");
  assert.ok(await effort.isDisabled());
  await model.selectOption("auto");
  assert.equal(await recommended.getAttribute("aria-pressed"), "true");

  const tools = await page.evaluate(async () =>
    (await fetch("/api/tools")).json(),
  );
  const newModel = tools.find((tool) => tool.id === "qwen38-mxfp4");
  assert.equal(newModel.state, "ready");
  assert.deepEqual(newModel.default_for, ["write", "website", "chat", "code"]);
  assert.equal(newModel.profiles.length, 3);
  assert.ok(
    tools.find((tool) => tool.id === "qwen38"),
    "Keep Qronos available",
  );
  const setup = await page.evaluate(async () =>
    (await fetch("/api/setup")).json(),
  );
  assert.ok(JSON.stringify(setup).includes("Qwen3.8 27B MXFP4 + DFlash2"));
  await page
    .getByText("Model choices & document limits", { exact: true })
    .click();
  await page
    .getByText("Recommended local text model.", { exact: false })
    .first()
    .waitFor();
  fs.mkdirSync(".local/qwen38-qualification", { recursive: true });
  await page.screenshot({
    path: ".local/qwen38-qualification/chat-ui.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "MXFP4 live UI: automatic selection, Code, model switching, reasoning controls, setup and API checks passed.",
  );
} finally {
  await browser.close();
}
