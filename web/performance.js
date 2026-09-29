const nonnegative = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const decimal = (value, digits = 1) =>
  value.toLocaleString("en-US", { maximumFractionDigits: digits });

export function performanceLabels(metrics) {
  if (!metrics || typeof metrics !== "object") return [];
  const labels = [];
  if (Number.isSafeInteger(metrics.output_tokens) && metrics.output_tokens >= 0)
    labels.push({
      text: `${decimal(metrics.output_tokens, 0)} tokens`,
      title:
        "Output tokens reported by the final model request, including reasoning when the runtime counts it.",
    });
  if (
    nonnegative(metrics.tokens_per_second) &&
    metrics.rate_scope === "client_observed_stream"
  )
    labels.push({
      text: `${decimal(metrics.tokens_per_second)} tok/s`,
      title:
        "Client-observed output rate for the final model request. Speculative output arrives in bursts; this is not an engine benchmark. Excludes loading and earlier tool calls.",
    });
  if (nonnegative(metrics.first_token_seconds))
    labels.push({
      text: `TTFT ${decimal(metrics.first_token_seconds, 2)} s`,
      title:
        "Time from the final model request to its first streamed output, including reasoning or tool arguments. Excludes model loading and earlier tool calls.",
    });
  if (["warm", "cold"].includes(metrics.model_state))
    labels.push({
      text: metrics.model_state === "warm" ? "Warm" : "Cold",
      title:
        metrics.model_state === "warm"
          ? "Used a model that was already loaded."
          : "Loaded the model for this request.",
    });
  return labels;
}

export function imageTimeLabel(asset) {
  const seconds = asset?.metadata?.generation_seconds;
  return asset?.kind === "image" &&
    asset?.metadata?.request?.task === "image" &&
    nonnegative(seconds)
    ? `${decimal(seconds)} s/image`
    : null;
}

export function estimateLabel(estimate) {
  if (
    estimate?.scope !== "same_contract_median" ||
    !nonnegative(estimate.seconds) ||
    estimate.seconds <= 0 ||
    !Number.isSafeInteger(estimate.samples) ||
    estimate.samples < 1
  )
    return null;
  return `Estimated run ~${decimal(estimate.seconds)} s once started · median of ${estimate.samples}`;
}
