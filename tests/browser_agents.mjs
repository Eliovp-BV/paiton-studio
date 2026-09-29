// Real Agents UI, synthetic local APIs only. Never queues live model work.
import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";

const base = process.env.STUDIO_TEST_URL || "http://127.0.0.1:8898";
assert.notEqual(new URL(base).port, "8877");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
page.setDefaultTimeout(10000);
const project = { id: "a".repeat(32), name: "Launch project" };
const assets = Array.from({ length: 9 }, (_, i) => ({
  id: (i + 1).toString(16).padStart(32, "0"),
  name: `Project notes ${i + 1}`,
  kind: "document",
  project: project.id,
}));
const templates = [
  {
    id: "brief",
    name: "Document briefing",
    purpose: "Turn my selected documents into a concise, accurate brief.",
  },
  {
    id: "content",
    name: "Content partner",
    purpose:
      "Help me turn approved product facts into clear, engaging content.",
  },
  {
    id: "plan",
    name: "Creative producer",
    purpose:
      "Turn my idea into an actionable plan for images, video and a website.",
  },
  {
    id: "code-review",
    name: "Code reviewer",
    purpose:
      "Review the code or diff I provide for concrete bugs, risks and useful improvements.",
  },
  { id: "custom", name: "My own purpose", purpose: "" },
];
const tools = [
  {
    id: "local-text",
    model: "Local text model",
    name: "Local text",
    state: "ready",
    default_for: ["chat"],
    profiles: [
      {
        id: "local-chat",
        task: "write",
        roles: ["chat"],
        label: "Chat",
        state: "ready",
      },
    ],
  },
  {
    id: "careful-text",
    model: "Careful local model",
    name: "Careful text",
    state: "ready",
    profiles: [
      {
        id: "careful-chat",
        task: "write",
        roles: ["chat"],
        label: "Chat",
        state: "ready",
      },
    ],
  },
];
let agents = [],
  id = 0,
  failRun = false,
  failServer = false,
  conflictEdit = false;
let brief = {
  project: project.id,
  content: "Audience: first-time Studio users.",
  revision: 1,
  updated: 1,
};
const requests = [],
  errors = [],
  unexpected = [];
const nextId = () => (++id + 100).toString(16).padStart(32, "0");
const clone = (value) => structuredClone(value);
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/api/**", async (route) => {
  const request = route.request(),
    path = new URL(request.url()).pathname,
    method = request.method();
  const body = request.postData() ? request.postDataJSON() : null;
  requests.push({ path, method, body: clone(body) });
  let data,
    status = 200;
  if (path === "/api/agent-templates" && method === "GET") data = templates;
  else if (path === `/api/projects/${project.id}/brief`) {
    if (method === "PUT") {
      assert.equal(body.expected_revision, brief.revision);
      brief = { ...brief, content: body.content, revision: brief.revision + 1 };
    }
    data = brief;
  } else if (
    /^\/api\/agents\/[a-f0-9]{32}\/context$/.test(path) &&
    method === "POST"
  ) {
    const agent = agents.find((item) => item.id === path.split("/")[3]);
    assert.ok(agent);
    const messages = [
      { role: "system", content: agent.definition.purpose },
      {
        role: "user",
        content:
          body.instruction +
          (body.project_brief_revision ? "\n" + brief.content : ""),
      },
    ];
    data = {
      kind: "text",
      messages,
      sources: [],
      project_brief: body.project_brief_revision
        ? { content: brief.content, revision: brief.revision }
        : null,
      history: { included_turns: 0, omitted_turns: 0, excerpted: false },
      characters: messages.reduce((sum, item) => sum + item.content.length, 0),
      fingerprint: "a".repeat(64),
    };
  } else if (path === `/api/projects/${project.id}/agents` && method === "GET")
    data = agents;
  else if (path === `/api/projects/${project.id}/agents` && method === "POST") {
    assert.deepEqual(Object.keys(body).sort(), [
      "document_ids",
      "name",
      "profile_id",
      "purpose",
      "template",
      "tools_enabled",
    ]);
    assert.equal(body.tools_enabled, false);
    data = {
      id: nextId(),
      project: project.id,
      definition: { ...body, version: 1 },
      created: Date.now() / 1000,
      runs: [],
    };
    agents.unshift(data);
  } else if (/^\/api\/agents\/[a-f0-9]{32}$/.test(path) && method === "PUT") {
    const agent = agents.find((item) => item.id === path.split("/")[3]);
    assert.ok(agent);
    if (conflictEdit || body.expected_version !== agent.definition.version) {
      conflictEdit = false;
      status = 400;
      data = {
        detail:
          "This agent changed in another window. Cancel editing and reopen its settings before saving.",
      };
    } else {
      const { expected_version, ...definition } = body;
      agent.definition = { ...definition, version: expected_version + 1 };
      data = agent;
    }
  } else if (
    /^\/api\/agents\/[a-f0-9]{32}\/runs$/.test(path) &&
    method === "POST"
  ) {
    const agent = agents.find((item) => item.id === path.split("/")[3]);
    assert.ok(agent);
    if (failRun) {
      failRun = false;
      status = 503;
      data = { detail: "Temporary fixture connection failure. Try again." };
    } else {
      data = agent.runs.find((run) => run.client_id === body.client_id);
      if (!data) {
        const selectedProfile =
          agent.definition.profile_id === "auto"
            ? "careful-chat"
            : agent.definition.profile_id;
        const selectedTool = tools.find((tool) =>
          tool.profiles.some((profile) => profile.id === selectedProfile),
        );
        data = {
          id: nextId(),
          agent: agent.id,
          client_id: body.client_id,
          instruction: body.instruction,
          definition: clone(agent.definition),
          state: "drafting",
          message: "Draft saved in the local queue.",
          created: Date.now() / 1000,
          text: null,
          draft_text: null,
          jobs: [
            {
              id: nextId(),
              state: "queued",
              message: "Waiting to draft",
              request: {
                prompt: body.instruction,
                profile: {
                  id: selectedProfile,
                  model: selectedTool.model,
                  package: selectedTool.id,
                  label: "Chat",
                },
                context_ids: clone(agent.definition.document_ids),
                sources: agent.definition.document_ids.map((id) => ({
                  id,
                  name: assets.find((asset) => asset.id === id).name,
                  excerpts: [1],
                })),
              },
            },
          ],
        };
        agent.runs.unshift(data);
      }
    }
  } else if (
    /^\/api\/agent-runs\/[a-f0-9]{32}\/cancel$/.test(path) &&
    method === "POST"
  ) {
    data = agents
      .flatMap((agent) => agent.runs)
      .find((run) => run.id === path.split("/")[3]);
    assert.ok(data);
    data.state = "cancelled";
    data.message = "Agent stopped. Completed drafts are preserved.";
    data.jobs.forEach((job) => {
      if (!["completed", "failed"].includes(job.state)) job.state = "cancelled";
    });
  } else if (
    path === `/api/projects/${project.id}/mcp-servers` &&
    method === "POST"
  ) {
    assert.ok(agents.find((agent) => agent.id === body.agent_id));
    if (failServer) {
      failServer = false;
      status = 503;
      data = {
        detail: "MCP registration unavailable. Retry from the saved agent.",
      };
    } else data = { id: "e".repeat(32), agent: body.agent_id, enabled: false };
  } else {
    unexpected.push(`${method} ${path}`);
    status = 500;
    data = { detail: "Unexpected fixture request" };
  }
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(data),
  });
});
await page.route("**/agents-fixture", (route) =>
  route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><title>Agents fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;
const {default: React} = await import('/node_modules/.vite-ui/deps/react.js');
const {useState} = React;
const {default: ReactDOM} = await import('/node_modules/.vite-ui/deps/react-dom_client.js');
const {createRoot} = ReactDOM;
await import('/web/style.css?import'); await import('/web/studio-design.css?import'); await import('/web/studio-gold.css?import');
const {default: AgentsStudio} = await import('/web/AgentsStudio.jsx');
const api = async (path, body, method) => { const response = await fetch('/api' + path, { method: method || (body === undefined ? 'GET' : 'POST'), headers: {'Content-Type':'application/json'}, body: body === undefined ? undefined : JSON.stringify(body) }); const value = await response.json(); if (!response.ok) throw Error(value.detail); return value; };
function Harness() {
  const [intent, setIntent] = useState(null), [worker, setWorker] = useState({state:'stopped'}), [handoff, setHandoff] = useState(''), [currentTools, setTools] = useState(${JSON.stringify(tools)}), [currentAssets, setAssets] = useState(${JSON.stringify(assets)}), [showAgents, setShowAgents] = useState(true);
  window.fixtureIntent = setIntent; window.fixtureWorker = setWorker; window.fixtureTools = setTools; window.fixtureAssets = setAssets;
  return React.createElement('main', {style:{padding:'24px',maxWidth:'1450px',margin:'0 auto',minWidth:0}}, showAgents ? React.createElement(AgentsStudio, {project:${JSON.stringify(project)}, assets:currentAssets, tools:currentTools, defaultProfile:'careful-chat', api, initialIntent:intent, onIntentConsumed:()=>setIntent(null), onMCPServer:(id)=>setHandoff('MCP handoff '+id), onCoding:()=>setHandoff('Coding workspace requested'), onModels:()=>{setHandoff('Model settings requested');setShowAgents(false);}, worker}) : React.createElement('button', {onClick:()=>setShowAgents(true)}, 'Back to agents'), React.createElement('output', {id:'handoff'}, handoff));
}
createRoot(document.getElementById('root')).render(React.createElement(Harness));
</script></body></html>`,
  }),
);
const saved = page.getByRole("complementary", { name: "Saved agents" });
const setup = page.getByRole("form", { name: "Agent setup" });
const runForm = page.getByRole("form", { name: "Run agent" });
const runPanel = page.getByRole("region", { name: "Agent run" });
const refresh = () =>
  page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
const runPosts = () =>
  requests.filter((request) => /\/agents\/[^/]+\/runs$/.test(request.path));
try {
  await mkdir(".local", { recursive: true });
  await page.goto(base + "/agents-fixture");
  await page
    .getByRole("heading", { name: "What would you like help with?" })
    .waitFor();
  assert.equal(await page.locator(".agent-starters > button").count(), 4);
  await page
    .getByRole("button", { name: /Code reviewer Review supplied code/ })
    .click();
  assert.equal(
    await setup.getByLabel("Agent name", { exact: true }).inputValue(),
    "Code reviewer",
  );
  await setup
    .getByRole("region", { name: "Local AI model" })
    .getByText("Careful text", { exact: true })
    .waitFor();
  for (let i = 1; i <= 8; i++)
    await setup.getByLabel(`Project notes ${i}`, { exact: true }).check();
  assert.equal(
    await setup.getByLabel("Project notes 9", { exact: true }).isDisabled(),
    true,
  );
  for (let i = 2; i <= 8; i++)
    await setup.getByLabel(`Project notes ${i}`, { exact: true }).uncheck();
  await setup
    .getByLabel("Agent model", { exact: true })
    .selectOption("local-chat");
  await setup
    .getByRole("button", { name: "Model settings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Back to agents", exact: true })
    .click();
  assert.equal(
    await setup.getByLabel("Agent name", { exact: true }).inputValue(),
    "Code reviewer",
  );
  assert.equal(
    await setup.getByLabel("Project notes 1", { exact: true }).isChecked(),
    true,
  );
  assert.equal(
    await setup.getByLabel("Agent model", { exact: true }).inputValue(),
    "local-chat",
  );
  await setup
    .getByRole("button", { name: "Create agent", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Code reviewer", exact: true })
    .waitFor();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].definition.template, "code-review");
  assert.deepEqual(agents[0].definition.document_ids, [assets[0].id]);
  await page
    .getByLabel("Agent model", { exact: true })
    .selectOption("careful-chat");
  await page
    .getByText("Model saved for future runs.", { exact: false })
    .waitFor();
  assert.equal(agents[0].definition.profile_id, "careful-chat");
  await page.reload();
  await page
    .getByRole("heading", { name: "Code reviewer", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Agent model", { exact: true }).inputValue(),
    "careful-chat",
  );
  await runForm
    .getByLabel("What should this agent work on?")
    .fill("Review this diff: +return input.value;");
  await page
    .getByRole("region", { name: "Local AI model" })
    .getByRole("button", { name: "Model settings", exact: true })
    .click();
  assert.equal(
    await page.locator("#handoff").textContent(),
    "Model settings requested",
  );
  await page
    .getByRole("button", { name: "Back to agents", exact: true })
    .click();
  assert.equal(
    await runForm.getByLabel("What should this agent work on?").inputValue(),
    "Review this diff: +return input.value;",
  );
  await page.getByText("Each run starts fresh", { exact: false }).waitFor();
  await runForm
    .getByLabel("What should this agent work on?")
    .fill("Review this diff: +return input.value;");
  assert.equal(
    await runForm
      .getByRole("button", { name: "Run agent", exact: true })
      .isDisabled(),
    true,
  );
  assert.ok(
    await page.getByText("AI is paused.", { exact: false }).isVisible(),
  );
  assert.equal(runPosts().length, 0);
  await runForm
    .getByRole("checkbox", { name: "Include project brief", exact: true })
    .check();
  await runForm.locator(".context-inspector > summary").click();
  await runForm
    .getByRole("button", { name: "Preview context", exact: true })
    .click();
  await runForm
    .getByText("Project brief included · revision 1", { exact: true })
    .waitFor();
  await runForm
    .locator(".context-inspector-messages details")
    .nth(1)
    .locator("summary")
    .click();
  assert.ok(
    (
      await runForm
        .locator(".context-inspector-messages pre")
        .nth(1)
        .innerText()
    ).includes(brief.content),
  );
  assert.equal(
    runPosts().length,
    0,
    "Inspecting context while paused never starts an agent",
  );
  const idleReads = requests.filter(
    (request) => request.path.endsWith("/agents") && request.method === "GET",
  ).length;
  await page.waitForTimeout(3200);
  assert.equal(
    requests.filter(
      (request) => request.path.endsWith("/agents") && request.method === "GET",
    ).length,
    idleReads,
    "Idle agents should not poll every few seconds",
  );
  await page.getByRole("button", { name: "Open coding workspace" }).click();
  assert.equal(
    await page.locator("#handoff").textContent(),
    "Coding workspace requested",
  );

  // Saved roles remain visible and searchable while making/editing another.
  await page.getByRole("button", { name: "Duplicate", exact: true }).click();
  await setup
    .getByLabel("Agent name", { exact: true })
    .fill("Release notes helper");
  await setup
    .getByLabel("Purpose", { exact: true })
    .fill("Write concise release notes from approved changes.");
  await setup
    .getByRole("button", { name: "Create agent", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Release notes helper", exact: true })
    .waitFor();
  assert.equal(agents.length, 2);
  await saved.getByLabel("Search saved agents").fill("concrete bugs");
  assert.equal(await saved.locator(".agents-saved-list > button").count(), 1);
  await saved.getByRole("button", { name: /Code reviewer/ }).click();
  assert.equal(
    await runForm.getByLabel("What should this agent work on?").inputValue(),
    "Review this diff: +return input.value;",
  );
  await saved.getByLabel("Search saved agents").fill("unmatched role");
  await saved.getByText("No agents match this search.").waitFor();
  await saved.getByRole("button", { name: "Show all agents" }).click();
  assert.equal(await saved.locator(".agents-saved-list > button").count(), 2);

  // Failed requests keep the client id; the fixture never forwards to a worker.
  await page.evaluate(() => window.fixtureWorker({ state: "idle" }));
  const unavailable = clone(tools);
  unavailable[1].state = "missing";
  unavailable[1].profiles[0].state = "missing";
  await page.evaluate((value) => window.fixtureTools(value), unavailable);
  await page
    .getByRole("region", { name: "Local AI model" })
    .getByText("Setup needed", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Agent model", { exact: true }).inputValue(),
    "careful-chat",
  );
  assert.equal(
    await runForm
      .getByRole("button", { name: "Run agent", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    runPosts().length,
    0,
    "Unavailable saved model must never silently fall back",
  );
  await page.evaluate((value) => window.fixtureTools(value), tools);
  await page.evaluate((value) => window.fixtureAssets(value), assets.slice(1));
  await page
    .getByRole("button", { name: "Edit approved context", exact: true })
    .waitFor();
  assert.equal(
    await runForm
      .getByRole("button", { name: "Run agent", exact: true })
      .isDisabled(),
    true,
  );
  await page.evaluate((value) => window.fixtureAssets(value), assets);
  // Refresh after switching agents/models so this exact next run uses the preview fingerprint.
  if (
    !(await runForm
      .getByRole("button", { name: "Preview context", exact: true })
      .isVisible())
  )
    await runForm.locator(".context-inspector > summary").click();
  await runForm
    .getByRole("button", { name: "Preview context", exact: true })
    .click();
  await runForm
    .getByText("Project brief included · revision 1", { exact: true })
    .waitFor();
  failRun = true;
  await runForm.getByRole("button", { name: "Run agent", exact: true }).click();
  await page
    .getByRole("alert")
    .getByText(/Temporary fixture/)
    .waitFor();
  await runForm.getByRole("button", { name: "Run agent", exact: true }).click();
  await runPanel
    .getByRole("heading", { name: "Drafting", exact: true })
    .waitFor();
  assert.equal(runPosts().length, 2);
  assert.equal(runPosts()[0].body.client_id, runPosts()[1].body.client_id);
  assert.equal(runPosts()[1].body.project_brief_revision, 1);
  assert.equal(runPosts()[1].body.context_fingerprint, "a".repeat(64));
  assert.equal(
    await runForm
      .getByRole("button", { name: "Run agent", exact: true })
      .isDisabled(),
    true,
  );
  const reviewer = agents.find(
    (agent) => agent.definition.name === "Code reviewer",
  );
  const firstRun = reviewer.runs[0];
  assert.equal(
    await runPanel
      .getByRole("tab", { name: "Run plan", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  await runPanel
    .getByText("Review this diff: +return input.value;", { exact: true })
    .waitFor();

  // Change future settings while the old run retains its own purpose/context.
  await page.getByRole("button", { name: "Edit agent", exact: true }).click();
  await setup
    .getByLabel("Purpose", { exact: true })
    .fill("Review changes for correctness and clear error handling.");
  conflictEdit = true;
  await setup
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await page
    .getByRole("alert")
    .getByText(/changed in another window/)
    .waitFor();
  assert.equal(
    await setup.getByLabel("Purpose", { exact: true }).inputValue(),
    "Review changes for correctness and clear error handling.",
  );
  await setup
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Code reviewer", exact: true })
    .waitFor();
  assert.equal(reviewer.definition.version, 3);
  assert.equal(firstRun.definition.version, 2);
  await runPanel
    .getByText("Careful local model · Chat", { exact: true })
    .waitFor();
  await runPanel.getByText("Project notes 1", { exact: true }).waitFor();
  await runPanel
    .getByText(firstRun.definition.purpose, { exact: true })
    .waitFor();

  firstRun.state = "reviewing";
  firstRun.draft_text =
    "First draft: the null input case can throw.\nSuggested test: missing input.";
  firstRun.jobs[0].state = "completed";
  firstRun.jobs[0].message = "Draft saved";
  firstRun.jobs.push({
    id: nextId(),
    state: "running",
    message: "Reviewing the supplied code",
  });
  firstRun.message =
    "Checking the draft against your purpose and selected sources.";
  await runPanel
    .getByRole("heading", { name: "Reviewing", exact: true })
    .waitFor();
  await runPanel.getByRole("tab", { name: "Draft", exact: true }).click();
  await runPanel.getByText(firstRun.draft_text, { exact: true }).waitFor();
  firstRun.state = "completed";
  firstRun.text =
    "Handle a missing input before reading value.\nAdd a regression test for null input.";
  firstRun.jobs[1].state = "completed";
  firstRun.message = "Agent result saved. Review it before using it.";
  await refresh();
  await runPanel
    .getByRole("heading", { name: "Ready to review", exact: true })
    .waitFor();
  await runPanel
    .getByRole("tab", { name: "Final result", exact: true })
    .click();
  await runPanel.getByText(firstRun.text, { exact: true }).waitFor();
  await runPanel
    .getByRole("tab", { name: "Final result", exact: true })
    .press("ArrowLeft");
  assert.equal(
    await runPanel
      .getByRole("tab", { name: "Draft", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  await runPanel.getByRole("tab", { name: "Draft", exact: true }).press("End");
  await runPanel
    .getByRole("button", { name: "Copy text", exact: true })
    .click();
  await runPanel.getByRole("button", { name: "Copied", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    firstRun.text,
  );
  const downloadPromise = page.waitForEvent("download");
  await runPanel.getByRole("button", { name: "Download", exact: true }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "Code-reviewer-result.md");
  assert.equal(await readFile(await download.path(), "utf8"), firstRun.text);

  await runForm
    .getByLabel("What should this agent work on?")
    .fill("Review the revised error handling.");
  await runForm.getByRole("button", { name: "Run agent", exact: true }).click();
  await runPanel
    .getByRole("heading", { name: "Drafting", exact: true })
    .waitFor();
  await runPanel.getByRole("button", { name: "Stop run", exact: true }).click();
  await runPanel
    .getByRole("heading", { name: "Stopped", exact: true })
    .waitFor();
  const history = page.getByRole("region", { name: "Run history" });
  assert.equal(await history.getByRole("button").count(), 2);
  await history.getByRole("button", { name: /Review this diff/ }).click();
  await runPanel.getByText(firstRun.text, { exact: true }).waitFor();
  const beforeReuse = runPosts().length;
  await runPanel
    .getByRole("button", { name: "Reuse task", exact: true })
    .click();
  assert.equal(
    await runForm.getByLabel("What should this agent work on?").inputValue(),
    firstRun.instruction,
  );
  assert.equal(
    runPosts().length,
    beforeReuse,
    "Reusing a task must not queue work",
  );
  await runForm.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(
    await runForm.getByLabel("What should this agent work on?").inputValue(),
    "Review the revised error handling.",
  );

  // Recover a failed review while preserving its completed draft and history.
  await runForm.getByRole("button", { name: "Run agent", exact: true }).click();
  await runPanel
    .getByRole("heading", { name: "Drafting", exact: true })
    .waitFor();
  const failedRun = reviewer.runs[0];
  failedRun.state = "failed";
  failedRun.message =
    "Agent stopped. The model connection was interrupted during review.";
  failedRun.draft_text = "Preserved draft from the interrupted review.";
  failedRun.jobs[0].state = "completed";
  failedRun.jobs.push({
    id: nextId(),
    state: "failed",
    message: "Model connection interrupted",
  });
  await refresh();
  await runPanel
    .getByRole("heading", { name: "Needs attention", exact: true })
    .waitFor();
  await runPanel.getByRole("tab", { name: "Draft", exact: true }).click();
  await runPanel.getByText(failedRun.draft_text, { exact: true }).waitFor();
  const beforeRecovery = runPosts().length;
  await runPanel
    .getByRole("button", { name: "Prepare another attempt", exact: true })
    .click();
  assert.equal(runPosts().length, beforeRecovery);
  assert.equal(
    await runForm.getByLabel("What should this agent work on?").inputValue(),
    failedRun.instruction,
  );
  await page
    .getByLabel("Agent model", { exact: true })
    .selectOption("local-chat");
  await page
    .getByText("Model saved for future runs.", { exact: false })
    .waitFor();
  await runPanel.getByRole("tab", { name: "Run plan", exact: true }).click();
  await runPanel
    .getByText("Careful local model · Chat", { exact: true })
    .waitFor();
  await runForm.getByRole("button", { name: "Run agent", exact: true }).click();
  await runPanel
    .getByRole("heading", { name: "Drafting", exact: true })
    .waitFor();
  assert.notEqual(reviewer.runs[0].client_id, failedRun.client_id);
  assert.equal(reviewer.runs[0].jobs[0].request.profile.id, "local-chat");
  assert.equal(
    failedRun.draft_text,
    "Preserved draft from the interrupted review.",
  );
  await runPanel.getByRole("button", { name: "Stop run", exact: true }).click();
  await runPanel
    .getByRole("heading", { name: "Stopped", exact: true })
    .waitFor();
  await history.getByRole("button", { name: /Review this diff/ }).click();
  await runPanel.getByText(firstRun.text, { exact: true }).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: ".local/agents-desktop.png", fullPage: true });

  // MCP intents still open a builder, and registration retries reuse the agent.
  await page.evaluate(() =>
    window.fixtureIntent({
      mcp: true,
      starter: {
        id: "documents",
        description: "Template display copy",
        scope: "Selected notes",
        name: "Connected brief",
        purpose: "Summarise approved launch notes.",
        template: "brief",
      },
    }),
  );
  await page
    .getByRole("heading", { name: "Create your MCP server", exact: true })
    .waitFor();
  failServer = true;
  await setup
    .getByRole("button", { name: "Create MCP server", exact: true })
    .click();
  await page
    .getByRole("alert")
    .getByText(/MCP registration unavailable/)
    .waitFor();
  assert.equal(agents.length, 3);
  await page
    .getByRole("button", { name: "Use from another app with MCP" })
    .click();
  await page.locator("#handoff").filter({ hasText: "MCP handoff" }).waitFor();
  assert.equal(agents.length, 3);
  const registered = requests.filter((item) =>
    item.path.endsWith("/mcp-servers"),
  );
  assert.equal(registered[0].body.agent_id, registered[1].body.agent_id);
  await page.evaluate(() => window.fixtureIntent({ mcp: true }));
  await setup.getByLabel("Agent name", { exact: true }).fill("Fresh server");
  await setup
    .getByLabel("Purpose", { exact: true })
    .fill("Write clear project summaries.");
  await setup
    .getByRole("button", { name: "Create MCP server", exact: true })
    .click();
  await page
    .getByText("Your MCP server is ready to configure.", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Configure MCP server", exact: true })
    .click();
  assert.equal(agents.length, 4);
  await page.evaluate((agent) => window.fixtureIntent({ agent }), reviewer.id);
  await page
    .getByRole("heading", { name: "Code reviewer", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByText("Your MCP server is ready to configure.", { exact: true })
      .count(),
    0,
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: ".local/agents-mobile.png", fullPage: true });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "Agents must fit a narrow viewport",
  );
  await page.getByRole("button", { name: "Edit agent", exact: true }).click();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "Agent setup must fit a narrow viewport",
  );
  await setup.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.ok(
    await page.evaluate(
      () =>
        parseFloat(getComputedStyle(document.documentElement).fontSize) >= 15,
    ),
  );
  // Hidden tabs do not keep polling. Visibility wakes the list immediately.
  await page.evaluate(() =>
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    }),
  );
  await refresh();
  const hiddenRequests = requests.length;
  await page.waitForTimeout(3200);
  assert.equal(requests.length, hiddenRequests);
  await page.evaluate(() =>
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    }),
  );
  await Promise.all([
    page.waitForResponse((response) =>
      response.url().endsWith(`/api/projects/${project.id}/agents`),
    ),
    refresh(),
  ]);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  console.log(
    "Agents passed: model persistence/default/readiness, setup and instruction preservation across Model settings, missing context, reuse/undo, failed-review recovery, snapshot model/sources, starters/search/edit/duplicate, pause/retry/cancel, copy/download, MCP handoff, visibility polling and narrow layouts. All APIs intercepted; no model work.",
  );
} catch (error) {
  console.error({
    errors,
    unexpected,
    body: (await page.locator("body").innerText()).slice(0, 2000),
  });
  await page.screenshot({ path: ".local/agents-failure.png", fullPage: true });
  throw error;
} finally {
  await browser.close();
}
