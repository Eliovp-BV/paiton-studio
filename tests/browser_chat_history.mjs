// Real conversation UI with intercepted synthetic APIs; no live backend or model calls.
import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";

const base = process.env.STUDIO_TEST_URL || "http://127.0.0.1:8898";
assert.notEqual(new URL(base).port, "8877");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(12000);
const errors = [],
  unexpected = [],
  calls = [];
page.on("pageerror", (error) => errors.push(error.message));
const projects = ["a", "b", "c"].map((letter) => ({
  id: letter.repeat(32),
  name: `Project ${letter}`,
}));
const model = {
  id: "fixture-chat",
  model: "Local fixture model",
  package: "fixture",
  label: "Conversation",
};
const now = Date.now() / 1000;
const documents = [
  {
    id: "doc-selected",
    project: projects[0].id,
    kind: "document",
    name: "Project brief.txt",
  },
];
const tools = [
  {
    id: "fixture",
    model: model.model,
    name: model.model,
    state: "ready",
    default_for: ["chat", "code"],
    profiles: [
      {
        id: model.id,
        task: "write",
        roles: ["chat", "code"],
        label: "Conversation",
        state: "ready",
      },
    ],
  },
  {
    id: "small-fixture",
    model: "Small fixture model",
    name: "Small fixture",
    state: "ready",
    profiles: [
      {
        id: "small-chat",
        task: "write",
        roles: ["chat", "code"],
        label: "Quick",
        state: "ready",
      },
    ],
  },
  {
    id: "image-fixture",
    name: "Image fixture",
    model: "Image fixture model",
    state: "ready",
    profiles: [
      {
        id: "fixture-image",
        task: "image",
        roles: ["image"],
        label: "High quality · 2048 × 2048",
        width: 2048,
        height: 2048,
        steps: 40,
        max_prompt_length: 512,
        state: "ready",
      },
      {
        id: "legacy-image",
        task: "image",
        roles: ["image"],
        label: "Legacy square",
        max_prompt_length: 2500,
        state: "ready",
      },
    ],
  },
];
const defaultSettings = () => ({
  preset: "general",
  instructions: "",
  profile_id: "auto",
});
const briefs = Object.fromEntries(
  projects.map((project) => [
    project.id,
    {
      project: project.id,
      content:
        project.id === projects[0].id
          ? "Audience: curious beginners. Keep claims factual."
          : "",
      revision: 1,
      updated: now,
    },
  ]),
);
let heldPreview = null;
function previewContext(project, body, chat = null) {
  const image = body.mode === "image";
  const brief = body.project_brief_revision == null ? null : briefs[project];
  const history = (chat?.turns || []).filter(
    (turn) => turn.job.state === "completed",
  );
  const sources = image
    ? []
    : (body.document_ids || []).map((id) => ({
        id,
        name: documents.find((item) => item.id === id)?.name || id,
        excerpts: [1],
      }));
  const messages = image
    ? [{ role: "user", content: body.prompt }]
    : [
        { role: "system", content: "Synthetic local assistant instructions." },
        ...history.flatMap((turn) => [
          { role: "user", content: turn.prompt },
          { role: "assistant", content: turn.answer || "Image saved." },
        ]),
        {
          role: "user",
          content:
            body.prompt +
            (brief ? `\nProject brief: ${brief.content}` : "") +
            (sources.length
              ? "\nDocument excerpt: fictional source facts."
              : "") +
            `\nReply setup: ${JSON.stringify(chat?.settings || defaultSettings())}`,
        },
      ];
  const result = {
    kind: image ? "image" : "text",
    messages,
    sources,
    project_brief: brief
      ? { content: brief.content, revision: brief.revision }
      : null,
    history: {
      included_turns: image ? 0 : history.length,
      omitted_turns: image
        ? (chat?.turns || []).length
        : (chat?.turns || []).length - history.length,
      excerpted: false,
    },
    characters: messages.reduce(
      (sum, message) => sum + message.content.length,
      0,
    ),
  };
  return {
    ...result,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(result))
      .digest("hex"),
  };
}
let serial = 10,
  failPatch = false,
  failSend = false,
  failOpenId = null,
  heldPatch = null,
  heldMessage = null;
function gate() {
  let release, arrived;
  return {
    promise: new Promise((resolve) => {
      release = resolve;
    }),
    arrival: new Promise((resolve) => {
      arrived = resolve;
    }),
    release: () => release(),
    arrived: () => arrived(),
  };
}
function turn(number, state, extra = {}) {
  return {
    id: String(number).padStart(32, "0"),
    prompt: `Visible question ${number}`,
    mode: "chat",
    documents: [],
    answer: null,
    partial: "",
    asset: null,
    job: {
      id: `job-${number}`,
      state,
      created: now - 2,
      updated: now,
      message:
        "Internal diagnostic /srv/private/runtime.socket credential=DO_NOT_EXPORT",
      request: {
        profile: model,
        sources: [],
        api_key: "DO_NOT_EXPORT_API_KEY",
        private_path: "/srv/private/model",
      },
    },
    ...extra,
  };
}
const turns = [
  turn(1, "completed", {
    answer: "A **complete answer**.\n\n```python\nprint('reviewed')\n```",
    asset: {
      kind: "text",
      metadata: {
        finish_reason: "length",
        performance: {
          output_tokens: 32,
          tokens_per_second: 8,
          first_token_seconds: 0.5,
          rate_scope: "client_observed_stream",
          model_state: "warm",
          load_seconds: 0.1,
          request_seconds: 4.5,
          turn_seconds: 4.6,
        },
      },
    },
    coding_context: [
      {
        path: "src/helper.py",
        version: "a".repeat(64),
        content: "SUPPORTING_BODY_NOT_OPTED_IN",
      },
      {
        path: ".gitignore",
        version: "b".repeat(64),
        content: "ANOTHER_SUPPORTING_BODY",
      },
      {
        path: "/srv/private/credentials.py",
        version: "c".repeat(64),
        content: "PRIVATE",
      },
    ],
    coding_instructions: "STYLE_PREFERENCES_NOT_OPTED_IN",
  }),
  turn(2, "failed", { partial: "An unfinished failed draft." }),
  turn(3, "cancelled", { partial: "An unfinished stopped draft." }),
  turn(4, "completed", {
    asset: {
      id: "image-fixture",
      kind: "image",
      name: "Lake image",
      metadata: {},
    },
  }),
  turn(5, "running", { partial: "Reply still in progress." }),
];
turns[0].job.request.sources = [
  {
    id: "doc-one",
    name: "/private/document-storage/notes.txt",
    excerpts: [1, 3],
  },
  { id: "doc-two", name: "unused.txt", excerpts: [] },
];
turns[0].job.request.history_excerpted = true;
const chats = [
  {
    id: "d".repeat(32),
    project: projects[0].id,
    title: "Alpine launch",
    turns,
  },
  {
    id: "e".repeat(32),
    project: projects[0].id,
    title: "Alpine photos",
    turns: [turn(6, "queued")],
  },
  {
    id: "f".repeat(32),
    project: projects[0].id,
    title: "Code notes",
    turns: [],
  },
];
for (const chat of chats)
  Object.assign(chat, {
    revision: 1,
    pinned: false,
    archived: false,
    settings: defaultSettings(),
    updated: now,
  });
let releaseHistory;
const initialHistory = new Promise((resolve) => {
  releaseHistory = resolve;
});
let failHistory = true;
await page.route("**/api/**", async (route) => {
  const request = route.request(),
    path = new URL(request.url()).pathname,
    method = request.method();
  const body = request.postData() ? request.postDataJSON() : null;
  calls.push({ path, method, body: structuredClone(body) });
  let data,
    status = 200;
  const list = path.match(/^\/api\/projects\/([a-f0-9]{32})\/chats$/);
  const briefRoute = path.match(/^\/api\/projects\/([a-f0-9]{32})\/brief$/);
  const previewRoute = path.match(
    /^\/api\/(projects|chats)\/([a-f0-9]{32})\/(chat-context|context)$/,
  );
  if (path === "/api/chat-presence" && method === "POST") data = {};
  else if (briefRoute && method === "GET") data = briefs[briefRoute[1]];
  else if (briefRoute && method === "PUT") {
    const saved = briefs[briefRoute[1]];
    if (body.expected_revision !== saved.revision) {
      status = 409;
      data = {
        detail:
          "Project brief changed elsewhere. Reload the saved revision and review your edits.",
      };
    } else {
      assert.ok(body.content.length <= 4000);
      Object.assign(saved, {
        content: body.content,
        revision: saved.revision + 1,
        updated: Date.now() / 1000,
      });
      data = saved;
    }
  } else if (previewRoute && method === "POST") {
    const target =
      previewRoute[1] === "chats"
        ? chats.find((chat) => chat.id === previewRoute[2])
        : null;
    data = previewContext(target?.project || previewRoute[2], body, target);
    if (heldPreview) {
      const pending = heldPreview;
      heldPreview = null;
      pending.arrived();
      await pending.promise;
    }
  } else if (list && method === "GET") {
    if (list[1] === projects[0].id) await initialHistory;
    if (list[1] === projects[2].id && failHistory) {
      status = 503;
      data = { detail: "Synthetic history connection failure" };
    } else
      data = chats
        .filter((chat) => chat.project === list[1])
        .map(({ turns, ...chat }) => chat);
  } else if (list && method === "POST") {
    data = {
      id: (++serial).toString(16).padStart(32, "0"),
      project: list[1],
      title: "New conversation",
      turns: [],
      revision: 1,
      pinned: false,
      archived: false,
      settings: defaultSettings(),
      updated: Date.now() / 1000,
    };
    chats.unshift(data);
  } else if (/^\/api\/chats\/[a-f0-9]{32}$/.test(path) && method === "GET") {
    const identity = path.split("/").at(-1);
    if (identity === failOpenId) {
      failOpenId = null;
      status = 503;
      data = { detail: "Synthetic conversation open failure" };
    } else data = chats.find((chat) => chat.id === identity);
  } else if (/^\/api\/chats\/[a-f0-9]{32}$/.test(path) && method === "PATCH") {
    const target = chats.find((chat) => chat.id === path.split("/").at(-1));
    if (heldPatch) {
      const pending = heldPatch;
      heldPatch = null;
      pending.arrived();
      await pending.promise;
    }
    if (failPatch || body.expected_revision !== target.revision) {
      failPatch = false;
      status = 409;
      data = {
        detail:
          "This conversation changed in another window. Reload its saved setup before trying again.",
      };
    } else {
      const { expected_revision, ...change } = body;
      Object.assign(target, change, { revision: target.revision + 1 });
      data = target;
    }
  } else if (
    /^\/api\/chats\/[a-f0-9]{32}\/messages$/.test(path) &&
    method === "POST"
  ) {
    const target = chats.find((chat) => chat.id === path.split("/")[3]);
    assert.equal(target.archived, false);
    if (heldMessage) {
      const pending = heldMessage;
      heldMessage = null;
      pending.arrived();
      await pending.promise;
    }
    if (failSend) {
      failSend = false;
      status = 503;
      data = { detail: "Synthetic send failure. Your draft is kept." };
    } else if (
      (body.project_brief_revision != null &&
        body.project_brief_revision !== briefs[target.project].revision) ||
      (body.context_fingerprint &&
        body.context_fingerprint !==
          previewContext(target.project, body, target).fingerprint)
    ) {
      status = 409;
      data = {
        detail:
          "Request context changed. Refresh the context preview before sending; no reply was queued.",
      };
    } else {
      const prepared = previewContext(target.project, body, target);
      const requestedProfile =
        target.settings.profile_id === "auto"
          ? "fixture-chat"
          : target.settings.profile_id;
      const profile = tools
        .flatMap((tool) =>
          tool.profiles.map((item) => ({
            ...item,
            model: tool.model,
            package: tool.id,
          })),
        )
        .find(
          (item) =>
            item.id ===
            (body.mode === "image" ? "fixture-image" : requestedProfile),
        );
      let saved = target.turns.find(
        (item) => item.client_id === body.client_id,
      );
      if (!saved) {
        saved = turn(++serial, "completed", {
          client_id: body.client_id,
          mode: body.mode,
          prompt: body.prompt,
          answer: "A synthetic local reply.",
          documents: body.document_ids || [],
          chat_settings: structuredClone(target.settings),
          chat_settings_applied: body.mode !== "image",
          project_brief: prepared.project_brief,
        });
        saved.job.request = {
          ...body,
          profile,
          sources: (body.document_ids || []).map((id) => ({
            id,
            name: documents.find((item) => item.id === id)?.name || id,
            excerpts: [1],
          })),
          chat_settings: structuredClone(target.settings),
          chat_settings_applied: body.mode !== "image",
          messages: prepared.messages,
          project_brief: prepared.project_brief,
          context_history: prepared.history,
          context_characters: prepared.characters,
          context_fingerprint: prepared.fingerprint,
        };
        target.turns.push(saved);
        if (target.title === "New conversation") {
          target.title = body.prompt.slice(0, 80);
          target.revision++;
        }
        target.updated = Date.now() / 1000;
      }
      data = saved.job;
    }
  } else if (path === "/api/assets/image-fixture" && method === "GET") {
    return route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/S9sAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  } else {
    unexpected.push(`${method} ${path}`);
    status = 404;
    data = { detail: "Unexpected fixture API request" };
  }
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(data),
  });
});
await page.route("**/chat-history-fixture", (route) =>
  route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;
const {default: React} = await import('/node_modules/.vite-ui/deps/react.js');
const {default: ReactDOM} = await import('/node_modules/.vite-ui/deps/react-dom_client.js');
await import('/web/style.css?import'); await import('/web/studio-design.css?import'); await import('/web/studio-gold.css?import');
const module = await import('/web/GPTPaiton.jsx'); window.fixtureMarkdown = module.conversationMarkdown;
const projects = ${JSON.stringify(projects)}; window.fixtureHandoffs=[]; window.fixtureConsumed=[];
const api = async (path, body, method) => { const result = await fetch('/api'+path, {method: method || (body === undefined ? 'GET' : 'POST'), headers:{'Content-Type':'application/json'}, body:body === undefined ? undefined : JSON.stringify(body)}); const data = await result.json(); if(!result.ok) throw Object.assign(Error(data.detail),{status:result.status}); return data; };
function Harness() { const [project,setProject] = React.useState(projects[0]), [failure,setFailure] = React.useState(''), [worker,setWorker] = React.useState({state:'stopped'}), [show,setShow] = React.useState(true), [currentTools,setTools] = React.useState(${JSON.stringify(tools)}), [intent,setIntent] = React.useState(null); window.fixtureProject = index => setProject(projects[index]); window.fixtureWorker=setWorker; window.fixtureTools=setTools; window.fixtureIntent=setIntent; return React.createElement('main',{className:'studio-shell',style:{padding:16,minWidth:0,display:'block'}},show ? React.createElement(module.default,{key:project.id, project, api, tools:currentTools, assets:${JSON.stringify(documents)}, worker, defaultProfile:'fixture-chat', defaultCodeProfile:'fixture-chat', defaultImageProfile:'fixture-image', report:error=>setFailure(error.message), onSetup:()=>setShow(false), initialIntent:intent, onIntentConsumed:id=>{window.fixtureConsumed.push(id);setIntent(current=>current?.id===id?null:current);}, onHandoff:payload=>window.fixtureHandoffs.push(payload)}) : React.createElement('button',{onClick:()=>setShow(true)},'Back to Chat'),React.createElement('output',{id:'fixture-error'},failure)); }
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
</script></body></html>`,
  }),
);
const search = () =>
  page.getByRole("searchbox", { name: "Search conversations" });
const listButtons = () => page.locator(".chat-history-open");
const exportButton = () =>
  page.getByRole("button", { name: "Export conversation", exact: true });
async function download() {
  const pending = page.waitForEvent("download");
  await exportButton().click();
  const file = await pending;
  return {
    name: file.suggestedFilename(),
    text: await readFile(await file.path(), "utf8"),
  };
}
try {
  await mkdir(".local", { recursive: true });
  await page.goto(base + "/chat-history-fixture");
  await page.getByText("Loading conversations…", { exact: true }).waitFor();
  assert.equal(await exportButton().isDisabled(), true);
  releaseHistory();
  await page.getByText("3 conversations", { exact: true }).waitFor();
  await page.getByText("Visible question 1", { exact: true }).waitFor();
  assert.equal(await listButtons().count(), 3);
  const firstReply = page.locator(".gpt-turn").first();
  const stoppedReply = page.locator(".gpt-turn").nth(2);
  assert.equal(
    await stoppedReply.getByLabel("Reply stopped").innerText(),
    "Stopped · partial reply saved",
  );
  await stoppedReply
    .getByText("An unfinished stopped draft.", { exact: true })
    .waitFor();
  const metrics = firstReply.getByLabel("Reply performance");
  assert.deepEqual(await metrics.locator("span").allTextContents(), [
    "32 tokens",
    "8 tok/s",
    "TTFT 0.5 s",
    "Warm",
  ]);
  assert.match(
    await metrics.getByText("8 tok/s", { exact: true }).getAttribute("title"),
    /bursts/,
  );
  await firstReply.getByText("Performance details", { exact: true }).click();
  await firstReply.getByText("Final model request", { exact: true }).waitFor();
  assert.match(
    await firstReply.locator(".performance-details").innerText(),
    /4.50 s/,
  );
  await firstReply
    .getByRole("button", { name: "Open in Files", exact: true })
    .click();
  assert.deepEqual(await page.evaluate(() => window.fixtureHandoffs.at(-1)), {
    kind: "code",
    target: "coding",
    text: "print('reviewed')\n",
    language: "python",
    project_id: projects[0].id,
    title: "Chat: Alpine launch",
    asset_id: undefined,
  });
  await firstReply
    .getByRole("button", { name: "Edit in Writing", exact: true })
    .click();
  const writingHandoff = await page.evaluate(() =>
    window.fixtureHandoffs.at(-1),
  );
  assert.equal(writingHandoff.text, turns[0].answer);
  assert.equal(writingHandoff.target, "write");
  assert.equal(writingHandoff.project_id, projects[0].id);
  await page
    .locator(".gpt-turn")
    .nth(3)
    .getByRole("button", { name: "Animate", exact: true })
    .click();
  assert.deepEqual(await page.evaluate(() => window.fixtureHandoffs.at(-1)), {
    kind: "image",
    target: "video",
    asset_id: "image-fixture",
    project_id: projects[0].id,
    title: "Lake image",
  });
  await page
    .locator(".gpt-turn")
    .nth(3)
    .getByRole("button", { name: "Edit image", exact: true })
    .click();
  assert.deepEqual(await page.evaluate(() => window.fixtureHandoffs.at(-1)), {
    kind: "image",
    target: "image",
    asset_id: "image-fixture",
    project_id: projects[0].id,
    title: "Lake image",
  });
  assert.equal(
    calls.filter((call) => call.path.endsWith("/messages")).length,
    0,
    "result actions only prepare navigation; they never send or execute",
  );
  await page.evaluate(
    ({ project, chatId, turnId }) =>
      window.fixtureIntent({
        id: "find-historical-message",
        project,
        chatId,
        turnId,
      }),
    { project: projects[0].id, chatId: chats[0].id, turnId: turns[3].id },
  );
  await page.locator(`#chat-turn-${turns[3].id}.search-destination`).waitFor();
  assert.equal(await page.locator(".gpt-turn.search-destination").count(), 1);
  await search().fill("  ALPINE ");
  await page.getByText("2 of 3 conversations", { exact: true }).waitFor();
  assert.deepEqual(await listButtons().allTextContents(), [
    "Alpine launch",
    "Alpine photos",
  ]);
  await search().fill("no such title");
  await page
    .getByText("No matching titles. Try another search or clear it.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await listButtons().count(), 0);
  assert.equal(
    await exportButton().isDisabled(),
    false,
    "search does not discard the open conversation",
  );
  await page.getByRole("button", { name: "Clear conversation search" }).click();
  const exported = await download();
  assert.equal(exported.name, "paiton-alpine-launch.md");
  for (const text of [
    "# Alpine launch",
    "Visible question 1",
    "A **complete answer**.",
    "print('reviewed')",
    "Model: Local fixture model",
    "Profile: fixture-chat",
    "notes.txt: excerpts 1, 3",
    "unused.txt: not included",
    "src/helper.py",
    ".gitignore",
    "SHA-256: " + "a".repeat(64),
    "Failed — no completed reply",
    "Stopped — no completed reply",
    "Running — reply incomplete",
    "Partial reply — incomplete",
    "An unfinished failed draft.",
    "An unfinished stopped draft.",
    "Reply still in progress.",
    "Generated image: Lake image",
    "Response budget reached",
    "Earlier conversation text was excerpted",
  ])
    assert.ok(exported.text.includes(text), `export includes ${text}`);
  for (const forbidden of [
    "DO_NOT_EXPORT",
    "/srv/private",
    "/private/document-storage",
    "SUPPORTING_BODY_NOT_OPTED_IN",
    "ANOTHER_SUPPORTING_BODY",
    "STYLE_PREFERENCES_NOT_OPTED_IN",
    "api_key",
    "runtime.socket",
  ])
    assert.ok(
      !exported.text.includes(forbidden),
      `export excludes ${forbidden}`,
    );
  await page
    .getByRole("button", { name: "Alpine photos", exact: true })
    .click();
  await page.getByText("Visible question 6", { exact: true }).waitFor();
  assert.ok((await download()).text.includes("Queued — reply pending"));
  await page.getByRole("button", { name: "Code notes", exact: true }).click();
  await page.getByText("What shall we work on?", { exact: true }).waitFor();
  assert.equal(await exportButton().isDisabled(), true);
  await search().fill("missing");
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .click();
  await page.getByText("4 conversations", { exact: true }).waitFor();
  assert.equal(await search().inputValue(), "");
  assert.equal(await exportButton().isDisabled(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "mobile history and export controls fit the viewport",
  );
  await page.evaluate(() => window.fixtureProject(1));
  await page
    .getByText("No conversations yet. Start one to save your ideas here.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await listButtons().count(), 0);
  await page.evaluate(() => window.fixtureProject(2));
  await page
    .getByText("Conversation history could not be loaded.", { exact: true })
    .waitFor();
  failHistory = false;
  await page
    .getByRole("button", { name: "Retry history", exact: true })
    .click();
  await page
    .getByText("No conversations yet. Start one to save your ideas here.", {
      exact: true,
    })
    .waitFor();
  const escaped = await page.evaluate(() =>
    window.fixtureMarkdown(
      { title: "[unsafe](javascript:alert(1))", turns: [] },
      new Date("2026-01-01T00:00:00Z"),
    ),
  );
  assert.ok(escaped.startsWith("# \\[unsafe\\]\\(javascript:alert\\(1\\)\\)"));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => window.fixtureProject(0));
  await page.getByRole("button", { name: "Code notes", exact: true }).click();
  await page
    .getByRole("heading", { name: "Code notes", exact: true })
    .waitFor();
  const editor = () =>
    page.getByRole("textbox", { name: "Message Chat", exact: true });
  const sendButton = () =>
    page.getByRole("button", { name: "Send message", exact: true });
  const settings = () => page.locator(".chat-reply-setup");
  const openSetup = async () => {
    if (!(await settings().evaluate((element) => element.open)))
      await settings().locator(":scope > summary").click();
  };
  const closeSetup = async () => {
    if (await settings().evaluate((element) => element.open))
      await settings().locator(":scope > summary").click();
  };
  const openOptions = async () => {
    const details = page.locator(".chat-context-details");
    if (!(await details.evaluate((element) => element.open)))
      await details.locator(":scope > summary").click();
  };
  const sendCalls = () =>
    calls.filter(
      (item) => item.method === "POST" && item.path.endsWith("/messages"),
    );
  assert.equal(sendCalls().length, 0, "browsing and examples never call AI");

  // A held response proves the visible pin update is optimistic, then revision-checked.
  const pinGate = gate();
  heldPatch = pinGate;
  await page
    .getByRole("button", { name: "Pin Code notes", exact: true })
    .click();
  await pinGate.arrival;
  assert.equal(await listButtons().first().textContent(), "Code notes");
  assert.equal(
    await page
      .getByRole("button", { name: "Unpin Code notes", exact: true })
      .isDisabled(),
    true,
  );
  await page.evaluate(
    ({ project, turnId }) =>
      window.fixtureIntent({
        id: "search-during-pin",
        project,
        chatId: "d".repeat(32),
        turnId,
      }),
    { project: projects[0].id, turnId: turns[3].id },
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(
    await page
      .getByRole("heading", { name: "Code notes", exact: true })
      .count(),
    1,
    "search waits while conversation metadata is being saved",
  );
  assert.equal(
    await page.evaluate(() =>
      window.fixtureConsumed.includes("search-during-pin"),
    ),
    false,
  );
  pinGate.release();
  await page.locator(`#chat-turn-${turns[3].id}.search-destination`).waitFor();
  await page.waitForFunction(() =>
    window.fixtureConsumed.includes("search-during-pin"),
  );
  await editor().fill("Preserve this draft if opening a search result fails.");
  failOpenId = "e".repeat(32);
  const readsBeforeFailure = calls.filter(
    (item) => item.method === "GET" && item.path === `/api/chats/${failOpenId}`,
  ).length;
  await page.evaluate(
    (project) =>
      window.fixtureIntent({
        id: "retry-failed-search",
        project,
        chatId: "e".repeat(32),
        turnId: String(6).padStart(32, "0"),
      }),
    projects[0].id,
  );
  await page
    .getByRole("button", { name: "Retry opening conversation", exact: true })
    .waitFor();
  await page
    .getByRole("heading", { name: "Alpine launch", exact: true })
    .waitFor();
  assert.equal(
    await editor().inputValue(),
    "Preserve this draft if opening a search result fails.",
  );
  assert.equal(
    await page.evaluate(() =>
      window.fixtureConsumed.includes("retry-failed-search"),
    ),
    false,
    "failed navigation retains the requested destination for explicit retry",
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(
    calls.filter(
      (item) =>
        item.method === "GET" && item.path === `/api/chats/${"e".repeat(32)}`,
    ).length,
    readsBeforeFailure + 1,
    "failed navigation does not loop automatically",
  );
  await page
    .getByRole("button", { name: "Retry opening conversation", exact: true })
    .click();
  await page
    .locator(`#chat-turn-${String(6).padStart(32, "0")}.search-destination`)
    .waitFor();
  await page.waitForFunction(() =>
    window.fixtureConsumed.includes("retry-failed-search"),
  );
  await page.getByRole("button", { name: "Code notes", exact: true }).click();
  await page
    .getByRole("heading", { name: "Code notes", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Rename conversation", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Conversation title", exact: true })
    .fill("Research notes");
  await page.getByRole("button", { name: "Save title", exact: true }).click();
  await page
    .getByRole("heading", { name: "Research notes", exact: true })
    .waitFor();
  assert.equal(
    chats.find((item) => item.id === "f".repeat(32)).title,
    "Research notes",
  );

  failPatch = true;
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "changed in another window" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Active", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(
    chats.find((item) => item.id === "f".repeat(32)).archived,
    false,
  );
  assert.equal(
    await editor().isDisabled(),
    false,
    "failed archive restores the composer",
  );
  await page.getByRole("button", { name: "Dismiss chat error" }).click();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page
    .getByText("Conversation archived. Its messages are kept.", { exact: true })
    .waitFor();
  assert.equal(await editor().isDisabled(), true);
  assert.equal(
    await page
      .getByRole("button", { name: "Archived", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page
    .getByRole("button", { name: "Restore conversation", exact: true })
    .click();
  await page.getByText("Conversation restored.", { exact: true }).waitFor();
  assert.equal(await editor().isDisabled(), false);

  // Settings are explicit, reusable, and safe to edit while execution is paused.
  await page
    .getByRole("button", { name: "Explain something", exact: true })
    .click();
  assert.match(await editor().inputValue(), /solar panels/);
  assert.equal(await sendButton().isDisabled(), true);
  await page
    .getByRole("region", { name: "Local AI model" })
    .getByText("Paused", { exact: true })
    .waitFor();
  await openSetup();
  await page
    .getByLabel("Response preset", { exact: true })
    .selectOption("concise");
  await page
    .getByRole("textbox", { name: "Custom response instructions", exact: true })
    .fill("Write for a curious beginner. Use metric units.");
  await page
    .getByLabel("Conversation model", { exact: true })
    .selectOption("small-chat");
  await page
    .getByRole("button", { name: "Save reply setup", exact: true })
    .click();
  await page
    .getByText("Reply setup saved for this conversation.", { exact: true })
    .waitFor();
  assert.deepEqual(chats.find((item) => item.id === "f".repeat(32)).settings, {
    preset: "concise",
    instructions: "Write for a curious beginner. Use metric units.",
    profile_id: "small-chat",
  });
  assert.equal(sendCalls().length, 0);
  await page
    .getByRole("button", { name: "New with this setup", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "New conversation", exact: true })
    .waitFor();
  const reusable = chats[0];
  assert.equal(reusable.settings.preset, "concise");
  assert.equal(reusable.settings.profile_id, "small-chat");
  assert.equal(reusable.turns.length, 0);
  await closeSetup();
  await editor().fill("A message draft kept through Model settings.");
  await page
    .getByRole("button", { name: "Model settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Back to Chat", exact: true }).click();
  await page
    .getByRole("heading", { name: "New conversation", exact: true })
    .waitFor();
  assert.equal(
    await editor().inputValue(),
    "A message draft kept through Model settings.",
  );
  await page
    .getByRole("region", { name: "Local AI model" })
    .getByText("Small fixture", { exact: true })
    .waitFor();
  await page.evaluate(() => window.fixtureWorker({ state: "running" }));
  await page
    .getByRole("region", { name: "Local AI model" })
    .getByText("Installed", { exact: true })
    .waitFor();
  assert.equal(await sendButton().isDisabled(), false);

  // Explicit selection is sent, stays visible for follow-ups, and clear never re-inherits.
  await openOptions();
  await page
    .getByLabel("Add a project document", { exact: true })
    .selectOption("doc-selected");
  await page
    .getByText("1 document selected for the next reply", { exact: true })
    .waitFor();
  const replyGate = gate();
  heldMessage = replyGate;
  await sendButton().click();
  await replyGate.arrival;
  await editor().fill(
    "A second question written while the first is submitting.",
  );
  assert.equal(
    await page.getByLabel("Conversation mode", { exact: true }).isDisabled(),
    true,
  );
  replyGate.release();
  await page.getByText("A synthetic local reply.", { exact: true }).waitFor();
  assert.equal(
    await editor().inputValue(),
    "A second question written while the first is submitting.",
  );
  assert.deepEqual(sendCalls().at(-1).body.document_ids, ["doc-selected"]);
  assert.equal(sendCalls().at(-1).body.inherit_documents, false);
  assert.equal(
    "profile_id" in sendCalls().at(-1).body,
    false,
    "server inherits the saved conversation model",
  );
  assert.equal(reusable.turns[0].job.request.profile.id, "small-chat");
  assert.equal(reusable.turns[0].chat_settings.preset, "concise");
  await page
    .getByRole("button", { name: "Clear documents", exact: true })
    .click();
  await page.getByText("No documents selected", { exact: true }).waitFor();
  await sendButton().click();
  await page.waitForFunction(
    () => document.querySelectorAll(".gpt-turn").length === 2,
  );
  assert.deepEqual(sendCalls().at(-1).body.document_ids, []);
  assert.equal(sendCalls().at(-1).body.inherit_documents, false);

  // Retry keeps the same idempotency key; changing saved setup invalidates it.
  failSend = true;
  await editor().fill("Retry this exact question.");
  await sendButton().click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Synthetic send failure" })
    .waitFor();
  const failed = sendCalls().at(-1);
  assert.equal(await editor().inputValue(), "Retry this exact question.");
  await sendButton().click();
  await page.waitForFunction(
    () => document.querySelectorAll(".gpt-turn").length === 3,
  );
  assert.equal(sendCalls().at(-1).body.client_id, failed.body.client_id);
  failSend = true;
  await editor().fill("Same wording with a changed saved setup.");
  await sendButton().click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Synthetic send failure" })
    .waitFor();
  const beforeSetup = sendCalls().at(-1);
  await openSetup();
  await page
    .getByLabel("Response preset", { exact: true })
    .selectOption("explain");
  assert.equal(await sendButton().isDisabled(), true);
  failPatch = true;
  await page
    .getByRole("button", { name: "Save reply setup", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "changed in another window" })
    .waitFor();
  assert.equal(
    await page.getByLabel("Response preset", { exact: true }).inputValue(),
    "explain",
  );
  assert.equal(
    await sendButton().isDisabled(),
    true,
    "failed settings save cannot silently send old settings",
  );
  assert.equal(
    await editor().inputValue(),
    "Same wording with a changed saved setup.",
  );
  await page
    .getByRole("button", { name: "Save reply setup", exact: true })
    .click();
  await page
    .getByText("Reply setup saved for this conversation.", { exact: true })
    .waitFor();
  await closeSetup();
  await sendButton().click();
  await page.waitForFunction(
    () => document.querySelectorAll(".gpt-turn").length === 4,
  );
  assert.notEqual(
    sendCalls().at(-1).body.client_id,
    beforeSetup.body.client_id,
  );
  assert.equal(reusable.turns.at(-1).chat_settings.preset, "explain");
  assert.equal(
    reusable.turns[0].chat_settings.preset,
    "concise",
    "earlier replies retain their original setup snapshot",
  );

  // An unavailable explicit profile never silently falls back to another local model.
  await page.evaluate(
    (value) =>
      window.fixtureTools(value.filter((tool) => tool.id !== "small-fixture")),
    tools,
  );
  await editor().fill("Keep this draft while fixing the model.");
  await page
    .getByRole("region", { name: "Local AI model" })
    .getByText("Setup needed", { exact: true })
    .waitFor();
  assert.equal(await sendButton().isDisabled(), true);
  await page.evaluate((value) => window.fixtureTools(value), tools);
  await page
    .getByRole("region", { name: "Local AI model" })
    .getByText("Installed", { exact: true })
    .waitFor();

  // Cross-project navigation keeps each draft independent, and Coding's source history still opens.
  await page.evaluate(() => window.fixtureProject(1));
  await page
    .getByRole("button", { name: "Explain something", exact: true })
    .waitFor();
  assert.equal(await editor().inputValue(), "");
  await editor().fill("Project B only.");
  await page.evaluate(() => window.fixtureProject(0));
  await page
    .getByText("Keep this draft while fixing the model.", { exact: true })
    .waitFor();
  assert.equal(
    await editor().inputValue(),
    "Keep this draft while fixing the model.",
  );
  await page.evaluate(
    (project) =>
      window.fixtureIntent({
        id: "from-code",
        chatId: "d".repeat(32),
        project: project.id,
      }),
    projects[0],
  );
  await page.getByText("Visible question 1", { exact: true }).waitFor();
  await page
    .getByText("Supporting code files · saved snapshots", { exact: true })
    .click();
  const sourceSnapshot = page.getByText(
    "src/helper.py · saved with this reply",
    { exact: true },
  );
  await sourceSnapshot.waitFor();
  assert.equal(await sourceSnapshot.getAttribute("title"), "a".repeat(64));
  assert.equal(
    await page
      .getByRole("button", { name: "Archive", exact: true })
      .isDisabled(),
    true,
    "active replies cannot be archived",
  );
  await page.getByRole("button", { name: reusable.title, exact: true }).click();
  await page
    .getByText("Keep this draft while fixing the model.", { exact: true })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await openSetup();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "mobile setup and context fit viewport",
  );
  await page.screenshot({ path: ".local/chat-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await closeSetup();
  await page.screenshot({ path: ".local/chat-desktop.png", fullPage: true });

  // A model-browser launch selects the intended model without losing the draft or sending.
  const beforeLaunch = sendCalls().length;
  await page.evaluate(() =>
    window.fixtureIntent({ id: "model-launch", profile: "fixture-chat" }),
  );
  await openSetup();
  assert.equal(
    await page.getByLabel("Conversation model", { exact: true }).inputValue(),
    "fixture-chat",
  );
  assert.equal(
    await editor().inputValue(),
    "Keep this draft while fixing the model.",
  );
  assert.equal(await sendButton().isDisabled(), true);
  await page
    .getByRole("button", { name: "Save reply setup", exact: true })
    .click();
  await page
    .getByText("Reply setup saved for this conversation.", { exact: true })
    .waitFor();

  // If copying preferences fails, retain the already-created conversation and its unsaved setup.
  const conversationsBeforeCopy = chats.length;
  failPatch = true;
  await page
    .getByRole("button", { name: "New with this setup", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "changed in another window" })
    .waitFor();
  await page
    .getByRole("heading", { name: "New conversation", exact: true })
    .waitFor();
  assert.equal(chats.length, conversationsBeforeCopy + 1);
  assert.equal(
    await page.getByLabel("Response preset", { exact: true }).inputValue(),
    "explain",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Save reply setup", exact: true })
      .isDisabled(),
    false,
  );
  await page
    .getByRole("button", { name: "Save reply setup", exact: true })
    .click();
  await page
    .getByText("Reply setup saved for this conversation.", { exact: true })
    .waitFor();
  assert.equal(
    chats.length,
    conversationsBeforeCopy + 1,
    "retry saves the existing new conversation",
  );
  assert.equal(chats[0].settings.preset, "explain");
  assert.equal(sendCalls().length, beforeLaunch);
  await closeSetup();

  // Brief selection is explicit; previewing exact context works while execution is paused.
  await page.evaluate(() => window.fixtureWorker({ state: "stopped" }));
  await editor().fill(
    '<img src=x onerror="window.contextPwn=true"> Explain the project goal.',
  );
  await openOptions();
  const briefBox = page.getByRole("region", {
    name: "Project brief",
    exact: true,
  });
  const includeBrief = () =>
    briefBox.getByRole("checkbox", {
      name: "Include project brief",
      exact: true,
    });
  assert.equal(await includeBrief().isChecked(), false);
  await includeBrief().check();
  await page
    .getByLabel("Add a project document", { exact: true })
    .selectOption("doc-selected");
  await openSetup();
  await briefBox.locator(":scope > details > summary").click();
  const desktopLayout = await page.evaluate(() => {
    const bounds = (selector) =>
      document.querySelector(selector).getBoundingClientRect();
    return {
      headerBottom: bounds(".gpt-conversation > header").bottom,
      modelTop: bounds(".chat-configuration").top,
      conversationBottom: bounds(".gpt-conversation").bottom,
      composerBottom: bounds(".gpt-composer").bottom,
    };
  });
  assert.ok(
    desktopLayout.headerBottom <= desktopLayout.modelTop,
    "expanded setup cannot collapse the header into the model status",
  );
  assert.ok(
    desktopLayout.composerBottom <= desktopLayout.conversationBottom + 1,
    "expanded composer stays inside the conversation's scrollable page bounds",
  );
  const inspector = page.locator(".gpt-composer > .context-inspector");
  await inspector.locator(":scope > summary").click();
  const previewButton = () =>
    inspector.getByRole("button", {
      name: /^(Preview context|Refresh context preview)$/,
    });
  const previewRequests = () =>
    calls.filter((item) => /\/(context|chat-context)$/.test(item.path));
  const beforePreview = { chats: chats.length, sends: sendCalls().length };
  await previewButton().click();
  await inspector
    .getByText("Preview ready · verified again when sent", { exact: true })
    .waitFor();
  await page.screenshot({
    path: ".local/chat-expanded-context-desktop.png",
    fullPage: true,
  });
  assert.equal(await sendButton().isDisabled(), true);
  assert.equal(chats.length, beforePreview.chats);
  assert.equal(sendCalls().length, beforePreview.sends);
  assert.equal(previewRequests().at(-1).body.project_brief_revision, 1);
  await inspector
    .locator(".context-inspector-messages details")
    .last()
    .locator("summary")
    .click();
  assert.match(
    await inspector.locator("pre").last().textContent(),
    /Audience: curious beginners/,
  );
  assert.match(
    await inspector.locator("pre").last().textContent(),
    /<img src=x/,
  );
  assert.equal(
    await page.evaluate(() => Boolean(window.contextPwn)),
    false,
    "request text is never rendered as HTML",
  );

  // Editing the request clears the fingerprint, and a delayed obsolete preview cannot restore it.
  await editor().fill("An obsolete preview request.");
  assert.equal(
    await inspector.locator(".context-inspector-summary").count(),
    0,
  );
  const previewGate = gate();
  heldPreview = previewGate;
  await previewButton().click();
  await previewGate.arrival;
  await editor().fill("The current request after editing.");
  previewGate.release();
  await page.waitForTimeout(80);
  assert.equal(
    await inspector.locator(".context-inspector-summary").count(),
    0,
  );
  await previewButton().click();
  await inspector
    .getByText("Preview ready · verified again when sent", { exact: true })
    .waitFor();

  // Editing an included brief blocks sending; conflicts retain the draft until an explicit retry.
  if (
    !(await briefBox
      .locator(":scope > details")
      .evaluate((element) => element.open))
  )
    await briefBox.locator(":scope > details > summary").click();
  const briefEditor = () =>
    briefBox.getByRole("textbox", {
      name: "Shared project notes",
      exact: true,
    });
  await briefEditor().fill("Audience: local residents. Use metric units.");
  await page.evaluate(() => window.fixtureWorker({ state: "running" }));
  await page
    .getByRole("region", { name: "Local AI model" })
    .getByText("Installed", { exact: true })
    .waitFor();
  assert.equal(await sendButton().isDisabled(), true);
  assert.equal(await previewButton().isDisabled(), true);
  Object.assign(briefs[projects[0].id], {
    content: "Someone else updated the shared brief.",
    revision: 2,
  });
  await briefBox
    .getByRole("button", { name: "Save project brief", exact: true })
    .click();
  await briefBox
    .getByRole("alert")
    .filter({ hasText: "changed elsewhere" })
    .waitFor();
  assert.equal(
    await briefEditor().inputValue(),
    "Audience: local residents. Use metric units.",
  );
  await briefBox
    .getByRole("button", { name: "Reload saved brief", exact: true })
    .first()
    .click();
  await briefBox
    .getByText(
      "Saved revision reloaded. Your edits are kept; review them before saving.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await briefEditor().inputValue(),
    "Audience: local residents. Use metric units.",
  );
  await briefBox
    .getByRole("button", { name: "Save project brief", exact: true })
    .click();
  await briefBox
    .getByText("Project brief saved · revision 3.", { exact: true })
    .waitFor();
  assert.equal(await includeBrief().isChecked(), true);
  assert.equal(
    await inspector.locator(".context-inspector-summary").count(),
    0,
  );
  await previewButton().click();
  await inspector
    .getByText("Project brief included · revision 3", { exact: true })
    .waitFor();
  const reviewed = previewRequests().at(-1);
  await sendButton().click();
  await page.waitForFunction(
    () => document.querySelectorAll(".gpt-turn").length === 1,
  );
  assert.equal(sendCalls().at(-1).body.project_brief_revision, 3);
  assert.equal(
    sendCalls().at(-1).body.context_fingerprint,
    previewContext(projects[0].id, reviewed.body, {
      turns: [],
      settings: chats[0].settings,
    }).fingerprint,
  );
  await page
    .getByText("Project brief saved with this reply.", {
      exact: true,
    })
    .waitFor();
  const pastInspector = page.locator(".gpt-turn .context-inspector");
  await pastInspector.locator(":scope > summary").click();
  await pastInspector
    .getByText("Project brief included · revision 3", { exact: true })
    .waitFor();
  Object.assign(briefs[projects[0].id], {
    content: "New brief after the reply.",
    revision: 4,
  });
  await pastInspector
    .locator(".context-inspector-messages details")
    .last()
    .locator("summary")
    .click();
  assert.match(
    await pastInspector.locator("pre").last().textContent(),
    /Audience: local residents/,
  );
  assert.doesNotMatch(
    await pastInspector.locator("pre").last().textContent(),
    /New brief after/,
  );

  // A stale server-side revision is rejected without losing the current message.
  await editor().fill("Keep this question after a stale brief conflict.");
  await sendButton().click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Request context changed" })
    .waitFor();
  assert.equal(
    await editor().inputValue(),
    "Keep this question after a stale brief conflict.",
  );
  assert.equal(chats[0].turns.length, 1);
  await includeBrief().uncheck();
  await sendButton().click();
  await page.waitForFunction(
    () => document.querySelectorAll(".gpt-turn").length === 2,
  );
  assert.equal(sendCalls().at(-1).body.project_brief_revision, null);
  assert.equal(sendCalls().at(-1).body.context_fingerprint, null);
  assert.equal(chats[0].turns[1].job.request.project_brief, null);

  // New-project previews create neither conversations nor jobs, and image previews are prompt-only.
  await page.evaluate(() => window.fixtureProject(1));
  await editor().fill("Preview before creating a conversation.");
  const freshInspector = page.locator(".gpt-composer > .context-inspector");
  await freshInspector.locator(":scope > summary").click();
  const beforeFresh = chats.length;
  await freshInspector
    .getByRole("button", { name: "Preview context", exact: true })
    .click();
  await freshInspector
    .getByText("Preview ready · verified again when sent", { exact: true })
    .waitFor();
  assert.equal(chats.length, beforeFresh);
  assert.equal(
    previewRequests().at(-1).path,
    `/api/projects/${projects[1].id}/chat-context`,
  );
  assert.equal(previewRequests().at(-1).body.project_brief_revision, null);
  await editor().fill("x".repeat(600));
  await page
    .getByLabel("Conversation mode", { exact: true })
    .selectOption("image");
  const imageCounter = page.locator("#chat-image-prompt-limit");
  const sendsBeforeImageBounds = sendCalls().length;
  const previewsBeforeImageBounds = previewRequests().length;
  assert.equal((await editor().inputValue()).length, 600);
  assert.equal(await sendButton().isDisabled(), true);
  assert.equal(
    await freshInspector
      .getByRole("button", { name: "Preview context", exact: true })
      .isDisabled(),
    true,
  );
  assert.match(
    await imageCounter.innerText(),
    /2048 × 2048 · 40 steps · 600 \/ 512/,
  );
  assert.match(await imageCounter.innerText(), /Your draft is kept/);
  await editor().press("Enter");
  assert.equal(sendCalls().length, sendsBeforeImageBounds);
  assert.equal(previewRequests().length, previewsBeforeImageBounds);
  await openOptions();
  await page
    .getByLabel("Image model", { exact: true })
    .selectOption("legacy-image");
  assert.equal(await sendButton().isDisabled(), false);
  assert.equal((await editor().inputValue()).length, 600);
  await page
    .getByLabel("Image model", { exact: true })
    .selectOption("fixture-image");
  assert.equal(await sendButton().isDisabled(), true);
  await editor().fill("🌲".repeat(512));
  assert.match(await imageCounter.innerText(), /512 \/ 512/);
  assert.equal(await sendButton().isDisabled(), false);
  await page
    .getByLabel("Conversation mode", { exact: true })
    .selectOption("auto");
  await editor().fill("Create an image of " + "x".repeat(512));
  assert.equal(await sendButton().isDisabled(), true);
  assert.match(await imageCounter.innerText(), /531 \/ 512/);
  await page
    .getByLabel("Conversation mode", { exact: true })
    .selectOption("image");
  await editor().fill("A detailed moonlit forest at 2048 square resolution.");
  await freshInspector
    .getByRole("button", { name: "Preview context", exact: true })
    .click();
  await freshInspector
    .getByText(
      "Image request: prompt only. Chat history, documents, response instructions and project brief are excluded.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await freshInspector.locator(".context-inspector-messages details").count(),
    1,
  );
  assert.equal(previewRequests().at(-1).body.project_brief_revision, null);
  const sendsBeforeIncoming = sendCalls().length;
  await editor().fill("Keep my existing Chat draft.");
  await page.evaluate(
    (project) =>
      window.fixtureIntent({
        id: "incoming-chat-task",
        project,
        task: { text: "Explain this reviewed result.", source: "Agent report" },
      }),
    projects[1].id,
  );
  const incomingChat = page.getByRole("region", {
    name: "Incoming Chat task",
    exact: true,
  });
  await incomingChat.waitFor();
  assert.equal(await editor().inputValue(), "Keep my existing Chat draft.");
  await page.evaluate(
    (project) =>
      window.fixtureIntent({
        id: "second-incoming-chat-task",
        project,
        task: {
          text: "A second task stays separate.",
          source: "Second report",
        },
      }),
    projects[1].id,
  );
  await incomingChat
    .getByText("2 incoming tasks waiting for review.", { exact: true })
    .waitFor();
  assert.equal(
    await incomingChat.locator("pre").textContent(),
    "Explain this reviewed result.",
    "a second incoming task does not overwrite the first",
  );
  await page.evaluate(() => window.fixtureProject(0));
  await editor().waitFor();
  assert.equal(
    await incomingChat.count(),
    0,
    "tasks remain scoped to their project",
  );
  await page.evaluate(() => window.fixtureProject(1));
  await incomingChat.waitFor();
  assert.equal(await editor().inputValue(), "Keep my existing Chat draft.");
  await page
    .getByRole("button", { name: "Model settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Back to Chat", exact: true }).click();
  await incomingChat.waitFor();
  assert.equal(
    await incomingChat.locator("pre").textContent(),
    "Explain this reviewed result.",
    "pending task survives remount without automatically applying",
  );
  assert.equal(await editor().inputValue(), "Keep my existing Chat draft.");
  await incomingChat
    .getByRole("button", { name: "Add to my draft", exact: true })
    .click();
  assert.equal(
    await editor().inputValue(),
    "Keep my existing Chat draft.\n\nExplain this reviewed result.",
  );
  assert.equal(
    await page.getByLabel("Conversation mode", { exact: true }).inputValue(),
    "chat",
  );
  await incomingChat.getByText("Second report", { exact: true }).waitFor();
  assert.equal(
    await incomingChat.locator("pre").textContent(),
    "A second task stays separate.",
  );
  await incomingChat
    .getByRole("button", { name: "Keep my draft", exact: true })
    .click();
  assert.equal(await incomingChat.count(), 0);
  await page.evaluate(
    (project) =>
      window.fixtureIntent({
        id: "foreign-chat-task",
        project,
        task: { text: "DO_NOT_INSERT_FOREIGN_TASK", source: "Other project" },
      }),
    projects[0].id,
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(await incomingChat.count(), 0);
  assert.equal(
    (await editor().inputValue()).includes("DO_NOT_INSERT_FOREIGN_TASK"),
    false,
  );
  await page.evaluate(
    (project) =>
      window.fixtureIntent({
        id: "oversized-chat-task",
        project,
        task: { text: "x".repeat(8000), source: "Long report" },
      }),
    projects[1].id,
  );
  await incomingChat.waitFor();
  await incomingChat
    .getByRole("button", { name: "Add to my draft", exact: true })
    .click();
  await page
    .getByText(/combined draft is longer than 8,000/)
    .first()
    .waitFor();
  assert.equal(
    await editor().inputValue(),
    "Keep my existing Chat draft.\n\nExplain this reviewed result.",
  );
  await incomingChat
    .getByRole("button", { name: "Keep my draft", exact: true })
    .click();
  assert.equal(
    sendCalls().length,
    sendsBeforeIncoming,
    "incoming tasks prepare drafts without submitting requests",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "expanded context inspector fits mobile",
  );
  await page.screenshot({
    path: ".local/chat-context-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  assert.ok(
    calls.every((item) => !/runtime|download|install|start/.test(item.path)),
    "all setup and metadata actions are inert with respect to models",
  );
  console.log(
    "Chat browser checks passed: history/search/export privacy, optimistic rename/pin/archive/restore and rollback, presets/model persistence, paused/unavailable model gating, explicit document selection/clear, safe retries, async draft preservation, project/Coding handoff, brief revision conflicts, exact context preview/invalidation/history and mobile layout; all APIs intercepted, no real AI calls.",
  );
} catch (error) {
  console.error({ errors, unexpected });
  console.error((await page.locator("body").innerText()).slice(-11000));
  await page.screenshot({ path: ".local/chat-failure.png", fullPage: true });
  throw error;
} finally {
  releaseHistory();
  await browser.close();
}
