// CPU UI policy fixtures: availability is simulated; no model is installed or run.
import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";

assert.equal(process.env.STUDIO_UI_HARNESS, "1", "Use npm run test:ui.");
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
  await page.request.get(process.env.STUDIO_URL + "/api/session");
  const response = await page.request.get(
    process.env.STUDIO_URL + "/api/tools",
  );
  assert.equal(response.status(), 200);
  const tools = (await response.json()).map((tool) => ({
    ...tool,
    state: "ready",
    compatibility: { compatible: true },
    profiles: tool.profiles.map((profile) => ({
      ...profile,
      state: "ready",
      compatibility: { compatible: true },
    })),
  }));
  await page.route("**/api/tools", (route) => route.fulfill({ json: tools }));
  await page.addInitScript(
    (project) => localStorage.setItem("studio-project", project),
    process.env.STUDIO_PROJECT,
  );
  await page.goto(process.env.STUDIO_URL + "/#chat");
  await page.locator(".chat-reply-setup > summary").click();
  await page.locator(".chat-context-details > summary").click();
  const model = page.getByLabel("Conversation model", { exact: true });
  const effort = page.getByLabel("Reasoning effort");
  assert.equal(await model.inputValue(), "auto");
  assert.match(
    await model.locator("option:checked").textContent(),
    /Recommended automatically/,
  );
  await model.selectOption("gptoss-chat");
  assert.ok(await effort.isEnabled());
  await effort.selectOption("high");
  await model.selectOption("qwen38-mxfp4-chat");
  assert.ok(await effort.isDisabled());
  assert.equal(
    await effort.inputValue(),
    "low",
    "DFlash2 must not imply deeper reasoning.",
  );
  assert.match(
    await effort.locator("option:checked").textContent(),
    /Direct answers/,
  );
  await page
    .getByLabel("Conversation mode", { exact: true })
    .selectOption("code");
  assert.equal(await model.inputValue(), "qwen38-mxfp4-chat");
  assert.ok(await effort.isDisabled());
  await model.selectOption("minicpm5-chat");
  assert.ok(await effort.isDisabled());
  await model.selectOption("auto");
  const qwen = tools.find((tool) => tool.id === "qwen38-mxfp4");
  assert.ok(qwen.qualified, "The measured package stays qualified.");
  assert.deepEqual(qwen.default_for, ["write", "website", "chat", "code"]);
  assert.deepEqual(
    qwen.profiles.map((profile) => profile.id),
    ["qwen38-mxfp4-writing", "qwen38-mxfp4-website", "qwen38-mxfp4-chat"],
  );
  assert.ok(
    tools.find((tool) => tool.id === "qwen38"),
    "Keep Qronos available.",
  );
  assert.match(
    await model
      .locator('option[value="qwen38-mxfp4-chat"]')
      .getAttribute("title"),
    /MXFP4.*DFlash2/,
  );
  const setup = await (
    await page.request.get(process.env.STUDIO_URL + "/api/setup")
  ).json();
  assert.ok(
    setup.tools.some(
      (tool) => tool.id === "qwen38-mxfp4" && /MXFP4.*DFlash2/.test(tool.model),
    ),
  );
  fs.mkdirSync(".local/qwen38-qualification", { recursive: true });
  await page.screenshot({
    path: ".local/qwen38-qualification/chat-ui.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "MXFP4 UI fixtures: automatic recommendation, Code, model switching, direct-answer policy, qualified catalog and package setup passed; no inference.",
  );
} finally {
  await browser.close();
}
