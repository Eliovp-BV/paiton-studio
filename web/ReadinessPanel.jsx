import HostGuidance from "./HostGuidance";
import React, { useEffect, useState } from "react";
import {
  Check,
  ChevronRight,
  Cpu,
  Download,
  Info,
  RefreshCw,
} from "lucide-react";
const STATE = {
  ready: "Ready to create",
  setup_required: "Needs setup",
  incompatible: "Not qualified here",
  environment_required: "Host needs attention",
  available: "Not integrated yet",
};
export default function ReadinessPanel({ api, onSetup }) {
  const [report, setReport] = useState(null),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState(true);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError("");
    api("/readiness")
      .then((data) => {
        if (active) setReport(data);
      })
      .catch((e) => {
        if (active) setError(e.message || "Readiness could not be checked.");
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [api, refresh]);
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "paiton-compatibility-report.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section
      className="machine-readiness"
      aria-label="Machine creation readiness"
      aria-busy={busy}
    >
      <HostGuidance api={api} />
      <div className="section-heading">
        <div>
          <span className="eyebrow">
            <Cpu size={14} /> QUALIFIED FOR YOUR MACHINE
          </span>
          <h2>What can you create here?</h2>
          <p className="helper">
            Installed tools, GPU qualification and memory capacity—checked
            separately.
          </p>
        </div>
        <button
          aria-label="Refresh creation readiness"
          disabled={busy}
          onClick={() => setRefresh((n) => n + 1)}
        >
          <RefreshCw size={15} />
          {busy ? "Checking…" : "Check again"}
        </button>
      </div>
      {error && (
        <p className="notice" role="alert">
          {error}
          {report && " Showing the previous check."}
        </p>
      )}
      {!report && !error && (
        <p role="status" className="helper">
          Checking local tools. No models are being loaded.
        </p>
      )}
      {report && (
        <>
          <div className="readiness-capabilities">
            {report.capabilities.map((c) => (
              <div key={c.id} className={"readiness-capability " + c.state}>
                {c.state === "ready" ? (
                  <Check size={16} />
                ) : c.state === "setup_required" ? (
                  <Download size={16} />
                ) : (
                  <Info size={16} />
                )}
                <span>
                  <strong>{c.name}</strong>
                  <small>
                    {c.state === "ready"
                      ? `${c.ready_models.length} local ${c.ready_models.length === 1 ? "tool" : "tools"} ready`
                      : c.state === "setup_required"
                        ? "Prepare a compatible tool"
                        : "No qualified tool ready"}
                  </small>
                </span>
              </div>
            ))}
          </div>
          <p className="helper">
            Ready tools still share one GPU. If it is busy, your request waits
            safely in the queue.
          </p>
          <div className="readiness-models">
            {report.models
              .filter((m) => m.integrated)
              .map((m) => (
                <details key={m.id} className="readiness-model">
                  <summary>
                    <span>
                      <strong>{m.model}</strong>
                      <small>
                        {m.installed
                          ? "Installed locally"
                          : "Package needs setup"}
                      </small>
                    </span>
                    <span className={"readiness-state " + m.state}>
                      {STATE[m.state] || m.state}
                      <ChevronRight size={14} />
                    </span>
                  </summary>
                  <div className="readiness-explanation">
                    {m.hardware.qualification && (
                      <p>{m.hardware.qualification}</p>
                    )}
                    {m.hardware.checks?.map((check) => (
                      <div
                        key={check.id}
                        className={"readiness-check " + check.status}
                      >
                        {check.status === "compatible" ? (
                          <Check size={14} />
                        ) : (
                          <Info size={14} />
                        )}
                        <span>{check.message}</span>
                      </div>
                    ))}
                    {!report.environment.compatible && (
                      <p>{report.environment.reason}</p>
                    )}
                    {m.hardware.memory_basis && (
                      <p className="helper">
                        Memory basis: {m.hardware.memory_basis}
                      </p>
                    )}
                    {m.quality_note && (
                      <p className="helper">{m.quality_note}</p>
                    )}
                    {m.state === "setup_required" && onSetup && (
                      <button onClick={onSetup}>
                        <Download size={14} /> Prepare creation tools
                      </button>
                    )}
                  </div>
                </details>
              ))}
          </div>
          <button className="readiness-download" onClick={download}>
            <Download size={14} /> Save compatibility report
          </button>
          <p className="helper">
            Hardware and package checks only. No prompts, documents or model
            weights are included.
          </p>
          <details className="readiness-limits">
            <summary>About future GPUs and driver support</summary>
            {report.notes.map((note) => (
              <p key={note} className="helper">
                {note}
              </p>
            ))}
          </details>
        </>
      )}
    </section>
  );
}
