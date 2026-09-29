import React, { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, Square } from "lucide-react";
import Diagnostics from "./Diagnostics";
import "./optionalWeights.css";

const terminal = new Set(["completed", "cancelled", "failed", "interrupted"]);
const size = (value) =>
  Number.isFinite(value)
    ? `${(value / 1024 ** 3).toFixed(1)} GiB`
    : "Size unavailable";
const labels = {
  not_installed: "Optional download",
  verification_required: "Verification needed",
  repair_required: "Repair needed",
  ready: "Installed & verified",
  installing: "Setting up",
};

export default function OptionalWeights({
  packageId,
  component,
  api,
  onChanged,
  disabled = false,
}) {
  const [busy, setBusy] = useState(false);
  const [pendingEnabled, setPendingEnabled] = useState(null);
  const [error, setError] = useState("");
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const job = component.job;
  const running = Boolean(job && !terminal.has(job.state));
  const enabled = Boolean(component.enabled_default);
  async function perform(path, body = {}, method) {
    setBusy(true);
    setError("");
    try {
      await api(path, body, method);
      await onChanged?.();
    } catch (failure) {
      if (live.current)
        setError(
          failure.message || "The optional weights could not be updated.",
        );
    } finally {
      if (live.current) setBusy(false);
    }
  }
  const endpoint = `/setup/${packageId}/components/${component.id}`;
  return (
    <section className="optional-weights" aria-label={component.label}>
      <div className="section-heading">
        <h4>{component.label}</h4>
        <span className={`badge ${component.verified ? "ready" : ""}`}>
          {labels[component.state] || "Check weights"}
        </span>
      </div>
      <p className="helper">{component.quality_note}</p>
      <p className="optional-weights-license">
        <span>{size(component.download_bytes)} download</span>
        {component.license_url && (
          <a
            href={component.license_url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {component.license || "License"}
            <ExternalLink size={12} />
          </a>
        )}
      </p>
      <label className="conversation-option">
        <span>
          <strong>Use 3-bit weights for new chats</strong>
          <small>Existing chats keep their saved choice.</small>
        </span>
        <input
          type="checkbox"
          checked={pendingEnabled ?? enabled}
          disabled={
            disabled || busy || running || (!enabled && !component.can_toggle)
          }
          onChange={async (event) => {
            const requested = event.target.checked;
            setPendingEnabled(requested);
            await perform(endpoint, { enabled: requested }, "PUT");
            if (live.current) setPendingEnabled(null);
          }}
        />
      </label>
      {component.message && (
        <p className="helper" role="status">
          {component.message}
        </p>
      )}
      {running ? (
        <div className="optional-weights-progress" role="status">
          <p>{job.message}</p>
          {job.total_bytes > 0 && (
            <>
              <progress
                value={job.completed_bytes || 0}
                max={job.total_bytes}
              />
              <small>
                {size(job.completed_bytes || 0)} / {size(job.total_bytes)}
              </small>
            </>
          )}
          <button
            disabled={disabled || busy || job.state === "cancelling"}
            onClick={() => perform(`/setup-jobs/${job.id}/cancel`)}
          >
            <Square size={13} />
            Cancel download
          </button>
        </div>
      ) : (
        !component.verified && (
          <button
            disabled={disabled || busy || !component.can_install}
            onClick={() => perform(`${endpoint}/install`)}
          >
            <Download size={14} />
            {busy
              ? "Starting…"
              : component.state === "verification_required"
                ? "Verify weights"
                : component.state === "repair_required"
                  ? "Repair weights"
                  : job &&
                      ["cancelled", "failed", "interrupted"].includes(job.state)
                    ? "Resume download"
                    : "Download 3-bit weights"}
          </button>
        )
      )}
      {!running &&
        job &&
        ["failed", "cancelled", "interrupted"].includes(job.state) && (
          <p className="helper" role="status">
            {job.message}
          </p>
        )}
      {!running && job && ["failed", "interrupted"].includes(job.state) && (
        <Diagnostics api={api} endpoint={`/setup-jobs/${job.id}/diagnostics`} />
      )}
      {error && (
        <p className="helper" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
