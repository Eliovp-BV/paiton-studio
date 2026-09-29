export const weightsLabel = (options) =>
  options?.weights === "w3a4" ? "W3A4 3-bit" : "MXFP4";

export function kvCacheLabel(savedDetails) {
  return savedDetails?.kv_cache_mode === "kv4"
    ? "KV4 (4-bit)"
    : savedDetails?.kv_cache_mode === "fp8"
      ? "FP8"
      : null;
}

export function technicalModel(pkg, options) {
  const model = pkg?.model || "";
  if (pkg?.id !== "qwen38-mxfp4") return model;
  const label = weightsLabel(options);
  return /\bMXFP4\b/.test(model)
    ? model.replace(/\bMXFP4\b/g, label)
    : `${model} · ${label}`;
}

export function taskProfiles(tools, task, conversation) {
  return tools.flatMap((tool) =>
    (tool.profiles || [])
      .filter(
        (profile) =>
          profile.task ===
            (["website", "chat", "code"].includes(task)
              ? "write"
              : task === "video_text"
                ? "video"
                : task === "image_edit"
                  ? "image"
                  : task) &&
          (task === "image_edit"
            ? profile.roles?.includes(task)
            : !profile.roles || profile.roles.includes(task)),
      )
      .map((profile) => {
        const release =
          tool.id === "qwen38-mxfp4" && ["chat", "code"].includes(task)
            ? tool.release_states?.[
                conversation?.context_mode === "extra_long" ? "200k" : "64k"
              ]
            : null;
        return {
          ...profile,
          package: tool,
          state: release?.state ?? profile.state ?? tool.state,
          message: release?.message ?? profile.message,
          compatibility:
            release?.compatibility ??
            profile.compatibility ??
            tool.compatibility,
        };
      }),
  );
}
export function selectedProfile(
  tools,
  task,
  value = "auto",
  defaultId = "auto",
  conversation,
) {
  const all = taskProfiles(tools, task, conversation);
  const identity = !value || value === "auto" ? defaultId : value;
  if (identity && identity !== "auto")
    return all.find((item) => item.id === identity);
  const ready = all.filter(
    (item) =>
      item.state === "ready" &&
      item.compatibility?.compatible !== false &&
      !item.requires_explicit_selection &&
      !item.package.requires_explicit_selection,
  );
  return (
    ready.find((item) => item.package.default_for?.includes(task)) || ready[0]
  );
}
export function modelReadiness({
  tools = [],
  task,
  value = "auto",
  defaultId = "auto",
  worker,
  conversation,
}) {
  const selected = selectedProfile(tools, task, value, defaultId, conversation);
  const ready = Boolean(
    selected &&
      selected.state === "ready" &&
      selected.compatibility?.compatible !== false,
  );
  const paused = worker?.state === "stopped";
  const explicit =
    (value && value !== "auto") || (defaultId && defaultId !== "auto");
  // Creators see the outcome-first package name; the technical package string
  // (quantisation, draft model, vendor) stays available one step away.
  const label =
    selected?.package?.name || selected?.package?.model || "No model selected";
  const technical = technicalModel(selected?.package, conversation);
  const reason = !ready
    ? (selected?.compatibility?.compatible === false &&
        selected.compatibility.reason) ||
      selected?.message ||
      (explicit
        ? "Your saved model needs attention. Choose another installed model or open model settings."
        : "Choose an installed coding or chat model in model settings.")
    : paused
      ? "AI is paused. You can prepare your work; requests will stay off until execution resumes."
      : "Installed locally. The model loads when you send a request.";
  return {
    selected,
    ready,
    paused,
    canRun: ready && !paused,
    reason,
    label,
    technical,
  };
}
