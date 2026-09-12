import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const studioUrl = process.env.STUDIO_URL || "http://127.0.0.1:8888";
fs.mkdirSync(".local", { recursive: true });
await page.goto(studioUrl);
await page.getByRole("heading", { name: "Create without the cloud." }).waitFor();
// This suite creates a manually authored website fixture. It never starts inference.
// Prefer an isolated worker-disabled Studio instance; original preferences are restored.
const originalSettings = await page.evaluate(async () =>
  (await fetch("/api/settings")).json(),
);
try {
  const fixture = await page.evaluate(async () => {
    const token = (await (await fetch("/api/session")).json()).token;
    const headers = {
      "X-Studio-Token": token,
      "Content-Type": "application/json",
    };
    await fetch("/api/settings", { method: "PUT", headers, body: "{}" });
    let sourceId = null;
    for (const candidate of await (await fetch("/api/projects")).json()) {
      const detail = await (
        await fetch("/api/projects/" + candidate.id)
      ).json();
      const image = detail.assets.find((asset) => asset.kind === "image");
      if (image) {
        sourceId = image.id;
        break;
      }
    }
    const project = await (
      await fetch("/api/projects", { method: "POST", headers, body: "{}" })
    ).json();
    await fetch("/api/projects/" + project.id, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        name: "Website editor verification",
        state: {},
        revision: project.revision,
      }),
    });
    if (sourceId) {
      const form = new FormData();
      form.append(
        "file",
        await (await fetch("/api/assets/" + sourceId)).blob(),
        "real-source-verification.png",
      );
      const result = await fetch("/api/projects/" + project.id + "/import", {
        method: "POST",
        headers: { "X-Studio-Token": token },
        body: form,
      });
      if (!result.ok)
        throw Error(
          "Could not copy the real source image into the verification project.",
        );
    }
    localStorage.setItem("studio-project", project.id);
    return { id: project.id, hasImage: !!sourceId };
  });
  await page.reload();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await page.getByRole("heading", { name: "Create without the cloud." }).waitFor();
  if (!fixture.hasImage) {
    assert.ok(
      process.env.STUDIO_TEST_IMAGE,
      "An existing real image or STUDIO_TEST_IMAGE is required; no image is simulated.",
    );
    await page
      .locator("input[type=file]")
      .setInputFiles(process.env.STUDIO_TEST_IMAGE);
  } else {
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Projects", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Animate this", exact: true })
      .first()
      .click();
  }
  await page.getByAltText("Source image fitted to the video canvas").waitFor();
  await page.waitForFunction(
    () => document.querySelector(".source-preview img")?.naturalWidth > 0,
  );
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Write", exact: true })
    .click();
  await page.getByLabel("Writing model", { exact: true }).waitFor();
  const options = await page
    .getByLabel("Writing model", { exact: true })
    .locator("option")
    .allTextContents();
  assert.ok(options[0].includes("Recommended automatically"));
  assert.ok(options.some((text) => text.includes("Qwen3.8")));
  assert.ok(!options.some((text) => /FLUX|MiniMax|Website plan/.test(text)));
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Default creation tools" }).waitFor();
  await page
    .getByLabel("Writing model", { exact: true })
    .selectOption("qwen38-writing");
  await page.getByLabel("Compact queue history").check();
  await page.getByRole("button", { name: "Save preferences" }).click();
  await page.getByText("Preferences saved on the Studio host.").waitFor();
  await page.screenshot({
    path: ".local/ui-expansion-settings.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Studio wiki", exact: true }).click();
  await page.getByRole("heading", { name: "Studio wiki" }).waitFor();
  await page.getByLabel("Search the wiki").fill("first frame");
  assert.ok(
    (await page.locator(".wiki-article").count()) ||
      (await page.getByText("No articles found").count()),
  );
  await page.getByLabel("Search the wiki").fill("");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Build Page", exact: true })
    .click();
  await page.getByRole("button", { name: "Full website", exact: true }).click();
  await page
    .getByLabel("What would you like to build?")
    .fill("A manually entered verification website for the woodland image.");
  await page.getByLabel("Pages", { exact: true }).selectOption("2");
  await page.getByLabel("New artwork", { exact: true }).selectOption("0");
  await page.waitForTimeout(650);
  const response = await page.evaluate(async (id) => {
    const token = (await (await fetch("/api/session")).json()).token;
    const headers = {
      "X-Studio-Token": token,
      "Content-Type": "application/json",
    };
    const project = await (await fetch("/api/projects/" + id)).json();
    const image = project.assets.find((asset) => asset.kind === "image");
    const site = {
      title: "Woodland · browser fixture",
      theme: "light",
      revision: 0,
      pages: [
        {
          slug: "index",
          title: "Welcome",
          description: "Manually authored browser verification content.",
          sections: [
            {
              heading: "A quiet place",
              body: "This page verifies editing with a real project image, without inference.",
              asset_ids: [image.id],
            },
          ],
        },
        {
          slug: "our-story",
          title: "Our story",
          description: "The second page is linked to the first.",
          sections: [
            {
              heading: "Made locally",
              body: "These fixture words are manually entered for browser verification.",
              asset_ids: [],
            },
          ],
        },
      ],
    };
    const result = await fetch("/api/projects/" + id + "/website", {
      method: "PUT",
      headers,
      body: JSON.stringify(site),
    });
    return result.status;
  }, fixture.id);
  assert.equal(response, 200);
  await page.getByRole("heading", { name: "Your site map" }).waitFor();
  await page
    .getByRole("navigation", { name: "Website pages" })
    .getByRole("button", { name: "Our story" })
    .click();
  await page
    .frameLocator('iframe[title="Website preview"]')
    .getByRole("heading", { name: "Our story", exact: true })
    .waitFor();
  await page
    .getByLabel("Page title", { exact: true })
    .fill("Our woodland story");
  await page.getByRole("button", { name: "Save website changes" }).click();
  await page
    .getByText(
      "Website changes saved. The preview now shows your latest version.",
    )
    .waitFor();
  await page
    .frameLocator('iframe[title="Website preview"]')
    .getByRole("heading", { name: "Our woodland story", exact: true })
    .waitFor();
  await page
    .frameLocator('iframe[title="Website preview"]')
    .getByRole("link", { name: "Welcome", exact: true })
    .first()
    .click();
  await page
    .frameLocator('iframe[title="Website preview"]')
    .getByRole("heading", { name: "Welcome", exact: true })
    .waitFor();
  await page.screenshot({
    path: ".local/ui-expansion-website-fixture.png",
    fullPage: true,
  });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export full website" }).click();
  await (await download).saveAs(".local/ui-expansion-website-fixture.zip");
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .frameLocator('iframe[title="Website preview"]')
    .getByRole("heading", { name: "Welcome", exact: true })
    .waitFor();
  await page.screenshot({
    path: ".local/ui-expansion-website-mobile-fixture.png",
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Website has mobile overflow",
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  assert.equal(
    await page.getByLabel("Writing model", { exact: true }).inputValue(),
    "qwen38-writing",
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Settings has mobile overflow",
  );
  await page.getByRole("button", { name: "Studio wiki", exact: true }).click();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Wiki has mobile overflow",
  );
  // UI-only profile fixture: verifies per-profile compatibility overrides package state.
  // These profiles are never sent to Studio's real job API or presented as supported models.
  const compatibilityPage = await browser.newPage();
  await compatibilityPage.route("**/api/tools", (route) =>
    route.fulfill({
      json: [
        {
          id: "ui-rendering-fixture",
          name: "Compatibility rendering fixture",
          model: "UI fixture",
          state: "ready",
          profiles: [
            {
              id: "fixture-small",
              task: "image",
              roles: ["image"],
              label: "Small profile",
              state: "ready",
              compatibility: {
                compatible: true,
                required_vram_gib: 4,
                detected_vram_gib: 16,
              },
            },
            {
              id: "fixture-large",
              task: "image",
              roles: ["image"],
              label: "Large profile",
              state: "incompatible",
              compatibility: {
                compatible: false,
                required_vram_gib: 40,
                detected_vram_gib: 16,
                reason:
                  "The profile needs more memory than this test fixture provides.",
              },
            },
          ],
        },
      ],
    }),
  );
  await compatibilityPage.goto(studioUrl);
  await compatibilityPage
    .getByRole("heading", { name: "Create without the cloud." })
    .waitFor();
  await compatibilityPage
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  const compatibilitySelect = compatibilityPage.getByLabel(
    "Image creation model",
    { exact: true },
  );
  await compatibilitySelect.waitFor();
  assert.equal(
    await compatibilitySelect
      .locator('option[value="fixture-small"]')
      .evaluate((option) => option.disabled),
    false,
  );
  assert.equal(
    await compatibilitySelect
      .locator('option[value="fixture-large"]')
      .evaluate((option) => option.disabled),
    true,
  );
  await compatibilityPage.close();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      fixtureProject: fixture.id,
      checks: [
        "real image import and fitting",
        "Qwen3.8 compatible writing choice",
        "exclude video/image/website profiles from writing",
        "persisted settings",
        "searchable offline wiki",
        "website brief and page editing",
        "linked sandbox preview",
        "website ZIP export",
        "mobile website/settings/wiki overflow",
        "per-profile compatibility overrides package availability (UI fixture)",
        "no JavaScript errors",
      ],
      inference:
        "none: manually authored website fixture; no generation request submitted",
    }),
  );
} finally {
  await page.evaluate(async (settings) => {
    const token = (await (await fetch("/api/session")).json()).token;
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "X-Studio-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        defaults: settings.defaults,
        appearance: settings.appearance,
        generation: settings.generation,
      }),
    });
    if (!response.ok)
      throw Error("Could not restore original Studio preferences.");
  }, originalSettings);
  await browser.close();
}
