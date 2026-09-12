// Standalone component fixture: no Studio API, downloads or inference involved.
import { chromium } from "playwright";
import { createServer } from "vite";
import assert from "node:assert/strict";
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module" src="/@setup-recovery"></script></body></html>`;
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import SetupTools from '/web/SetupTools.jsx';
const state = window.fixture = { calls: 0, active: 0, peak: 0, pending: [], tools: 0, errors: [] };
const api = async path => {
  if (path !== '/setup') throw new Error('Unexpected API: '+path);
  state.calls++; state.active++; state.peak=Math.max(state.peak,state.active);
  try {return await new Promise((resolve,reject)=>state.pending.push({resolve,reject}));}
  finally {state.active--;}
};
state.release = (value, error) => {
  const next=state.pending.shift();
  if(error) next.reject(new Error(error)); else next.resolve(value);
};
const root=createRoot(document.getElementById('root'));
state.unmount=()=>root.unmount();
root.render(React.createElement(SetupTools,{api,onTools:async()=>{state.tools++},report:e=>state.errors.push(e.message)}));
`;
const server = await createServer({
  server: { host: "127.0.0.1", port: 0, proxy: {} },
  logLevel: "error",
  cacheDir: ".local/setup-recovery-vite-cache",
  optimizeDeps: { include: ["react", "react-dom/client"] },
  plugins: [
    {
      name: "setup-recovery-fixture",
      resolveId(id) {
        if (id === "/@setup-recovery") return "\0setup-recovery";
      },
      load(id) {
        if (id === "\0setup-recovery") return entry;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/setup-recovery-fixture") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml(req.url, fixture));
        });
      },
    },
  ],
});
await server.listen();
const address = server.httpServer.address();
const browser = await chromium.launch({
  executablePath: process.env.STUDIO_CHROMIUM,
  headless: true,
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const snapshot = {
  system: {
    disk_free_bytes: 200 * 1024 ** 3,
    message: "Isolated fixture",
    checks: [],
  },
  tools: [
    {
      id: "fixture",
      title: "Local image tool",
      model: "Fixture model",
      state: "ready",
      message: "Ready for your ideas",
    },
  ],
  jobs: [],
};
try {
  await page.clock.install();
  await page.goto(`http://127.0.0.1:${address.port}/setup-recovery-fixture`);
  await page.waitForFunction(() => window.fixture?.calls === 1);
  await page.clock.runFor(5500);
  assert.equal(
    await page.evaluate(() => window.fixture.calls),
    1,
    "slow checks never overlap",
  );
  await page.evaluate(() => window.fixture.release(null, "Studio is offline"));
  await page.getByRole("alert").waitFor();
  assert.match(
    await page.getByRole("alert").innerText(),
    /Your saved work is safe/,
  );
  await page.getByRole("button", { name: "Try again" }).click();
  await page.waitForFunction(() => window.fixture.calls === 2);
  assert.equal(
    await page.getByRole("button", { name: "Checking again…" }).isDisabled(),
    true,
  );
  await page.evaluate((value) => window.fixture.release(value), snapshot);
  await page.getByRole("heading", { name: "Local image tool" }).waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
  await page.clock.runFor(2600);
  await page.waitForFunction(() => window.fixture.calls === 3);
  await page.evaluate(() =>
    window.fixture.release(null, "Connection interrupted"),
  );
  await page.getByRole("alert").waitFor();
  assert.match(
    await page.getByRole("alert").innerText(),
    /last successful check/,
  );
  assert.equal(
    await page.getByRole("heading", { name: "Local image tool" }).count(),
    1,
  );
  await page.getByRole("button", { name: "Try again" }).click();
  await page.waitForFunction(() => window.fixture.calls === 4);
  const complete = {
    ...snapshot,
    jobs: [{ id: "setup-completed", package: "fixture", state: "completed" }],
  };
  await page.evaluate((value) => window.fixture.release(value), complete);
  await page.waitForFunction(() => window.fixture.tools === 1);
  await page.clock.runFor(2600);
  await page.waitForFunction(() => window.fixture.calls === 5);
  await page.evaluate((value) => window.fixture.release(value), complete);
  await page.waitForFunction(() => window.fixture.active === 0);
  assert.equal(
    await page.evaluate(() => window.fixture.tools),
    1,
    "completed downloads refresh model choices once",
  );
  await page.evaluate(() => window.fixture.unmount());
  await page.clock.runFor(8000);
  assert.equal(
    await page.evaluate(() => window.fixture.calls),
    5,
    "polling stops on navigation",
  );
  assert.equal(await page.evaluate(() => window.fixture.peak), 1);
  assert.deepEqual(await page.evaluate(() => window.fixture.errors), []);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "single-flight slow setup checks",
        "inline offline recovery",
        "manual retry",
        "preserved last snapshot",
        "completed setup refresh",
        "navigation cleanup",
      ],
      inference: "none",
    }),
  );
} catch (error) {
  console.error({ pageErrors: errors });
  throw error;
} finally {
  await browser.close();
  await server.close();
}
