// Real coding UI with synthetic, intercepted APIs. Never contacts a backend,
// launches an IDE, executes source, loads models, or downloads runtime packages.
import { chromium } from "./browser_support.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";

const base = process.env.STUDIO_TEST_URL || "http://127.0.0.1:8898";
assert.notEqual(new URL(base).port, "8877");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM,
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
page.setDefaultTimeout(12000);
const errors = [],
  unexpected = [],
  requests = [],
  writes = [],
  gates = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => dialog.accept());
await page.addInitScript(() => {
  Object.defineProperty(navigator, "clipboard", { value: undefined });
  window.fixtureCopies = [];
  window.fixtureCopyThrows = false;
  document.execCommand = (command) => {
    if (window.fixtureCopyThrows) throw Error("Clipboard blocked by browser.");
    if (command !== "copy") return false;
    window.fixtureCopies.push(document.activeElement.value);
    return true;
  };
});
const projects = ["a", "b", "c"].map((letter) => ({
  id: letter.repeat(32),
  name: `Coding project ${letter.toUpperCase()}`,
}));
const tools = [
  {
    id: "coding-fixture",
    name: "Local coding fixture",
    model: "CPU fixture",
    state: "ready",
    compatibility: { compatible: true },
    profiles: [
      {
        id: "fixture-code",
        task: "write",
        roles: ["chat", "code"],
        label: "Code",
      },
    ],
  },
  {
    id: "coding-alternative",
    name: "Alternative local package",
    model: "Alternative CPU fixture",
    state: "ready",
    compatibility: { compatible: true },
    profiles: [
      {
        id: "fixture-alternative",
        task: "write",
        roles: ["code"],
        label: "Code",
      },
    ],
  },
];
const disks = new Map(
  projects.map((project) => [
    project.id,
    {
      exists: false,
      files: new Map(),
      root: `/srv/Studio projects/owner's $work #1/${project.id[0]}`,
    },
  ]),
);
const chats = new Map();
const preferences = new Map(
  projects.map(({ id }) => [
    id,
    { profile_id: "auto", instructions: "", version: null },
  ]),
);
const preferenceWrites = [];
const briefs = new Map(
  projects.map(({ id }) => [
    id,
    { revision: 1, content: "Use approachable examples for this project." },
  ]),
);
let serial = 0,
  heldFile,
  heldChat,
  heldPreferences,
  heldMessage,
  heldSearch,
  heldPreview,
  failNextMessage = false;
let answer = "Suggested change:\n```python\nprint('reviewed')\n```";
const nextId = () => (++serial + 100).toString(16).padStart(32, "0");
const clone = (value) => structuredClone(value);
function prepared(project, body, conversation) {
  const { client_id, context_fingerprint, ...input } = body;
  const brief =
    body.project_brief_revision === null ? null : briefs.get(project);
  const messages = [
    {
      role: "system",
      content: [
        body.coding_instructions || "",
        brief?.content || "",
        ...(body.coding_context || []).map(
          (file) => disks.get(project).files.get(file.path)?.content || "",
        ),
      ]
        .filter(Boolean)
        .join("\n"),
    },
    { role: "user", content: body.prompt },
  ];
  const history = {
    included_turns: conversation?.turns.length || 0,
    omitted_turns: 0,
    excerpted: false,
  };
  const value = {
    kind: "text",
    messages,
    sources: [],
    project_brief: brief,
    history,
    characters: messages.reduce(
      (total, item) => total + item.content.length,
      0,
    ),
  };
  return {
    ...value,
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ input, ...value }))
      .digest("hex"),
  };
}
function setPreferences(project, fields) {
  const value = {
    ...fields,
    version: createHash("sha256").update(JSON.stringify(fields)).digest("hex"),
  };
  preferences.set(project, value);
  return value;
}
function setFile(project, path, content) {
  const file = {
    path,
    content,
    version: createHash("sha256").update(content).digest("hex"),
    language: path.endsWith(".py") ? "python" : "plaintext",
    size: Buffer.byteLength(content),
    updated_at: Date.now() / 1000,
  };
  disks.get(project).files.set(path, file);
  return file;
}
function workspace(project) {
  const disk = disks.get(project);
  return {
    project_id: project,
    root: disk.root,
    exists: disk.exists,
    files: [...disk.files.values()]
      .map(({ content, ...file }) => file)
      .sort((a, b) => a.path.localeCompare(b.path)),
    skipped: 0,
    execution_enabled: false,
    limits: {
      file_bytes: 512 * 1024,
      files: 256,
      total_bytes: 8 * 1024 * 1024,
    },
  };
}
function gate(fields = {}) {
  let arrive, release, finish;
  const result = {
    ...fields,
    arrival: new Promise((resolve) => {
      arrive = resolve;
    }),
    arrived: () => arrive(),
    release: new Promise((resolve) => {
      release = resolve;
    }),
    resume: () => release(),
    completion: new Promise((resolve) => {
      finish = resolve;
    }),
    finished: () => finish(),
  };
  gates.push(result);
  return result;
}
async function waitForGate(promise, description) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error(`Timed out waiting for ${description}.`)),
          12000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
await page.route("**/api/**", async (route) => {
  const request = route.request(),
    url = new URL(request.url()),
    path = url.pathname,
    method = request.method();
  const body = request.postData() ? request.postDataJSON() : undefined;
  requests.push({ path, method, body: clone(body) });
  let data,
    status = 200,
    delayed;
  const code = path.match(
    /^\/api\/projects\/([a-f0-9]{32})\/code(?:\/(file|starter|preferences|search))?$/,
  );
  const projectChat = path.match(/^\/api\/projects\/([a-f0-9]{32})\/chats$/);
  const chatPath = path.match(/^\/api\/chats\/([a-f0-9]{32})(\/messages)?$/);
  const briefPath = path.match(/^\/api\/projects\/([a-f0-9]{32})\/brief$/);
  const contextPath = path.match(
    /^\/api\/(?:projects\/([a-f0-9]{32})\/chat-context|chats\/([a-f0-9]{32})\/context)$/,
  );
  if (briefPath) {
    data = clone(briefs.get(briefPath[1]));
    if (method === "PUT") {
      if (body.expected_revision !== data.revision) {
        status = 409;
        data = { detail: "The project brief changed. Reload before saving." };
      } else {
        data = { revision: data.revision + 1, content: body.content };
        briefs.set(briefPath[1], data);
      }
    } else assert.equal(method, "GET");
  } else if (contextPath && method === "POST") {
    const conversation = contextPath[2] ? chats.get(contextPath[2]) : null;
    data = prepared(contextPath[1] || conversation.project, body, conversation);
    if (heldPreview) {
      delayed = heldPreview;
      heldPreview = null;
      delayed.arrived();
      await delayed.release;
    }
  } else if (code) {
    const [, project, action] = code,
      disk = disks.get(project);
    assert.ok(disk, "all source operations must remain in the chosen project");
    if (action === "search" && method === "GET") {
      const query = url.searchParams.get("query"),
        sensitive = url.searchParams.get("case_sensitive") === "true",
        matches = [];
      for (const file of disk.files.values()) {
        const haystack = sensitive ? file.content : file.content.toLowerCase(),
          needle = sensitive ? query : query.toLowerCase();
        let position = haystack.indexOf(needle);
        while (position >= 0 && matches.length < 200) {
          const lines = file.content.slice(0, position).split("\n");
          matches.push({
            path: file.path,
            version: file.version,
            start: position,
            end: position + query.length,
            match: file.content.slice(position, position + query.length),
            line: lines.length,
            column: lines.at(-1).length + 1,
            preview: file.content.split("\n")[lines.length - 1],
          });
          position = haystack.indexOf(needle, position + query.length);
        }
      }
      data = {
        query,
        case_sensitive: sensitive,
        matches,
        searched_files: disk.files.size,
        partial: false,
        limit_reached: false,
      };
      if (heldSearch) {
        delayed = heldSearch;
        heldSearch = null;
        delayed.arrived();
        await delayed.release;
      }
    } else if (action === "preferences" && method === "GET") {
      data = clone(preferences.get(project));
      if (heldPreferences?.project === project) {
        delayed = heldPreferences;
        heldPreferences = null;
        delayed.arrived();
        await delayed.release;
      }
    } else if (action === "preferences" && method === "PUT") {
      if (body.version !== preferences.get(project).version) {
        status = 409;
        data = {
          detail:
            "AI setup changed in another window. Reload the saved setup before saving.",
        };
      } else {
        data = setPreferences(project, {
          profile_id: body.profile_id,
          instructions: body.instructions,
        });
        preferenceWrites.push({ project, ...clone(body) });
      }
    } else if (!action && method === "GET") data = workspace(project);
    else if (action === "starter" && method === "POST") {
      disk.exists = true;
      if (body.template === "python") {
        setFile(project, "main.py", "print('starter')\n");
        setFile(project, "utils.py", "def helper():\n    return 1\n");
      } else assert.equal(body.template, "empty");
      data = workspace(project);
    } else if (action === "file" && method === "GET") {
      const filename = url.searchParams.get("path");
      data = clone(disk.files.get(filename));
      if (!data) {
        status = 404;
        data = { detail: "The fixture file no longer exists." };
      }
      if (heldFile?.project === project && heldFile.path === filename) {
        delayed = heldFile;
        heldFile = null;
        delayed.arrived();
        await delayed.release;
      }
    } else if (action === "file" && method === "PUT") {
      const old = disk.files.get(body.path);
      if ((old?.version ?? null) !== body.version) {
        status = 409;
        data = {
          detail:
            "This file changed in another editor. Your draft has not been applied.",
        };
      } else {
        data = setFile(project, body.path, body.content);
        disk.exists = true;
        writes.push({ project, ...clone(body) });
      }
    } else {
      unexpected.push(`${method} ${path}`);
      data = {};
    }
  } else if (projectChat && method === "GET") {
    data = [...chats.values()]
      .filter((chat) => chat.project === projectChat[1])
      .map(({ turns, ...chat }) => ({
        ...chat,
        last_mode: turns.at(-1)?.mode || chat.last_mode,
        updated: chat.updated || Date.now() / 1000,
      }));
  } else if (projectChat && method === "POST") {
    data = {
      id: nextId(),
      project: projectChat[1],
      title: body.title,
      turns: [],
    };
    chats.set(data.id, data);
  } else if (chatPath && method === "GET") {
    data = clone(chats.get(chatPath[1]));
    assert.ok(data);
    if (heldChat?.id === chatPath[1]) {
      delayed = heldChat;
      heldChat = null;
      delayed.arrived();
      await delayed.release;
    }
  } else if (chatPath?.[2] && method === "POST") {
    const conversation = chats.get(chatPath[1]);
    assert.ok(conversation);
    const contextValue = prepared(conversation.project, body, conversation);
    if (
      (body.project_brief_revision !== null &&
        body.project_brief_revision !==
          briefs.get(conversation.project).revision) ||
      (body.context_fingerprint &&
        body.context_fingerprint !== contextValue.fingerprint)
    ) {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          detail:
            "Request context changed. Preview the context again before sending.",
        }),
      });
      return;
    }
    const context = (body.coding_context || []).map((entry) =>
      disks.get(conversation.project).files.get(entry.path),
    );
    const stale = (body.coding_context || []).some(
      (entry, index) =>
        !context[index] || context[index].version !== entry.version,
    );
    if (stale) {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          detail:
            "A supporting file changed. Refresh context before sending again.",
        }),
      });
      return;
    }
    assert.ok(
      context.length <= 4 &&
        context.reduce((sum, file) => sum + file.content.length, 0) <= 12000,
    );
    assert.ok((body.coding_instructions || "").length <= 2000);
    let turn = conversation.turns.find(
      (item) => item.client_id === body.client_id,
    );
    if (!turn) {
      const job = {
        id: nextId(),
        state: "completed",
        message: "Synthetic completion; no model was run.",
        request: {
          ...clone(contextValue),
          task: "write",
          chat_id: conversation.id,
          profile: { id: "fixture-code", model: "CPU fixture" },
        },
      };
      turn = {
        id: nextId(),
        client_id: body.client_id,
        prompt: body.prompt,
        mode: body.mode,
        documents: [],
        coding_context: clone(context),
        coding_instructions: body.coding_instructions || "",
        answer,
        job,
      };
      conversation.turns.push(turn);
    }
    data = turn.job;
    if (heldMessage?.id === conversation.id) {
      delayed = heldMessage;
      heldMessage = null;
      delayed.arrived();
      await delayed.release;
    }
    if (failNextMessage) {
      failNextMessage = false;
      status = 503;
      data = {
        detail: "Fixture response lost after accepting the coding request.",
      };
    }
  } else {
    unexpected.push(`${method} ${path}`);
    status = 404;
    data = { detail: "Unexpected fixture route." };
  }
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(data),
  });
  delayed?.finished();
});
await page.route("**/mcp/**", (route) => {
  unexpected.push("MCP execution attempted");
  return route.abort();
});
await page.route("**/coding-fixture", (route) =>
  route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><title>Coding fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;
const {default: React} = await import('/node_modules/.vite-ui/deps/react.js');
const {useState} = React;
const {default: ReactDOM} = await import('/node_modules/.vite-ui/deps/react-dom_client.js');
await import('/web/style.css?import'); await import('/web/studio-design.css?import'); await import('/web/studio-gold.css?import');
const {default: CodingStudio} = await import('/web/CodingStudio.jsx');
const projects = ${JSON.stringify(projects)}; window.fixtureConsumed=[];
const api = async (path, body, method) => { const response = await fetch('/api' + path, {method:method || (body === undefined ? 'GET' : 'POST'),headers:{'Content-Type':'application/json'},body:body === undefined ? undefined : JSON.stringify(body)}); const value = await response.json(); if (!response.ok) { const failure = Error(value.detail || value.error); failure.status = response.status; throw failure; } return value; };
function Harness() {
  const [project, setProject] = useState(projects[0]), [worker, setWorker] = useState({state:'stopped'}), [handoff, setHandoff] = useState(''), [intent,setIntent]=useState(null);
  window.fixtureProject = (index) => setProject(projects[index]); window.fixtureWorker = setWorker; window.fixtureIntent=setIntent;
  return React.createElement('main', {style:{padding:'16px',maxWidth:'1600px',margin:'0 auto',minWidth:0}}, React.createElement(CodingStudio, {key:project.id, project, api, tools:${JSON.stringify(tools)}, defaultProfile:'fixture-alternative', worker, initialIntent:intent,onIntentConsumed:id=>{window.fixtureConsumed.push(id);setIntent(current=>current?.id===id?null:current);}, onModels:()=>setHandoff('Models requested'), onMCP:()=>setHandoff('MCP requested'), onAgents:()=>setHandoff('Agents requested')}), React.createElement('output', {id:'handoff'}, handoff));
}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
</script></body></html>`,
  }),
);

const editor = (path = "main.py") =>
  page.getByRole("textbox", { name: `Edit ${path}`, exact: true });
const file = (path) =>
  page
    .getByRole("complementary", { name: "Project files" })
    .getByTitle(path, { exact: true });
const askButton = () =>
  page.getByRole("button", { name: "Ask assistant", exact: true });
const question = () =>
  page.getByRole("textbox", { name: "Ask about your code", exact: true });
const modelStatus = () =>
  page.getByRole("region", { name: "Local AI model", exact: true });
const instructionField = () =>
  page.getByRole("textbox", {
    name: "Instructions for this project",
    exact: true,
  });
async function openDetails(selector) {
  const details = page.locator(selector);
  if (!(await details.evaluate((element) => element.open)))
    await details.locator("summary").click();
  return details;
}
async function saveSetup() {
  await page
    .getByRole("button", { name: "Save AI setup", exact: true })
    .click();
  await page
    .getByText("AI setup saved for this project. No model was loaded.", {
      exact: true,
    })
    .waitFor();
  await page
    .getByRole("button", { name: "Save AI setup", exact: true })
    .waitFor({ state: "detached" });
}
async function selectReference(path) {
  await page.getByRole("checkbox", { name: path, exact: true }).click();
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll(".coding-reference-list label")]
        .find((label) => label.querySelector("span")?.textContent === name)
        ?.querySelector("input")?.checked,
    path,
  );
}
const messagePosts = () =>
  requests.filter(
    (item) => item.method === "POST" && item.path.endsWith("/messages"),
  );
const chatPosts = () =>
  requests.filter(
    (item) =>
      item.method === "POST" &&
      /^\/api\/projects\/[^/]+\/chats$/.test(item.path),
  );
const conflict = () =>
  page.getByRole("dialog", { name: "Review conflicting edits" });
const proposal = () => page.getByRole("dialog", { name: "Review code change" });
const ask = async (text) => {
  await question().fill(text);
  await askButton().click();
  await page.waitForFunction(
    () => document.querySelector(".coding-composer textarea").value === "",
  );
};
const assertEditor = async (text, path = "main.py") => {
  await page.waitForFunction(
    ({ name, value }) =>
      document.querySelector(`textarea[aria-label="Edit ${name}"]`)?.value ===
      value,
    { name: path, value: text },
  );
  assert.equal(await editor(path).inputValue(), text);
};
const settle = () =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
async function save() {
  await page.getByRole("button", { name: "Save file", exact: true }).click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent.trim() === "Save file",
      )?.disabled &&
      document
        .querySelector(".coding-editor-status")
        ?.textContent.includes("Saved on this computer"),
  );
}
async function selectSource(start, end) {
  await editor().evaluate(
    (field, range) => {
      field.focus();
      field.setSelectionRange(range.start, range.end);
      field.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      document.dispatchEvent(new Event("selectionchange"));
    },
    { start, end },
  );
}
async function downloadWorkspace() {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Download VS Code workspace", exact: true })
      .click(),
  ]);
  assert.equal(download.suggestedFilename(), "paiton.code-workspace");
  return JSON.parse(await readFile(await download.path(), "utf8"));
}

try {
  const delayedPreferences = gate({ project: projects[0].id });
  heldPreferences = delayedPreferences;
  await page.goto(base + "/coding-fixture");
  await waitForGate(delayedPreferences.arrival, "initial AI setup restore");
  await page
    .getByRole("heading", { name: "What would you like to build?" })
    .waitFor();
  await page.getByRole("button", { name: /A Python project/ }).click();
  await assertEditor("print('starter')\n");
  await page.evaluate(() => window.fixtureWorker({ state: "idle" }));
  await question().fill("Do not send while setup is still restoring.");
  assert.equal(await askButton().isDisabled(), true);
  assert.equal(chatPosts().length, 0);
  assert.equal(messagePosts().length, 0);
  delayedPreferences.resume();
  await waitForGate(delayedPreferences.completion, "released AI setup restore");
  await page.waitForFunction(
    () => !document.querySelector(".coding-composer button.primary")?.disabled,
  );
  assert.match(await modelStatus().innerText(), /Alternative local package/);
  assert.match(await modelStatus().innerText(), /Following Studio/);
  await modelStatus()
    .getByRole("button", { name: "Model settings", exact: true })
    .click();
  assert.equal(await page.locator("#handoff").innerText(), "Models requested");
  await question().fill("");
  await page.evaluate(() => window.fixtureWorker({ state: "stopped" }));
  assert.equal(
    requests.filter((item) => item.path.endsWith("/starter")).length,
    1,
  );
  const draftA = "print('unsaved project A')\n";
  await editor().fill(draftA);
  await file("utils.py").click();
  await editor("utils.py").waitFor();
  await file("main.py").click();
  await assertEditor(draftA);
  await page.evaluate(() => window.fixtureProject(1));
  await page
    .getByRole("heading", { name: "What would you like to build?" })
    .waitFor();
  await page.getByRole("button", { name: /Start from scratch/ }).click();
  await page.getByLabel("New file path", { exact: true }).fill("main.py");
  await page.getByRole("button", { name: "Create file", exact: true }).click();
  await assertEditor("");
  const draftB = "print('unsaved project B')\n";
  await editor().fill(draftB);
  await page.evaluate(() => window.fixtureProject(0));
  await assertEditor(draftA);
  await page.reload();
  await assertEditor(draftA);
  await page.evaluate(() => window.fixtureProject(1));
  await assertEditor(draftB);
  await page.evaluate(() => window.fixtureProject(0));
  await assertEditor(draftA);
  await save();
  assert.equal(disks.get(projects[0].id).files.get("main.py").content, draftA);
  assert.equal(
    disks.get(projects[1].id).files.get("main.py").content,
    "",
    "other project draft stays unsaved",
  );

  // Actual 409s preserve both versions and require a second explicit save.
  await editor().fill("print('browser draft')\n");
  setFile(projects[0].id, "main.py", "print('external edit')\n");
  const beforeConflictWrites = writes.length;
  await page.getByRole("button", { name: "Save file", exact: true }).click();
  await conflict().waitFor();
  assert.match(await conflict().innerText(), /external edit/);
  assert.match(await conflict().innerText(), /browser draft/);
  assert.equal(writes.length, beforeConflictWrites);
  await conflict()
    .getByRole("button", { name: "Keep my draft", exact: true })
    .click();
  assert.equal(writes.length, beforeConflictWrites);
  await assertEditor("print('browser draft')\n");
  await save();
  assert.equal(
    disks.get(projects[0].id).files.get("main.py").content,
    "print('browser draft')\n",
  );
  await editor().fill("print('draft to discard')\n");
  setFile(projects[0].id, "main.py", "print('external version to keep')\n");
  const beforeDiskChoice = writes.length;
  await page.getByRole("button", { name: "Save file", exact: true }).click();
  await conflict().waitFor();
  await conflict()
    .getByRole("button", { name: "Use saved version", exact: true })
    .click();
  await assertEditor("print('external version to keep')\n");
  assert.equal(writes.length, beforeDiskChoice);

  // Refreshing B and then opening already-cached A must read A's new disk version.
  await file("utils.py").click();
  setFile(projects[0].id, "main.py", "print('changed while inactive')\n");
  await page
    .getByRole("button", { name: "Refresh project files", exact: true })
    .click();
  await file("main.py").click();
  await assertEditor("print('changed while inactive')\n");
  const delayedRead = gate({ project: projects[0].id, path: "main.py" });
  heldFile = delayedRead;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await waitForGate(delayedRead.arrival, "the held file read");
  await editor().fill("print('saved after a pending read')\n");
  await save();
  delayedRead.resume();
  await waitForGate(delayedRead.completion, "the released file read");
  await settle();
  await assertEditor("print('saved after a pending read')\n");

  // External deletion drops a clean cached file; deleting a dirty one keeps its draft.
  disks.get(projects[0].id).files.delete("utils.py");
  await page
    .getByRole("button", { name: "Refresh project files", exact: true })
    .click();
  await file("utils.py").waitFor({ state: "detached" });
  setFile(projects[0].id, "utils.py", "def helper():\n    return 1\n");
  await page
    .getByRole("button", { name: "Refresh project files", exact: true })
    .click();
  await file("utils.py").waitFor();
  const recreatedDraft = "print('keep draft after external deletion')\n";
  await editor().fill(recreatedDraft);
  disks.get(projects[0].id).files.delete("main.py");
  await page
    .getByRole("button", { name: "Refresh project files", exact: true })
    .click();
  await assertEditor(recreatedDraft);
  const beforeRecreate = writes.length;
  await page.getByRole("button", { name: "Save file", exact: true }).click();
  await conflict()
    .getByRole("button", { name: "Prepare to recreate", exact: true })
    .click();
  assert.equal(writes.length, beforeRecreate);
  assert.equal(disks.get(projects[0].id).files.has("main.py"), false);
  await save();
  assert.equal(
    disks.get(projects[0].id).files.get("main.py").content,
    recreatedDraft,
  );

  // Paused assistants must not create a chat or submit a message.
  // Search uses saved files, selects exact source and never replaces an unsaved draft.
  const searchSource = "😀 prefix\r\nNeedle.* first\r\nsecond needle.*\r\n";
  setFile(projects[0].id, "search.py", searchSource);
  await page
    .getByRole("button", { name: "Refresh project files", exact: true })
    .click();
  await page.keyboard.press("Control+Shift+f");
  await page
    .getByRole("textbox", { name: "Find in saved files", exact: true })
    .fill("needle.*");
  await page
    .getByRole("button", { name: "Search saved files", exact: true })
    .click();
  const results = () =>
    page.getByLabel("Content search results", { exact: true });
  await results().getByRole("button").first().waitFor();
  assert.equal(await results().getByRole("button").count(), 2);
  await results().getByRole("button").first().click();
  await assertEditor(searchSource.replace(/\r\n/g, "\n"), "search.py");
  await page.waitForFunction(() => {
    const editor = document.querySelector(
      'textarea[aria-label="Edit search.py"]',
    );
    return (
      editor &&
      editor.value.slice(editor.selectionStart, editor.selectionEnd) ===
        "Needle.*"
    );
  });
  const firstJump = gate({ project: projects[0].id, path: "search.py" });
  heldFile = firstJump;
  await results().getByRole("button").first().click();
  await waitForGate(firstJump.arrival, "held earlier search jump");
  await results().getByRole("button").last().click();
  await page.waitForFunction(() => {
    const editor = document.querySelector(
      'textarea[aria-label="Edit search.py"]',
    );
    return (
      editor?.value.slice(editor.selectionStart, editor.selectionEnd) ===
      "needle.*"
    );
  });
  firstJump.resume();
  await waitForGate(firstJump.completion, "outdated search jump response");
  await settle();
  assert.equal(
    await editor("search.py").evaluate((field) =>
      field.value.slice(field.selectionStart, field.selectionEnd),
    ),
    "needle.*",
    "the latest search jump keeps its selection when an older read completes",
  );
  const searchDraft = "unsaved draft must remain\n";
  disks.get(projects[0].id).files.delete("search.py");
  await results().getByRole("button").first().click();
  await page
    .getByRole("alert")
    .filter({ hasText: "The fixture file no longer exists" })
    .waitFor();
  assert.equal(
    await editor("search.py").evaluate(
      (field) => field === document.activeElement,
    ),
    false,
    "failed reads do not jump into an old cached result",
  );
  setFile(projects[0].id, "search.py", searchSource);
  await editor("search.py").fill(searchDraft);
  await results().getByRole("button").last().click();
  await page
    .getByText("This result refers to an earlier saved file.", { exact: false })
    .waitFor();
  await assertEditor(searchDraft, "search.py");
  assert.equal(
    disks.get(projects[0].id).files.get("search.py").content,
    searchSource,
  );
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await proposal().waitFor();
  assert.match(
    await proposal().getByLabel("Line changes", { exact: true }).innerText(),
    /1 added · 3 removed/,
  );
  assert.equal(
    await proposal()
      .getByRole("button", { name: "Apply to draft", exact: true })
      .count(),
    0,
  );
  await proposal().getByRole("button", { name: "Cancel", exact: true }).click();
  await editor("search.py").fill(searchSource);
  await save();
  setFile(projects[0].id, "search.py", "changed on host\n");
  await results().getByRole("button").first().click();
  await assertEditor("changed on host\n", "search.py");
  assert.equal(
    await editor("search.py").evaluate(
      (field) => field.selectionStart === field.selectionEnd,
    ),
    true,
  );
  const searchGate = gate();
  heldSearch = searchGate;
  await page
    .getByRole("textbox", { name: "Find in saved files", exact: true })
    .fill("changed");
  await page
    .getByRole("button", { name: "Search saved files", exact: true })
    .click();
  await waitForGate(searchGate.arrival, "held saved-file search");
  await page
    .getByRole("textbox", { name: "Find in saved files", exact: true })
    .fill("unmatched new query");
  searchGate.resume();
  await waitForGate(searchGate.completion, "obsolete search response");
  await settle();
  assert.equal(
    await results().count(),
    0,
    "an obsolete query cannot publish results after typing a new search",
  );
  await page.keyboard.press("Control+p");
  await page
    .getByRole("textbox", { name: "Find a code file", exact: true })
    .fill("main.py");
  await page
    .locator(".coding-explorer nav")
    .getByRole("button", { name: "main.py", exact: true })
    .click();
  await editor().waitFor();
  await page
    .getByRole("textbox", { name: "Find a code file", exact: true })
    .fill("");
  await question().fill("Explain this code without running it.");
  assert.equal(await askButton().isDisabled(), true);
  assert.equal(chatPosts().length, 0);
  assert.equal(messagePosts().length, 0);
  await openDetails(".coding-composer .context-inspector");
  await page
    .getByRole("button", { name: "Preview context", exact: true })
    .click();
  await page
    .getByText("Preview ready · verified again when sent", { exact: true })
    .waitFor();
  assert.equal(chatPosts().length, 0, "preview must not create a chat");
  assert.equal(
    messagePosts().length,
    0,
    "paused context inspection must not submit inference",
  );
  const pausedPreview = requests
    .filter((item) => item.path.endsWith("/chat-context"))
    .at(-1);
  assert.equal(pausedPreview.body.project_brief_revision, null);
  assert.ok(pausedPreview.body.prompt.includes(recreatedDraft));
  await page.evaluate(() => window.fixtureWorker({ state: "idle" }));
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll("button")].find(
        (button) => button.textContent.trim() === "Ask assistant",
      )?.disabled,
  );
  const source =
    "// DO_NOT_ATTACH_BEFORE\nconst target = 1;\n// DO_NOT_ATTACH_AFTER\n";
  const selected = "const target = 1;\n",
    selectionStart = source.indexOf(selected);
  await editor().fill(source);
  await selectSource(selectionStart, selectionStart + selected.length);
  await page
    .locator(".coding-composer select")
    .first()
    .selectOption("selection");
  answer = "Use the updated value:\n```javascript\nconst target = 2;\n```";
  const beforeSuggestionWrites = writes.length;
  await ask("Change the selected value to two.");
  const sent = messagePosts().at(-1).body;
  assert.equal(sent.mode, "code");
  assert.equal(
    sent.inherit_documents,
    false,
    "coding requests must not silently inherit documents from a resumed general chat",
  );
  assert.match(sent.client_id, /^[a-f0-9]{32}$/);
  assert.ok(sent.prompt.includes(selected));
  assert.equal(sent.prompt.includes("DO_NOT_ATTACH_BEFORE"), false);
  assert.equal(sent.prompt.includes("DO_NOT_ATTACH_AFTER"), false);
  assert.equal(writes.length, beforeSuggestionWrites);
  await page
    .locator(".coding-turn")
    .last()
    .getByRole("button", { name: "Review change", exact: true })
    .click();
  await proposal().waitFor();
  assert.match(
    await proposal().getByLabel("Line changes", { exact: true }).innerText(),
    /1 added · 1 removed/,
  );
  await proposal()
    .getByRole("button", { name: "Apply to draft", exact: true })
    .click();
  await assertEditor(source.replace(selected, "const target = 2;\n"));
  assert.equal(
    writes.length,
    beforeSuggestionWrites,
    "reviewed AI changes remain unsaved until Save is chosen",
  );
  await save();

  // A proposal cannot replace a file that changed after the request or review.
  await page.locator(".coding-composer select").first().selectOption("file");
  answer = "```javascript\nconst replacement = true;\n```";
  await ask("Propose a complete replacement.");
  const lastReview = page
    .locator(".coding-turn")
    .last()
    .getByRole("button", { name: "Review change", exact: true });
  await lastReview.click();
  await proposal().waitFor();
  await proposal().getByRole("button", { name: "Cancel", exact: true }).click();
  await editor().fill("const myNewEdit = 'keep this';\n");
  await lastReview.click();
  await page
    .getByRole("alert")
    .filter({ hasText: "This file changed since the request" })
    .waitFor();
  assert.equal(await proposal().count(), 0);
  await assertEditor("const myNewEdit = 'keep this';\n");

  // A cached conversation is an actual restoration gate, independent of worker state.
  const activeChat = [...chats.values()].at(-1),
    oldChatCount = chatPosts().length;
  await question().fill("A question after reload");
  const delayedChat = gate({ id: activeChat.id });
  heldChat = delayedChat;
  await page.reload();
  await waitForGate(delayedChat.arrival, "the held chat restore");
  await editor().waitFor();
  await page.evaluate(() => window.fixtureWorker({ state: "idle" }));
  await page
    .getByText("Restoring your coding conversation…", { exact: true })
    .waitFor();
  assert.equal(await askButton().isDisabled(), true);
  assert.equal(chatPosts().length, oldChatCount);
  delayedChat.resume();
  await waitForGate(delayedChat.completion, "the released chat restore");
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll("button")].find(
        (button) => button.textContent.trim() === "Ask assistant",
      )?.disabled,
  );
  assert.equal(chatPosts().length, oldChatCount);
  await assertEditor("const myNewEdit = 'keep this';\n");

  // Identical selected text in another range needs a new idempotency identity.
  const repeated = "repeat();\n",
    duplicatedSource = repeated + "// divider\n" + repeated;
  await editor().fill(duplicatedSource);
  await selectSource(0, repeated.length);
  await page
    .locator(".coding-composer select")
    .first()
    .selectOption("selection");
  answer = "```javascript\nchanged();\n```";
  failNextMessage = true;
  await question().fill("Change this selected call.");
  await askButton().click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Fixture response lost" })
    .waitFor();
  const firstRetry = messagePosts().at(-1).body;
  await selectSource(
    duplicatedSource.lastIndexOf(repeated),
    duplicatedSource.length,
  );
  await askButton().click();
  await page.waitForFunction(
    () => document.querySelector(".coding-composer textarea").value === "",
  );
  const secondRetry = messagePosts().at(-1).body;
  assert.equal(secondRetry.prompt, firstRetry.prompt);
  assert.notEqual(secondRetry.client_id, firstRetry.client_id);
  await page
    .locator(".coding-turn")
    .last()
    .getByRole("button", { name: "Review change", exact: true })
    .click();
  await proposal()
    .getByRole("button", { name: "Apply to draft", exact: true })
    .click();
  await assertEditor(repeated + "// divider\nchanged();\n");

  // Project AI preferences are durable, scoped and conflict checked, without generation.
  const beforeSetupMessages = messagePosts().length;
  await openDetails(".coding-ai-setup");
  await instructionField().fill(
    "Use small functions. Preserve the public API.",
  );
  await openDetails(".model-status details");
  await page
    .getByLabel("Coding model", { exact: true })
    .selectOption("fixture-code");
  assert.match(await modelStatus().innerText(), /Your selected local model/);
  await saveSetup();
  assert.deepEqual(preferenceWrites.at(-1), {
    project: projects[0].id,
    profile_id: "fixture-code",
    instructions: "Use small functions. Preserve the public API.",
    version: null,
  });
  await page.evaluate(() => window.fixtureProject(1));
  await editor().waitFor();
  await openDetails(".coding-ai-setup");
  assert.equal(await instructionField().inputValue(), "");
  assert.match(await modelStatus().innerText(), /Alternative local package/);
  await instructionField().fill("Project B uses Rust.");
  await saveSetup();
  await page.evaluate(() => window.fixtureProject(0));
  await editor().waitFor();
  await openDetails(".coding-ai-setup");
  await page.waitForFunction(
    () =>
      document.querySelector(".coding-ai-setup textarea")?.value ===
      "Use small functions. Preserve the public API.",
  );
  await instructionField().fill("Unsaved instruction draft survives reload.");
  await settle();
  await page.reload();
  await editor().waitFor();
  await openDetails(".coding-ai-setup");
  await page.waitForFunction(
    () =>
      document.querySelector(".coding-ai-setup textarea")?.value ===
      "Unsaved instruction draft survives reload.",
  );
  const concurrent = setPreferences(projects[0].id, {
    profile_id: "fixture-alternative",
    instructions: "Saved by another browser window.",
  });
  const beforeSetupWrites = preferenceWrites.length;
  await page
    .getByRole("button", { name: "Save AI setup", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "AI setup changed in another window" })
    .waitFor();
  assert.equal(preferenceWrites.length, beforeSetupWrites);
  assert.equal(
    await instructionField().inputValue(),
    "Unsaved instruction draft survives reload.",
  );
  await page.evaluate(() => window.fixtureWorker({ state: "idle" }));
  await page.locator(".coding-composer select").first().selectOption("none");
  await question().fill("Wait for the saved setup before sending.");
  await openDetails(".model-status details");
  assert.equal(await askButton().isDisabled(), false);
  const delayedSetupReload = gate({ project: projects[0].id });
  heldPreferences = delayedSetupReload;
  await page
    .getByRole("button", { name: "Load saved AI setup", exact: true })
    .click();
  await waitForGate(delayedSetupReload.arrival, "saved AI setup reload");
  await settle();
  assert.equal(await instructionField().isDisabled(), true);
  assert.equal(
    await page.getByLabel("Coding model", { exact: true }).isDisabled(),
    true,
  );
  assert.equal(await askButton().isDisabled(), true);
  assert.equal(messagePosts().length, beforeSetupMessages);
  assert.equal(
    await instructionField().inputValue(),
    "Unsaved instruction draft survives reload.",
  );
  delayedSetupReload.resume();
  await waitForGate(delayedSetupReload.completion, "released AI setup reload");
  await page.waitForFunction(
    () =>
      document.querySelector(".coding-ai-setup textarea")?.value ===
      "Saved by another browser window.",
  );
  assert.equal(await instructionField().isDisabled(), false);
  assert.equal(
    await page.getByLabel("Coding model", { exact: true }).isDisabled(),
    false,
  );
  assert.equal(
    await page.getByLabel("Coding model", { exact: true }).inputValue(),
    "fixture-alternative",
  );
  assert.equal(await askButton().isDisabled(), false);
  await instructionField().fill("Persisted project A coding instructions.");
  await saveSetup();
  assert.equal(preferenceWrites.at(-1).version, concurrent.version);
  assert.equal(messagePosts().length, beforeSetupMessages);

  // A saved model disappearing must block Ask rather than silently substitute Auto.
  setPreferences(projects[0].id, {
    profile_id: "missing-package",
    instructions: "Unavailable saved choice.",
  });
  await page.reload();
  await editor().waitFor();
  await page.evaluate(() => window.fixtureWorker({ state: "idle" }));
  await question().fill("Do not run a substituted model.");
  await modelStatus().getByText("Setup needed", { exact: true }).waitFor();
  assert.equal(await askButton().isDisabled(), true);
  assert.equal(messagePosts().length, beforeSetupMessages);
  await openDetails(".model-status details");
  await page
    .getByLabel("Coding model", { exact: true })
    .selectOption("fixture-alternative");
  await openDetails(".coding-ai-setup");
  await instructionField().fill("Persisted project A coding instructions.");
  await saveSetup();

  // Supporting files send exact saved revisions; stale server snapshots are recoverable.
  await page.locator(".coding-composer select").first().selectOption("file");
  await openDetails(".coding-context-picker");
  assert.equal(
    await page
      .getByRole("checkbox", { name: /main\.py.*included above/ })
      .isDisabled(),
    true,
  );
  await page.locator(".coding-composer select").first().selectOption("none");
  await openDetails(".coding-context-picker");
  await selectReference("utils.py");
  const firstSupportingVersion = disks
    .get(projects[0].id)
    .files.get("utils.py").version;
  answer = "The helper is a small pure function.";
  await ask("Explain the supporting helper.");
  assert.deepEqual(messagePosts().at(-1).body.coding_context, [
    { path: "utils.py", version: firstSupportingVersion },
  ]);
  assert.equal(
    messagePosts().at(-1).body.coding_instructions,
    "Persisted project A coding instructions.",
  );
  assert.equal(messagePosts().at(-1).body.profile_id, "fixture-alternative");
  const contextualTurn = page.locator(".coding-turn").last();
  await contextualTurn
    .getByText("1 supporting file included", { exact: true })
    .click();
  assert.match(await contextualTurn.innerText(), /utils\.py.*saved snapshot/);
  await contextualTurn
    .getByText("Project instructions used", { exact: true })
    .click();
  assert.match(
    await contextualTurn.innerText(),
    /Persisted project A coding instructions/,
  );
  setFile(projects[0].id, "utils.py", "def helper():\n    return 42\n");
  await question().fill("Read the updated helper.");
  await askButton().click();
  await page
    .getByRole("alert")
    .filter({ hasText: "A supporting file changed" })
    .waitFor();
  assert.equal(await question().inputValue(), "Read the updated helper.");
  const rejectedContext = messagePosts().at(-1).body;
  await page
    .getByRole("button", { name: "Refresh context", exact: true })
    .click();
  await page
    .getByText("Supporting files refreshed from the Studio host.", {
      exact: true,
    })
    .waitFor();
  await ask("Read the updated helper.");
  assert.notEqual(
    messagePosts().at(-1).body.client_id,
    rejectedContext.client_id,
  );
  assert.equal(
    messagePosts().at(-1).body.coding_context[0].version,
    disks.get(projects[0].id).files.get("utils.py").version,
  );
  await page.getByRole("button", { name: "Clear files", exact: true }).click();
  setFile(projects[0].id, "too-large.txt", "x".repeat(12001));
  for (const path of [
    "one.txt",
    "two.txt",
    "three.txt",
    "four.txt",
    "five.txt",
  ])
    setFile(projects[0].id, path, path + "\n");
  await page
    .getByRole("button", { name: "Refresh project files", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "too-large.txt", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Supporting files can contain up to 12,000 characters" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("checkbox", { name: "too-large.txt", exact: true })
      .isChecked(),
    false,
  );
  for (const path of ["one.txt", "two.txt", "three.txt", "four.txt"])
    await selectReference(path);
  assert.equal(
    await page
      .getByRole("checkbox", { name: "five.txt", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Clear files", exact: true }).click();

  // Resume only this project's code conversations; async restore keeps files and setup.
  const pastId = nextId();
  chats.set(pastId, {
    id: pastId,
    project: projects[0].id,
    title: "Earlier code investigation",
    last_mode: "code",
    turns: [],
    updated: Date.now() / 1000,
  });
  const unrelatedId = nextId();
  chats.set(unrelatedId, {
    id: unrelatedId,
    project: projects[0].id,
    title: "A general writing conversation",
    last_mode: "chat",
    turns: [],
  });
  const otherProjectId = nextId();
  chats.set(otherProjectId, {
    id: otherProjectId,
    project: projects[1].id,
    title: "Other project's code",
    last_mode: "code",
    turns: [],
  });
  const historyList = await openDetails(".coding-history");
  await historyList
    .getByRole("button", { name: /Earlier code investigation/ })
    .waitFor();
  assert.equal(
    await historyList
      .getByRole("button", { name: /general writing|Other project's code/ })
      .count(),
    0,
  );
  const beforeResume = await editor().inputValue();
  const delayedResume = gate({ id: pastId });
  heldChat = delayedResume;
  await historyList
    .getByRole("button", { name: /Earlier code investigation/ })
    .click();
  await waitForGate(delayedResume.arrival, "past conversation restore");
  await question().fill("Continue this earlier investigation.");
  assert.equal(await askButton().isDisabled(), true);
  delayedResume.resume();
  await waitForGate(delayedResume.completion, "released past conversation");
  await assertEditor(beforeResume);
  assert.equal(
    await instructionField().inputValue(),
    "Persisted project A coding instructions.",
  );
  const beforeResumeChatPosts = chatPosts().length;
  await ask("Continue this earlier investigation.");
  assert.equal(messagePosts().at(-1).path, `/api/chats/${pastId}/messages`);
  assert.deepEqual(messagePosts().at(-1).body.coding_context, []);
  assert.equal(chatPosts().length, beforeResumeChatPosts);

  // An unopened file must finish loading before it can become AI context.
  const delayedUncachedFile = gate({
    project: projects[0].id,
    path: "one.txt",
  });
  heldFile = delayedUncachedFile;
  await page.locator(".coding-composer select").first().selectOption("file");
  await question().fill("Explain this newly opened file.");
  const beforeUncachedFileMessages = messagePosts().length;
  await file("one.txt").click();
  await waitForGate(delayedUncachedFile.arrival, "uncached source file");
  await page
    .getByText("Opening the current file for your question…", { exact: true })
    .waitFor();
  assert.equal(await askButton().isDisabled(), true);
  await page.locator(".coding-composer select").first().selectOption("none");
  assert.equal(
    await askButton().isDisabled(),
    false,
    "questions without a file remain available during a file read",
  );
  await page.locator(".coding-composer select").first().selectOption("file");
  assert.equal(await askButton().isDisabled(), true);
  assert.equal(messagePosts().length, beforeUncachedFileMessages);
  delayedUncachedFile.resume();
  await waitForGate(
    delayedUncachedFile.completion,
    "released uncached source file",
  );
  await assertEditor("one.txt\n", "one.txt");
  assert.equal(await askButton().isDisabled(), false);
  await ask("Explain this newly opened file.");
  assert.ok(messagePosts().at(-1).body.prompt.includes("one.txt"));
  assert.equal(
    messagePosts().at(-1).body.prompt.includes(beforeResume),
    false,
    "the former editor's draft must not be attached to the new file request",
  );
  await page.locator(".coding-composer select").first().selectOption("none");

  // A response arriving after the next question is typed must preserve that draft.
  const delayedSend = gate({ id: pastId });
  heldMessage = delayedSend;
  const beforePendingSend = messagePosts().length;
  await question().fill("Explain the first question.");
  await askButton().click();
  await waitForGate(delayedSend.arrival, "pending message response");
  await question().fill(
    "Keep my next question while the first response arrives.",
  );
  assert.equal(messagePosts().length, beforePendingSend + 1);
  assert.ok(
    messagePosts().at(-1).body.prompt.includes("Explain the first question."),
  );
  delayedSend.resume();
  await waitForGate(delayedSend.completion, "released message response");
  await askButton().waitFor();
  await settle();
  assert.equal(
    await question().inputValue(),
    "Keep my next question while the first response arrives.",
  );
  assert.equal(messagePosts().length, beforePendingSend + 1);
  assert.match(
    await page.locator(".coding-turn").last().innerText(),
    /Explain the first question/,
  );
  await question().fill("");

  // Download/copy only: never launch an IDE or execute a generated command.
  // Shared briefs and exact context previews are opt-in and bind to the sent request.
  const projectBrief = page.getByRole("region", {
    name: "Project brief",
    exact: true,
  });
  await projectBrief
    .getByRole("checkbox", { name: "Include project brief", exact: true })
    .check();
  await openDetails(".project-brief > details");
  await question().fill("Use the shared project constraints.");
  await projectBrief
    .getByRole("textbox", { name: "Shared project notes", exact: true })
    .fill("Keep examples small and label all assumptions.");
  assert.equal(
    await askButton().isDisabled(),
    true,
    "an included unsaved brief blocks sending",
  );
  await openDetails(".coding-composer .context-inspector");
  assert.equal(
    await page
      .getByRole("button", { name: "Preview context", exact: true })
      .isDisabled(),
    true,
  );
  await projectBrief
    .getByRole("button", { name: "Save project brief", exact: true })
    .click();
  await projectBrief
    .getByText("Project brief saved · revision 2.", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Preview context", exact: true })
    .click();
  await page
    .getByText("Preview ready · verified again when sent", { exact: true })
    .waitFor();
  const previewRequest = requests
    .filter((item) => item.path.endsWith("/context"))
    .at(-1);
  assert.equal(previewRequest.body.project_brief_revision, 2);
  assert.equal(
    previewRequest.body.coding_instructions,
    "Persisted project A coding instructions.",
  );
  const expectedFingerprint = prepared(
    projects[0].id,
    previewRequest.body,
    chats.get(pastId),
  ).fingerprint;
  await askButton().click();
  await page.waitForFunction(
    () => document.querySelector(".coding-composer textarea").value === "",
  );
  const previewedSend = messagePosts().at(-1).body;
  assert.equal(previewedSend.context_fingerprint, expectedFingerprint);
  const {
    client_id: previewNonce,
    context_fingerprint: previewHash,
    ...sentContext
  } = previewedSend;
  assert.deepEqual(
    sentContext,
    previewRequest.body,
    "preview and send must use the exact same context construction",
  );
  const savedContext = page
    .locator(".coding-turn")
    .last()
    .locator(".context-inspector");
  await savedContext.locator("summary").first().click();
  assert.match(
    await savedContext.innerText(),
    /Project brief included · revision 2/,
  );
  assert.equal(
    await savedContext.getByRole("button", { name: /Preview/ }).count(),
    0,
  );
  await question().fill("Preview to invalidate before sending.");
  await openDetails(".coding-composer .context-inspector");
  const previewGate = gate();
  heldPreview = previewGate;
  await page
    .getByRole("button", { name: "Preview context", exact: true })
    .click();
  await waitForGate(previewGate.arrival, "held context preview");
  assert.equal(await askButton().isDisabled(), true);
  await question().fill("This later question must invalidate the old preview.");
  previewGate.resume();
  await waitForGate(previewGate.completion, "obsolete context preview");
  await settle();
  assert.equal(
    await page
      .getByText("Preview ready · verified again when sent", { exact: true })
      .count(),
    0,
  );
  await askButton().click();
  await page.waitForFunction(
    () => document.querySelector(".coding-composer textarea").value === "",
  );
  assert.equal(messagePosts().at(-1).body.context_fingerprint, null);
  await question().fill("Fresh preview detects external brief edits.");
  await openDetails(".coding-composer .context-inspector");
  await page
    .getByRole("button", { name: "Preview context", exact: true })
    .click();
  await page
    .getByText("Preview ready · verified again when sent", { exact: true })
    .waitFor();
  const turnsBeforeConflict = chats.get(pastId).turns.length;
  briefs.set(projects[0].id, {
    revision: 3,
    content: "Changed in another workspace.",
  });
  await askButton().click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Request context changed" })
    .waitFor();
  assert.equal(chats.get(pastId).turns.length, turnsBeforeConflict);
  assert.equal(
    await question().inputValue(),
    "Fresh preview detects external brief edits.",
  );
  await projectBrief
    .getByRole("button", { name: "Reload saved brief", exact: true })
    .click();
  await projectBrief
    .getByRole("button", { name: "Use saved revision 3", exact: true })
    .click();
  await projectBrief
    .getByRole("checkbox", { name: "Include project brief", exact: true })
    .uncheck();
  await question().fill("");

  await page
    .getByRole("button", { name: "Connect VS Code", exact: true })
    .click();
  const connection = page.getByRole("region", { name: "Connect VS Code" });
  const root = disks.get(projects[0].id).root;
  assert.deepEqual(await downloadWorkspace(), {
    folders: [{ path: root }],
    settings: {},
  });
  const link = await connection
    .getByRole("link", { name: "Open in VS Code" })
    .getAttribute("href");
  assert.ok(link.startsWith("vscode://file/"));
  assert.ok(link.includes("%20") && link.includes("%23"));
  await connection
    .getByRole("button", { name: "Copy folder path", exact: true })
    .click();
  assert.equal(await page.evaluate(() => window.fixtureCopies.at(-1)), root);
  await connection
    .getByText("Connect from a terminal", { exact: true })
    .click();
  assert.ok(
    (await connection.locator("pre").innerText()).includes("owner'\\''s"),
  );
  await connection.locator("select").selectOption("powershell");
  assert.ok((await connection.locator("pre").innerText()).includes("owner''s"));
  await connection.getByRole("button", { name: /On another computer/ }).click();
  await connection
    .getByLabel("SSH host alias or user@hostname", { exact: true })
    .fill("studio-lab");
  const remote = await downloadWorkspace();
  assert.equal(remote.folders[0].uri.split("/")[2], "ssh-remote+studio-lab");
  assert.equal(
    decodeURIComponent(new URL(remote.folders[0].uri).pathname),
    root,
  );
  assert.equal(
    await connection.getByRole("link", { name: "Open in VS Code" }).count(),
    0,
  );
  await connection
    .getByLabel("SSH host alias or user@hostname", { exact: true })
    .fill("studio; touch /tmp/should-not-run");
  await connection.getByRole("alert").waitFor();
  assert.equal(
    await connection
      .getByRole("button", { name: "Download VS Code workspace" })
      .count(),
    0,
  );
  await connection
    .getByLabel("SSH host alias or user@hostname", { exact: true })
    .fill("studio-lab");
  await connection
    .getByText("Connect from a terminal", { exact: true })
    .click();
  await page.evaluate(() => {
    window.fixtureCopyThrows = true;
  });
  const textareas = await page.locator("textarea").count();
  await connection
    .getByRole("button", { name: "Copy command", exact: true })
    .click();
  await connection
    .getByText("Clipboard blocked by browser.", { exact: true })
    .waitFor();
  assert.equal(
    await page.locator("textarea").count(),
    textareas,
    "clipboard failures remove their temporary field",
  );
  await connection
    .getByRole("button", { name: "Connect an agent", exact: true })
    .click();
  assert.equal(await page.locator("#handoff").innerText(), "MCP requested");
  await connection
    .getByRole("button", { name: "Close VS Code setup", exact: true })
    .click();
  // Incoming results are scoped, unsaved drafts and never implicit writes or AI requests.
  const beforeIntents = {
    writes: writes.length,
    messages: messagePosts().length,
    chats: chatPosts().length,
  };
  await page.evaluate(
    (project) =>
      window.fixtureIntent({
        id: "result-draft",
        project,
        kind: "draft",
        path: "reviewed-result.py",
        content: "print('handoff draft')\n",
        language: "python",
        source: "Chat answer",
      }),
    projects[0].id,
  );
  await assertEditor("print('handoff draft')\n", "reviewed-result.py");
  assert.equal(
    disks.get(projects[0].id).files.has("reviewed-result.py"),
    false,
  );
  await page.evaluate(
    (project) =>
      window.fixtureIntent({
        id: "duplicate-result-draft",
        project,
        kind: "draft",
        path: "reviewed-result.py",
        content: "OVERWRITE_NOT_ALLOWED",
        source: "Another answer",
      }),
    projects[0].id,
  );
  await page
    .getByRole("alert")
    .filter({ hasText: "already uses the result's name" })
    .waitFor();
  await assertEditor("print('handoff draft')\n", "reviewed-result.py");
  await page.evaluate(
    (project) =>
      window.fixtureIntent({
        id: "foreign-result-draft",
        project,
        kind: "draft",
        path: "foreign.py",
        content: "FOREIGN_DRAFT",
        source: "Other project",
      }),
    projects[1].id,
  );
  await settle();
  assert.equal(await page.getByRole("tab", { name: /foreign.py/ }).count(), 0);
  const focusFile = setFile(
    projects[0].id,
    "focus.py",
    "first\r\nwanted line\r\nlast\r\n",
  );
  await page.evaluate(
    ({ project, version }) =>
      window.fixtureIntent({
        id: "search-open",
        project,
        kind: "open",
        path: "focus.py",
        version,
        line: 2,
      }),
    { project: projects[0].id, version: focusFile.version },
  );
  await assertEditor("first\nwanted line\nlast\n", "focus.py");
  await page.waitForFunction(() => {
    const field = document.querySelector(
      'textarea[aria-label="Edit focus.py"]',
    );
    return (
      field?.value.slice(field.selectionStart, field.selectionEnd) ===
      "wanted line"
    );
  });
  await editor("focus.py").fill("Keep this unsaved source\n");
  await page.evaluate(
    ({ project, version }) =>
      window.fixtureIntent({
        id: "dirty-search-open",
        project,
        kind: "open",
        path: "focus.py",
        version,
        line: 3,
      }),
    { project: projects[0].id, version: focusFile.version },
  );
  await page
    .getByText(
      "Search found the saved file. Your unsaved draft is kept; save or refresh before jumping to its saved lines.",
      { exact: true },
    )
    .waitFor();
  await assertEditor("Keep this unsaved source\n", "focus.py");
  // Open another clean file with an outdated search revision; it may display the file but cannot jump as though the snapshot matched.
  const staleFile = setFile(projects[0].id, "stale-focus.py", "old\ntarget\n");
  setFile(projects[0].id, "stale-focus.py", "updated\nnew target\n");
  await page.evaluate(
    ({ project, version }) =>
      window.fixtureIntent({
        id: "stale-search-open",
        project,
        kind: "open",
        path: "stale-focus.py",
        version,
        line: 2,
      }),
    { project: projects[0].id, version: staleFile.version },
  );
  await assertEditor("updated\nnew target\n", "stale-focus.py");
  assert.equal(
    await editor("stale-focus.py").evaluate(
      (field) => field.selectionStart === field.selectionEnd,
    ),
    true,
  );
  await question().fill("Keep my question.");
  await page.evaluate(
    (project) =>
      window.fixtureIntent({
        id: "coding-incoming-task",
        project,
        kind: "task",
        text: "Explain the proposed change.",
        source: "Reviewed result",
      }),
    projects[0].id,
  );
  const incomingCode = page.getByRole("region", {
    name: "Incoming Coding task",
    exact: true,
  });
  await incomingCode.waitFor();
  assert.equal(await question().inputValue(), "Keep my question.");
  await page.evaluate(
    (project) =>
      window.fixtureIntent({
        id: "second-coding-incoming-task",
        project,
        kind: "task",
        text: "A separate second Coding task.",
        source: "Second reviewed result",
      }),
    projects[0].id,
  );
  await incomingCode
    .getByText("2 incoming tasks waiting for review.", { exact: true })
    .waitFor();
  assert.equal(
    await incomingCode.locator("pre").textContent(),
    "Explain the proposed change.",
  );
  await page.evaluate(() => window.fixtureProject(1));
  await editor().waitFor();
  assert.equal(await incomingCode.count(), 0);
  await page.evaluate(() => window.fixtureProject(0));
  await incomingCode.waitFor();
  assert.equal(await question().inputValue(), "Keep my question.");
  await page.reload();
  await incomingCode.waitFor();
  assert.equal(await question().inputValue(), "Keep my question.");
  assert.equal(
    await incomingCode.locator("pre").textContent(),
    "Explain the proposed change.",
    "pending tasks survive a page reload without changing the question",
  );
  await incomingCode
    .getByRole("button", { name: "Add to my question", exact: true })
    .click();
  assert.equal(
    await question().inputValue(),
    "Keep my question.\n\nExplain the proposed change.",
  );
  await incomingCode
    .getByText("Second reviewed result", { exact: true })
    .waitFor();
  assert.equal(
    await incomingCode.locator("pre").textContent(),
    "A separate second Coding task.",
  );
  await incomingCode
    .getByRole("button", { name: "Keep my question", exact: true })
    .click();
  assert.equal(await incomingCode.count(), 0);
  await page.evaluate(
    (project) =>
      window.fixtureIntent({
        id: "coding-long-task",
        project,
        kind: "task",
        text: "x".repeat(1200),
        source: "Long result",
      }),
    projects[0].id,
  );
  await incomingCode.waitFor();
  await incomingCode
    .getByRole("button", { name: "Add to my question", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "combined draft is longer than 1,200" })
    .waitFor();
  assert.equal(
    await question().inputValue(),
    "Keep my question.\n\nExplain the proposed change.",
  );
  await incomingCode
    .getByRole("button", { name: "Keep my question", exact: true })
    .click();
  assert.deepEqual(
    {
      writes: writes.length,
      messages: messagePosts().length,
      chats: chatPosts().length,
    },
    beforeIntents,
  );
  await page.evaluate(() => {
    window.fixtureProject(2);
    window.fixtureIntent({
      id: "empty-workspace-task",
      project: "c".repeat(32),
      kind: "task",
      text: "Start with a small Python example.",
      source: "Recipe",
    });
  });
  await page.waitForFunction(() =>
    window.fixtureConsumed.includes("empty-workspace-task"),
  );
  assert.equal(
    disks.get(projects[2].id).exists,
    false,
    "incoming task does not create files or start a runtime",
  );
  await question().waitFor();
  assert.equal(
    await question().inputValue(),
    "Start with a small Python example.",
  );
  assert.equal(messagePosts().length, beforeIntents.messages);
  assert.equal(chatPosts().length, beforeIntents.chats);
  assert.equal(writes.length, beforeIntents.writes);
  assert.equal(
    await page.locator(".coding-composer select").first().inputValue(),
    "none",
  );
  await page.evaluate(() => window.fixtureProject(0));
  await editor("stale-focus.py").waitFor();
  if (process.env.STUDIO_CODING_SCREENSHOT_DIR) {
    await mkdir(process.env.STUDIO_CODING_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: `${process.env.STUDIO_CODING_SCREENSHOT_DIR}/coding-desktop.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  if (process.env.STUDIO_CODING_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.STUDIO_CODING_SCREENSHOT_DIR}/coding-mobile.png`,
      fullPage: true,
    });
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  console.log(
    "Coding browser checks passed: managed saved-content search/CRLF jumps/stale results, line diffs and draft review, opt-in shared brief/context preview/fingerprint rejection, project drafts/reload/save, external conflicts, stale reads, paused AI, exact selected context, reviewed/stale proposals, restored chats, retry identity, scoped/conflicted AI setup, model readiness, supporting snapshots/budgets, history resume, safe VS Code configs, clipboard cleanup and mobile layout; no execution.",
  );
} finally {
  for (const item of gates) item.resume();
  await browser.close();
}
