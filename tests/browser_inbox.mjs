// Synthetic saved outcomes only: no job, model, or runtime endpoints.
import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";
const base = process.env.STUDIO_TEST_URL || "http://127.0.0.1:8898";
assert.notEqual(new URL(base).port, "8877");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.setDefaultTimeout(12000);
const errors = [],
  unexpected = [],
  acknowledgments = [];
page.on("pageerror", (error) => errors.push(error.message));
const projects = [
  { id: "a".repeat(32), name: "Alpine" },
  { id: "b".repeat(32), name: "Beach" },
];
const events = [
  {
    id: "job:" + "1".repeat(32) + ":" + "1".repeat(16),
    kind: "chat",
    state: "completed",
    title: "Reply ready",
    summary: "Your saved result is ready to review.",
    project_id: projects[0].id,
    project_name: "Alpine",
    updated: 1700000000,
    read: false,
    target: {
      kind: "chat",
      project_id: projects[0].id,
      chat_id: "c".repeat(32),
      turn_id: "d".repeat(32),
    },
  },
  {
    id: "job:" + "2".repeat(32) + ":" + "2".repeat(16),
    kind: "job",
    state: "failed",
    title: "Video failed",
    summary: "Open to review recovery options.",
    project_id: projects[1].id,
    project_name: "Beach",
    updated: 1700000001,
    read: false,
    target: { kind: "job", project_id: projects[1].id, job_id: "2".repeat(32) },
  },
  {
    id: "website:" + "3".repeat(32) + ":" + "3".repeat(16),
    kind: "website",
    state: "needs_attention",
    title: "Website draft ready",
    summary: "Review and apply when ready.",
    project_id: projects[0].id,
    project_name: "Alpine",
    updated: 1700000002,
    read: false,
    target: {
      kind: "website",
      project_id: projects[0].id,
      run_id: "3".repeat(32),
    },
  },
];
let failGet = false,
  failRead = false,
  heldGet = null;
const gate = () => {
  let arrived, release, done;
  return {
    arrival: new Promise((resolve) => (arrived = resolve)),
    promise: new Promise((resolve) => (release = resolve)),
    completion: new Promise((resolve) => (done = resolve)),
    arrived: () => arrived(),
    release: () => release(),
    done: () => done(),
  };
};
await page.route("**/api/**", async (route) => {
  const req = route.request(),
    url = new URL(req.url()),
    path = url.pathname,
    method = req.method();
  let data,
    status = 200,
    hold;
  if (path === "/api/inbox" && method === "GET") {
    const project = url.searchParams.get("project_id");
    const selected = structuredClone(
      events.filter((event) => !project || event.project_id === project),
    );
    data = {
      events: selected,
      unread: selected.filter((event) => !event.read).length,
      has_more: false,
      limit: 100,
      project_id: project,
    };
    if (failGet) {
      failGet = false;
      status = 503;
      data = { detail: "Inbox temporarily unavailable." };
    }
    if (heldGet) {
      hold = heldGet;
      heldGet = null;
      hold.arrived();
      await hold.promise;
    }
  } else if (path === "/api/inbox/read" && method === "POST") {
    const body = req.postDataJSON();
    acknowledgments.push(body.event_ids);
    if (failRead) {
      failRead = false;
      status = 503;
      data = { detail: "Read status could not be saved." };
    } else {
      const found = events.filter((event) => body.event_ids.includes(event.id));
      for (const event of found) event.read = true;
      data = {
        read_ids: found.map((event) => event.id),
        unavailable_ids: body.event_ids.filter(
          (id) => !found.some((event) => event.id === id),
        ),
      };
    }
  } else {
    unexpected.push(method + " " + path);
    status = 404;
    data = { detail: "Unexpected fixture API" };
  }
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(data),
  });
  hold?.done();
});
await page.route("**/inbox-fixture", (route) =>
  route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;
const {default:React}=await import('/node_modules/.vite-ui/deps/react.js');const {default:ReactDOM}=await import('/node_modules/.vite-ui/deps/react-dom_client.js');await import('/web/style.css?import');await import('/web/studio-design.css?import');const {default:CompletionInbox}=await import('/web/CompletionInbox.jsx');
window.opened=[];window.navigation='success';window.reports=[];
const api=async(path,body)=>{const response=await fetch('/api'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw Error(data.detail);return data;};
function Harness(){const [project,setProject]=React.useState(${JSON.stringify(projects[0])}),[mount,setMount]=React.useState(0);window.fixtureProject=setProject;window.fixtureRemount=()=>setMount(value=>value+1);return React.createElement('main',{style:{display:'flex',justifyContent:'end',padding:20}},React.createElement(CompletionInbox,{key:mount,project,api,report:value=>window.reports.push(value),onOpen:async target=>{window.opened.push(target);if(window.navigation==='fail')throw Error('Result is no longer available.');if(window.navigation==='cancel')return false;return true;}}));}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
</script></body></html>`,
  }),
);
const trigger = () => page.getByRole("button", { name: /^Completion inbox/ });
const panel = () =>
  page.getByRole("region", { name: "Completion inbox", exact: true });
const card = (title) =>
  panel()
    .locator("li")
    .filter({ has: page.getByText(title, { exact: true }) });
const open = async () => {
  await trigger().click();
  await panel().waitFor();
};
const refresh = async () => {
  await panel()
    .getByRole("button", { name: "Refresh completion inbox", exact: true })
    .click();
};
try {
  await page.goto(base + "/inbox-fixture");
  await page
    .getByRole("button", {
      name: "Completion inbox, 3 unread in recent outcomes",
      exact: true,
    })
    .waitFor();
  await open();
  const colors = await panel().evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, text: style.color };
  });
  const luminance = (color) => {
    const rgb = color
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map(Number)
      .map((value) => {
        const normalized = value / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  assert.ok(
    (luminance(colors.text) + 0.05) / (luminance(colors.background) + 0.05) >=
      4.5,
    "inbox text has readable contrast against Studio's dark surface",
  );
  assert.equal(await panel().locator("li").count(), 3);
  assert.equal(
    await panel().getByText("Review needed", { exact: true }).count(),
    1,
  );
  assert.match(
    await panel().locator("footer").textContent(),
    /Latest 100 saved outcomes/,
  );
  assert.equal(
    acknowledgments.length,
    0,
    "opening the inbox does not mark unseen outcomes read",
  );
  await page.evaluate(() => (window.navigation = "cancel"));
  await card("Reply ready").locator(".completion-inbox-open").click();
  assert.equal(
    acknowledgments.length,
    0,
    "cancelled navigation retains unread status",
  );
  await page.evaluate(() => (window.navigation = "fail"));
  await card("Reply ready").locator(".completion-inbox-open").click();
  await panel()
    .getByRole("alert")
    .getByText("Result is no longer available.", { exact: true })
    .waitFor();
  assert.equal(
    acknowledgments.length,
    0,
    "failed navigation retains unread status",
  );
  await page.evaluate(() => (window.navigation = "success"));
  await card("Reply ready").locator(".completion-inbox-open").click();
  await panel().waitFor({ state: "hidden" });
  assert.deepEqual(acknowledgments[0], [events[0].id]);
  assert.deepEqual(
    await page.evaluate(() => window.opened.at(-1)),
    events[0].target,
    "exact turn/project target passed to parent",
  );
  await page.evaluate(() => window.fixtureRemount());
  await page
    .getByRole("button", {
      name: "Completion inbox, 2 unread in recent outcomes",
      exact: true,
    })
    .waitFor();
  await open();
  assert.equal(
    await card("Reply ready")
      .getByRole("button", { name: "Mark Reply ready as read", exact: true })
      .isDisabled(),
    true,
  );
  await panel()
    .getByRole("combobox", { name: "Inbox projects" })
    .selectOption("project");
  await page.waitForFunction(
    () => document.querySelectorAll(".completion-inbox-events li").length === 2,
  );
  assert.equal(await panel().getByText("Beach", { exact: true }).count(), 0);
  // A slow result from the previous project must never replace the new scope.
  const hold = gate();
  heldGet = hold;
  await refresh();
  await hold.arrival;
  await page.evaluate((project) => window.fixtureProject(project), projects[1]);
  await panel().getByText("Video failed", { exact: true }).waitFor();
  hold.release();
  await hold.completion;
  assert.equal(await panel().locator("li").count(), 1);
  assert.equal(await panel().getByText("Alpine", { exact: true }).count(), 0);
  failRead = true;
  await card("Video failed")
    .getByRole("button", { name: "Mark Video failed as read", exact: true })
    .click();
  await panel()
    .getByRole("alert")
    .getByText("Read status could not be saved.", { exact: true })
    .waitFor();
  assert.equal(events[1].read, false);
  await card("Video failed")
    .getByRole("button", { name: "Mark Video failed as read", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector(".completion-inbox-read")?.disabled,
  );
  assert.equal(events[1].read, true);
  await panel()
    .getByRole("combobox", { name: "Inbox projects" })
    .selectOption("all");
  await page.waitForFunction(
    () => document.querySelectorAll(".completion-inbox-events li").length === 3,
  );
  await panel()
    .getByRole("button", { name: "Mark shown as read", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector(".completion-inbox-panel footer")
      ?.textContent.includes("0 unread."),
  );
  assert.deepEqual(
    acknowledgments.at(-1),
    [events[2].id],
    "mark shown only submits reviewed unread IDs",
  );
  failGet = true;
  await refresh();
  await panel()
    .getByRole("alert")
    .getByText("Inbox temporarily unavailable.", { exact: true })
    .waitFor();
  await panel()
    .getByRole("button", { name: "Retry inbox", exact: true })
    .click();
  await panel().getByRole("alert").waitFor({ state: "hidden" });
  await page.keyboard.press("Escape");
  await panel().waitFor({ state: "hidden" });
  assert.equal(
    await trigger().evaluate((element) => element === document.activeElement),
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  const box = await panel().boundingBox();
  assert.ok(
    box.x >= 0 && box.x + box.width <= 390,
    "mobile popover fits viewport",
  );
  events.length = 0;
  await refresh();
  await panel()
    .getByText("No completed or stopped work yet", { exact: true })
    .waitFor();
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  console.log(
    "Completion inbox browser checks passed: scoped saved history, persistent read state, exact navigation/ack order, stale project response rejection, failures/retry, read shown, keyboard and mobile. No jobs or runtime calls.",
  );
} finally {
  await browser.close();
}
