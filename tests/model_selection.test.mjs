import test from "node:test";
import assert from "node:assert/strict";
import {
  modelReadiness,
  weightsLabel,
  technicalModel,
  kvCacheLabel,
  selectedProfile,
  taskProfiles,
} from "../web/modelSelection.js";

const tools = [
  {
    id: "first",
    name: "First model",
    state: "ready",
    profiles: [
      { id: "first-code", task: "write", roles: ["code"], label: "Code" },
    ],
  },
  {
    id: "recommended",
    model: "Recommended model",
    default_for: ["code"],
    state: "ready",
    profiles: [
      { id: "recommended-code", task: "write", roles: ["code"], label: "Code" },
    ],
  },
  {
    id: "missing",
    name: "Missing model",
    state: "setup_required",
    profiles: [
      {
        id: "missing-code",
        task: "write",
        roles: ["code"],
        message: "Model files are missing.",
        compatibility: { compatible: true, reason: "Supported hardware" },
      },
    ],
  },
  {
    id: "incompatible",
    name: "Large model",
    state: "ready",
    profiles: [
      {
        id: "large-code",
        task: "write",
        roles: ["code"],
        compatibility: { compatible: false, reason: "Needs 64 GB" },
      },
    ],
  },
];

test("automatic routing respects Studio defaults and never substitutes a missing explicit choice", () => {
  assert.equal(selectedProfile(tools, "code").id, "recommended-code");
  assert.equal(
    selectedProfile(tools, "code", "auto", "first-code").id,
    "first-code",
  );
  assert.equal(
    modelReadiness({ tools, task: "code", value: "unknown" }).canRun,
    false,
  );
  assert.equal(
    modelReadiness({ tools, task: "code", defaultId: "missing-code" }).reason,
    "Model files are missing.",
  );
  assert.equal(
    modelReadiness({ tools, task: "code", value: "large-code" }).canRun,
    false,
  );
  assert.equal(modelReadiness({ tools, task: "chat" }).ready, false);
});

test("installed availability is distinct from permission to execute while paused", () => {
  const paused = modelReadiness({
    tools,
    task: "code",
    worker: { state: "stopped" },
  });
  assert.equal(paused.label, "Recommended model");
  assert.equal(paused.ready, true);
  assert.equal(paused.canRun, false);
  assert.equal(
    modelReadiness({ tools, task: "code", worker: { state: "running" } })
      .canRun,
    true,
  );
});

test("image editing has a separate role and uncensored checkpoints require an explicit choice", () => {
  const imageTools = [
    {
      id: "uncensored",
      state: "ready",
      requires_explicit_selection: true,
      profiles: [
        { id: "uncensored-edit", task: "image", roles: ["image_edit"] },
        { id: "uncensored-create", task: "image", roles: ["image"] },
      ],
    },
    {
      id: "original",
      state: "ready",
      default_for: ["image", "image_edit"],
      profiles: [
        { id: "original-create", task: "image", roles: ["image"] },
        { id: "original-edit", task: "image", roles: ["image_edit"] },
        {
          id: "explicit-extra",
          task: "image",
          roles: ["image_edit"],
          requires_explicit_selection: true,
        },
      ],
    },
  ];
  assert.deepEqual(
    taskProfiles(imageTools, "image_edit").map((profile) => profile.id),
    ["uncensored-edit", "original-edit", "explicit-extra"],
  );
  assert.equal(selectedProfile(imageTools, "image").id, "original-create");
  assert.equal(selectedProfile(imageTools, "image_edit").id, "original-edit");
  assert.equal(
    selectedProfile(imageTools, "image_edit", "uncensored-edit").id,
    "uncensored-edit",
  );
  assert.equal(
    selectedProfile(imageTools, "image_edit", "auto", "uncensored-edit").id,
    "uncensored-edit",
  );
  assert.equal(
    selectedProfile(imageTools.slice(0, 1), "image_edit"),
    undefined,
  );
  assert.equal(
    selectedProfile(imageTools, "image", "original-edit"),
    undefined,
  );
});

test("the readiness label leads with the package name and keeps the technical string separate", () => {
  const named = [
    {
      id: "friendly",
      name: "Fast writing & chat",
      model: "Model 27B MXFP4 + Draft · Vendor",
      state: "ready",
      profiles: [
        { id: "friendly-code", task: "write", roles: ["code"], label: "Code" },
      ],
    },
  ];
  const status = modelReadiness({ tools: named, task: "code" });
  assert.equal(status.label, "Fast writing & chat");
  assert.equal(status.technical, "Model 27B MXFP4 + Draft · Vendor");
  assert.equal(
    modelReadiness({ tools, task: "code", value: "first-code" }).technical,
    "",
  );
});

test("Qwen technical names use the saved precision and old missing precision stays MXFP4", () => {
  const pkg = { id: "qwen38-mxfp4", model: "Qwen3.8 27B MXFP4 + DFlash2" };
  assert.equal(weightsLabel(), "MXFP4");
  assert.equal(weightsLabel({ weights: "w3a4" }), "W3A4 3-bit");
  assert.equal(technicalModel(pkg), "Qwen3.8 27B MXFP4 + DFlash2");
  assert.equal(
    technicalModel(
      { ...pkg, optional_components: [{ enabled_default: true }] },
      {},
    ),
    "Qwen3.8 27B MXFP4 + DFlash2",
  );
  assert.equal(
    technicalModel(pkg, { weights: "w3a4" }),
    "Qwen3.8 27B W3A4 3-bit + DFlash2",
  );
  assert.equal(
    technicalModel(
      { id: "different", model: "Other MXFP4" },
      { weights: "w3a4" },
    ),
    "Other MXFP4",
  );
});

test("picker readiness exposes precision separately without changing its outcome name", () => {
  const qwen = [
    {
      id: "qwen38-mxfp4",
      name: "Balanced chat",
      model: "Qwen3.8 MXFP4 + DFlash2",
      state: "ready",
      profiles: [{ id: "qwen", task: "write", roles: ["chat"] }],
    },
  ];
  const status = modelReadiness({
    tools: qwen,
    task: "chat",
    value: "qwen",
    conversation: { weights: "w3a4" },
  });
  assert.equal(status.label, "Balanced chat");
  assert.equal(status.technical, "Qwen3.8 W3A4 3-bit + DFlash2");
  assert.equal(status.canRun, true);
});

test("Qwen readiness follows the saved context release when only legacy 200K is installed", () => {
  const packageInfo = {
    id: "qwen38-mxfp4",
    name: "Balanced chat",
    model: "Qwen3.8 MXFP4 + DFlash2",
    state: "setup_required",
    compatibility: { compatible: true },
    profiles: [{ id: "qwen", task: "write", roles: ["chat", "code"] }],
    release_states: {
      "64k": { state: "setup_required", message: "Install the new target." },
      "200k": { state: "ready", message: "Legacy target ready." },
    },
  };
  const common = { tools: [packageInfo], task: "chat", value: "qwen" };
  assert.equal(modelReadiness(common).canRun, false);
  const legacy = modelReadiness({
    ...common,
    conversation: { context_mode: "extra_long", weights: "mxfp4" },
  });
  assert.equal(legacy.canRun, true);
  assert.equal(legacy.selected.state, "ready");
  assert.equal(
    selectedProfile([packageInfo], "code", "qwen", "auto", {
      context_mode: "extra_long",
    }).state,
    "ready",
  );
  packageInfo.state = "ready";
  packageInfo.release_states = {
    "64k": { state: "ready" },
    "200k": { state: "setup_required", message: "Legacy target required." },
  };
  assert.equal(modelReadiness(common).canRun, true);
  const missingLegacy = modelReadiness({
    ...common,
    conversation: { context_mode: "extra_long" },
  });
  assert.equal(missingLegacy.canRun, false);
  assert.equal(missingLegacy.reason, "Legacy target required.");
});

test("KV precision comes only from recorded execution details, never the weight choice", () => {
  assert.equal(kvCacheLabel(), null);
  assert.equal(kvCacheLabel({ weights: "w3a4" }), null);
  assert.equal(kvCacheLabel({ weights: "w3a4", kv_cache_mode: "fp8" }), "FP8");
  assert.equal(
    kvCacheLabel({ weights: "w3a4", kv_cache_mode: "kv4" }),
    "KV4 (4-bit)",
  );
  assert.equal(kvCacheLabel({ weights: "mxfp4", kv_cache_mode: "fp8" }), "FP8");
  assert.equal(kvCacheLabel({ kv_cache_mode: "unrecognized" }), null);
});
