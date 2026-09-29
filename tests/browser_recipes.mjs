// Recipe library UI with entirely synthetic APIs and draft handoffs; no generation.
import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { recipeVariables, RECIPE_TARGETS } from "../web/recipeTemplates.js";
const base = process.env.STUDIO_TEST_URL || "http://127.0.0.1:8898";
assert.notEqual(new URL(base).port, "8877");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const page = await browser.newPage({ viewport: { width: 1350, height: 1050 } });
page.setDefaultTimeout(12000);
const calls = [],
  unexpected = [],
  errors = [],
  rows = [];
let serial = 0,
  failList = true,
  heldRender = null,
  heldSave = null;
page.on("pageerror", (error) => errors.push(error.message));
const fields = (row) => ({
  name: row.name,
  description: row.description,
  target: row.target,
  template: row.template,
});
const decorate = (row) => ({
  ...row,
  variables: recipeVariables(row.template).variables,
  prompt_limit: RECIPE_TARGETS[row.target].limit,
});
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
  const r = route.request(),
    path = new URL(r.url()).pathname,
    method = r.method(),
    body = r.postDataJSON();
  calls.push({ path, method, body });
  let data,
    status = 200;
  const match = path.match(
      /^\/api\/recipes\/([^/]+)(?:\/(duplicate|render))?$/,
    ),
    row = match && rows.find((row) => row.id === match[1]);
  if (path === "/api/recipes" && method === "GET") {
    if (failList) {
      failList = false;
      status = 503;
      data = { detail: "Synthetic recipe library connection failure" };
    } else data = rows.map(decorate);
  } else if (path === "/api/recipes" && method === "POST") {
    data = {
      ...body,
      id: "recipe-" + ++serial,
      revision: 1,
      created: serial,
      updated: serial,
    };
    rows.unshift(data);
    data = decorate(data);
  } else if (match && !row) {
    status = 404;
    data = {
      detail: "This recipe no longer exists. Your local draft has been kept.",
    };
  } else if (match && method === "GET") data = decorate(row);
  else if (match && body.expected_revision !== row.revision) {
    status = 409;
    data = {
      detail:
        "This recipe changed in another window. Compare the saved version before replacing it; your draft has been kept.",
    };
  } else if (match && method === "PATCH") {
    Object.assign(row, fields(body), {
      revision: row.revision + 1,
      updated: ++serial,
    });
    data = decorate(row);
    if (heldSave) {
      const held = heldSave;
      heldSave = null;
      held.arrived();
      await held.promise;
    }
  } else if (match && method === "DELETE") {
    rows.splice(rows.indexOf(row), 1);
    data = { deleted: row.id };
  } else if (match?.[2] === "duplicate" && method === "POST") {
    data = {
      ...fields(row),
      name: row.name + " copy",
      id: "recipe-" + ++serial,
      revision: 1,
      created: serial,
      updated: serial,
    };
    rows.unshift(data);
    data = decorate(data);
  } else if (match?.[2] === "render" && method === "POST") {
    const prompt = row.template.replace(
      /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,31})\s*\}\}/g,
      (_, name) => body.values[name],
    );
    if ([...prompt].length > RECIPE_TARGETS[row.target].limit) {
      status = 422;
      data = {
        detail:
          "Completed task exceeds the destination limit. Shorten the inputs; no text was truncated.",
      };
    } else
      data = {
        id: row.id,
        revision: row.revision,
        name: row.name,
        target: row.target,
        prompt,
      };
    if (heldRender) {
      const held = heldRender;
      heldRender = null;
      held.arrived();
      await held.promise;
    }
  } else {
    unexpected.push(`${method} ${path}`);
    status = 404;
    data = { detail: "Unexpected fixture request" };
  }
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(data),
  });
});
await page.route("**/recipes-fixture", (route) =>
  route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;
const {default:React}=await import('/node_modules/.vite-ui/deps/react.js');const {default:ReactDOM}=await import('/node_modules/.vite-ui/deps/react-dom_client.js');await import('/web/style.css?import');await import('/web/studio-design.css?import');const {default:Recipes}=await import('/web/Recipes.jsx');window.usedRecipes=[];window.failHandoff=false;
const api=async(path,body,method)=>{const r=await fetch('/api'+path,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw Object.assign(Error(value.detail),{status:r.status});return value;};
function Harness(){const[project,setProject]=React.useState({id:'project-a',name:'Alpine'}),[mount,setMount]=React.useState(0);window.fixtureProject=index=>setProject({id:'project-'+index,name:index==='a'?'Alpine':'Beach'});window.fixtureRemount=()=>setMount(value=>value+1);return React.createElement('main',{style:{padding:22,maxWidth:1200,margin:'auto'}},React.createElement(Recipes,{key:mount,api,project,onUse:async recipe=>{if(window.failHandoff){window.failHandoff=false;throw Error('Synthetic workspace draft could not open.');}window.usedRecipes.push({project:project.id,recipe});}}));}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
</script></body></html>`,
  }),
);
const name = () =>
  page.getByRole("textbox", { name: "Recipe name", exact: true });
const template = () =>
  page.getByRole("textbox", { name: "Prompt template", exact: true });
const input = (key) =>
  page.getByRole("textbox", { name: "Recipe input " + key, exact: true });
const saved = (name) =>
  page
    .getByRole("complementary", { name: "Saved recipes", exact: true })
    .getByRole("button")
    .filter({ has: page.getByText(name, { exact: true }) });
const preview = () =>
  page.getByRole("button", { name: "Preview task", exact: true });
const use = (name) =>
  page.getByRole("button", { name: "Use in " + name, exact: true });
try {
  await mkdir(".local", { recursive: true });
  await page.goto(base + "/recipes-fixture");
  await page
    .getByRole("alert")
    .filter({ hasText: "connection failure" })
    .waitFor();
  await page
    .getByRole("button", { name: "Refresh recipe library", exact: true })
    .click();
  await page
    .getByText(
      "No saved recipes yet. Start with an example or create your own.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
  await page
    .getByRole("button", { name: "Customize Explain a topic", exact: true })
    .click();
  await name().fill("Explain for teammates");
  await page.getByRole("button", { name: "Save recipe", exact: true }).click();
  await input("topic").waitFor();
  assert.equal(rows.length, 1);
  const original = rows[0];
  await input("topic").fill("<script>window.recipePwn=true</script> 😀");
  await input("audience").fill("new starters");
  await preview().click();
  await use("Chat").waitFor();
  assert.match(
    await page.getByLabel("Rendered recipe task").textContent(),
    /<script>/,
  );
  assert.equal(await page.evaluate(() => Boolean(window.recipePwn)), false);
  assert.deepEqual(await page.evaluate(() => window.usedRecipes), []);
  await page.evaluate(() => (window.failHandoff = true));
  await use("Chat").click();
  await page
    .getByRole("alert")
    .filter({ hasText: "workspace draft could not open" })
    .waitFor();
  assert.equal(await input("audience").inputValue(), "new starters");
  assert.deepEqual(await page.evaluate(() => window.usedRecipes), []);
  await preview().click();
  await use("Chat").click();
  await page
    .getByText(
      "Draft opened in Chat. Review its model and context before sending.",
      { exact: true },
    )
    .waitFor();
  const handed = await page.evaluate(() => window.usedRecipes);
  assert.equal(handed.length, 1);
  assert.equal(handed[0].recipe.id, original.id);
  assert.equal(handed[0].project, "project-a");

  // Stale edits retain the draft and original CAS base through remount/navigation.
  await page.getByRole("button", { name: "Edit recipe", exact: true }).click();
  await template().fill(
    "Explain {{topic}} for {{audience}}. Include a reviewed example.",
  );
  original.revision = 2;
  original.description = "Someone else changed this purpose.";
  await page.getByRole("button", { name: "Save recipe", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "changed in another window" })
    .waitFor();
  assert.match(await template().inputValue(), /reviewed example/);
  await page
    .getByRole("button", { name: "Reload saved recipe", exact: true })
    .click();
  await page
    .getByText(
      "Latest saved revision loaded. Your draft is kept; compare it before saving.",
      { exact: true },
    )
    .waitFor();
  await page.getByRole("button", { name: "Save recipe", exact: true }).click();
  await input("topic").waitFor();
  assert.equal(original.revision, 3);
  assert.match(original.template, /reviewed example/);
  await page.getByRole("button", { name: "Edit recipe", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Recipe purpose", exact: true })
    .fill("My unsaved local purpose.");
  original.revision = 4;
  original.description = "Published purpose in another window.";
  await page.evaluate(() => window.fixtureRemount());
  await page
    .getByRole("alert")
    .filter({ hasText: "saved recipe is now revision 4" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Recipe purpose", exact: true })
      .inputValue(),
    "My unsaved local purpose.",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Save recipe", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByRole("button", { name: "Discard recipe edits", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Recipe purpose", exact: true })
      .inputValue(),
    "Published purpose in another window.",
  );

  // Duplicate is independent. Deletion needs a confirmation and checks the current revision.
  await page.getByRole("button", { name: "Duplicate", exact: true }).click();
  await name().waitFor();
  assert.equal(rows.length, 2);
  const copy = rows[0];
  assert.notEqual(copy.id, original.id);
  await name().fill("Another explanation");
  await page.getByRole("button", { name: "Save recipe", exact: true }).click();
  await input("topic").waitFor();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);
  await page.getByRole("button", { name: "Keep recipe", exact: true }).click();
  assert.equal(rows.length, 2);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  copy.revision++;
  await page
    .getByRole("button", { name: "Delete recipe", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "changed in another window" })
    .waitFor();
  assert.equal(rows.length, 2);
  await page
    .getByRole("button", { name: "Reload saved recipe", exact: true })
    .click();
  await page
    .getByText(
      "Latest saved revision loaded. Your draft is kept; compare it before saving.",
      { exact: true },
    )
    .waitFor();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("button", { name: "Delete recipe", exact: true })
    .click();
  await page
    .getByText("Recipe deleted. Existing workspace drafts are unchanged.", {
      exact: true,
    })
    .waitFor();
  assert.equal(rows.length, 1);

  // New-draft replacement is explicit, and inputs do not leak across projects.
  await name().fill("Unsaved custom recipe");
  await template().fill("Review {{material}}.");
  await page.locator(".recipe-examples > summary").click();
  await page
    .getByRole("button", { name: "Customize Art direction", exact: true })
    .click();
  await page
    .getByRole("group", { name: "Replace unsaved recipe draft", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Keep current draft", exact: true })
    .click();
  assert.equal(await name().inputValue(), "Unsaved custom recipe");
  await saved("Explain for teammates").click();
  await input("topic").waitFor();
  assert.equal(await input("audience").inputValue(), "new starters");
  const held = gate();
  heldRender = held;
  await preview().click();
  await held.arrival;
  await page.evaluate(() => window.fixtureProject("b"));
  held.release();
  await page.waitForTimeout(70);
  assert.equal(await input("topic").inputValue(), "");
  assert.equal(await use("Chat").count(), 0);
  await input("topic").fill("Beach-only topic");
  await input("audience").fill("visitors");
  await page.evaluate(() => window.fixtureProject("a"));
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Recipe input audience"]')?.value ===
      "new starters",
  );
  assert.match(await input("topic").inputValue(), /<script>/);
  await page.getByRole("button", { name: "New recipe", exact: true }).click();
  assert.equal(await name().inputValue(), "Unsaved custom recipe");
  await page
    .getByLabel("Recipe destination", { exact: true })
    .selectOption("coding");
  await template().fill("x".repeat(1201));
  assert.equal(
    await page
      .getByRole("button", { name: "Save recipe", exact: true })
      .isDisabled(),
    true,
  );
  await template().fill("Review {{material}}.");
  await page.getByRole("button", { name: "Save recipe", exact: true }).click();
  await input("material").waitFor();
  await input("material").fill("x".repeat(1200));
  await preview().click();
  await page
    .getByRole("alert")
    .filter({ hasText: "no text was truncated" })
    .waitFor();
  assert.equal((await input("material").inputValue()).length, 1200);
  assert.equal(await use("Coding").count(), 0);
  await input("material").fill("selected source");
  await preview().click();
  await use("Coding").waitFor();
  await page
    .getByRole("searchbox", { name: "Search recipes", exact: true })
    .fill("no matching title");
  await page
    .getByText("No matching recipes. Try another search.", { exact: true })
    .waitFor();
  await page
    .getByRole("searchbox", { name: "Search recipes", exact: true })
    .fill("");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.screenshot({ path: ".local/recipes-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1350, height: 1050 });
  await page.screenshot({ path: ".local/recipes-desktop.png", fullPage: true });
  // A save finishing after close/reopen cannot clear a newer local definition draft.
  await page.getByRole("button", { name: "Edit recipe", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Recipe purpose", exact: true })
    .fill("The first editor's submitted purpose.");
  const saveGate = gate();
  heldSave = saveGate;
  await page.getByRole("button", { name: "Save recipe", exact: true }).click();
  await saveGate.arrival;
  await page.evaluate(() => window.fixtureRemount());
  await page
    .getByRole("alert")
    .filter({ hasText: "saved recipe is now revision 2" })
    .waitFor();
  await page
    .getByRole("textbox", { name: "Recipe purpose", exact: true })
    .fill("Newer edits after reopening the recipe.");
  saveGate.release();
  await page.waitForTimeout(70);
  await page.evaluate(() => window.fixtureRemount());
  await page
    .getByRole("alert")
    .filter({ hasText: "saved recipe is now revision 2" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Recipe purpose", exact: true })
      .inputValue(),
    "Newer edits after reopening the recipe.",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Save recipe", exact: true })
      .isDisabled(),
    true,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.ok(
    calls.every((call) => call.path.startsWith("/api/recipes")),
    "No model, generation or destination-write APIs",
  );
  console.log(
    "Recipe browser checks passed: examples vs saved library, CRUD/CAS/recovery, original draft base on remount, confirmed deletion, literal preview and failed handoff recovery, project-isolated inputs, stale preview protection, destination limits and mobile; no AI or destination writes.",
  );
} catch (error) {
  console.error(
    { errors, unexpected },
    (await page.locator("body").innerText()).slice(-9000),
  );
  await page.screenshot({ path: ".local/recipes-failure.png", fullPage: true });
  throw error;
} finally {
  await browser.close();
}
