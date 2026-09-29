import React from "react";
import {
  performanceLabels,
  imageTimeLabel,
  estimateLabel,
} from "./performance";
import "./performance.css";

export function PerformanceSummary({ metrics }) {
  const labels = performanceLabels(metrics);
  return labels.length ? (
    <p className="performance-summary" aria-label="Reply performance">
      {labels.map(({ text, title }) => (
        <span key={text} title={title}>
          {text}
        </span>
      ))}
    </p>
  ) : null;
}

export function ImageTime({ asset }) {
  const label = imageTimeLabel(asset);
  return label ? (
    <p
      className="performance-summary"
      title="Time for one image, including model loading, checks and saving. Queue wait is excluded."
    >
      {label}
    </p>
  ) : null;
}

export function QueueEstimate({ estimate }) {
  const label = estimateLabel(estimate);
  return label ? (
    <p
      className="helper queue-estimate"
      title="Based on completed runs using the same saved model, runtime and quality settings. Time waiting for other requests or another GPU user is not included."
    >
      {label}
    </p>
  ) : null;
}

export function PerformanceDetails({ metadata }) {
  const metrics = metadata?.performance;
  if (!metrics) return null;
  const seconds = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? `${value.toFixed(2)} s`
      : "Unavailable";
  return (
    <details className="performance-details">
      <summary>Performance details</summary>
      <dl>
        <dt>Model loading and readiness</dt>
        <dd>{seconds(metrics.load_seconds)}</dd>
        <dt>Final model request</dt>
        <dd>{seconds(metrics.request_seconds)}</dd>
        <dt>This reply, including tools</dt>
        <dd>{seconds(metrics.turn_seconds)}</dd>
      </dl>
      <p className="helper">
        The footer describes the final model request. Queue wait and earlier
        tool or summary calls are excluded from its rate and TTFT. Output
        arrives in bursts, so the displayed rate is observed by Studio.
      </p>
      {metadata.inference && (
        <dl>
          {["fresh", "replayed"].flatMap((source) =>
            ["final", "tool", "summary"].map((kind) => {
              const part = metadata.inference[source]?.[kind];
              return part?.calls > 0 ? (
                <React.Fragment key={`${source}-${kind}`}>
                  <dt>
                    {source === "fresh" ? "New" : "Saved"} {kind} requests
                  </dt>
                  <dd>
                    {part.calls} ·{" "}
                    {Number.isSafeInteger(part.output_tokens)
                      ? `${part.output_tokens} output tokens`
                      : "token count unavailable"}{" "}
                    · {seconds(part.request_seconds)}
                  </dd>
                </React.Fragment>
              ) : null;
            }),
          )}
        </dl>
      )}
    </details>
  );
}
