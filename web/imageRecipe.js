const MAX_SEED = Number.MAX_SAFE_INTEGER;

export const IMAGE_STYLES = [
  { id: "photograph", label: "Photograph" },
  { id: "illustration", label: "Illustration" },
  { id: "product", label: "Product" },
  { id: "cinematic", label: "Cinematic" },
];

function text(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

export function imageStyle(value) {
  return IMAGE_STYLES.find((style) => style.id === value) || null;
}

// The style chips used to append this exact text to the draft. Keeping the
// wording means the runtime still receives the same prompt shape.
export function imageStylePhrase(style) {
  const known = imageStyle(style);
  return known ? `, ${known.id} style` : "";
}

export function styledImagePrompt(prompt, style) {
  return (prompt || "").trimEnd() + imageStylePhrase(style);
}

function promptWithoutStyle(prompt, style) {
  const phrase = imageStylePhrase(style);
  return phrase && prompt.endsWith(phrase)
    ? prompt.slice(0, -phrase.length)
    : prompt;
}

export function imageRecipe(asset) {
  const request = asset?.metadata?.request;
  const profile = request?.profile;
  const style = imageStyle(request?.style)?.id || null;
  const checkpointVariant =
    asset?.metadata?.model_variant ||
    profile?.checkpoint_variant ||
    (profile?.package === "qwen-image21" ? "original" : null);
  if (
    asset?.kind !== "image" ||
    request?.task !== "image" ||
    !text(request.prompt) ||
    !text(profile?.id) ||
    !Number.isSafeInteger(request.seed) ||
    request.seed < 0
  )
    return null;
  return {
    prompt: promptWithoutStyle(request.prompt, style),
    style,
    profile: profile.id,
    seed: request.seed,
    model: text(profile.model) || text(profile.package) || profile.id,
    label: text(profile.label),
    width: Number.isSafeInteger(profile.width) ? profile.width : null,
    height: Number.isSafeInteger(profile.height) ? profile.height : null,
    steps: Number.isSafeInteger(profile.steps) ? profile.steps : null,
    mode: profile.mode === "edit" ? "edit" : "create",
    sourceId:
      profile.mode === "edit" && request.source?.project === asset.project
        ? text(request.source.id)
        : null,
    sourceName: profile.mode === "edit" ? text(request.source?.name) : null,
    checkpointVariant:
      checkpointVariant === "uncensored"
        ? "Uncensored"
        : checkpointVariant === "original"
          ? "Original"
          : null,
    precision:
      asset.metadata.precision_profile === "exact"
        ? "Exact (BF16 activations)"
        : null,
    runtimeRef: text(request.runtime_ref),
    runtimeImage:
      text(request.runtime_image) || text(asset.metadata.runtime_image),
  };
}

export function newImageSeed(previous, random = globalThis.crypto) {
  let seed;
  if (random?.getRandomValues) {
    const words = random.getRandomValues(new Uint32Array(2));
    seed = (words[0] & 0x1fffff) * 2 ** 32 + words[1];
  } else {
    seed = Math.floor(Math.random() * 2 ** 53);
  }
  // A variation must differ even if random sampling happens to repeat a seed.
  return seed === Number(previous) ? (seed === MAX_SEED ? 0 : seed + 1) : seed;
}

export const MAX_IMAGE_COUNT = 4;

export function imageSequenceCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 1
    ? Math.min(count, MAX_IMAGE_COUNT)
    : 1;
}

// Count means one ordinary batch-1 request per seed, counting up from the
// seed shown, so a series stays reproducible from its first seed alone.
export function imageSeedSequence(base, count) {
  // Wrap without ever forming a sum above MAX_SEED, which would lose precision.
  const room = MAX_SEED - base;
  return Array.from({ length: imageSequenceCount(count) }, (_, offset) =>
    offset <= room ? base + offset : offset - room - 1,
  );
}

export function imageRecipeDraft(asset, variationSeed) {
  const recipe = imageRecipe(asset);
  if (!recipe || (recipe.mode === "edit" && !recipe.sourceId)) return null;
  const seed = variationSeed ?? recipe.seed;
  if (!Number.isSafeInteger(seed) || seed < 0) return null;
  // Copy only editable fields and a same-project source identifier. The server
  // resolves the original asset and current runtime again for the next request.
  return {
    prompt: recipe.prompt,
    profile: recipe.profile,
    seed,
    ...(recipe.mode === "edit"
      ? { mode: "edit", source: recipe.sourceId }
      : { style: recipe.style }),
  };
}

// A finished 1024 × 1024 creation can be rendered again at 2048 × 2048 with the
// same prompt, style and seed when its package offers that sibling profile.
export function imagePromotionProfile(asset, tools = []) {
  const recipe = imageRecipe(asset);
  const profile = asset?.metadata?.request?.profile;
  if (
    !recipe ||
    recipe.mode !== "create" ||
    recipe.width !== 1024 ||
    recipe.height !== 1024
  )
    return null;
  const tool = tools.find((item) => item.id === profile.package);
  return (
    (tool?.profiles || []).find(
      (item) =>
        item.task === "image" &&
        item.mode === profile.mode &&
        item.width === 2048 &&
        item.height === 2048 &&
        (!item.roles || item.roles.includes("image")),
    ) || null
  );
}

export function imageEditSourceIssue(asset, projectId) {
  if (!asset || asset.kind !== "image" || asset.project !== projectId)
    return "Choose an original image from this project.";
  const { width, height } = asset.metadata || {};
  if (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width * height > 4194304
  )
    return "This image is larger than 4,194,304 pixels. Import a smaller copy to edit; your original stays saved.";
  return "";
}

export function imagePromptLimit(profile) {
  const limit = profile?.max_prompt_length;
  return Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, 2500)
    : 2500;
}
