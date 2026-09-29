// Creator-facing readiness labels for /api/tools and /api/readiness models.
// `state` says whether a tool is installed and compatible; `qualified` is the
// package's static flag saying its published testing is complete. It knows
// nothing about the detected GPU. A ready but unqualified tool stays usable
// and says so instead of claiming "Ready to create".
export const READINESS_LABELS = {
  ready: "Ready to create",
  setup_required: "Needs setup",
  incompatible: "Not qualified here",
  environment_required: "Host needs attention",
  available: "Not integrated yet",
};

export const UNQUALIFIED_READY_LABEL =
  "Ready · not yet qualified (testing pending)";

export function readinessLabel(model) {
  if (!model) return "";
  if (model.state === "ready" && model.qualified === false)
    return UNQUALIFIED_READY_LABEL;
  return READINESS_LABELS[model.state] || model.state;
}
