// CPU/browser coverage only: isolated settings persistence and simulated hardware.
// This test never submits inference, changes drivers or starts model services.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const base = process.env.STUDIO_TEST_URL || "http://127.0.0.1:8897";
const endpoint = new URL(base);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname));
assert.notEqual(endpoint.port, "8877", "Use an isolated worker-disabled server.");
const artifacts = path.resolve(".local/cache-guardrails-20260912");
await mkdir(artifacts, { recursive: true });

// Produce simulated host responses with the real pure backend policy. The
// /api/system endpoint is deliberately left real; these are not hardware tests.
const python = process.env.STUDIO_PYTHON || path.resolve(".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const fixtures = JSON.parse(execFileSync(python, ["-c", `
import json
from copy import deepcopy
from studio.host_guidance import guidance
base = dict(platform=dict(system='Linux',machine='x86_64',distribution_id='ubuntu',distribution_version='24.04'),
            gpu=dict(driver_available=True,gpu_count=1,name='AMD Radeon AI PRO R9700',architecture='gfx1201',total=32*1024**3,available=False),
            driver=dict(version='fixture'),docker=dict(available=True),
            device_access=dict(kfd_exists=True,kfd_read_write=True,inaccessible_render_nodes=[]))
hosts = {}
host = deepcopy(base)
host['gpu'].update(name='RDNA3 test fixture', architecture='gfx1100', total=24*1024**3)
hosts['rdna3'] = guidance(host)
host = deepcopy(base)
host['gpu'].update(name='RDNA4 16 GB test fixture', total=16*1024**3)
hosts['rdna4_16gb'] = guidance(host)
host = deepcopy(base)
host['platform'].update(system='Windows', machine='AMD64')
host['gpu'] = dict(driver_available=False, gpu_count=0)
hosts['windows'] = guidance(host)
print(json.dumps(hosts))
`], { encoding: "utf8" }));

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const errors = [], apiErrors = [], forbidden = [], contexts = [];
let settingsContext, original;

async function newContext() {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  contexts.push(context);
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!["GET", "HEAD"].includes(request.method()) &&
        !(request.method() === "PUT" && url.pathname === "/api/settings")) {
      forbidden.push(`${request.method()} ${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  context.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/api/") && response.status() >= 400) {
      apiErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
    }
  });
  return context;
}

async function json(context, suffix) {
  const response = await context.request.get(base + "/api" + suffix);
  assert.equal(response.status(), 200, suffix);
  return response.json();
}

function inputSettings(value) {
  return Object.fromEntries(["defaults", "appearance", "generation", "performance"].map((key) => [key, value[key]]));
}

async function restoreSettings() {
  if (!settingsContext || !original) return;
  const { token } = await json(settingsContext, "/session");
  const response = await settingsContext.request.put(base + "/api/settings", {
    headers: { "X-Studio-Token": token }, data: inputSettings(original),
  });
  assert.equal(response.status(), 200, "Restore original private-server preferences");
  assert.deepEqual(inputSettings(await response.json()), inputSettings(original));
}

async function assertFits(page, description) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), description);
}

try {
  settingsContext = await newContext();
  await json(settingsContext, "/session");
  original = await json(settingsContext, "/settings");
  const page = await settingsContext.newPage();
  await page.goto(base + "/#settings");
  const select = page.getByLabel("Keep supported models ready for", { exact: true });
  await select.waitFor();
  const save = page.getByRole("button", { name: "Save preferences", exact: true });
  async function saveMinutes(minutes) {
    await select.selectOption(String(minutes));
    if (await save.isEnabled()) {
      await save.click();
      await page.getByText("Preferences saved on the Studio host.", { exact: true }).waitFor();
    }
    assert.equal((await json(settingsContext, "/settings")).performance.keep_ready_minutes, minutes);
    assert.equal((await json(settingsContext, "/status")).model_memory.keep_ready_minutes, minutes);
  }
  await saveMinutes(2);
  await saveMinutes(5);
  const saved = await json(settingsContext, "/settings");
  for (const field of ["defaults", "appearance", "generation"]) {
    assert.deepEqual(saved[field], original[field], `${field} must stay unchanged`);
  }
  await page.reload();
  await select.waitFor();
  assert.equal(await select.inputValue(), "5");
  assert.equal((await json(settingsContext, "/status")).model_memory.keep_ready_minutes, 5);
  const panel = page.getByRole("region", { name: "Model loading and memory" });
  await panel.getByText("No model kept ready between requests", { exact: true }).waitFor();
  await panel.getByText("Can system memory make switching faster?", { exact: true }).click();
  assert.match(await panel.innerText(), /path is not yet qualified/);
  for (const [width, height] of [[1600, 1000], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await panel.scrollIntoViewIfNeeded();
    await assertFits(page, `Memory settings overflow at ${width}`);
    await panel.screenshot({ path: path.join(artifacts, `memory-settings-${width}.png`) });
  }
  // Restore immediately so other read-only browser suites see their original
  // defaults, and repeat restoration in finally if a later assertion fails.
  await restoreSettings();

  for (const [name, fixture] of Object.entries(fixtures)) {
    const context = await newContext();
    await context.route("**/api/host-guidance", (route) => route.fulfill({ json: fixture }));
    const page = await context.newPage();
    await page.goto(base + "/#home");
    const banner = page.locator(".host-notice");
    await banner.waitFor();
    const firstWarning = fixture.checks.find((check) => check.severity === "warning");
    assert.match(await banner.innerText(), new RegExp(firstWarning.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok((await banner.innerText()).includes(firstWarning.message));
    if (name === "rdna4_16gb") {
      for (const [width, height] of [[1600, 1000], [390, 844]]) {
        await page.setViewportSize({ width, height });
        await banner.scrollIntoViewIfNeeded();
        await assertFits(page, `16 GB warning overflow at ${width}`);
        await banner.screenshot({ path: path.join(artifacts, `rdna4-16gb-warning-${width}.png`) });
      }
    }
    await banner.getByRole("button", { name: "Review system setup", exact: true }).click();
    const guidance = page.getByRole("region", { name: "Host setup and driver guidance" });
    await guidance.getByRole("heading", { name: "System setup & driver guidance" }).waitFor();
    const text = await guidance.innerText();
    for (const field of ["title", "message", "platform_message"]) {
      assert.ok(text.includes(fixture.consumer_support[field]), `${name}: missing consumer ${field}`);
    }
    if (fixture.consumer_support.memory_message) {
      assert.ok(text.includes(fixture.consumer_support.memory_message));
    }
    await assertFits(page, `${name}: system details overflow`);
    if (name === "windows") {
      assert.match(text, /Native Windows inference is not supported/);
      assert.equal(await guidance.getByRole("button", { name: /Install driver|Run installer/ }).count(), 0);
    }
    await context.close();
  }
  assert.deepEqual(forbidden, [], "No inference or runtime mutation was attempted");
  assert.deepEqual(errors, [], "No frontend exceptions");
  assert.deepEqual(apiErrors, [], "No failed browser API responses");
  console.log("Passed: private API 2→5 minute retention save/reload/status, other preferences preserved and restored; simulated RDNA3, 16 GB RDNA4 and Windows guardrails; desktop/mobile memory and warning layouts; no inference or frontend exceptions.");
} finally {
  try { await restoreSettings(); }
  finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
    await browser.close();
  }
}
