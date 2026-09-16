import React from "react";
import { Cpu, HardDrive, ArrowRight } from "lucide-react";
import "./model-memory.css";

export default function ModelMemorySettings({
  value = 2,
  onChange,
  memory,
  onSystem,
}) {
  const retained = memory?.retained_model;
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
            This describes models retained for reuse. Running jobs appear in
            your queue.
          </p>
        </div>
      </div>
      <label>
        Keep supported models ready for
        <select
          aria-label="Keep supported models ready for"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        >
          <option value={2}>2 minutes</option>
          <option value={5}>5 minutes</option>
          <option value={15}>15 minutes</option>
        </select>
      </label>
      <p className="helper">
        Applies to Qwen3.8 MXFP4 + DFlash2, Qronos writing and website planning,
        GPT-OSS, and MiniCPM after their last activity. An open GPT workspace
        extends retention. Keeping a model ready uses GPU memory; another queued
        tool can still take its turn.
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
      <details>
        <summary>Can system memory make switching faster?</summary>
        <p className="helper">
          The operating system may cache recently read files in RAM. It manages
          that space automatically; availability varies. This can help disk
          reads, while model preparation and transfer to the GPU still take
          time.
        </p>
        <p className="helper">
          Keeping an initialized model in system RAM for fast resume needs
          support from its Paiton runtime. That path is not yet qualified in
          Studio. Adding disk space or system RAM does not make a model fit into
          insufficient GPU memory.
        </p>
        <p className="helper">
          For fewer switches, finish a group of requests with one tool before
          moving to the next. Your queue order and selected output quality stay
          under your control.
        </p>
        <button type="button" className="text-link" onClick={onSystem}>
          Check this host’s memory <ArrowRight size={14} />
        </button>
      </details>
    </section>
  );
}
