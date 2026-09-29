import test from "node:test";
import assert from "node:assert/strict";
import {
  READINESS_LABELS,
  UNQUALIFIED_READY_LABEL,
  readinessLabel,
} from "../web/readinessLabels.js";

test("ready tools with pending qualification say so instead of Ready to create", () => {
  assert.equal(
    readinessLabel({ state: "ready", qualified: false }),
    UNQUALIFIED_READY_LABEL,
  );
  assert.equal(
    UNQUALIFIED_READY_LABEL,
    "Ready · not yet qualified (testing pending)",
  );
  assert.equal(
    readinessLabel({ state: "ready", qualified: true }),
    "Ready to create",
  );
  assert.equal(readinessLabel({ state: "ready" }), "Ready to create");
});

test("other states keep their labels regardless of qualification", () => {
  assert.equal(
    readinessLabel({ state: "setup_required", qualified: false }),
    "Needs setup",
  );
  assert.equal(
    readinessLabel({ state: "incompatible", qualified: false }),
    "Not qualified here",
  );
  assert.equal(readinessLabel({ state: "future" }), "future");
  assert.equal(readinessLabel(null), "");
  assert.equal(Object.keys(READINESS_LABELS).length, 5);
});
