// Real worker-disabled Studio APIs with explicitly authored completion fixtures.
// No runtime is started: fixture copy/images are never claimed as inference.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const base = process.env.STUDIO_URL || "http://127.0.0.1:8897";
const data = path.resolve(process.env.STUDIO_TEST_DATA || "");
assert.ok(
  data.startsWith(path.resolve(".local") + path.sep),
  "STUDIO_TEST_DATA must name an isolated worker-disabled data directory under .local",
);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const page = await browser.newPage({
  viewport: { width: 1600, height: 1100 },
  reducedMotion: "reduce",
});
page.setDefaultTimeout(15000);
const errors = [],
  writes = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  if (
    ["POST", "PUT"].includes(request.method()) &&
    request.url().includes("/website")
  )
    writes.push({
      path: new URL(request.url()).pathname,
      method: request.method(),
      body: request.postDataJSON(),
    });
});
const output = path.resolve(
  ".local/workflow-reuse-20260912/browser-regeneration",
);
fs.mkdirSync(output, { recursive: true });
let fixture;
const releases = [];
function gate() {
  let release, enter;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  releases.push(release);
  return { waiting, entered, enter, release };
}
async function api(url, body, method = "POST") {
  return page.evaluate(
    async ({ url, body, method }) => {
      const token = (await (await fetch("/api/session")).json()).token;
      const result = await fetch("/api" + url, {
        method: body === undefined ? "GET" : method,
        headers: {
          "Content-Type": "application/json",
          "X-Studio-Token": token,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await result.json();
      if (!result.ok) throw Error(JSON.stringify(value));
      return value;
    },
    { url, body, method },
  );
}
const saved = () => api(`/projects/${fixture.project}/website`);
async function latest() {
  return (await saved()).runs[0];
}
async function clearNotice() {
  const dismiss = page.getByRole("button", {
    name: "Dismiss website notification",
  });
  if (await dismiss.isVisible()) await dismiss.click();
}
async function review() {
  await page
    .locator(".site-review")
    .getByRole("button", { name: "Review update", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Review your website update" });
}
// The target project and run were created by this suite using actual APIs.
// The model's output is replaced with a plainly identified CPU test fixture.
function complete(run, kind) {
  const input = {
    data,
    project: fixture.project,
    run: run.id,
    kind,
    image: fixture.replacement,
  };
  execFileSync(
    path.resolve(".venv/bin/python"),
    [
      "-c",
      `
import copy,json,sys,time
from pathlib import Path
from studio.store import Store
value=json.loads(sys.stdin.read())
root=Path(value['data']).resolve()
assert root.is_relative_to(Path('.local').resolve())
store=Store(root)
project=store.project(value['project'])
assert project['name']=='Website regeneration browser fixture'
run=store.rows('SELECT * FROM website_runs WHERE id=? AND project=?',(value['run'],value['project']))[0]
assert run['state'] in ('planning','artwork')
request=run['request']; assert request['kind']==value['kind']
site=copy.deepcopy(request['base_site'])
target=next(page for page in site['pages'] if page['slug']==request['page_slug'])
job=json.loads(run['jobs'])[0]
if value['kind']=='page-copy':
 target['title']='A warmer welcome — browser fixture'
 target['description']='Manually authored review fixture. No model inference.'
 target['sections'][0]['heading']='Take a quiet moment'
 target['sections'][0]['body']='A manually authored replacement paragraph for the consumer review test.'
 asset=store.add_asset(value['project'],'text','Manually authored browser copy',b'CPU test fixture, no inference.','.md',{'browser_fixture':True})['id']
else:
 asset=value['image']; store.asset(asset,value['project'])
 section=target['sections'][request['section_index']]
 if request.get('asset_id'): section['asset_ids']=[asset if old==request['asset_id'] else old for old in section['asset_ids']]
 else: section['asset_ids'].append(asset)
with store.connect() as db:
 db.execute("UPDATE jobs SET state='completed',message='Manually authored CPU browser fixture',asset=?,updated=? WHERE id=?",(asset,time.time(),job))
 db.execute("UPDATE website_runs SET state='completed',message='Manually authored CPU browser fixture',result=?,updated=? WHERE id=?",(json.dumps(site),time.time(),run['id']))
`,
    ],
    { input: JSON.stringify(input), encoding: "utf8" },
  );
}
try {
  await page.goto(base + "/#home");
  await page
    .getByRole("heading", { name: "Create without the cloud." })
    .waitFor();
  fixture = await page.evaluate(async () => {
    const token = (await (await fetch("/api/session")).json()).token;
    const headers = {
      "X-Studio-Token": token,
      "Content-Type": "application/json",
    };
    const projects = await (await fetch("/api/projects")).json();
    let image;
    for (const candidate of projects) {
      const details = await (
        await fetch("/api/projects/" + candidate.id)
      ).json();
      image = details.assets.find((asset) => asset.kind === "image");
      if (image) break;
    }
    if (!image)
      throw Error(
        "An existing real source image is required; no image is simulated.",
      );
    const project = await (
      await fetch("/api/projects", { method: "POST", headers, body: "{}" })
    ).json();
    await fetch("/api/projects/" + project.id, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        name: "Website regeneration browser fixture",
        revision: project.revision,
        state: { buildMode: "website" },
      }),
    });
    const source = await (await fetch("/api/assets/" + image.id)).blob();
    const images = [];
    for (const name of [
      "original-browser-source.png",
      "replacement-browser-source.png",
    ]) {
      const body = new FormData();
      body.append("file", source, name);
      const response = await fetch("/api/projects/" + project.id + "/import", {
        method: "POST",
        headers: { "X-Studio-Token": token },
        body,
      });
      if (!response.ok) throw Error("Failed to import the real image fixture");
      images.push((await response.json()).id);
    }
    localStorage.setItem("studio-project", project.id);
    localStorage.removeItem("studio-website-feedback-v1");
    return { project: project.id, original: images[0], replacement: images[1] };
  });
  // Refuse to enqueue against a different Studio installation than the private DB.
  execFileSync(path.resolve(".venv/bin/python"), [
    "-c",
    "import sys; from studio.store import Store; assert Store(sys.argv[1]).project(sys.argv[2])['name'] == 'Website regeneration browser fixture'",
    data,
    fixture.project,
  ]);
  const originalSite = await api(
    `/projects/${fixture.project}/website`,
    {
      title: "Browser review site",
      theme: "light",
      revision: 0,
      pages: [
        {
          slug: "index",
          title: "Original welcome",
          description: "Original introduction",
          sections: [
            {
              heading: "A quiet place",
              body: "Original manually authored paragraph",
              asset_ids: [fixture.original],
            },
          ],
        },
        {
          slug: "about",
          title: "Our story",
          description: "Keep this page",
          sections: [
            {
              heading: "Unchanged heading",
              body: "Keep every word on this page.",
              asset_ids: [fixture.original],
            },
          ],
        },
      ],
    },
    "PUT",
  );
  // Every website read takes longer than the normal polling interval. Loading
  // and later revisions must still arrive without overlapping background reads.
  let slowReads = 0,
    overlappingReads = 0,
    maxOverlappingReads = 0;
  const websitePath = `**/api/projects/${fixture.project}/website`;
  const slowHost = async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    ++slowReads;
    ++overlappingReads;
    maxOverlappingReads = Math.max(maxOverlappingReads, overlappingReads);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2600));
      const response = await route.fetch();
      await route.fulfill({ response });
    } finally {
      --overlappingReads;
    }
  };
  await page.route(websitePath, slowHost);
  await page.goto(base + "/?regeneration-test=" + fixture.project + "#page");
  await page
    .getByRole("button", { name: "Rewrite page copy", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Page title", { exact: true }).inputValue(),
    "Original welcome",
  );
  const newerSite = await api(
    `/projects/${fixture.project}/website`,
    { ...originalSite, title: "Latest website revision" },
    "PUT",
  );
  await page
    .getByText(`Website revision ${newerSite.revision}`, { exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Site title", { exact: true }).inputValue(),
    "Latest website revision",
  );
  assert.ok(slowReads >= 2);
  assert.equal(
    maxOverlappingReads,
    1,
    "Slow background website reads must run sequentially",
  );
  await page.unroute(websitePath, slowHost);
  await page
    .getByLabel("Page title", { exact: true })
    .fill("My edited welcome");
  await page
    .getByRole("button", { name: "Rewrite page copy", exact: true })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "Rewrite page copy",
    exact: true,
  });
  await dialog
    .getByLabel("What should change?")
    .fill("Make the welcome warmer and shorten the introduction.");
  assert.match(await dialog.innerText(), /edits will be saved before/);
  // A save failure must keep the instructions and prevent any queued generation.
  let failSave = true;
  let delayedGet = null,
    delayedSave = null;
  await page.route(
    `**/api/projects/${fixture.project}/website`,
    async (route) => {
      if (route.request().method() === "GET" && delayedGet) {
        const held = delayedGet;
        delayedGet = null;
        const response = await route.fetch();
        held.enter();
        await held.waiting;
        return route.fulfill({ response });
      }
      if (route.request().method() === "PUT" && delayedSave) {
        const held = delayedSave;
        delayedSave = null;
        const response = await route.fetch();
        held.enter();
        await held.waiting;
        return route.fulfill({ response });
      }
      if (route.request().method() === "PUT" && failSave) {
        failSave = false;
        return route.fulfill({
          status: 409,
          json: {
            detail:
              "Browser fixture: save needs retry; your edits are preserved.",
          },
        });
      }
      return route.continue();
    },
  );
  await dialog.getByRole("button", { name: "Queue this update" }).click();
  await dialog.getByRole("alert").waitFor();
  assert.equal((await saved()).runs.length, 0);
  assert.match(
    await dialog.getByLabel("What should change?").inputValue(),
    /warmer/,
  );
  const oldRead = gate();
  delayedGet = oldRead;
  await oldRead.entered;
  await dialog.getByRole("button", { name: "Queue this update" }).click();
  await page.getByRole("button", { name: "Cancel website update" }).waitFor();
  await clearNotice();
  oldRead.release();
  await page.waitForTimeout(200);
  assert.equal(
    await page.getByLabel("Page title", { exact: true }).inputValue(),
    "My edited welcome",
  );
  let run = await latest();
  assert.equal(run.request.kind, "page-copy");
  assert.equal(run.progress.total, 1);
  assert.equal(run.jobs.length, 1);
  assert.equal(run.request.base_site.pages[0].title, "My edited welcome");
  assert.ok(run.request.base_revision > originalSite.revision);
  assert.deepEqual(run.request.base_site.pages[1], originalSite.pages[1]);
  const enqueued = writes.findLast((request) =>
    request.path.endsWith("/regenerate"),
  );
  assert.equal(enqueued.body.revision, run.request.base_revision);
  assert.ok(!("section_index" in enqueued.body));
  assert.ok(!("asset_id" in enqueued.body));
  await page.getByRole("button", { name: "Cancel website update" }).click();
  await page
    .getByRole("button", { name: "Retry this output" })
    .first()
    .waitFor();
  assert.equal((await latest()).state, "cancelled");
  await page.getByRole("button", { name: "Retry this output" }).first().click();
  await page.getByRole("button", { name: "Cancel website update" }).waitFor();
  const retried = await latest();
  assert.notEqual(retried.id, run.id);
  assert.equal(retried.jobs.length, 1);
  complete(retried, "page-copy");
  await page
    .getByRole("complementary", { name: "Website update finished" })
    .waitFor();
  assert.match(
    await page.locator(".website-feedback").innerText(),
    /1 page’s copy/,
  );
  assert.doesNotMatch(
    await page.locator(".website-feedback").innerText(),
    /2 pages/,
  );
  await page
    .locator(".website-feedback")
    .getByRole("button", { name: "Review update", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Review your website update" });
  await dialog
    .getByRole("region", { name: "Original output" })
    .getByRole("heading", { name: "My edited welcome" })
    .waitFor();
  await dialog
    .getByRole("heading", { name: "A warmer welcome — browser fixture" })
    .waitFor();
  await page.screenshot({ path: path.join(output, "copy-review-desktop.png") });
  await dialog.getByRole("button", { name: "Apply this update" }).click();
  await page
    .getByText(
      "Update applied. Other pages and your original project assets are preserved.",
    )
    .waitFor();
  const applied = (await saved()).site;
  assert.equal(applied.pages[0].title, "A warmer welcome — browser fixture");
  assert.deepEqual(applied.pages[0].sections[0].asset_ids, [fixture.original]);
  assert.deepEqual(applied.pages[1], originalSite.pages[1]);
  await page.getByRole("button", { name: "Create section artwork" }).click();
  dialog = page.getByRole("dialog", {
    name: "Create section artwork",
    exact: true,
  });
  await dialog
    .getByLabel("Use the new image to")
    .selectOption(fixture.original);
  await dialog
    .getByLabel("Describe the new artwork")
    .fill("A sunlit forest clearing with a quiet wooden cabin.");
  assert.match(await dialog.innerText(), /does not edit the original/);
  await dialog.getByRole("button", { name: "Queue this update" }).click();
  await page.getByRole("button", { name: "Cancel website update" }).waitFor();
  run = await latest();
  assert.equal(run.job_details[0].task, "image");
  complete(run, "section-artwork");
  await page
    .getByRole("complementary", { name: "Website update finished" })
    .waitFor();
  assert.match(await page.locator(".website-feedback").innerText(), /1 image/);
  dialog = await review();
  assert.ok(
    (
      await dialog.getByAltText("Original section artwork").getAttribute("src")
    ).endsWith(fixture.original),
  );
  assert.ok(
    (
      await dialog.getByAltText("New section artwork").getAttribute("src")
    ).endsWith(fixture.replacement),
  );
  await page.screenshot({
    path: path.join(output, "artwork-review-desktop.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
    true,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: path.join(output, "artwork-review-mobile.png"),
  });
  await dialog.getByRole("button", { name: "Discard update" }).click();
  await page
    .getByText(
      "Update discarded. Your website is unchanged; generated assets remain in your project.",
    )
    .waitFor();
  assert.deepEqual((await saved()).site, applied);
  assert.equal((await latest()).state, "discarded");
  await page.locator(".website-feedback").waitFor({ state: "hidden" });
  const details = await api(`/projects/${fixture.project}`);
  assert.ok(details.assets.some((asset) => asset.id === fixture.original));
  assert.ok(details.assets.some((asset) => asset.id === fixture.replacement));
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page
    .getByRole("button", { name: "Rewrite page copy", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Rewrite page copy", exact: true });
  await dialog
    .getByLabel("What should change?")
    .fill("Rewrite this introduction with a more concise opening.");
  await dialog.getByRole("button", { name: "Queue this update" }).click();
  await page.getByRole("button", { name: "Cancel website update" }).waitFor();
  complete(await latest(), "page-copy");
  await page
    .locator(".site-review")
    .getByRole("button", { name: "Review update", exact: true })
    .waitFor();
  await clearNotice();
  await page
    .getByLabel("Page description", { exact: true })
    .fill("Newer unsaved editorial changes.");
  dialog = await review();
  assert.equal(
    await dialog
      .getByRole("button", { name: "Apply this update" })
      .isDisabled(),
    true,
  );
  assert.match(await dialog.innerText(), /newer editor changes/);
  await dialog.getByRole("button", { name: "Review later" }).click();
  const pendingSave = gate();
  delayedSave = pendingSave;
  await page.getByRole("button", { name: "Save website changes" }).click();
  await pendingSave.entered;
  assert.equal(
    await page.getByLabel("Page description", { exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByLabel("Page title", { exact: true }).isDisabled(),
    true,
  );
  pendingSave.release();
  await page
    .getByText(
      "Website changes saved. The preview now shows your latest version.",
    )
    .waitFor();
  dialog = await review();
  assert.equal(
    await dialog
      .getByRole("button", { name: "Apply this update" })
      .isDisabled(),
    true,
  );
  assert.match(await dialog.innerText(), /saved website changed/);
  await page.screenshot({ path: path.join(output, "stale-review.png") });
  await dialog.getByRole("button", { name: "Discard update" }).click();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      fixtureProject: fixture.project,
      checks: [
        "save failure preserves input and never enqueues",
        "slow host loads and sees newer revisions without overlapping background reads",
        "save-before-enqueue uses current revision",
        "delayed older poll cannot revert a saved website",
        "editor cannot lose typing during a delayed save",
        "single page job scope",
        "queue cancellation and retry",
        "one-output completion notification",
        "notification review opens the requested result",
        "before/after copy review and apply",
        "other pages and original image preserved",
        "artwork replacement review and discard",
        "new assets remain after discard",
        "discard retires the completed notification",
        "unsaved and stale revision protection",
        "desktop and narrow dialog overflow",
        "no frontend exceptions",
      ],
      inference:
        "none: worker-disabled API integration with explicitly authored completion fixtures",
      screenshots: output,
    }),
  );
} catch (error) {
  await page.screenshot({
    path: path.join(output, "failure.png"),
    fullPage: true,
  });
  fs.writeFileSync(
    path.join(output, "failure.txt"),
    await page.locator("body").innerText(),
  );
  throw error;
} finally {
  releases.forEach((release) => release());
  // Even on a failing assertion, leave no queued fixture jobs behind.
  if (fixture) {
    try {
      for (const run of (await saved()).runs)
        if (["planning", "artwork"].includes(run.state))
          await api(`/website-runs/${run.id}/cancel`, {});
    } catch {}
  }
  await browser.close();
}
