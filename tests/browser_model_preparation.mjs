// Standalone presentation fixture. No Studio APIs, model loading or GPU work.
import { chromium } from "playwright";
import { createServer } from "vite";
import assert from "node:assert/strict";

const fixture = `<!doctype html><html><body><div id="root"></div><script type="module" src="/@model-preparation"></script></body></html>`;
const entry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ModelChoice} from '/web/WorkspaceExtras.jsx';
function Fixture() {
  const [props, setProps] = useState({tools:[],task:'write',details:true});
  window.fixture = {setProps: patch => setProps(old => ({...old,...patch}))};
  return React.createElement(ModelChoice, {...props,onChange:value=>setProps(old=>({...old,value}))});
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
`;
const server = await createServer({
  server: { host: "127.0.0.1", port: 0, proxy: {} },
  logLevel: "error",
  cacheDir: ".local/model-preparation-vite-cache",
  optimizeDeps: { include: ["react", "react-dom/client"] },
  plugins: [
    {
      name: "model-preparation-fixture",
      resolveId(id) {
        if (id === "/@model-preparation") return "\0model-preparation";
      },
      load(id) {
        if (id === "\0model-preparation") return entry;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/model-preparation-fixture") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml(req.url, fixture));
        });
      },
    },
  ],
});
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.STUDIO_CHROMIUM,
  headless: true,
});
const page = await browser.newPage();
const errors = [],
  apiCalls = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/api/**", (route) => {
  apiCalls.push(route.request().url());
  return route.abort();
});
const tools = [
  {
    id: "small",
    name: "Small fixture",
    state: "ready",
    compatibility: { compatible: true },
    preparation_note: "Small fixture preparation.",
    quality_note: "Small fixture needs careful review.",
    profiles: [
      {
        id: "small-write",
        label: "Short draft",
        task: "write",
        roles: ["write"],
      },
    ],
  },
  {
    id: "large",
    name: "Large fixture",
    state: "ready",
    default_for: ["write", "website"],
    compatibility: { compatible: true },
    preparation_note: "Large fixture can take several minutes to load.",
    quality_note: "Package quality note.",
    profiles: [
      {
        id: "large-write",
        label: "Full draft",
        task: "write",
        roles: ["write"],
        quality_note: "Profile quality note.",
      },
      { id: "large-site", label: "Website", task: "write", roles: ["website"] },
    ],
  },
];
async function setProps(props) {
  await page.evaluate((value) => window.fixture.setProps(value), props);
}
async function describedText(select) {
  return select.evaluate((element) =>
    (element.getAttribute("aria-describedby") || "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" "),
  );
}
try {
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/model-preparation-fixture`,
  );
  await page.waitForFunction(() => window.fixture);
  await setProps({ tools, value: "auto", defaultId: "auto" });
  const select = page.getByRole("combobox", { name: "Creation tool" });
  const preparation = page.locator(".model-preparation-note");
  await preparation
    .getByText(tools[1].preparation_note, { exact: false })
    .waitFor();
  assert.equal(await select.inputValue(), "auto");
  assert.match(await describedText(select), /Profile quality note/);
  assert.match(await describedText(select), /several minutes/);
  assert.doesNotMatch(await describedText(select), /Small fixture/);

  await select.selectOption("small-write");
  await preparation
    .getByText(tools[0].preparation_note, { exact: false })
    .waitFor();
  assert.match(await describedText(select), /needs careful review/);
  assert.doesNotMatch(await describedText(select), /several minutes/);

  await setProps({ value: "auto", defaultId: "small-write" });
  assert.match(await describedText(select), /Small fixture preparation/);
  await setProps({
    defaultId: "auto",
    tools: [tools[0], { ...tools[1], state: "setup required" }],
  });
  assert.match(await describedText(select), /Small fixture preparation/);
  await setProps({
    tools: [tools[0], { ...tools[1], compatibility: { compatible: false } }],
  });
  assert.match(await describedText(select), /Small fixture preparation/);

  // An explicit missing choice must not claim that a fallback model was chosen.
  await setProps({ value: "missing-profile" });
  await page.waitForFunction(
    () => !document.querySelector(".model-preparation-note"),
  );
  assert.equal(await select.getAttribute("aria-describedby"), null);

  await setProps({ tools, task: "website", value: "auto", defaultId: "auto" });
  await preparation
    .getByText(tools[1].preparation_note, { exact: false })
    .waitFor();
  assert.deepEqual(
    await select
      .locator("option")
      .evaluateAll((options) => options.map((o) => o.value)),
    ["auto", "large-site"],
  );
  assert.match(await describedText(select), /Package quality note/);
  assert.doesNotMatch(await describedText(select), /Profile quality note/);

  await setProps({ task: "image" });
  await page.waitForFunction(
    () => !document.querySelector(".model-preparation-note"),
  );
  assert.match(
    await page.locator(".model-note").innerText(),
    /No compatible tool is ready/,
  );
  assert.deepEqual(apiCalls, []);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "recommended automatic preparation before creation",
        "quality and preparation accessible together",
        "explicit model and saved default honored",
        "unready and incompatible recommendations skipped",
        "no fallback for explicit missing choice",
        "role-aware notes",
        "no network or GPU work",
      ],
    }),
  );
} finally {
  await browser.close();
  await server.close();
}
