// Display real lifecycle states; never infer progress or benchmark gains from
// an animated indicator, model size, or a generation-only benchmark.
let hostClockOffset = 0;
export function syncServerClock(header, received = Date.now()) {
  const timestamp = Date.parse(header || "");
  if (Number.isFinite(timestamp)) hostClockOffset = timestamp - received;
}
export function studioNow() {
  return Date.now() + hostClockOffset;
}

// Persist only display metadata. Treat browser storage as untrusted input and
// keep terminal states/acknowledgments monotonic across open windows.
export function normalizeDesignRecords(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const states = [
    "watching",
    "completed",
    "failed",
    "cancelled",
    "applied",
    "discarded",
  ];
  const time = (n) => (Number.isFinite(n) && n >= 0 ? n : null);
  const records = Object.entries(value).flatMap(([id, r]) => {
    if (
      !/^[a-f0-9]{32}$/.test(id) ||
      !r ||
      typeof r.project !== "string" ||
      !/^[a-f0-9]{32}$/.test(r.project) ||
      !states.includes(r.state)
    )
      return [];
    if (
      r.state === "completed" &&
      (!Number.isInteger(r.pages) || r.pages < 1 || r.pages > 5)
    )
      return [];
    return [
      [
        id,
        {
          id,
          project: r.project,
          state: r.state,
          created: time(r.created),
          finished: time(r.finished),
          elapsed: time(r.elapsed),
          pages: Number.isInteger(r.pages) ? r.pages : 0,
          kind: ["page-copy", "section-artwork"].includes(r.kind)
            ? r.kind
            : "website",
          title:
            typeof r.title === "string"
              ? r.title.slice(0, 200)
              : "Your website",
          acknowledged: r.acknowledged === true,
        },
      ],
    ];
  });
  const priority = (r) =>
    r.state === "watching"
      ? 2
      : r.state === "completed" && !r.acknowledged
        ? 1
        : 0;
  records.sort(
    (a, b) =>
      priority(b[1]) - priority(a[1]) ||
      (b[1].created || 0) - (a[1].created || 0),
  );
  return Object.fromEntries(records.slice(0, 160));
}

export function mergeDesignRecords(...sources) {
  const merged = {};
  for (const source of sources) {
    for (const [id, record] of Object.entries(normalizeDesignRecords(source))) {
      const previous = merged[id];
      merged[id] =
        previous && record.state === "watching" && previous.state !== "watching"
          ? previous
          : {
              ...record,
              acknowledged:
                record.acknowledged || previous?.acknowledged === true,
            };
    }
  }
  return normalizeDesignRecords(merged);
}

export function formatElapsed(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "Time unavailable";
  const value = Math.floor(seconds),
    minutes = Math.floor(value / 60),
    remainder = value % 60;
  return minutes
    ? `${minutes} min ${String(remainder).padStart(2, "0")} sec`
    : `${value} sec`;
}

export function stageForJob(job) {
  const task = job?.request?.task;
  const website = !!job?.request?.website_run;
  // Only the runtime can confirm reuse. Installed files or a prior result do
  // not establish that a model is still resident in GPU memory.
  const reusing = [
    "Reusing the ready local chat model.",
    "Reusing the ready local text model.",
  ].includes(job?.message);
  const progress = job?.progress;
  const measured =
    Number.isFinite(progress?.value) &&
    Number.isFinite(progress?.maximum) &&
    progress.maximum > 0 &&
    progress.value >= 0 &&
    progress.value <= progress.maximum;
  const stages = {
    queued: [
      "Waiting in your queue",
      "Your request is saved. Studio shares one GPU across creation tools; a different model may need to load when your turn starts. Keep browsing while you wait.",
    ],
    preparing: [
      "Preparing the local model",
      "Checking the model and your inputs before loading. Your project is saved.",
    ],
    loading: reusing
      ? [
          "Ready model reused",
          "The local model is already loaded. Studio is preparing your request without loading it again.",
        ]
      : [
          "Loading model · this can take a while",
          "Downloaded models still need to be loaded into GPU memory. Switching back to a large model can take several minutes, even with files cached locally. Your data stays on the Studio host; keep browsing while it loads.",
        ],
    warming: [
      "Warming up the model",
      "The runtime is preparing to create. This can include first-use compilation or warm-up runs; installed files do not skip every preparation step. Your request continues locally in the background.",
    ],
    generating: [
      task === "write"
        ? website
          ? job?.request?.purpose === "website-page-copy"
            ? "Rewriting this page"
            : "Writing your website"
          : "Writing your draft"
        : task === "video"
          ? "Creating your video"
          : website
            ? "Creating website artwork"
            : "Creating your image",
      "The model is creating on your Studio host. You can keep browsing and editing.",
    ],
    processing: [
      task === "meeting" ? "Transcribing your meeting" : "Processing locally",
      job?.message ||
        "The local tool is processing your request. Keep the Studio host running.",
    ],
    saving: [
      "Saving and checking the result",
      "Checking the completed files before adding them to your project.",
    ],
    cancelling: [
      "Stopping the creation tool",
      "Waiting for the tool to stop safely. Your saved work stays available.",
    ],
    completed: [
      "Creation finished",
      "Your result is saved on the Studio host.",
    ],
    failed: [
      "Creation needs attention",
      job?.message ||
        "Open the queue for details. Your saved work is preserved.",
    ],
    cancelled: ["Request stopped", "Your earlier saved work is preserved."],
  };
  const [title, description] = stages[job?.state] || [
    "Preparing your website",
    "The local workflow is moving to its next step.",
  ];
  return {
    title,
    description,
    indeterminate:
      !measured && !["completed", "failed", "cancelled"].includes(job?.state),
    measured,
  };
}

export function completedDesign(run) {
  if (run?.state !== "completed" || !run.result?.pages?.length) return null;
  const elapsed =
    Number.isFinite(run.created) &&
    Number.isFinite(run.updated) &&
    run.updated >= run.created
      ? run.updated - run.created
      : null;
  const kind = ["page-copy", "section-artwork"].includes(run.request?.kind)
    ? run.request.kind
    : "website";
  const target = run.request?.base_site?.pages?.find(
    (page) => page.slug === run.request.page_slug,
  );
  return {
    id: run.id,
    project: run.project,
    created: run.created,
    finished: run.updated,
    elapsed,
    pages: run.result.pages.length,
    kind,
    // This count comes from completed image child jobs, not a requested count.
    artwork: (run.job_details || []).filter(
      (j) =>
        j.state === "completed" &&
        (j.task ? j.task === "image" : (run.jobs || []).indexOf(j.id) > 0),
    ).length,
    title:
      kind === "website"
        ? run.result.title || "Your website"
        : target?.title || run.request.page_slug || "Your website update",
    state: "completed",
  };
}
