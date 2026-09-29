import test from "node:test";
import assert from "node:assert/strict";
import { STATE_LABELS, stateLabel } from "../web/jobStates.js";

test("queue states map to plain words and unknown states pass through", () => {
  assert.equal(stateLabel("queued"), "Waiting");
  assert.equal(stateLabel("preparing"), "Preparing");
  assert.equal(stateLabel("generating"), "Working");
  assert.equal(stateLabel("cancelling"), "Stopping");
  assert.equal(stateLabel("completed"), "Done");
  assert.equal(stateLabel("failed"), "Failed");
  assert.equal(stateLabel("cancelled"), "Stopped");
  assert.equal(stateLabel("future_state"), "future_state");
  for (const state of [
    "queued",
    "preparing",
    "loading",
    "warming",
    "generating",
    "processing",
    "saving",
    "cancelling",
  ])
    assert.ok(STATE_LABELS[state], `${state} needs a label`);
});

test("workspace overrides keep their own wording for a few states", () => {
  const agent = { completed: "Ready to review", failed: "Needs attention" };
  assert.equal(stateLabel("completed", agent), "Ready to review");
  assert.equal(stateLabel("failed", agent), "Needs attention");
  assert.equal(stateLabel("cancelling", agent), "Stopping");
});
