import React, { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCheck,
  Clock,
  Globe,
  Layers3,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  completedDesign,
  formatElapsed,
  normalizeDesignRecords,
  mergeDesignRecords,
} from "./creationFeedback";
import "./website-notifications.css";

const KEY = "studio-website-feedback-v1";
const ACTIVE = [
  "queued",
  "preparing",
  "loading",
  "warming",
  "generating",
  "saving",
  "cancelling",
];
function readSaved() {
  try {
    return normalizeDesignRecords(
      JSON.parse(localStorage.getItem(KEY) || "{}"),
    );
  } catch {
    return {};
  }
}

export default function WebsiteNotifications({
  api,
  enabled,
  jobs,
  submitted,
  onReview,
  onQueue,
  report,
}) {
  const [records, setRecords] = useState(readSaved);
  const [started, setStarted] = useState(null);
  const [opening, setOpening] = useState(false);
  const recordsRef = useRef(records);
  function change(update) {
    const current = mergeDesignRecords(recordsRef.current, readSaved());
    const next = mergeDesignRecords(current, update(current));
    recordsRef.current = next;
    setRecords(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* Feedback remains available in this session. */
    }
  }
  useEffect(() => {
    if (!submitted) return;
    change((old) => ({
      ...old,
      [submitted.id]: {
        id: submitted.id,
        project: submitted.project,
        created: submitted.created,
        kind: submitted.request?.kind,
        state: "watching",
      },
    }));
    setStarted(submitted.id);
  }, [submitted]);
  useEffect(() => {
    const observed = jobs.filter(
      (j) => j.request?.website_run && ACTIVE.includes(j.state),
    );
    if (!observed.some((j) => !recordsRef.current[j.request.website_run]))
      return;
    change((old) => {
      const next = { ...old };
      for (const job of observed) {
        const id = job.request.website_run;
        if (!next[id])
          next[id] = {
            id,
            project: job.project,
            created: job.created,
            state: "watching",
          };
      }
      return next;
    });
  }, [jobs]);
  useEffect(() => {
    function sync(event) {
      if (event.key === KEY) {
        const next = mergeDesignRecords(recordsRef.current, readSaved());
        recordsRef.current = next;
        setRecords(next);
      }
    }
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let ended = false,
      busy = false,
      offset = 0;
    async function tick() {
      if (busy || ended) return;
      const pending = Object.values(recordsRef.current).filter(
        (r) =>
          r.state === "watching" ||
          (r.state === "completed" && !r.acknowledged),
      );
      const projects = [...new Set(pending.map((r) => r.project))];
      if (!projects.length) return;
      busy = true;
      const group = Array.from(
        { length: Math.min(8, projects.length) },
        (_, i) => projects[(offset + i) % projects.length],
      );
      offset = (offset + group.length) % projects.length;
      // Read-only API already available in the running Studio. A website is
      // finished only when its coordinator reports completed, not when the
      // first writing/image child finishes. No backend restart is required.
      try {
        const results = await Promise.allSettled(
          group.map((project) => api(`/projects/${project}/website`)),
        );
        if (ended) return;
        change((old) => {
          const next = { ...old };
          for (const result of results) {
            if (result.status !== "fulfilled") continue;
            for (const run of result.value.runs || []) {
              if (!["watching", "completed"].includes(next[run.id]?.state))
                continue;
              const complete = completedDesign(run);
              if (complete && next[run.id].state === "watching")
                next[run.id] = { ...complete, acknowledged: false };
              else if (
                ["failed", "cancelled", "applied", "discarded"].includes(
                  run.state,
                )
              )
                next[run.id] = {
                  ...next[run.id],
                  state: run.state,
                  acknowledged: true,
                };
            }
          }
          return next;
        });
      } finally {
        busy = false;
      }
    }
    tick();
    const timer = setInterval(tick, 2400);
    return () => {
      ended = true;
      clearInterval(timer);
    };
  }, [api, enabled]);
  const completed = Object.values(records)
    .filter((r) => r.state === "completed" && !r.acknowledged)
    .sort((a, b) => a.finished - b.finished);
  const design = completed[0];
  const initial = started && records[started]?.state === "watching";
  const kind = (design || records[started])?.kind;
  const refinement = ["page-copy", "section-artwork"].includes(kind);
  const output =
    kind === "section-artwork"
      ? "1 image"
      : kind === "page-copy"
        ? "1 page’s copy"
        : `${design?.pages} pages`;
  const finishedTitle = refinement
    ? "Website update finished"
    : "Design finished";
  function dismiss(id) {
    change((old) => ({ ...old, [id]: { ...old[id], acknowledged: true } }));
  }
  if (!enabled || (!design && !initial)) return null;
  return (
    <aside
      className={"website-feedback " + (design ? "finished" : "accepted")}
      aria-label={
        design
          ? finishedTitle
          : refinement
            ? "Website update queued"
            : "Website queued"
      }
    >
      <div className="feedback-topline">
        <span>
          {design ? "SAVED ON YOUR STUDIO HOST" : "YOUR REQUEST IS SAVED"}
        </span>
        <button
          aria-label="Dismiss website notification"
          onClick={() => (design ? dismiss(design.id) : setStarted(null))}
        >
          <X size={18} />
        </button>
      </div>
      <div className="feedback-heading">
        <span className="feedback-mark">
          {design ? <CheckCheck size={26} /> : <Globe size={26} />}
        </span>
        <div>
          <h2>
            {design
              ? finishedTitle
              : refinement
                ? "Your update is on its way"
                : "Your website is on its way"}
          </h2>
          <p>
            {design
              ? design.title
              : "Local creation is running in the background."}
          </p>
        </div>
      </div>
      {design ? (
        <>
          <div className="feedback-metrics">
            <div>
              <Clock size={17} />
              <strong>{formatElapsed(design.elapsed)}</strong>
              <span>Total elapsed time</span>
            </div>
            <div>
              <Layers3 size={17} />
              <strong>{output}</strong>
              <span>Ready to review</span>
            </div>
          </div>
          <p className="feedback-copy">
            {refinement
              ? "Your selected output is ready. Compare it with the original and apply it when you’re ready. Your current website is preserved."
              : "Your new design is saved as a draft. Review and apply it when you’re ready."}
          </p>
          <div className="feedback-privacy">
            <ShieldCheck size={16} />
            <span>Created locally with Paiton. No cloud model.</span>
          </div>
          <details>
            <summary>About this timing</summary>
            <p>
              Measured from entering the queue until{" "}
              {refinement ? "this output" : "the complete design"} was ready,
              including model loading. A matching unoptimized baseline has not
              been recorded for this design, so no time-saving estimate is
              shown.
            </p>
          </details>
          <div className="feedback-actions">
            <button onClick={() => dismiss(design.id)}>Later</button>
            <button
              className="primary"
              disabled={opening}
              onClick={async () => {
                setOpening(true);
                try {
                  await onReview(design);
                  dismiss(design.id);
                } catch (e) {
                  report(e);
                } finally {
                  setOpening(false);
                }
              }}
            >
              {opening
                ? "Opening…"
                : refinement
                  ? "Review update"
                  : "Review design"}
              <ArrowRight size={16} />
            </button>
          </div>
          {completed.length > 1 && (
            <p className="feedback-more">
              {completed.length - 1} more finished{" "}
              {completed.length === 2 ? "result" : "results"} waiting
            </p>
          )}
          <div className="sr-only" role="status" aria-live="polite">
            {finishedTitle}. {output} ready in {formatElapsed(design.elapsed)}.
          </div>
        </>
      ) : (
        <>
          <p className="feedback-copy">
            This can take several minutes, especially while the model loads.
            Keep browsing and editing in Studio. We’ll let you know when your{" "}
            {refinement ? "update" : "design"} is ready.
          </p>
          <div className="feedback-privacy">
            <ShieldCheck size={16} />
            <span>
              AI processing stays local. Keep the Studio host running.
            </span>
          </div>
          <div className="feedback-actions">
            <button
              onClick={() => {
                onQueue();
                setStarted(null);
              }}
            >
              Open queue
            </button>
            <button className="primary" onClick={() => setStarted(null)}>
              Continue browsing <Check size={16} />
            </button>
          </div>
          <div className="sr-only" role="status" aria-live="polite">
            {refinement ? "Website update" : "Website"} queued. Loading can take
            several minutes. Keep browsing; creation continues locally.
          </div>
        </>
      )}
    </aside>
  );
}
