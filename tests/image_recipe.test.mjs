import test from "node:test";
import assert from "node:assert/strict";
import {
  IMAGE_STYLES,
  imageRecipe,
  imageRecipeDraft,
  imagePromptLimit,
  imageEditSourceIssue,
  imagePromotionProfile,
  imageSeedSequence,
  imageSequenceCount,
  imageStylePhrase,
  newImageSeed,
  styledImagePrompt,
} from "../web/imageRecipe.js";

const output = {
  kind: "image",
  project: "project-a",
  metadata: {
    request: {
      task: "image",
      prompt: "A quiet forest",
      seed: 0,
      source: { id: "another-project-source", path: "private/file" },
      runtime_ref: "ghcr.io/eliovp/paiton-vllm-plugin:candidate",
      runtime_image: "sha256:" + "a".repeat(64),
      profile: {
        id: "retired-profile",
        model: "Qualified image model",
        width: 1024,
        height: 1024,
        steps: 50,
      },
    },
  },
};

test("reuse retains explicit unavailable choice and zero seed, copying no source or runtime binding", () => {
  const before = structuredClone(output);
  assert.deepEqual(imageRecipeDraft(output), {
    prompt: "A quiet forest",
    profile: "retired-profile",
    seed: 0,
    style: null,
  });
  assert.deepEqual(imageRecipeDraft(output, 42), {
    prompt: "A quiet forest",
    profile: "retired-profile",
    seed: 42,
    style: null,
  });
  assert.deepEqual(output, before);
  assert.equal(
    imageRecipe(output).runtimeImage,
    output.metadata.request.runtime_image,
  );
});

test("imported, video and invalid recipes cannot masquerade as repeatable image requests", () => {
  assert.equal(imageRecipe({ kind: "image", metadata: {} }), null);
  assert.equal(imageRecipe({ ...output, kind: "video" }), null);
  for (const seed of [-1, Number.MAX_SAFE_INTEGER + 1, "771", null, NaN]) {
    assert.equal(
      imageRecipe({
        ...output,
        metadata: { request: { ...output.metadata.request, seed } },
      }),
      null,
    );
  }
  assert.equal(imageRecipeDraft(output, -1), null);
  assert.equal(imageRecipeDraft(output, Number.MAX_SAFE_INTEGER + 1), null);
  const older = structuredClone(output);
  delete older.metadata.request.runtime_image;
  delete older.metadata.request.runtime_ref;
  assert.equal(imageRecipe(older).runtimeImage, null);
  assert.equal(imageRecipe(older).runtimeRef, null);
});

test("variation seeds stay safe for JSON and always change even at integer boundaries", () => {
  const allBits = { getRandomValues: (words) => words.fill(0xffffffff) };
  const noBits = { getRandomValues: (words) => words.fill(0) };
  assert.equal(newImageSeed(771, allBits), Number.MAX_SAFE_INTEGER);
  assert.equal(newImageSeed(Number.MAX_SAFE_INTEGER, allBits), 0);
  assert.equal(newImageSeed(0, noBits), 1);
  assert.equal(newImageSeed("0", noBits), 1);
  assert.ok(Number.isSafeInteger(newImageSeed(771, null)));
});

test("prompt bounds follow effective profiles and retain the API-wide ceiling", () => {
  assert.equal(imagePromptLimit({ max_prompt_length: 512 }), 512);
  assert.equal(imagePromptLimit({ max_prompt_length: 6000 }), 2500);
  for (const value of [0, -1, 12.5, "512", NaN, undefined])
    assert.equal(imagePromptLimit({ max_prompt_length: value }), 2500);
  assert.equal(imagePromptLimit(undefined), 2500);
});

test("precision details describe verified result metadata without upgrading older assets", () => {
  assert.equal(imageRecipe(output).precision, null);
  for (const value of ["exact", "balanced", "fast", undefined]) {
    const asset = structuredClone(output);
    asset.metadata.precision_profile = value;
    assert.equal(
      imageRecipe(asset).precision,
      value === "exact" ? "Exact (BF16 activations)" : null,
    );
  }
});

test("edit reuse carries only a same-project original reference and preserves checkpoint details", () => {
  const edited = structuredClone(output);
  edited.metadata.request.profile.mode = "edit";
  edited.metadata.request.profile.checkpoint_variant = "uncensored";
  edited.metadata.request.source = {
    id: "original",
    project: edited.project,
    name: "Original photograph",
    path: "private/original.png",
  };
  assert.deepEqual(imageRecipeDraft(edited), {
    prompt: "A quiet forest",
    profile: "retired-profile",
    seed: 0,
    mode: "edit",
    source: "original",
  });
  assert.equal(imageRecipe(edited).checkpointVariant, "Uncensored");
  assert.equal(imageRecipe(edited).sourceName, "Original photograph");
  assert.equal(imageRecipe(edited).mode, "edit");
  edited.metadata.request.source.project = "different-project";
  assert.equal(imageRecipeDraft(edited), null);
  delete edited.metadata.request.source;
  assert.equal(imageRecipeDraft(edited), null);
});

test("edit source guard admits the pixel boundary and rejects oversized or foreign originals", () => {
  const source = {
    kind: "image",
    project: "p",
    metadata: { width: 2048, height: 2048 },
  };
  assert.equal(imageEditSourceIssue(source, "p"), "");
  assert.match(imageEditSourceIssue(source, "other"), /this project/);
  assert.match(imageEditSourceIssue(null, "p"), /Choose/);
  assert.match(
    imageEditSourceIssue(
      { ...source, metadata: { width: 4097, height: 1024 } },
      "p",
    ),
    /smaller copy/,
  );
});

test("styles are recorded beside the styled prompt and restored as a selection", () => {
  assert.deepEqual(
    IMAGE_STYLES.map((style) => style.id),
    ["photograph", "illustration", "product", "cinematic"],
  );
  assert.equal(imageStylePhrase("cinematic"), ", cinematic style");
  for (const value of ["neon", "", null, undefined, 4])
    assert.equal(imageStylePhrase(value), "");
  assert.equal(
    styledImagePrompt("A quiet forest \n", "cinematic"),
    "A quiet forest, cinematic style",
  );
  assert.equal(styledImagePrompt("A quiet forest", null), "A quiet forest");
  assert.equal(styledImagePrompt(undefined, "product"), ", product style");

  const styled = structuredClone(output);
  styled.metadata.request.prompt = "A quiet forest, cinematic style";
  styled.metadata.request.style = "cinematic";
  assert.equal(imageRecipe(styled).prompt, "A quiet forest");
  assert.equal(imageRecipe(styled).style, "cinematic");
  assert.deepEqual(imageRecipeDraft(styled, 7), {
    prompt: "A quiet forest",
    profile: "retired-profile",
    seed: 7,
    style: "cinematic",
  });
  // An unknown or missing style never rewrites the saved prompt.
  styled.metadata.request.style = "neon";
  assert.equal(imageRecipe(styled).style, null);
  assert.equal(imageRecipe(styled).prompt, "A quiet forest, cinematic style");
  delete styled.metadata.request.style;
  assert.equal(imageRecipe(styled).prompt, "A quiet forest, cinematic style");
  // Edit recipes carry no style selection.
  const edited = structuredClone(output);
  edited.metadata.request.profile.mode = "edit";
  edited.metadata.request.style = "cinematic";
  edited.metadata.request.source = {
    id: "original",
    project: edited.project,
    name: "Original photograph",
    path: "private/original.png",
  };
  assert.equal("style" in imageRecipeDraft(edited), false);
});

test("promotion offers the package's 2048 sibling only for finished 1024 creations", () => {
  const tools = [
    {
      id: "qwen-image21",
      profiles: [
        {
          id: "qwen-image21-2048",
          task: "image",
          roles: ["image"],
          mode: "text-to-image",
          width: 2048,
          height: 2048,
        },
        {
          id: "qwen-image21-1024",
          task: "image",
          roles: ["image"],
          mode: "text-to-image",
          width: 1024,
          height: 1024,
        },
        {
          id: "qwen-image21-rgba-2048",
          task: "image",
          roles: ["image"],
          mode: "rgba",
          width: 2048,
          height: 2048,
        },
        {
          id: "qwen-image21-edit",
          task: "image",
          roles: ["image_edit"],
          mode: "edit",
          width: 1024,
          height: 1024,
        },
      ],
    },
  ];
  const draft = structuredClone(output);
  Object.assign(draft.metadata.request.profile, {
    id: "qwen-image21-1024",
    package: "qwen-image21",
    mode: "text-to-image",
  });
  assert.equal(imagePromotionProfile(draft, tools).id, "qwen-image21-2048");
  draft.metadata.request.profile.mode = "rgba";
  assert.equal(
    imagePromotionProfile(draft, tools).id,
    "qwen-image21-rgba-2048",
  );
  draft.metadata.request.profile.mode = "text-to-image";
  assert.equal(imagePromotionProfile(draft, []), null);
  assert.equal(imagePromotionProfile(draft), null);
  const full = structuredClone(draft);
  Object.assign(full.metadata.request.profile, {
    id: "qwen-image21-2048",
    width: 2048,
    height: 2048,
  });
  assert.equal(imagePromotionProfile(full, tools), null);
  const edited = structuredClone(draft);
  edited.metadata.request.profile.mode = "edit";
  edited.metadata.request.source = {
    id: "original",
    project: edited.project,
    name: "Original",
  };
  assert.equal(imagePromotionProfile(edited, tools), null);
  assert.equal(
    imagePromotionProfile({ kind: "image", metadata: {} }, tools),
    null,
  );
});

test("count queues sequential seeds from one base and wraps at the safe-integer ceiling", () => {
  assert.deepEqual(imageSeedSequence(771, 3), [771, 772, 773]);
  assert.deepEqual(imageSeedSequence(5, 1), [5]);
  assert.deepEqual(imageSeedSequence(Number.MAX_SAFE_INTEGER - 1, 4), [
    Number.MAX_SAFE_INTEGER - 1,
    Number.MAX_SAFE_INTEGER,
    0,
    1,
  ]);
  assert.deepEqual(imageSeedSequence(0, 9), [0, 1, 2, 3]);
  for (const value of [undefined, null, "", 0, -3, 1.5, NaN, "x"])
    assert.equal(imageSequenceCount(value), 1);
  assert.equal(imageSequenceCount("2"), 2);
  assert.equal(imageSequenceCount(4), 4);
  assert.equal(imageSequenceCount(9), 4);
});
