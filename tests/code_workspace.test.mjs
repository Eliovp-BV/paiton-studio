import test from "node:test";
import assert from "node:assert/strict";
import {
  codeBlocks,
  codingPrompt,
  reviewedReplacement,
  ideConfiguration,
  sourceTextOffset,
  editorTextOffset,
} from "../web/codeWorkspace.js";

test("browser selections map to exact stored CRLF source without splitting Unicode", () => {
  const source = "😀 heading\r\nconst target = 1;\r\ntail\r\n";
  const editor = source.replace(/\r\n/g, "\n"),
    start = editor.indexOf("const"),
    end = editor.indexOf("tail");
  const from = sourceTextOffset(source, start),
    to = sourceTextOffset(source, end);
  assert.equal(source.slice(from, to), "const target = 1;\r\n");
  assert.equal(editorTextOffset(source, from), start);
  assert.equal(editorTextOffset(source, to), end);
  assert.equal(
    reviewedReplacement(
      { content: source, version: "v", start: from, end: to },
      "new\r\n",
      { content: source, version: "v" },
    ),
    "😀 heading\r\nnew\r\ntail\r\n",
  );
});

test("review applies only to the exact file draft, version and selection used in the request", () => {
  const snapshot = {
    path: "main.py",
    content: "first\nold\nlast\n",
    version: "v1",
    start: 6,
    end: 10,
  };
  assert.equal(
    reviewedReplacement(snapshot, "new\n", {
      content: snapshot.content,
      version: "v1",
    }),
    "first\nnew\nlast\n",
  );
  assert.throws(
    () =>
      reviewedReplacement(snapshot, "new", {
        content: "edited",
        version: "v1",
      }),
    /changed/,
  );
  assert.throws(
    () =>
      reviewedReplacement(snapshot, "new", {
        content: snapshot.content,
        version: "v2",
      }),
    /changed/,
  );
  assert.throws(() => reviewedReplacement(null, "new", null), /changed/);
});

test("coding context includes the selected bytes and refuses hidden truncation", () => {
  const snapshot = {
    path: "src/app.js",
    content: "SECRET outside\nfunction add(a,b) { return a+b; }\nother outside",
    start: 15,
    end: 48,
  };
  const prompt = codingPrompt("Explain this", snapshot);
  assert.ok(prompt.includes("Only the selected part"));
  assert.ok(!prompt.includes("SECRET"));
  assert.ok(!prompt.includes("other outside"));
  assert.ok(
    prompt.includes(snapshot.content.slice(snapshot.start, snapshot.end)),
  );
  assert.throws(
    () =>
      codingPrompt("Explain", {
        path: "big.py",
        content: "x".repeat(6001),
        start: 0,
        end: 6001,
      }),
    /6,000/,
  );
  assert.ok(!codingPrompt("hello", null).includes("Source begins:"));
});

test("fenced suggestions stay data and keep their indentation", () => {
  assert.deepEqual(
    codeBlocks("Try this:\n```python\n  return value\n```\nDone."),
    [
      { text: "Try this:\n" },
      { code: "  return value\n", language: "python" },
      { text: "\nDone." },
    ],
  );
  assert.deepEqual(codeBlocks("<script>alert(1)</script>"), [
    { text: "<script>alert(1)</script>" },
  ]);
});

test("VS Code settings distinguish local paths from remote authorities and escape terminal arguments", () => {
  const local = ideConfiguration("/home/Ada's project/code", "local", "");
  assert.equal(local.url, "vscode://file/home/Ada's%20project/code/");
  assert.equal(local.command, "code '/home/Ada'\\''s project/code'");
  assert.deepEqual(local.workspace.folders, [
    { path: "/home/Ada's project/code" },
  ]);
  const remote = ideConfiguration(
    "/home/test/project #1/code",
    "remote",
    "test@studio",
  );
  assert.equal(
    remote.workspace.folders[0].uri,
    "vscode-remote://ssh-remote+test%40studio/home/test/project%20%231/code",
  );
  assert.equal(
    remote.command,
    "code --folder-uri 'vscode-remote://ssh-remote+test%40studio/home/test/project%20%231/code'",
  );
  assert.equal(
    ideConfiguration("C:\\Ada's files\\code", "local", "", "powershell")
      .command,
    "code 'C:\\Ada''s files\\code'",
  );
  for (const host of [
    "-bad",
    "a;touch file",
    "$(command)",
    "host:2222",
    "a\nnext",
    "",
  ])
    assert.throws(() => ideConfiguration("/code", "remote", host), /SSH host/);
  assert.throws(
    () => ideConfiguration("/path\ncommand", "local", ""),
    /workspace/,
  );
});
