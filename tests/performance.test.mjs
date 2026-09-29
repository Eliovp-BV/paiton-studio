import assert from "node:assert/strict";
import test from "node:test";
import {
  performanceLabels,
  imageTimeLabel,
  estimateLabel,
} from "../web/performance.js";

test("reply footer reports measured data with its timing scope", () => {
  const labels = performanceLabels({
    output_tokens: 512,
    tokens_per_second: 184.4,
    first_token_seconds: 0.426,
    model_state: "warm",
    rate_scope: "client_observed_stream",
  });
  assert.deepEqual(
    labels.map((item) => item.text),
    ["512 tokens", "184.4 tok/s", "TTFT 0.43 s", "Warm"],
  );
  assert.match(labels[1].title, /bursts/);
  assert.match(labels[2].title, /Excludes model loading/);
});
test("old, missing and invalid measurements do not invent results", () => {
  for (const value of [
    null,
    {},
    {
      output_tokens: -1,
      tokens_per_second: Infinity,
      first_token_seconds: NaN,
      model_state: "unknown",
    },
  ])
    assert.deepEqual(performanceLabels(value), []);
  assert.deepEqual(performanceLabels({ tokens_per_second: 12 }), []);
  assert.equal(
    performanceLabels({ first_token_seconds: 0 })[0].text,
    "TTFT 0 s",
  );
});
test("image time uses one completed generated image and excludes imports", () => {
  const asset = {
    kind: "image",
    metadata: { generation_seconds: 105.27, request: { task: "image" } },
  };
  assert.equal(imageTimeLabel(asset), "105.3 s/image");
  assert.equal(
    imageTimeLabel({ kind: "image", metadata: { generation_seconds: 100 } }),
    null,
  );
  assert.equal(imageTimeLabel({ ...asset, kind: "video" }), null);
});
test("queue estimate names its historical median and excludes unknown wait", () => {
  assert.equal(
    estimateLabel({
      seconds: 100.5,
      samples: 4,
      scope: "same_contract_median",
    }),
    "Estimated run ~100.5 s once started · median of 4",
  );
  for (const estimate of [
    null,
    {},
    { seconds: -1, samples: 2, scope: "same_contract_median" },
    { seconds: 3, samples: 0, scope: "same_contract_median" },
  ])
    assert.equal(estimateLabel(estimate), null);
});
