// Friendly labels for queue, delivery, website-run and agent-run states.
// Raw state ids stay in the API; creators only see these words.
export const STATE_LABELS = {
  queued: "Waiting",
  preparing: "Preparing",
  loading: "Loading model",
  warming: "Warming up",
  planning: "Planning",
  artwork: "Creating artwork",
  running: "Working",
  generating: "Working",
  processing: "Working",
  saving: "Saving",
  drafting: "Drafting",
  reviewing: "Reviewing",
  cancelling: "Stopping",
  completed: "Done",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
};

// `overrides` lets a workspace keep its own wording for a few states (agent
// runs say "Ready to review" instead of "Done") without a second map.
export function stateLabel(state, overrides = {}) {
  return overrides[state] || STATE_LABELS[state] || state;
}
