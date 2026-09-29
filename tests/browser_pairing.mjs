import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";
const base = process.env.STUDIO_URL;
const browser = await chromium.launch();
const owner = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// A forwarded request has no local-owner authority, even on this loopback fixture.
const remote = await browser.newPage({
  viewport: { width: 390, height: 844 },
  extraHTTPHeaders: { "x-forwarded-for": "192.0.2.20" },
});
const errors = [];
for (const page of [owner, remote])
  page.on("pageerror", (error) => errors.push(error.message));
let jobs = 0;
remote.on("request", (request) => {
  if (request.method() === "POST" && /\/jobs(?:\?|$)/.test(request.url()))
    jobs++;
});
try {
  await remote.goto(base);
  await remote
    .getByRole("heading", { name: "Pair this browser", exact: true })
    .waitFor();
  assert.equal(await remote.locator(".shell").count(), 0);
  await owner.goto(base + "#settings");
  await owner
    .getByRole("button", { name: "Network access", exact: true })
    .click();
  const enabled = owner.getByRole("checkbox", {
    name: /Allow other devices on my network/,
  });
  async function allowNetwork(value) {
    const [response] = await Promise.all([
      owner.waitForResponse(
        (item) =>
          item.url().endsWith("/api/network-access") &&
          item.request().method() === "PUT",
      ),
      enabled.click(),
    ]);
    assert.equal(response.status(), 200);
    await owner.waitForFunction(
      (checked) =>
        document.querySelector('.network-access input[type="checkbox"]')
          ?.checked === checked,
      value,
    );
  }
  await allowNetwork(true);
  const token = owner.getByLabel("One-time pairing token", { exact: true });
  await token.waitFor();
  await remote
    .getByLabel("Browser name", { exact: true })
    .fill("Synthetic LAN browser");
  await remote
    .getByLabel("Pairing token", { exact: true })
    .fill(await token.inputValue());
  await remote
    .getByRole("button", { name: "Pair browser", exact: true })
    .click();
  await remote.locator(".shell").waitFor();
  await owner
    .getByRole("button", { name: "Refresh paired browsers", exact: true })
    .click();
  await owner
    .getByRole("button", { name: "Revoke Synthetic LAN browser", exact: true })
    .waitFor();
  await token.waitFor({ state: "detached" });
  await remote.goto(base + "#image");
  const prompt = remote.getByLabel("Describe your image", { exact: true });
  await prompt.fill("Preserve this private draft while reconnecting.");
  await allowNetwork(false);
  await remote.getByRole("dialog").waitFor({ timeout: 12000 });
  assert.equal(await remote.locator(".shell").getAttribute("inert"), "");
  assert.equal(
    await prompt.inputValue(),
    "Preserve this private draft while reconnecting.",
  );
  assert.equal(jobs, 0);
  await allowNetwork(true);
  await token.waitFor();
  await remote
    .getByLabel("Pairing token", { exact: true })
    .fill(await token.inputValue());
  await remote
    .getByRole("button", { name: "Pair browser", exact: true })
    .click();
  await remote.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(await remote.locator(".shell").getAttribute("inert"), null);
  assert.equal(
    await prompt.inputValue(),
    "Preserve this private draft while reconnecting.",
  );
  assert.equal(jobs, 0);
  await remote.goto(base + "#settings");
  await remote
    .getByRole("button", { name: "Network access", exact: true })
    .click();
  await remote
    .getByText(
      "Manage paired browsers from Studio on the host using localhost.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await remote
      .getByRole("checkbox", { name: /Allow other devices on my network/ })
      .count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Pairing bootstrap, owner controls, revocation, draft preservation and manual resume passed.",
  );
} finally {
  await browser.close();
}
