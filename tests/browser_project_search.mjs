// Actual project search UI against intercepted synthetic content only.
import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";

const base = process.env.STUDIO_TEST_URL || "http://127.0.0.1:8898";
assert.notEqual(new URL(base).port, "8877");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.setDefaultTimeout(10000);
const projects = ["a", "b"].map((letter) => ({
  id: letter.repeat(32),
  name: `Project ${letter.toUpperCase()}`,
}));
const errors = [],
  unexpected = [],
  requests = [],
  navigations = [],
  reports = [],
  gates = [];
let nextSearch,
  nextNavigation,
  navigationMode = "success";
page.on("pageerror", (error) => errors.push(error.message));
function gate() {
  let arrive, release;
  const value = {
    arrival: new Promise((resolve) => (arrive = resolve)),
    arrived: () => arrive(),
    release: new Promise((resolve) => (release = resolve)),
    resume: () => release(),
  };
  gates.push(value);
  return value;
}
async function arrival(value) {
  let timer;
  try {
    await Promise.race([
      value.arrival,
      new Promise(
        (_, reject) =>
          (timer = setTimeout(
            () => reject(Error("Fixture request did not arrive.")),
            10000,
          )),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
await page.exposeFunction("fixtureNavigate", async (target) => {
  navigations.push(target);
  const delayed = nextNavigation;
  nextNavigation = null;
  if (delayed) {
    delayed.arrived();
    await delayed.release;
  }
  if (navigationMode === "reject")
    throw Error("This saved result is no longer available.");
  return navigationMode === "false" ? false : true;
});
await page.exposeFunction("fixtureReport", (message) => reports.push(message));
function result(project, query) {
  const snippet = `Prefix 😀 ${query} <img src=x onerror="window.injected=true">`;
  const targetQuery = { query };
  const rows = [
    {
      id: "chat-result",
      title: "Archived planning",
      source: "chat",
      field: "reply",
      archived: true,
      target: {
        kind: "chat",
        chat_id: "1".repeat(32),
        turn_id: "2".repeat(32),
        ...targetQuery,
      },
    },
    {
      id: "code-result",
      title: "src/main.py",
      source: "code",
      field: "content",
      target: {
        kind: "code",
        path: "src/main.py",
        version: "c".repeat(64),
        line: 8,
        ...targetQuery,
      },
    },
    {
      id: "document-result",
      title: "Facts.pdf",
      source: "document",
      field: "text",
      target: { kind: "asset", asset_id: "3".repeat(32), ...targetQuery },
    },
    {
      id: "agent-result",
      title: "Research helper",
      source: "agent",
      field: "output",
      target: {
        kind: "agent",
        agent_id: "4".repeat(32),
        run_id: "5".repeat(32),
        ...targetQuery,
      },
    },
  ].map((row) => ({
    ...row,
    snippet,
    highlights: [
      [snippet.indexOf(query), snippet.indexOf(query) + query.length],
    ],
  }));
  return {
    project_id: project,
    query,
    results: query === "absent" ? [] : rows,
    searched: { chat: 1, agent: 1, document: 1, asset: 0, code: 1 },
    partial: query === "partial",
    partial_reasons: query === "partial" ? ["result_limit"] : [],
    limit_reached: query === "partial",
    skipped: { private: query === "partial" ? 2 : 0 },
    limits: {
      results: 80,
      items: 1000,
      text_bytes: 8388608,
      matches_per_field: 3,
    },
  };
}
await page.route("**/api/**", async (route) => {
  const request = route.request(),
    url = new URL(request.url()),
    match = url.pathname.match(/^\/api\/projects\/([a-f0-9]{32})\/search$/),
    query = url.searchParams.get("q");
  if (
    request.method() !== "GET" ||
    !match ||
    !projects.some((project) => project.id === match[1])
  ) {
    unexpected.push(request.method() + " " + url.pathname);
    return route.abort();
  }
  requests.push({ project: match[1], query });
  const delayed = nextSearch;
  nextSearch = null;
  if (delayed) {
    delayed.arrived();
    await delayed.release;
  }
  await route.fulfill({
    status: query === "failure" ? 503 : 200,
    contentType: "application/json",
    body: JSON.stringify(
      query === "failure"
        ? { detail: "Saved search is temporarily unavailable." }
        : result(match[1], query),
    ),
  });
});
await page.route("**/project-search-fixture", (route) =>
  route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>(type)=>type; window.__vite_plugin_react_preamble_installed__=true;
const {default:React}=await import('/node_modules/.vite-ui/deps/react.js'); const {useState}=React;
const {default:ReactDOM}=await import('/node_modules/.vite-ui/deps/react-dom_client.js');
await import('/web/style.css?import'); await import('/web/studio-design.css?import'); await import('/web/studio-gold.css?import');
const {default:ProjectSearch}=await import('/web/ProjectSearch.jsx');
const projects=${JSON.stringify(projects)};
const api=async path=>{const response=await fetch('/api'+path);const value=await response.json();if(!response.ok)throw Error(value.detail);return value;};
function Fixture(){const [project,setProject]=useState(projects[0]);window.fixtureProject=index=>setProject(projects[index]);return React.createElement('main',{style:{padding:24}},React.createElement(ProjectSearch,{project,api,onOpen:target=>window.fixtureNavigate(target),report:error=>window.fixtureReport(error.message)}));}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Fixture));
</script></body></html>`,
  }),
);
const button = (name) => page.getByRole("button", { name, exact: true });
const dialog = () => page.getByRole("dialog");
const input = () =>
  page.getByRole("searchbox", {
    name: "Find text in this project",
    exact: true,
  });
const results = () => page.locator(".project-search-results > li");
const settle = () =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
async function search(query) {
  await input().fill(query);
  await button("Search").click();
  await page.locator(".project-search-summary").waitFor();
}
try {
  await page.goto(base + "/project-search-fixture");
  await button("Search project").waitFor();
  assert.equal(requests.length, 0, "opening Studio does not search silently");
  await page.keyboard.press("Control+Shift+k");
  await dialog().waitFor();
  assert.equal(
    await input().evaluate((field) => field === document.activeElement),
    true,
  );
  assert.equal(await button("Search").isDisabled(), true);
  await input().fill("   ");
  assert.equal(await button("Search").isDisabled(), true);
  await search("literal.*");
  assert.equal(await results().count(), 4);
  assert.equal(requests.at(-1).query, "literal.*");
  assert.equal(
    await results().first().locator("mark").innerText(),
    "literal.*",
  );
  assert.equal(
    await dialog().locator("img").count(),
    0,
    "source markup remains literal text",
  );
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.match(await results().first().innerText(), /Archived/);
  assert.match(await results().nth(1).innerText(), /line 8/);
  await dialog().getByText("Search coverage", { exact: true }).click();
  assert.match(await dialog().innerText(), /4 searched items/);
  assert.match(await dialog().innerText(), /Code: 1 searched/);

  navigationMode = "reject";
  await results().first().getByRole("button").click();
  await dialog()
    .getByRole("alert")
    .filter({ hasText: "no longer available" })
    .waitFor();
  assert.equal(await dialog().isVisible(), true);
  assert.equal(reports.length, 1);
  navigationMode = "false";
  await results().nth(1).getByRole("button").click();
  await dialog()
    .getByRole("alert")
    .filter({ hasText: "could not be opened" })
    .waitFor();
  const delayedNavigation = gate();
  nextNavigation = delayedNavigation;
  navigationMode = "success";
  await results().nth(1).getByRole("button").click();
  await arrival(delayedNavigation);
  assert.equal(
    await dialog().isVisible(),
    true,
    "results remain open while navigation is pending",
  );
  assert.equal(await input().isDisabled(), true);
  assert.deepEqual(navigations.at(-1), {
    kind: "code",
    path: "src/main.py",
    version: "c".repeat(64),
    line: 8,
    query: "literal.*",
  });
  delayedNavigation.resume();
  await dialog().waitFor({ state: "hidden" });
  assert.equal(
    await button("Search project").evaluate(
      (field) => field === document.activeElement,
    ),
    true,
  );

  await button("Search project").click();
  await search("absent");
  await dialog()
    .getByText(
      "No matching saved text. Try a shorter phrase or check another project.",
      { exact: true },
    )
    .waitFor();
  await search("partial");
  assert.match(
    await page.locator(".project-search-summary").innerText(),
    /Results are partial/,
  );
  const earlier = gate();
  nextSearch = earlier;
  await input().fill("old phrase");
  await button("Search").click();
  await arrival(earlier);
  await input().fill("new phrase");
  await button("Search").click();
  await page.locator(".project-search-summary").waitFor();
  earlier.resume();
  await settle();
  assert.equal(
    await results().first().locator("mark").innerText(),
    "new phrase",
  );

  const crossProject = gate();
  nextSearch = crossProject;
  await input().fill("project A only");
  await button("Search").click();
  await arrival(crossProject);
  await page.evaluate(() => window.fixtureProject(1));
  await dialog().waitFor({ state: "hidden" });
  crossProject.resume();
  await settle();
  await button("Search project").click();
  await page
    .getByRole("heading", { name: "Search Project B", exact: true })
    .waitFor();
  assert.equal(await input().inputValue(), "");
  assert.equal(await results().count(), 0);
  await input().fill("failure");
  await button("Search").click();
  await dialog()
    .getByRole("alert")
    .filter({ hasText: "temporarily unavailable" })
    .waitFor();
  await search("recovered");
  assert.equal(requests.at(-1).project, projects[1].id);
  assert.equal(await dialog().getByRole("alert").count(), 0);

  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await dialog().evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
      true,
      "dialog content stays within a narrow viewport",
    );
    const rect = await dialog().boundingBox();
    assert.ok(rect.x >= 0 && rect.x + rect.width <= width + 1);
  }
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "hidden" });
  await page.evaluate(() => window.fixtureProject(-1));
  await page.waitForFunction(
    () => document.querySelector(".project-search-trigger")?.disabled,
  );
  assert.equal(await button("Search project").isDisabled(), true);
  await page.keyboard.press("Control+Shift+k");
  assert.equal(await dialog().count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(
    "Project search browser checks passed: exact targets, literal safe highlights, archives/coverage, no silent searches, keyboard/focus/modal, awaited failed navigation, query/project races, errors and mobile bounds; intercepted read-only APIs only.",
  );
} finally {
  for (const item of gates) item.resume();
  await browser.close();
}
