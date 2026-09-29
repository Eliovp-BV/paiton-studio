import test from "node:test";
import assert from "node:assert/strict";
import { lineDiff, diffContext } from "../web/codeDiff.js";

function reconstruct(result, side) {
  return result.rows
    .filter((row) => row.kind !== (side === "before" ? "insert" : "delete"))
    .map((row) => row.text)
    .join("");
}
test("line diff aligns unchanged source, numbers insertions/deletions, and preserves exact bytes", () => {
  const before = "head\nold\nkeep\ntail\n",
    after = "head\nnew\nkeep\nextra\ntail\n";
  const diff = lineDiff(before, after);
  assert.deepEqual(
    diff.rows.map((row) => [row.kind, row.oldLine, row.newLine]),
    [
      ["equal", 1, 1],
      ["delete", 2, null],
      ["insert", null, 2],
      ["equal", 3, 3],
      ["insert", null, 4],
      ["equal", 4, 5],
    ],
  );
  assert.equal(reconstruct(diff, "before"), before);
  assert.equal(reconstruct(diff, "after"), after);
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 1);
});
test("empty files, trailing newline and CRLF changes remain visible", () => {
  for (const [before, after] of [
    ["", "new\n"],
    ["old\n", ""],
    ["x", "x\n"],
    ["a\r\n", "a\n"],
    ["😀\n", "😀\nnext"],
    ["", ""],
    ["same", "same"],
  ]) {
    const diff = lineDiff(before, after);
    assert.equal(reconstruct(diff, "before"), before);
    assert.equal(reconstruct(diff, "after"), after);
    assert.equal(diff.added + diff.removed === 0, before === after);
  }
});
test("large changes use a bounded replacement while keeping common prefix and suffix exact", () => {
  const before = "head\n" + "old\n".repeat(2000) + "tail\n",
    after = "head\n" + "new\n".repeat(2000) + "tail\n";
  const diff = lineDiff(before, after);
  assert.equal(diff.simplified, true);
  assert.equal(diff.added, 2000);
  assert.equal(diff.removed, 2000);
  assert.equal(diff.rows[0].kind, "equal");
  assert.equal(diff.rows.at(-1).kind, "equal");
  assert.equal(reconstruct(diff, "before"), before);
  assert.equal(reconstruct(diff, "after"), after);
});
test("collapsed context preserves changed lines and accurately counts omitted lines", () => {
  const before = "prefix\n".repeat(20) + "old\n" + "suffix\n".repeat(20),
    after = before.replace("old\n", "new\n");
  const diff = lineDiff(before, after),
    display = diffContext(diff.rows);
  assert.deepEqual(
    display.filter((row) => row.kind === "skip").map((row) => row.count),
    [17, 17],
  );
  assert.equal(display.filter((row) => row.kind === "equal").length, 6);
  assert.equal(
    display.filter((row) => row.kind === "insert" || row.kind === "delete")
      .length,
    2,
  );
});
