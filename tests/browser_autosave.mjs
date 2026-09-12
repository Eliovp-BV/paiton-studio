import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
const base = process.env.STUDIO_URL || "http://127.0.0.1:8877";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(base);
  await page.getByRole("heading", { name: "Create without limits." }).waitFor();
  const id = await page.evaluate(async () => {
    const token = (await (await fetch("/api/session")).json()).token;
    const p = await (
      await fetch("/api/projects", {
        method: "POST",
        headers: { "X-Studio-Token": token },
        body: "{}",
      })
    ).json();
    localStorage.setItem("studio-project", p.id);
    return p.id;
  });
  await page.reload();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await page.getByRole("heading", { name: "Create without limits." }).waitFor();
  let release, arrived;
  const held = new Promise((r) => (release = r));
  const first = new Promise((r) => (arrived = r));
  let writes = 0;
  const responses = [];
  await page.route(base + "/api/projects/" + id, async (route) => {
    if (route.request().method() === "PUT") {
      writes++;
      if (writes === 1) {
        arrived();
        await held;
      }
    }
    await route.continue();
  });
  page.on("response", (r) => {
    if (
      r.url() === base + "/api/projects/" + id &&
      r.request().method() === "PUT"
    )
      responses.push(r.status());
  });
  const name = page.getByRole("textbox", { name: "Project name" });
  await name.fill("Autosave first draft");
  await name.blur();
  await first;
  await name.fill("Autosave second draft");
  await name.blur();
  await name.fill("Autosave final draft");
  await name.blur();
  release();
  await page.waitForFunction(() =>
    document
      .querySelector(".save-state")
      ?.textContent.includes("Saved on Studio host"),
  );
  const saved = await page.evaluate(
    async (identity) => await (await fetch("/api/projects/" + identity)).json(),
    id,
  );
  assert.equal(saved.name, "Autosave final draft");
  assert.equal(saved.revision, 2);
  assert.equal(writes, 2);
  assert.deepEqual(responses, [200, 200]);
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    ".local/review-autosave.json",
    JSON.stringify(
      {
        passed: true,
        project: id,
        writes,
        responses,
        revision: saved.revision,
        finalName: saved.name,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "Concurrent autosave check passed: final draft preserved, two serialized writes, no conflict.",
  );
} finally {
  await browser.close();
}
