import React, { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Download,
  ExternalLink,
  Server,
  Square,
  RefreshCw,
} from "lucide-react";

const ACTIVE_SETUP = [
  "queued",
  "waiting_for_gpu",
  "preparing",
  "downloading_runtime",
  "downloading",
  "verifying",
  "configuring",
  "cancelling",
];
function bytes(value) {
  return Number.isFinite(value)
    ? `${(value / 1024 ** 3).toFixed(1)} GB`
    : "Size unavailable";
}
export default function SetupTools({ api, report, onTools }) {
  const [snapshot, setSnapshot] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const seen = useRef("");
  const lifecycle = useRef(null);
  const callbacks = useRef({ api, onTools });
  callbacks.current = { api, onTools };
  function refresh() {
    const session = lifecycle.current;
    if (!session?.active) return Promise.resolve();
    if (session.pending) return session.pending;
    setRefreshing(true);
    const request = Promise.resolve().then(async () => {
      try {
        const next = await callbacks.current.api("/setup");
        if (!session.active) return;
        setSnapshot(next);
        const signature = next.jobs
          .filter((job) => job.state === "completed")
          .map((job) => job.id)
          .join();
        if (seen.current !== signature) {
          await callbacks.current.onTools();
          if (!session.active) return;
          seen.current = signature;
        }
        setError("");
      } catch (failure) {
        if (session.active)
          setError(
            failure.message || "Studio could not check your creation tools.",
          );
      } finally {
        session.pending = null;
        if (session.active) setRefreshing(false);
      }
    });
    session.pending = request;
    return request;
  }
  useEffect(() => {
    const session = { active: true, pending: null };
    lifecycle.current = session;
    let timer;
    async function poll() {
      await refresh();
      if (session.active) timer = setTimeout(poll, 2500);
    }
    poll();
    return () => {
      session.active = false;
      clearTimeout(timer);
    };
  }, []);
  async function perform(packageId, fn) {
    setBusy(packageId);
    try {
      await fn();
      // Finish any older check before reading the result of this action.
      await lifecycle.current?.pending;
      await refresh();
    } catch (failure) {
      report(failure);
    } finally {
      if (lifecycle.current?.active) setBusy(null);
    }
  }
  const connectionNotice = error && (
    <div className="notice" role="alert">
      <strong>Creation tools could not be checked.</strong>
      <p>{error}</p>
      <p className="helper">
        {snapshot
          ? "Showing the last successful check. Download status may be out of date."
          : "Keep the Studio host running and check your connection. Your saved work is safe."}
      </p>
      <button disabled={refreshing} onClick={refresh}>
        <RefreshCw size={14} />
        {refreshing ? "Checking again…" : "Try again"}
      </button>
    </div>
  );
  if (!snapshot)
    return (
      <section className="panel settings-section" aria-busy={refreshing}>
        <h2>Set up creation tools</h2>
        {connectionNotice || (
          <p className="helper" role="status">
            Checking installed tools and this computer…
          </p>
        )}
      </section>
    );
  const labels = {
    ready: "Ready to create",
    setup_required: "Ready to download",
    installing: "Setting up",
    manual_setup: "Preparation needed",
    system_required: "System setup needed",
    insufficient_disk: "More disk space needed",
  };
  return (
    <section className="panel settings-section tool-setup">
      <div className="section-heading">
        <div>
          <h2>Set up creation tools</h2>
          <p className="helper">
            Choose what to install. Downloads begin only when you ask.
          </p>
        </div>
        <Download size={21} />
      </div>
      {connectionNotice}
      <div className="setup-system">
        <div>
          <Server size={17} />
          <strong>Studio host</strong>
          <span>{bytes(snapshot.system.disk_free_bytes)} available</span>
        </div>
        <p>{snapshot.system.message}</p>
        <div className="setup-checks">
          {(
            snapshot.system.checks || [
              {
                id: "docker",
                label: "Container runtime",
                state: snapshot.system.docker ? "ready" : "missing",
              },
              {
                id: "driver",
                label: "GPU driver",
                state: snapshot.system.driver ? "ready" : "missing",
              },
            ]
          ).map((check) => (
            <span
              key={check.id}
              className={
                check.state === "ready" ||
                check.state === "passed" ||
                check.state === "ok"
                  ? "check-ready"
                  : "check-needed"
              }
              title={check.message || check.label}
            >
              {check.state === "ready" ||
              check.state === "passed" ||
              check.state === "ok" ? (
                <Check size={12} />
              ) : (
                <AlertCircle size={12} />
              )}{" "}
              {check.label}
            </span>
          ))}
        </div>
      </div>
      <div className="setup-tools">
        {snapshot.tools.map((tool) => {
          const job = snapshot.jobs.find(
            (job) =>
              job.package === tool.id && ACTIVE_SETUP.includes(job.state),
          );
          const last = snapshot.jobs.find((job) => job.package === tool.id);
          return (
            <article className="setup-tool" key={tool.id}>
              <div className="section-heading">
                <div>
                  <h3>{tool.title}</h3>
                  <p className="helper">{tool.model}</p>
                </div>
                <span
                  className={
                    "badge " +
                    (tool.state === "ready" &&
                    tool.generation_ready !== false &&
                    tool.compatibility?.compatible !== false
                      ? "ready"
                      : "")
                  }
                >
                  {tool.files_ready && tool.compatibility?.compatible === false
                    ? "Installed · incompatible GPU"
                    : tool.files_ready && tool.generation_ready === false
                      ? "Installed · device setup needed"
                      : labels[tool.state] || tool.state.replaceAll("_", " ")}
                </span>
              </div>
              <p className="helper">{tool.message}</p>
              {tool.compatibility?.compatible === false && (
                <div className="setup-compatibility">
                  <AlertCircle size={16} />
                  <span>
                    {tool.compatibility.reason}
                    {tool.can_install && (
                      <small>
                        You can download the files, but this model cannot run on
                        the detected GPU.
                      </small>
                    )}
                  </span>
                </div>
              )}
              {tool.state !== "ready" && (
                <>
                  <div className="setup-download-details">
                    <span>
                      Download <b>{bytes(tool.download_bytes)}</b>
                    </span>
                    <span>
                      Disk required <b>{bytes(tool.required_disk_bytes)}</b>
                    </span>
                    <span>
                      License <b>{tool.license || "See model source"}</b>
                    </span>
                  </div>
                  <p className="helper download-note">
                    {tool.download_note ||
                      "Shown size covers model files. Runtime downloads are additional."}
                  </p>
                  {tool.source_url && (
                    <a
                      className="setup-source"
                      href={tool.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Model source:{" "}
                      {tool.source_url.replace(/^https?:\/\//, "")}
                      <ExternalLink size={12} />
                    </a>
                  )}
                </>
              )}
              {tool.steps?.length > 0 && (
                <div
                  className="setup-steps"
                  aria-label={`${tool.title} preparation steps`}
                >
                  {tool.steps.map((step, index) => (
                    <span
                      key={step.id || index}
                      className={"setup-step " + step.state}
                    >
                      {step.state === "completed" || step.state === "ready" ? (
                        <Check size={12} />
                      ) : (
                        <i />
                      )}
                      {step.label}
                    </span>
                  ))}
                </div>
              )}
              {job ? (
                <div className="setup-job" role="status">
                  <strong>{job.state.replaceAll("_", " ")}</strong>
                  <p>{job.message}</p>
                  {job.total_bytes > 0 ? (
                    <>
                      <progress
                        value={job.completed_bytes || 0}
                        max={job.total_bytes}
                      />
                      <small>
                        {bytes(job.completed_bytes || 0)} /{" "}
                        {bytes(job.total_bytes)}
                      </small>
                    </>
                  ) : (
                    <small>Waiting for measured download progress.</small>
                  )}
                  <button
                    disabled={busy === tool.id || job.state === "cancelling"}
                    onClick={() =>
                      perform(tool.id, () =>
                        api(`/setup-jobs/${job.id}/cancel`, {}),
                      )
                    }
                  >
                    <Square size={12} />
                    Cancel setup
                  </button>
                </div>
              ) : (
                tool.state !== "ready" && (
                  <div className="setup-install">
                    <button
                      className="primary"
                      disabled={!tool.can_install || !!busy}
                      onClick={() =>
                        perform(tool.id, () =>
                          api(`/setup/${tool.id}/install`, {}),
                        )
                      }
                    >
                      <Download size={15} />
                      {busy === tool.id
                        ? "Starting setup…"
                        : "Download & set up"}
                    </button>
                    {!tool.can_install && (
                      <span className="helper">
                        {tool.state === "manual_setup"
                          ? "This package needs the preparation described in its source."
                          : "Complete the requirements above to continue."}
                      </span>
                    )}
                  </div>
                )
              )}
              {last &&
                !job &&
                ["failed", "cancelled", "interrupted"].includes(last.state) && (
                  <p className="setup-last" role="status">
                    {last.state}: {last.message}
                  </p>
                )}
            </article>
          );
        })}
      </div>
      <p className="helper setup-footnote">
        Downloads need an internet connection. Image, video and writing
        inference remains on your Studio host.
      </p>
    </section>
  );
}
