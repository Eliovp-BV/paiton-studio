// Actual navigation components and production styles, with no backend access.
// Never starts inference, an IDE, a runtime package, or a service.
import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const base = process.env.STUDIO_TEST_URL || "http://127.0.0.1:8898";
assert.notEqual(new URL(base).port, "8877");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [],
  unexpected = [],
  navigations = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.exposeFunction("fixtureNavigation", (route) =>
  navigations.push(route),
);
await page.route("**/api/**", (route) => {
  unexpected.push(`${route.request().method()} ${route.request().url()}`);
  return route.abort();
});
await page.route("**/mcp/**", (route) => {
  unexpected.push("MCP execution attempted");
  return route.abort();
});
await page.route("**/navigation-fixture", (route) =>
  route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta charset="utf-8"><title>Studio navigation fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;
const {default: React} = await import('/node_modules/.vite-ui/deps/react.js');
const {useEffect, useState} = React;
const {default: ReactDOM} = await import('/node_modules/.vite-ui/deps/react-dom_client.js');
await import('/web/style.css?import'); await import('/web/studio-design.css?import'); await import('/web/studio-gold.css?import');
const {default: StudioNavigation, WorkspaceSections} = await import('/web/StudioNavigation.jsx');
const {NAV_ROUTES, MODEL_TABS, studioRoute} = await import('/web/studioNavigation.js');
function Harness() {
  const [route,setRoute] = useState(() => studioRoute(location.hash.slice(1))), [collapsed,setCollapsed] = useState(false);
  useEffect(() => { const update = () => setRoute(studioRoute(location.hash.slice(1))); window.addEventListener('hashchange',update); return () => window.removeEventListener('hashchange',update); }, []);
  const navigate = (value) => { const target = studioRoute(value); window.fixtureNavigation(target); location.hash = target; setRoute(target); };
  const title = NAV_ROUTES.find(item => item.id === route)?.label || route;
  return React.createElement('div',{className:'shell studio-shell route-'+route+(collapsed?' nav-collapsed':'')},
    React.createElement('aside',{className:'sidebar'},
      React.createElement('a',{className:'brand',href:'#home'},'P',React.createElement('span',null,'Paiton Studio')),
      React.createElement('button',{className:'nav-toggle','aria-label':'Toggle navigation rail',onClick:()=>setCollapsed(value=>!value)},'↔',React.createElement('span',null,'Creative workspace')),
      React.createElement(StudioNavigation,{route,collapsed,onNavigate:navigate})),
    React.createElement('div',{className:'body'},React.createElement('main',{'data-studio-page':route,style:{padding:'20px',minWidth:0}},
      !['image','video','write','page','settings','system',...Object.keys(MODEL_TABS)].includes(route) && React.createElement(WorkspaceSections,{route,onNavigate:navigate}),
      React.createElement('h1',null,title),React.createElement('p',null,'Navigation fixture. All processing is off.'))));
}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
</script></body></html>`,
  }),
);

const mainNav = () =>
  page.getByRole("navigation", { name: "Main navigation", exact: true });
const workspace = (group) =>
  page.getByRole("navigation", { name: `${group} workspace`, exact: true });
const flyout = (group) =>
  page.getByRole("region", { name: `${group} sections`, exact: true });
const button = (name) => mainNav().getByRole("button", { name, exact: true });
const disclosure = (group, expanded) =>
  button(`${expanded ? "Collapse" : "Expand"} ${group} sections`);
const storageKey = "paiton-navigation-sections:v1";
const settle = () =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
async function expectRoute(route, activeLabel) {
  await page.waitForFunction(
    (expected) =>
      document.querySelector("main")?.dataset.studioPage === expected,
    route,
  );
  await settle();
  const current = mainNav().locator('[aria-current="page"]:visible');
  assert.equal(
    await current.count(),
    1,
    "exactly one visible main navigation item marks the current page",
  );
  assert.equal(await current.getAttribute("aria-label"), activeLabel);
}
async function assertNoOverflow(width) {
  const measured = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.equal(measured.viewport, width);
  assert.ok(
    measured.document <= width + 1 && measured.body <= width + 1,
    `unexpected horizontal overflow: ${JSON.stringify(measured)}`,
  );
  for (const nav of [
    mainNav(),
    page.locator(".workspace-sections"),
    page.locator(".navigation-flyout"),
  ]) {
    for (const control of await nav.getByRole("button").all()) {
      if (!(await control.isVisible())) continue;
      const bounds = await control.boundingBox();
      assert.ok(
        bounds.width > 0 &&
          bounds.x >= 0 &&
          bounds.x + bounds.width <= width + 1,
        "visible navigation controls stay within the viewport",
      );
      const name =
        (await control.getAttribute("aria-label")) ||
        (await control.innerText());
      assert.ok(name.trim(), "every visible button retains an accessible name");
    }
  }
}
async function openHash(hash) {
  await page.evaluate((value) => {
    location.hash = value;
  }, hash);
}

try {
  await page.goto(base + "/navigation-fixture#home");
  await expectRoute("home", "Home");
  assert.deepEqual(
    await mainNav()
      .locator(".navigation-parent > .nav")
      .evaluateAll((buttons) =>
        buttons.map((item) => item.getAttribute("aria-label")),
      ),
    ["Home", "Chat", "Create", "Projects", "Models", "Connect", "Settings"],
  );
  assert.equal(
    await mainNav().getByRole("button", { name: "GPT", exact: true }).count(),
    0,
  );
  assert.equal(await workspace("Coding").count(), 0);

  // Parent navigation opens its default task; disclosure only changes expansion.
  await button("Create").click();
  await expectRoute("image", "Image");
  assert.equal(
    await workspace("Create").count(),
    0,
    "Create keeps its composer above the fold without a second tab strip",
  );
  assert.equal(
    await disclosure("Create", true).getAttribute("aria-expanded"),
    "true",
  );
  const createRegion = await disclosure("Create", true).getAttribute(
    "aria-controls",
  );
  assert.equal(
    await page.locator(`#${createRegion}`).getAttribute("role"),
    "group",
  );
  await button("Video").click();
  await expectRoute("video", "Video");
  const beforeToggle = navigations.length;
  await disclosure("Create", true).focus();
  await page.keyboard.press("Space");
  await expectRoute("video", "Create");
  assert.equal(navigations.length, beforeToggle);
  assert.equal(
    await disclosure("Create", false).getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(
    await mainNav()
      .getByRole("group", { name: "Create sections", exact: true })
      .count(),
    0,
  );
  await disclosure("Create", false).focus();
  await page.keyboard.press("Enter");
  await expectRoute("video", "Video");
  assert.equal(navigations.length, beforeToggle);

  for (const [parent, child, route] of [
    ["Projects", "Files", "coding"],
    ["Create", "Website", "page"],
    ["Chat", "Assistants", "agents"],
    ["Connect", "MCP Servers", "mcp"],
    ["Models", "Runtime packages", "runtime-packages"],
    ["Settings", "System & drivers", "system"],
  ]) {
    await button(parent).click();
    await button(child).click();
    await expectRoute(route, child);
  }
  await button("Chat").click();
  await expectRoute("chat", "Conversations");
  assert.equal(
    await workspace("Chat").locator('[aria-current="page"]').innerText(),
    "Conversations",
  );

  // Non-active section preferences persist; active deep links reopen their group.
  await disclosure("Create", true).click();
  await disclosure("Projects", true).click();
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    storageKey,
  );
  assert.equal(saved.create, false);
  assert.equal(saved.projects, false);
  assert.equal(saved.connect, true);
  await page.reload();
  await expectRoute("chat", "Conversations");
  await disclosure("Create", false).waitFor();
  await disclosure("Projects", false).waitFor();
  await disclosure("Connect", true).waitFor();
  await openHash("website");
  await expectRoute("page", "Website");
  await disclosure("Create", true).waitFor();
  await button("Chat").click();
  await expectRoute("chat", "Conversations");
  await page.goBack();
  await expectRoute("page", "Website");
  await page.goForward();
  await expectRoute("chat", "Conversations");

  for (const [alias, route, label] of [
    ["gpt", "chat", "Conversations"],
    ["mail", "mcp", "MCP Servers"],
    ["models", "tools", "Installed models"],
    ["build", "coding", "Files"],
    ["assistants", "agents", "Assistants"],
    ["downloads", "model-setup", "Setup & downloads"],
    ["packages", "runtime-packages", "Runtime packages"],
    ["meetings", "meetings", "Home"],
    ["not-a-studio-page", "home", "Home"],
  ]) {
    await page.goto(base + `/navigation-fixture#${alias}`);
    await expectRoute(route, label);
  }

  // Portaled compact sections keep every route reachable, including Create without tabs.
  await button("Projects").click();
  await button("Files").click();
  await expectRoute("coding", "Files");
  await page
    .getByRole("button", { name: "Toggle navigation rail", exact: true })
    .click();
  await expectRoute("coding", "Projects");
  assert.equal(await mainNav().getByRole("group").count(), 0);
  assert.equal(
    await mainNav()
      .getByRole("button", { name: /sections$/ })
      .count(),
    0,
  );
  await button("Create").focus();
  await page.keyboard.press("Enter");
  await flyout("Create").waitFor();
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Image",
  );
  assert.equal(await button("Create").getAttribute("aria-expanded"), "true");
  await assertNoOverflow(1440);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Website",
  );
  await page.keyboard.press("Enter");
  await expectRoute("page", "Create");
  assert.equal(await flyout("Create").count(), 0);
  assert.equal(await workspace("Create").count(), 0);
  await button("Connect").click();
  await flyout("Connect")
    .getByRole("button", { name: "MCP Servers", exact: true })
    .click();
  await expectRoute("mcp", "Connect");
  await button("Models").click();
  await flyout("Models").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await flyout("Models").count(), 0);
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
    "Models",
  );
  assert.equal(await button("Models").getAttribute("aria-expanded"), "false");
  await button("Connect").click();
  await flyout("Connect")
    .getByRole("button", { name: "MCP Servers", exact: true })
    .click();
  await assertNoOverflow(1440);
  await page
    .getByRole("button", { name: "Toggle navigation rail", exact: true })
    .click();
  await expectRoute("mcp", "MCP Servers");

  // The same stylesheet supports tablet and narrow mobile without clipped controls.
  for (const width of [900, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [parent, child, route] of [
      ["Projects", "Files", "coding"],
      ["Connect", "MCP Servers", "mcp"],
      ["Create", "Reels & shorts", "delivery"],
      ["Create", "Video", "video"],
      ["Models", "Setup & downloads", "model-setup"],
      ["Settings", "System & drivers", "system"],
    ]) {
      await button(parent).click();
      await flyout(parent).waitFor();
      assert.equal(await mainNav().getByRole("group").count(), 0);
      await assertNoOverflow(width);
      await flyout(parent)
        .getByRole("button", { name: child, exact: true })
        .click();
      await expectRoute(route, parent);
      await assertNoOverflow(width);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expectRoute("system", "System & drivers");

  // Invalid or unavailable storage never hides the active destination.
  await openHash("website");
  await expectRoute("page", "Website");
  for (const malformed of [
    "{invalid json",
    "[]",
    '{"create":"true","projects":1,"connect":null}',
  ]) {
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
      key: storageKey,
      value: malformed,
    });
    await page.reload();
    await expectRoute("page", "Website");
    await disclosure("Create", true).waitFor();
    await disclosure("Projects", false).waitFor();
    await disclosure("Connect", false).waitFor();
  }
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new DOMException("Storage denied", "SecurityError");
    };
    Storage.prototype.setItem = () => {
      throw new DOMException("Storage denied", "SecurityError");
    };
  });
  await page.reload();
  await expectRoute("page", "Website");
  await button("Connect").click();
  await button("MCP Servers").click();
  await expectRoute("mcp", "MCP Servers");

  if (process.env.STUDIO_NAVIGATION_SCREENSHOT_DIR) {
    await mkdir(process.env.STUDIO_NAVIGATION_SCREENSHOT_DIR, {
      recursive: true,
    });
    await page.screenshot({
      path: `${process.env.STUDIO_NAVIGATION_SCREENSHOT_DIR}/navigation-desktop.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expectRoute("mcp", "Connect");
    await page.screenshot({
      path: `${process.env.STUDIO_NAVIGATION_SCREENSHOT_DIR}/navigation-mobile.png`,
      fullPage: true,
    });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(
    "Navigation browser checks passed: seven primary destinations, retained routes, keyboard disclosure and flyouts, one visible current page, persisted sections, aliases/history, compact access and desktop/tablet/mobile bounds; no backend requests.",
  );
} catch (error) {
  console.error("Navigation fixture diagnostics:", {
    errors,
    unexpected,
    url: page.url(),
    body: (await page.locator("body").innerText()).slice(0, 1800),
  });
  throw error;
} finally {
  await browser.close();
}
