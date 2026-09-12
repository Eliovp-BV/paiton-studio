import test from "node:test";
import assert from "node:assert/strict";
import {
  completedDesign,
  formatElapsed,
  stageForJob,
  syncServerClock,
  studioNow,
  normalizeDesignRecords,
  mergeDesignRecords,
} from "../web/creationFeedback.js";

test("loading has an honest indeterminate stage, and malformed progress is never a percentage", () => {
  assert.match(stageForJob({ state: "loading" }).title, /Loading model/);
  assert.equal(stageForJob({ state: "loading" }).indeterminate, true);
  for (const progress of [
    { value: 5, maximum: 0 },
    { value: -1, maximum: 5 },
    { value: 9, maximum: 5 },
    { value: NaN, maximum: 5 },
  ])
    assert.equal(
      stageForJob({ state: "generating", progress }).measured,
      false,
    );
  assert.equal(
    stageForJob({ state: "generating", progress: { value: 3, maximum: 8 } })
      .measured,
    true,
  );
  assert.match(
    stageForJob({
      state: "generating",
      request: { task: "write", website_run: "a" },
    }).title,
    /Writing your website/,
  );
});
test("warm reuse needs runtime confirmation; caching never implies measured progress", () => {
  const reused = stageForJob({
    state: "loading",
    message: "Reusing the ready local chat model.",
  });
  assert.equal(reused.title, "Ready model reused");
  assert.match(reused.description, /without loading it again/);
  assert.equal(reused.indeterminate, true);
  assert.equal(reused.measured, false);
  assert.equal(
    stageForJob({
      state: "loading",
      message: "Reusing the ready local text model.",
    }).title,
    "Ready model reused",
  );
  const loading = stageForJob({
    state: "loading",
    message: "Loading the creation tool.",
    request: { task: "write", cached: true },
  });
  assert.match(loading.title, /Loading model/);
  assert.match(loading.description, /Switching back/);
  assert.match(loading.description, /files cached locally/);
  assert.equal(loading.indeterminate, true);
  assert.match(stageForJob({ state: "warming" }).description, /compilation/);
  assert.match(stageForJob({ state: "queued" }).description, /different model/);
  assert.equal(
    stageForJob({
      state: "failed",
      message: "Reusing the ready local chat model.",
    }).title,
    "Creation needs attention",
  );
});
test("only completed website results notify; duration uses server start/end, not the client clock or a later apply", () => {
  const run = {
    id: "a",
    project: "p",
    state: "planning",
    created: 10,
    updated: 143,
    jobs: ["one", "two"],
    job_details: [
      { id: "one", state: "completed" },
      { id: "two", state: "completed" },
    ],
    result: { title: "Site", pages: [{}, {}] },
  };
  for (const state of ["planning", "artwork", "failed", "cancelled", "applied"])
    assert.equal(completedDesign({ ...run, state }), null);
  const complete = completedDesign({ ...run, state: "completed" });
  assert.equal(complete.elapsed, 133);
  assert.equal(complete.pages, 2);
  assert.equal(complete.artwork, 1);
  assert.equal(formatElapsed(complete.elapsed), "2 min 13 sec");
  assert.equal(
    completedDesign({ ...run, state: "completed", updated: 9 }).elapsed,
    null,
  );
  assert.equal(formatElapsed(null), "Time unavailable");
  assert.equal(formatElapsed(Infinity), "Time unavailable");
  assert.ok(!("speedup" in complete));
  assert.ok(!("baseline_seconds" in complete));
});
test("individual output feedback keeps its scope and never reports a whole new design", () => {
  const run = {
    id: "a".repeat(32),
    project: "b".repeat(32),
    state: "completed",
    created: 10,
    updated: 130,
    jobs: ["one"],
    job_details: [{ id: "one", task: "image", state: "completed" }],
    request: {
      kind: "section-artwork",
      page_slug: "about",
      base_site: { pages: [{ slug: "about", title: "Our story" }] },
    },
    result: { title: "Whole site", pages: [{}, {}, {}] },
  };
  const image = completedDesign(run);
  assert.equal(image.kind, "section-artwork");
  assert.equal(image.title, "Our story");
  assert.equal(image.artwork, 1);
  assert.equal(image.elapsed, 120);
  assert.equal(
    normalizeDesignRecords({ [run.id]: image })[run.id].kind,
    "section-artwork",
  );
  const copy = completedDesign({
    ...run,
    request: { ...run.request, kind: "page-copy" },
    job_details: [{ id: "one", task: "write", state: "completed" }],
  });
  assert.equal(copy.kind, "page-copy");
  assert.equal(copy.artwork, 0);
  assert.equal(
    stageForJob({
      state: "generating",
      request: {
        task: "write",
        purpose: "website-page-copy",
        website_run: run.id,
      },
    }).title,
    "Rewriting this page",
  );
  assert.equal(
    normalizeDesignRecords({ [run.id]: { ...image, state: "discarded" } })[
      run.id
    ].state,
    "discarded",
  );
  assert.equal(
    normalizeDesignRecords({ [run.id]: { ...image, kind: {} } })[run.id].kind,
    "website",
  );
});
test("live elapsed timing follows the Studio host clock on another LAN system", () => {
  const before = Date.now();
  syncServerClock("Wed, 09 Sep 2026 12:00:00 GMT", before);
  assert.ok(
    Math.abs(studioNow() - Date.parse("Wed, 09 Sep 2026 12:00:00 GMT")) < 1000,
  );
  syncServerClock("not a date");
  assert.ok(Number.isFinite(studioNow()));
  syncServerClock(new Date().toUTCString());
});

test("stored feedback cannot render objects or lose a terminal acknowledgment to a stale watcher", () => {
  const id = "a".repeat(32),
    project = "b".repeat(32);
  const record = {
    project,
    state: "completed",
    pages: 2,
    title: "Site",
    created: 100,
    finished: 200,
    elapsed: 100,
  };
  assert.deepEqual(
    normalizeDesignRecords({ [id]: { ...record, pages: {} } }),
    {},
  );
  assert.equal(
    normalizeDesignRecords({
      [id]: { ...record, title: {}, elapsed: -1, id: "wrong" },
    })[id].title,
    "Your website",
  );
  assert.equal(normalizeDesignRecords({ [id]: record })[id].id, id);
  assert.equal(
    normalizeDesignRecords({ [id]: { ...record, elapsed: -1 } })[id].elapsed,
    null,
  );
  assert.deepEqual(
    normalizeDesignRecords({ [id]: { ...record, state: "invented" } }),
    {},
  );
  const seen = { [id]: { ...record, acknowledged: true } };
  const stale = { [id]: { project, state: "watching" } };
  assert.equal(mergeDesignRecords(seen, stale)[id].state, "completed");
  assert.equal(mergeDesignRecords(stale, seen)[id].acknowledged, true);
  assert.equal(
    mergeDesignRecords(seen, { [id]: record })[id].acknowledged,
    true,
  );
  const history = Object.fromEntries(
    Array.from({ length: 200 }, (_, n) => [
      n.toString(16).padStart(32, "0"),
      { ...record, created: n, acknowledged: true },
    ]),
  );
  const bounded = mergeDesignRecords(history, stale);
  assert.equal(Object.keys(bounded).length, 160);
  assert.equal(bounded[id].state, "watching");
});
