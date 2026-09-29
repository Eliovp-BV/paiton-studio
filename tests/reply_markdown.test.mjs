import assert from "node:assert/strict";
import {
  replyBlocks,
  replyInline,
  safeReplyUrl,
} from "../web/replyMarkdown.js";

const doc = replyBlocks(
  "# A **heading**\n\nA paragraph with *emphasis*, `code` and ~~old~~.\n\n- First item\n  - Nested item\n- Second item\n\n3. Third\n4. Fourth\n\n> A quote\n>\n> - Quoted item\n\n| Name | Value |\n| :--- | ---: |\n| safe | `a|b` |\n\n```js\nconst literal = '<script>alert(1)</script>';\n```\n",
);
assert.deepEqual(
  doc.map((node) => node.type),
  ["heading", "paragraph", "list", "list", "quote", "table", "code"],
);
assert.equal(doc[0].children[1].type, "strong");
assert.equal(doc[2].items[0][1].type, "list");
assert.equal(doc[3].start, 3);
assert.equal(doc[4].children[1].type, "list");
assert.equal(doc[5].rows[0][1][0].text, "a|b");
assert.equal(doc[5].align[1], "right");
assert.equal(doc[6].text, "const literal = '<script>alert(1)</script>';\n");
for (const value of [
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "data:text/html,test",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "//example.com",
  "/api/session",
  "https://user:password@example.com",
  "https://example.com\n/evil",
  " javaScript:alert(1)",
  "javascript&#58;alert(1)",
])
  assert.equal(safeReplyUrl(value), null, value);
assert.equal(
  safeReplyUrl("https://example.com/a?q=1&x=2"),
  "https://example.com/a?q=1&x=2",
);
assert.equal(
  safeReplyUrl("mailto:person@example.com"),
  "mailto:person@example.com",
);
assert.equal(replyInline("[bad](javascript:alert(1))")[0].href, null);
assert.equal(
  replyInline("[safe **label**](https://example.com/a_(b))")[0].href,
  "https://example.com/a_(b)",
);
assert.equal(replyInline("<https://example.com>")[0].type, "link");
assert.deepEqual(replyInline('<img src=x onerror="alert(1)">'), [
  { type: "text", text: '<img src=x onerror="alert(1)">' },
]);
assert.equal(
  replyInline("![image](https://example.com/tracking.png)")[0].type,
  "text",
);
assert.equal(
  replyBlocks("```python\nprint('streaming')")[0].text,
  "print('streaming')",
);
assert.equal(
  replyBlocks("~~~txt\n``` stays literal\n~~~")[0].text,
  "``` stays literal\n",
);
assert.equal(replyBlocks("Title\n=====\n")[0].level, 1);
assert.equal(
  replyBlocks("| A | B |\n| --- | --- |\n| escaped\\|pipe | safe |\n")[0]
    .rows[0][0][0].text,
  "escaped|pipe",
);
assert.equal(replyInline("file_name_test")[0].text, "file_name_test");
assert.equal(replyInline("\\*literal\\*")[0].text, "*literal*");
assert.equal(
  replyBlocks("plain\nsecond line")[0].children[0].text,
  "plain\nsecond line",
);
assert.doesNotThrow(() =>
  replyBlocks("> ".repeat(100) + "bounded nested quote"),
);
assert.doesNotThrow(() =>
  replyInline("[".repeat(5000) + "text" + "]".repeat(5000)),
);
console.log(
  "Reply Markdown unit checks passed: formatted blocks, safe links, escaped HTML, literal images, streaming fences and bounded nesting.",
);
