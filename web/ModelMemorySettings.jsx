import React, { useEffect, useState } from "react";
import { Cpu, HardDrive } from "lucide-react";
import "./model-memory.css";

export default function ModelMemorySettings({
  value = 15,
  onChange,
  memory,
  api,
  report,
}) {
  const [releaseStatus, setReleaseStatus] = useState(null);
  const [releaseBusy, setReleaseBusy] = useState(false);
  useEffect(() => setReleaseStatus(null), [memory]);
  const retained = (releaseStatus || memory)?.retained_model;
  const releasing = retained?.state === "releasing";
  const untilReleased = retained?.idle_remaining_seconds == null;
  const remaining = Math.max(0, retained?.idle_remaining_seconds || 0);
  const countdown = `${Math.floor(remaining / 60)}m ${String(remaining % 60).padStart(2, "0")}s`;
  async function release() {
    setReleaseBusy(true);
    try {
      setReleaseStatus(await api("/model-memory/release", {}));
    } catch (error) {
      report?.(error);
    } finally {
      setReleaseBusy(false);
    }
  }
  return (
    <section
      className="panel settings-section model-memory-settings"
      aria-label="Model loading and memory"
    >
      <div className="section-heading">
        <div>
          <h2>Model loading &amp; switching</h2>
          <p className="helper">
            Downloaded models still need to be prepared and loaded onto your
            GPU.
          </p>
        </div>
        <Cpu size={22} aria-hidden="true" />
      </div>
      <div className="memory-ready" role="status">
        <span className={retained?.state === "ready" ? "status-dot" : ""} />
        <div>
          <strong>
            {!memory
              ? "Checking model memory…"
              : retained
                ? `${retained.model} · ${retained.state === "ready" ? "kept ready" : "releasing when idle"}`
                : "No model kept ready between requests"}
          </strong>
          <p className="helper">
            {retained
              ? releasing
                ? "Release waits for the active request to finish and cleanup to succeed."
                : untilReleased
                  ? "Kept ready until you release it, Studio stops, or another queued tool needs the GPU."
                  : `Idle release in ${countdown}. Activity can extend this countdown.`
              : "This describes models retained for reuse. Running jobs appear in your queue."}
          </p>
        </div>
      </div>
      <div className="memory-release">
        <button
          type="button"
          disabled={!api || !retained || releasing || releaseBusy}
          onClick={release}
        >
          {releaseBusy
            ? "Requesting release…"
            : releasing
              ? "Release pending"
              : "Release kept-ready model"}
        </button>
        <p className="helper">
          Active work finishes first. Model files stay installed, and the next
          request may need to load them again.
        </p>
      </div>
      <label>
        Keep supported models ready for
        <select
          aria-label="Keep supported models ready for"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        >
          <option value={15}>15 minutes</option>
          <option value={60}>1 hour</option>
          <option value={-1}>Until you release it (while Studio runs)</option>
        </select>
      </label>
      <p className="helper">
        Applies to Qwen3.8 MXFP4 + DFlash2, Qronos writing and website planning,
        GPT-OSS, and MiniCPM after their last activity. An open Chat workspace
        extends a timed retention. Keeping a model ready uses GPU memory;
        another queued tool can still take its turn, and Release always applies.
      </p>
      <div className="memory-switch-note">
        <HardDrive size={19} aria-hidden="true" />
        <p>
          Model files and supported runtime caches stay on disk. Switching tools
          may release the current model, so returning can require another long
          load. Image and Video currently load for each request. Supported text
          models can stay ready between requests.
        </p>
      </div>
    </section>
  );
}
