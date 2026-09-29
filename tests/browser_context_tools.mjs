// Shared context controls with intercepted metadata/preview APIs; no models or jobs.
import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const base = process.env.STUDIO_TEST_URL || "http://127.0.0.1:8898";
assert.notEqual(new URL(base).port, "8877");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.setDefaultTimeout(12000);
const literalSnapshot =
  "Literal <script>window.sharedPwn=true</script> text. 😀";
const errors = [],
  unexpected = [],
  calls = [];
page.on("pageerror", (error) => errors.push(error.message));
const projects = [
  { id: "a".repeat(32), name: "Alpine" },
  { id: "b".repeat(32), name: "Beach" },
];
const briefs = Object.fromEntries(
  projects.map((project, index) => [
    project.id,
    {
      project: project.id,
      content: index ? "Beach project only." : "Alpine project notes.",
      revision: 1,
      updated: 1,
    },
  ]),
);
let failGet = false,
  heldGet = null,
  heldPut = null;
function gate() {
  let arrived, release;
  return {
    arrival: new Promise((resolve) => (arrived = resolve)),
    promise: new Promise((resolve) => (release = resolve)),
    arrived: () => arrived(),
    release: () => release(),
  };
}
await page.route("**/api/**", async (route) => {
  const request = route.request(),
    path = new URL(request.url()).pathname,
    method = request.method(),
    body = request.postDataJSON();
  calls.push({ path, method, body });
  let data,
    status = 200;
  const match = path.match(/^\/api\/projects\/([ab]{32})\/brief$/);
  if (match && method === "GET") {
    data = structuredClone(briefs[match[1]]);
    if (failGet) {
      failGet = false;
      status = 503;
      data = {
        detail: "Brief connection unavailable; your other work remains usable.",
      };
    }
    if (heldGet) {
      const hold = heldGet;
      heldGet = null;
      hold.arrived();
      await hold.promise;
    }
  } else if (match && method === "PUT") {
    if (heldPut) {
      const held = heldPut;
      heldPut = null;
      held.arrived();
      await held.promise;
    }
    const saved = briefs[match[1]];
    if (body.expected_revision !== saved.revision) {
      status = 409;
      data = { detail: "Brief changed elsewhere; reload to review." };
    } else {
      data = { ...saved, content: body.content, revision: saved.revision + 1 };
      briefs[match[1]] = data;
    }
  } else {
    unexpected.push(`${method} ${path}`);
    status = 404;
    data = { detail: "Unexpected synthetic API request" };
  }
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(data),
  });
});
await page.route("**/context-tools-fixture", (route) =>
  route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;
const {default:React}=await import('/node_modules/.vite-ui/deps/react.js');const {default:ReactDOM}=await import('/node_modules/.vite-ui/deps/react-dom_client.js');await import('/web/style.css?import');await import('/web/studio-design.css?import');
const {default:ProjectBrief}=await import('/web/ProjectBrief.jsx');const {default:ContextInspector}=await import('/web/ContextInspector.jsx');
const projects=${JSON.stringify(projects)};
const api=async(path,body,method)=>{const r=await fetch('/api'+path,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw Error(value.detail);return value;};
function Harness(){const[index,setIndex]=React.useState(0),[selection,setSelection]=React.useState(false),[choice,setChoice]=React.useState(null),[busy,setBusy]=React.useState(false),[mount,setMount]=React.useState(0),[submitted,setSubmitted]=React.useState(0),[secondary,setSecondary]=React.useState(false);window.fixtureSecond=setSecondary;window.fixtureProject=(next)=>{setIndex(next);setChoice(null);};window.fixtureSelection=setSelection;window.fixtureRemount=()=>setMount(value=>value+1);return React.createElement('main',{style:{maxWidth:800,padding:18,margin:'auto'}},React.createElement('form',{onSubmit:event=>{event.preventDefault();setSubmitted(value=>value+1)}},React.createElement(ProjectBrief,{key:index+':'+mount,project:projects[index],api,selection,value:choice,onChange:setChoice,onBusyChange:setBusy}),React.createElement('button',{type:'submit',disabled:busy},'Synthetic submit'),React.createElement('output',{id:'result'},JSON.stringify({choice,busy,submitted}))),secondary ? React.createElement('aside',{id:'second-brief'},React.createElement(ProjectBrief,{project:projects[index],api,selection:false})) : null,React.createElement(ContextInspector,{snapshot:{messages:[{role:'user',content:${JSON.stringify(literalSnapshot).replaceAll("<", "\\u003c")}}],sources:[],history_messages:4,history_excerpted:true}}));}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
</script></body></html>`,
  }),
);
const state = () => page.locator("#result").textContent().then(JSON.parse);
const notes = () =>
  page
    .locator("form")
    .getByRole("textbox", { name: "Shared project notes", exact: true });
const brief = () =>
  page
    .locator("form")
    .getByRole("region", { name: "Project brief", exact: true });
try {
  await mkdir(".local", { recursive: true });
  await page.goto(base + "/context-tools-fixture");
  await notes().waitFor();
  await page.waitForFunction(
    () => document.querySelector("textarea")?.value === "Alpine project notes.",
  );
  assert.equal(
    await page.getByRole("checkbox").count(),
    0,
    "Projects editor hides request opt-in",
  );
  await notes().fill("Alpine draft kept while visiting another project.");
  await page.evaluate(() => window.fixtureProject(1));
  await page.waitForFunction(
    () => document.querySelector("textarea")?.value === "Beach project only.",
  );
  await page.evaluate(() => window.fixtureProject(0));
  await page.waitForFunction(
    () =>
      document.querySelector("textarea")?.value ===
      "Alpine draft kept while visiting another project.",
  );
  assert.equal((await state()).submitted, 0);
  await brief()
    .getByRole("button", { name: "Save project brief", exact: true })
    .click();
  await brief()
    .getByText("Project brief saved · revision 2.", { exact: true })
    .waitFor();
  assert.equal(
    (await state()).submitted,
    0,
    "brief buttons never submit an enclosing request form",
  );
  await page.evaluate(() => window.fixtureSelection(true));
  await brief().locator(":scope > details > summary").click();
  await page
    .getByRole("checkbox", { name: "Include project brief", exact: true })
    .check();
  await notes().fill("An included, unsaved draft.");
  await page.waitForFunction(
    () =>
      JSON.parse(document.querySelector("#result").textContent).busy === true,
  );
  assert.equal((await state()).busy, true);
  assert.equal(
    await page
      .getByRole("button", { name: "Synthetic submit", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByRole("checkbox", { name: "Include project brief", exact: true })
    .uncheck();
  await page.waitForFunction(
    () =>
      JSON.parse(document.querySelector("#result").textContent).busy === false,
  );
  assert.equal(
    (await state()).busy,
    false,
    "excluded unsaved brief does not block unrelated work",
  );
  await page
    .getByRole("button", { name: "Synthetic submit", exact: true })
    .click();
  assert.equal((await state()).submitted, 1);
  await brief()
    .getByRole("button", { name: "Discard brief edits", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Include project brief", exact: true })
    .check();
  briefs[projects[0].id] = {
    ...briefs[projects[0].id],
    revision: 3,
    content: "Externally revised Alpine notes.",
  };
  await brief()
    .getByRole("button", { name: "Reload saved brief", exact: true })
    .click();
  await brief()
    .getByRole("button", { name: "Use saved revision 3", exact: true })
    .waitFor();
  assert.equal((await state()).choice, 2);
  await page.waitForFunction(
    () =>
      JSON.parse(document.querySelector("#result").textContent).busy === true,
  );
  assert.equal((await state()).busy, true);
  await brief()
    .getByRole("button", { name: "Use saved revision 3", exact: true })
    .click();
  assert.equal((await state()).choice, 3);
  await page.waitForFunction(
    () =>
      JSON.parse(document.querySelector("#result").textContent).busy === false,
  );
  assert.equal((await state()).busy, false);
  // Loading errors remain recoverable and cannot block a request that excludes the brief.
  await page
    .getByRole("checkbox", { name: "Include project brief", exact: true })
    .uncheck();
  failGet = true;
  await page.evaluate(() => window.fixtureRemount());
  await brief()
    .getByRole("alert")
    .filter({ hasText: "Brief connection unavailable" })
    .waitFor();
  await page.waitForFunction(
    () =>
      JSON.parse(document.querySelector("#result").textContent).busy === false,
  );
  assert.equal((await state()).busy, false);
  await brief()
    .getByRole("alert")
    .getByRole("button", { name: "Reload saved brief", exact: true })
    .click();
  await page.waitForFunction(
    () => !document.querySelector(".project-brief input").disabled,
  );
  // A reply from an outgoing project's fetch cannot overwrite the newly selected project.
  const held = gate();
  heldGet = held;
  await page.evaluate(() => window.fixtureRemount());
  await held.arrival;
  await page.evaluate(() => window.fixtureProject(1));
  await brief().locator(":scope > details > summary").click();
  await page.waitForFunction(
    () => document.querySelector("textarea")?.value === "Beach project only.",
  );
  held.release();
  await page.waitForTimeout(70);
  assert.equal(await notes().inputValue(), "Beach project only.");
  assert.equal((await state()).choice, null);
  // Returning to a dirty draft must preserve its original revision, not silently rebase it.
  await notes().fill("My Beach draft from revision one.");
  await page.evaluate(() => window.fixtureProject(0));
  await page.waitForFunction(
    () =>
      document.querySelector("textarea")?.value ===
      "Externally revised Alpine notes.",
  );
  briefs[projects[1].id] = {
    ...briefs[projects[1].id],
    content: "Someone else's new Beach revision.",
    revision: 2,
  };
  await page.evaluate(() => window.fixtureProject(1));
  await brief()
    .getByRole("alert")
    .filter({ hasText: "changed from revision 1 to 2" })
    .waitFor();
  await brief().locator(":scope > details > summary").click();
  assert.equal(await notes().inputValue(), "My Beach draft from revision one.");
  assert.equal(
    await brief()
      .getByRole("button", { name: "Save project brief", exact: true })
      .isDisabled(),
    true,
  );
  const writesBeforeRebase = calls.filter(
    (call) => call.method === "PUT",
  ).length;
  await brief().locator(".project-brief-comparison > summary").click();
  await brief()
    .getByText("Someone else's new Beach revision.", { exact: true })
    .waitFor();
  assert.equal(
    calls.filter((call) => call.method === "PUT").length,
    writesBeforeRebase,
  );
  await brief()
    .getByRole("button", { name: "Reload saved brief", exact: true })
    .click();
  await brief()
    .getByText(
      "Saved revision reloaded. Your edits are kept; review them before saving.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await notes().inputValue(), "My Beach draft from revision one.");
  await brief()
    .getByRole("button", { name: "Save project brief", exact: true })
    .click();
  await brief()
    .getByText("Project brief saved · revision 3.", { exact: true })
    .waitFor();
  assert.equal(
    calls.filter((call) => call.method === "PUT").at(-1).body.expected_revision,
    2,
  );
  assert.equal(
    briefs[projects[1].id].content,
    "My Beach draft from revision one.",
  );

  // A delayed save in one mounted editor must not erase newer edits in another editor.
  await page.evaluate(() => window.fixtureSecond(true));
  const secondNotes = page
    .locator("#second-brief")
    .getByRole("textbox", { name: "Shared project notes", exact: true });
  await secondNotes.waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector("#second-brief textarea")?.value ===
      "My Beach draft from revision one.",
  );
  await notes().fill("First editor submits this version.");
  const saveGate = gate();
  heldPut = saveGate;
  await brief()
    .getByRole("button", { name: "Save project brief", exact: true })
    .click();
  await saveGate.arrival;
  await secondNotes.fill("A newer draft in the second editor must survive.");
  saveGate.release();
  await brief()
    .getByText("Project brief saved · revision 4.", { exact: true })
    .waitFor();
  await page.evaluate(() => {
    window.fixtureSecond(false);
    window.fixtureRemount();
  });
  await brief()
    .getByRole("alert")
    .filter({ hasText: "changed from revision 3 to 4" })
    .waitFor();
  await brief().locator(":scope > details > summary").click();
  assert.equal(
    await notes().inputValue(),
    "A newer draft in the second editor must survive.",
  );
  assert.equal(
    briefs[projects[1].id].content,
    "First editor submits this version.",
  );
  // Older immutable snapshots show missing history counts as unknown and never render HTML.
  const inspector = page.locator(".context-inspector");
  await inspector.locator(":scope > summary").click();
  await inspector
    .getByText(/History: 2 earlier turns included; unknown omitted/)
    .waitFor();
  assert.equal(await inspector.locator("pre").textContent(), literalSnapshot);
  assert.equal(await page.evaluate(() => Boolean(window.sharedPwn)), false);
  await inspector
    .getByText(`${[...literalSnapshot].length} characters`, { exact: true })
    .waitFor();
  assert.match(
    await inspector
      .locator(".context-inspector-messages summary")
      .textContent(),
    new RegExp(`${[...literalSnapshot].length} characters`),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.screenshot({
    path: ".local/context-tools-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.ok(
    calls.every((call) => call.path.endsWith("/brief")),
    "shared editor and saved inspection only read/write brief metadata",
  );
  console.log(
    "Shared context browser checks passed: Projects editor, optional inclusion, dirty/stale gating, CAS recovery, project draft isolation, late fetch/load error recovery, nested-form safety, immutable literal snapshots and mobile; no AI calls.",
  );
} catch (error) {
  console.error({ errors, unexpected }, await page.locator("body").innerText());
  await page.screenshot({
    path: ".local/context-tools-failure.png",
    fullPage: true,
  });
  throw error;
} finally {
  await browser.close();
}
