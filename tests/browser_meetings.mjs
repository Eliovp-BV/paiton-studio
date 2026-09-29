import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const output = process.env.STUDIO_CAPTURE_DIR || ".local/ui-tests";
await mkdir(output, { recursive: true });
const base = process.env.STUDIO_TEST_URL || "http://127.0.0.1:8897";
assert.notEqual(new URL(base).port, "8877");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (r) => {
  if (r.status() >= 400 && r.url().includes("/api/"))
    errors.push(r.status() + " " + r.url());
});
try {
  await page.goto(base + "/#home");
  await page.locator(".new-project-tile").click();
  // Home retains the explicit Meetings entry outside the seven primary sections.
  // Missing readiness offers setup without starting a runtime; Create keeps four tiles.
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation.getByRole("button", { name: "Home", exact: true }).click();
  assert.equal(
    await page.locator(".creative-actions .creative-action").count(),
    4,
  );
  await page
    .locator(".home-quick")
    .getByRole("button", { name: /Set up Meetings/ })
    .click();
  assert.equal(
    await navigation
      .getByRole("button", { name: "Meetings", exact: true })
      .count(),
    0,
  );
  await page
    .getByRole("heading", { name: "Transcribe your meeting", exact: true })
    .waitFor();
  // A one-second silence fixture checks import and persistence only, never inference.
  const wav = Buffer.alloc(44 + 32000);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(32000, 40);
  await page.getByLabel("Import meeting recording").setInputFiles({
    name: "Browser import fixture.wav",
    mimeType: "audio/wav",
    buffer: wav,
  });
  await page
    .getByText("Recording imported. Ready for local processing.", {
      exact: true,
    })
    .waitFor();
  await page
    .getByRole("button", {
      name: "Transcribe and summarize locally",
      exact: true,
    })
    .waitFor();
  assert.equal(await page.locator(".meeting-result audio").count(), 1);
  await page.reload();
  await page
    .locator(".meeting-list")
    .getByRole("button", { name: /Browser import fixture/ })
    .click();
  await page
    .getByText("Recording imported. Ready for local processing.", {
      exact: true,
    })
    .waitFor();
  await page.screenshot({
    path: `${output}/meetings-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => ({
    width: innerWidth,
    document: document.documentElement.scrollWidth,
    elements: [...document.querySelectorAll("body *")]
      .map((node) => ({
        tag: node.tagName,
        className: node.className,
        text: node.textContent?.slice(0, 140),
        parent: node.parentElement?.className,
        width: node.getBoundingClientRect().width,
        right: node.getBoundingClientRect().right,
      }))
      .filter((box) => box.width > innerWidth || box.right > innerWidth + 1)
      .slice(-20),
  }));
  assert.ok(overflow.document <= overflow.width + 1, JSON.stringify(overflow));
  await page.screenshot({
    path: `${output}/meetings-mobile.png`,
    fullPage: true,
  });
  await page.getByText("Recording storage & deletion", { exact: true }).click();
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", {
      name: "Delete recording and derived content",
      exact: true,
    })
    .click();
  await page
    .getByText("Your imported recordings will appear here.", { exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Meetings browser passed: navigation, real audio decoding/upload, project persistence, playback, deletion and responsive layout; no inference submitted.",
  );
} finally {
  await browser.close();
}
