import React, { useEffect, useState, useRef } from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Clock3,
  Download,
  FileText,
  Globe,
  Image as ImageIcon,
  Layers3,
  LockKeyhole,
  Monitor,
  RefreshCw,
  Smartphone,
  Square,
} from "lucide-react";
import { ModelChoice } from "./WorkspaceExtras";
import { formatElapsed, stageForJob, studioNow } from "./creationFeedback";
import {
  RefinementDialog,
  RefinementReview,
  isRefinement,
  refinementName,
} from "./WebsiteRefinement";
import "./website-progress.css";

const RUNNING = [
  "queued",
  "planning",
  "preparing",
  "loading",
  "writing",
  "generating",
  "artwork",
  "assembling",
  "running",
  "cancelling",
];
export default function WebsiteBuilder({
  project,
  assets,
  tools,
  settings,
  draft,
  updateDraft,
  api,
  report,
  flush,
  onAssets,
  jobs = [],
  onRunStarted,
  reviewRequest,
  onReviewOpened,
}) {
  const [state, setState] = useState({ site: null, runs: [] });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [slug, setSlug] = useState("index");
  const [previewVersion, setPreviewVersion] = useState(0);
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(studioNow());
  const [refining, setRefining] = useState(false);
  const [reviewId, setReviewId] = useState(null);
  const [inspecting, setInspecting] = useState(null);
  const [operationError, setOperationError] = useState("");
  const alive = useRef(true);
  const latestRefresh = useRef(0);
  const site = draft.editor || state.site;
  const media = assets.filter((asset) => asset.kind !== "text");
  const documents = assets.filter((asset) => asset.kind === "text");
  const page =
    site?.pages?.find((page) => page.slug === slug) || site?.pages?.[0];
  const activeRun = state.runs.find((run) => RUNNING.includes(run.state));
  const websiteJobs = (activeRun?.jobs || [])
    .map((id, index) => {
      const job = jobs.find((job) => job.id === id);
      if (job) return job;
      const detail = activeRun?.job_details?.find((job) => job.id === id);
      return detail
        ? {
            ...detail,
            request: {
              task:
                detail.task ||
                (activeRun.request?.kind === "section-artwork"
                  ? "image"
                  : index === 0
                    ? "write"
                    : "image"),
              purpose: detail.purpose,
              website_run: activeRun.id,
            },
          }
        : null;
    })
    .filter(Boolean);
  const activeWebsiteJob =
    websiteJobs.find(
      (job) =>
        !["queued", "completed", "cancelled", "failed"].includes(job.state),
    ) || websiteJobs.find((job) => job.state === "queued");
  const activeStage = activeRun
    ? stageForJob(activeWebsiteJob || { state: activeRun.state })
    : null;
  const taskProgress = activeWebsiteJob?.progress;
  const hasMeasuredProgress =
    !activeStage?.indeterminate &&
    Number.isFinite(taskProgress?.value) &&
    Number.isFinite(taskProgress?.maximum) &&
    taskProgress.maximum > 0 &&
    taskProgress.value >= 0 &&
    taskProgress.value <= taskProgress.maximum;
  const elapsedSeconds =
    activeRun && Number.isFinite(activeRun.created)
      ? Math.max(0, now / 1000 - activeRun.created)
      : null;
  const reviewRuns = state.runs.filter(
    (run) => run.state === "completed" && run.result,
  );
  const reviewRun =
    reviewRuns.find((run) => run.id === reviewId) || reviewRuns[0];
  const inspectedRun = reviewRuns.find((run) => run.id === inspecting);
  const refinement = draft.refinement;
  async function refresh() {
    const sequence = ++latestRefresh.current;
    const next = await api(`/projects/${project.id}/website`);
    if (alive.current && sequence === latestRefresh.current) {
      setState((current) => ({
        ...next,
        site:
          (next.site?.revision || 0) < (current.site?.revision || 0)
            ? current.site
            : next.site,
      }));
      setLoaded(true);
    }
    return next;
  }
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let timer;
    async function poll() {
      try {
        await refresh();
      } catch (error) {
        if (!disposed) report(error);
      } finally {
        // Wait after completion: a slow host must not perpetually supersede
        // its own responses or accumulate overlapping background requests.
        if (!disposed) timer = setTimeout(poll, 2200);
      }
    }
    poll();
    return () => {
      disposed = true;
      alive.current = false;
      clearTimeout(timer);
    };
  }, [project.id]);
  useEffect(() => {
    if (!reviewRequest) return;
    const requested = state.runs.find((run) => run.id === reviewRequest.id);
    // The completion notification can receive a newer snapshot before this
    // workspace's poll. Keep its selection pending until that result arrives.
    if (!requested || RUNNING.includes(requested.state)) return;
    if (requested.state === "completed" && requested.result) {
      setReviewId(requested.id);
      if (isRefinement(requested)) {
        setInspecting(requested.id);
        setSlug(requested.request.page_slug);
      }
      setOperationError("");
    } else {
      setMessage(
        `This website result is ${requested.state}. Your saved website is available below.`,
      );
    }
    onReviewOpened?.();
  }, [reviewRequest, state.runs]);
  useEffect(() => {
    if (!activeRun) return;
    setNow(studioNow());
    const timer = setInterval(() => setNow(studioNow()), 1000);
    return () => clearInterval(timer);
  }, [activeRun?.id]);
  function action(fn) {
    return async () => {
      setBusy(true);
      ++latestRefresh.current;
      setOperationError("");
      try {
        await fn();
      } catch (error) {
        if (alive.current) setOperationError(error.message);
        report(error);
      } finally {
        if (alive.current) setBusy(false);
      }
    };
  }
  function toggle(field, id, checked) {
    updateDraft({
      [field]: checked
        ? [...new Set([...(draft[field] || []), id])]
        : (draft[field] || []).filter((value) => value !== id),
    });
  }
  function editSite(patch) {
    updateDraft({ editor: { ...site, ...patch } });
  }
  function editPage(patch) {
    editSite({
      pages: site.pages.map((item) =>
        item.slug === page.slug ? { ...item, ...patch } : item,
      ),
    });
  }
  function editSection(index, patch) {
    editPage({
      sections: page.sections.map((section, i) =>
        i === index ? { ...section, ...patch } : section,
      ),
    });
  }
  async function generate() {
    await flush();
    const run = await api(`/projects/${project.id}/website/generate`, {
      brief: draft.brief || "",
      page_count: Number(draft.page_count || 3),
      artwork_count: Number(draft.artwork_count ?? 1),
      asset_ids: draft.asset_ids || [],
      context_ids: draft.context_ids || [],
      writing_profile_id: draft.writing_profile_id || "auto",
      image_profile_id: draft.image_profile_id || "auto",
      theme: draft.theme || "light",
    });
    onRunStarted?.(run);
    if (alive.current) {
      ++latestRefresh.current;
      setState((value) => ({
        ...value,
        runs: [run, ...value.runs.filter((item) => item.id !== run.id)],
      }));
      setMessage("");
    }
    await refresh();
  }
  function beginRefinement(kind, sectionIndex) {
    const target = {
      kind,
      page_slug: page.slug,
      ...(kind === "section-artwork" ? { section_index: sectionIndex } : {}),
    };
    const previous = draft.refinement;
    const sameTarget =
      previous?.kind === kind &&
      previous?.page_slug === page.slug &&
      previous?.section_index === sectionIndex;
    updateDraft({
      refinement: sameTarget
        ? previous
        : { ...target, instructions: "", asset_id: "" },
    });
    setOperationError("");
    setRefining(true);
  }
  async function regenerate() {
    const saved = draft.editor ? await save() : state.site;
    await flush();
    if (!alive.current) return;
    const body = {
      kind: refinement.kind,
      page_slug: refinement.page_slug,
      instructions: refinement.instructions.trim(),
      revision: saved.revision,
      writing_profile_id: draft.writing_profile_id || "auto",
      image_profile_id: draft.image_profile_id || "auto",
      ...(refinement.kind === "section-artwork"
        ? {
            section_index: refinement.section_index,
            ...(refinement.asset_id ? { asset_id: refinement.asset_id } : {}),
          }
        : {}),
    };
    const run = await api(`/projects/${project.id}/website/regenerate`, body);
    onRunStarted?.(run);
    if (!alive.current) return;
    ++latestRefresh.current;
    setRefining(false);
    setState((value) => ({
      ...value,
      runs: [run, ...value.runs.filter((item) => item.id !== run.id)],
    }));
    setMessage(
      "Your update is queued. Review the result here before applying it.",
    );
    await refresh();
  }
  async function apply(run = reviewRun) {
    const next = await api(`/website-runs/${run.id}/apply`, {
      revision: state.site?.revision || 0,
    });
    if (!alive.current) return;
    ++latestRefresh.current;
    updateDraft({ editor: null, siteReady: true });
    setState((value) => ({ ...value, site: next }));
    await flush();
    await refresh();
    await onAssets();
    setPreviewVersion(Date.now());
    setInspecting(null);
    setMessage(
      isRefinement(run)
        ? "Update applied. Other pages and your original project assets are preserved."
        : "Website draft applied. Review each page, make it yours, then export.",
    );
  }
  async function save() {
    const next = await api(`/projects/${project.id}/website`, site, "PUT");
    if (!alive.current) return next;
    ++latestRefresh.current;
    setState((current) => ({ ...current, site: next }));
    updateDraft({ editor: null, siteReady: true });
    await flush();
    await refresh();
    setPreviewVersion(Date.now());
    setMessage(
      "Website changes saved. The preview now shows your latest version.",
    );
    return next;
  }
  async function discard(run) {
    await api(`/website-runs/${run.id}/discard`, {});
    if (!alive.current) return;
    setInspecting(null);
    await refresh();
    setMessage(
      "Update discarded. Your website is unchanged; generated assets remain in your project.",
    );
  }
  async function retry(run) {
    const next = await api(`/website-runs/${run.id}/retry`, {});
    onRunStarted?.(next);
    await refresh();
  }
  async function download() {
    if (draft.editor) await save();
    const blob = await api(`/projects/${project.id}/website/export`, {});
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download =
      project.name.replace(/[^a-zA-Z0-9 -]/g, "") + "-website.zip";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    setMessage(
      "Exported linked pages, media and writing. Open index.html from the extracted folder.",
    );
  }
  return (
    <div className="website-workspace">
      {refining && refinement && (
        <RefinementDialog
          value={refinement}
          page={site.pages.find((item) => item.slug === refinement.page_slug)}
          assets={assets}
          tools={tools}
          settings={settings}
          draft={draft}
          updateDraft={updateDraft}
          busy={busy}
          error={operationError}
          onClose={() => setRefining(false)}
          onGenerate={action(regenerate)}
        />
      )}
      {inspectedRun && (
        <RefinementReview
          run={inspectedRun}
          currentRevision={state.site?.revision}
          unsaved={!!draft.editor}
          busy={busy}
          error={operationError}
          onClose={() => setInspecting(null)}
          onApply={action(() => apply(inspectedRun))}
          onDiscard={action(() => discard(inspectedRun))}
        />
      )}
      <div className="site-intro">
        <span className="site-icon">
          <Globe size={23} />
        </span>
        <div>
          <h2>One idea. A complete website.</h2>
          <p>
            Studio writes connected pages, creates artwork and brings your
            project assets together.
          </p>
        </div>
        <span className="badge ready">All local</span>
      </div>
      {message && (
        <p role="status" className="inline-message">
          <Check size={15} />
          {message}
        </p>
      )}
      {activeRun && (
        <div className="website-background-notice" role="status">
          <span className="website-background-icon" aria-hidden="true">
            <Clock3 size={21} />
          </span>
          <div>
            <strong>
              {isRefinement(activeRun)
                ? "Your website update is running in the background"
                : "Your website is queued and will run in the background"}
            </strong>
            <p>
              {isRefinement(activeRun)
                ? "Studio is regenerating only the selected output. Loading its model may take longer than creating the result. "
                : "Loading a model can take several minutes, followed by writing and any artwork. "}
              You can keep browsing Studio while it works. Keep Studio running
              on the host computer.
            </p>
            <span className="website-local-note">
              <LockKeyhole size={13} aria-hidden="true" />
              Your prompts, assets and generation stay local.
            </span>
          </div>
        </div>
      )}
      <div className="website-layout">
        <section className="panel site-brief">
          <div className="section-heading">
            <h3>Your website brief</h3>
            <span className="badge">01 / CREATE</span>
          </div>
          <label>
            What would you like to build?
            <textarea
              className="site-brief-input"
              maxLength={2500}
              placeholder="A warm, welcoming website for a woodland retreat. Include a home page, our story and a page about staying with us. Use my forest image and keep the writing simple."
              value={draft.brief || ""}
              onChange={(event) => updateDraft({ brief: event.target.value })}
            />
          </label>
          <div className="row">
            <label>
              Pages
              <select
                aria-label="Pages"
                value={draft.page_count || 3}
                onChange={(event) =>
                  updateDraft({ page_count: Number(event.target.value) })
                }
              >
                {[2, 3, 4, 5].map((count) => (
                  <option key={count} value={count}>
                    {count} linked pages
                  </option>
                ))}
              </select>
            </label>
            <label>
              New artwork
              <select
                aria-label="New artwork"
                value={draft.artwork_count ?? 1}
                onChange={(event) =>
                  updateDraft({ artwork_count: Number(event.target.value) })
                }
              >
                {[0, 1, 2, 3].map((count) => (
                  <option key={count} value={count}>
                    {count
                      ? `${count} image${count > 1 ? "s" : ""}`
                      : "Use my assets"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset>
            <legend>
              Include project media{" "}
              <span className="helper">
                ({(draft.asset_ids || []).length} selected)
              </span>
            </legend>
            {media.length ? (
              <div className="site-media-picker">
                {media.map((asset) => (
                  <label
                    className={
                      (draft.asset_ids || []).includes(asset.id)
                        ? "selected"
                        : ""
                    }
                    key={asset.id}
                  >
                    <input
                      type="checkbox"
                      checked={(draft.asset_ids || []).includes(asset.id)}
                      onChange={(event) =>
                        toggle("asset_ids", asset.id, event.target.checked)
                      }
                    />
                    {asset.kind === "image" ? (
                      <img src={`/api/assets/${asset.id}`} alt="" />
                    ) : (
                      <video
                        src={`/api/assets/${asset.id}`}
                        muted
                        preload="metadata"
                      />
                    )}
                    <span>{asset.name}</span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="helper">
                New artwork will be saved to this project. You can also create
                or import media first.
              </p>
            )}
          </fieldset>
          {documents.length > 0 && (
            <details>
              <summary>
                Use existing writing ({(draft.context_ids || []).length})
              </summary>
              {documents.map((asset) => (
                <label className="check-row" key={asset.id}>
                  <input
                    type="checkbox"
                    checked={(draft.context_ids || []).includes(asset.id)}
                    onChange={(event) =>
                      toggle("context_ids", asset.id, event.target.checked)
                    }
                  />
                  {asset.name}
                </label>
              ))}
            </details>
          )}
          <details>
            <summary>Tools & appearance</summary>
            <ModelChoice
              tools={tools}
              task="website"
              value={draft.writing_profile_id || "auto"}
              defaultId={settings.defaults?.website}
              label="Website writing model"
              onChange={(value) => updateDraft({ writing_profile_id: value })}
              details
            />
            <ModelChoice
              tools={tools}
              task="image"
              value={draft.image_profile_id || "auto"}
              defaultId={settings.defaults?.image}
              label="Website artwork model"
              onChange={(value) => updateDraft({ image_profile_id: value })}
              details
            />
            <label>
              Website theme
              <select
                value={draft.theme || "light"}
                onChange={(event) => updateDraft({ theme: event.target.value })}
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
          </details>
          <div className="site-generation-plan">
            <Layers3 size={16} />
            <span>
              Write {draft.page_count || 3} pages
              {Number(draft.artwork_count ?? 1) > 0
                ? ` → create ${draft.artwork_count ?? 1} image${Number(draft.artwork_count ?? 1) > 1 ? "s" : ""}`
                : ""}{" "}
              → assemble your site
              <small>Compatible tools run in sequence on one GPU.</small>
            </span>
          </div>
          <button
            className="primary"
            disabled={busy || !!activeRun || !draft.brief?.trim()}
            onClick={action(generate)}
          >
            <Globe size={17} />
            {activeRun
              ? isRefinement(activeRun)
                ? "Creating your update…"
                : "Creating your website…"
              : "Generate website"}
          </button>
          <p className="helper">
            A new draft is kept separate until you apply it. Your current
            website stays available.
          </p>
          {activeRun && (
            <div className="site-run website-active-run">
              <div className="website-stage-heading" role="status">
                <span className="website-stage-dot" aria-hidden="true" />
                <strong>{activeStage.title}</strong>
              </div>
              <p className="website-stage-description">
                {activeStage.description}
              </p>
              <progress
                aria-label={`${activeStage.title} progress`}
                {...(hasMeasuredProgress
                  ? { value: taskProgress.value, max: taskProgress.maximum }
                  : {})}
              />
              <div className="website-run-facts">
                <span>
                  <Layers3 size={13} aria-hidden="true" />
                  {activeRun.progress?.completed ?? 0} of{" "}
                  {activeRun.progress?.total ?? "—"} creation tasks complete
                </span>
                {elapsedSeconds !== null && (
                  <span aria-live="off">
                    <Clock3 size={13} aria-hidden="true" />
                    {formatElapsed(elapsedSeconds)} elapsed
                  </span>
                )}
              </div>
              <p className="website-progress-explanation">
                Tasks take different amounts of time. This is completed work,
                not an estimate of time remaining.
              </p>
              {(activeWebsiteJob?.message || activeRun.message) && (
                <details className="website-runtime-detail">
                  <summary>Current activity details</summary>
                  <p>{activeWebsiteJob?.message || activeRun.message}</p>
                </details>
              )}
              <button
                disabled={
                  busy ||
                  activeRun.state === "cancelling" ||
                  activeWebsiteJob?.state === "cancelling"
                }
                onClick={action(async () => {
                  await api(`/website-runs/${activeRun.id}/cancel`, {});
                  await refresh();
                })}
              >
                <Square size={13} />
                {activeRun.state === "cancelling" ||
                activeWebsiteJob?.state === "cancelling"
                  ? "Stopping creation…"
                  : isRefinement(activeRun)
                    ? "Cancel website update"
                    : "Cancel website creation"}
              </button>
            </div>
          )}
          {reviewRun && (
            <div className="site-review">
              <Check size={19} />
              <h3>
                {isRefinement(reviewRun)
                  ? "Your website update is ready"
                  : "Your new website is ready"}
              </h3>
              {reviewRuns.length > 1 && (
                <label>
                  Pending results
                  <select
                    value={reviewRun.id}
                    onChange={(event) => setReviewId(event.target.value)}
                  >
                    {reviewRuns.map((run) => (
                      <option key={run.id} value={run.id}>
                        {isRefinement(run)
                          ? refinementName(run)
                          : "Complete website"}{" "}
                        · {new Date(run.created * 1000).toLocaleString()}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p className="helper">
                {isRefinement(reviewRun)
                  ? `${refinementName(reviewRun)}. Compare the original and new result before applying.`
                  : `${reviewRun.result.pages?.length || draft.page_count || 3} linked pages, ready for your review.`}
              </p>
              {Number.isFinite(reviewRun.created) &&
                Number.isFinite(reviewRun.updated) &&
                reviewRun.updated >= reviewRun.created && (
                  <p className="website-completion-duration">
                    <Clock3 size={14} aria-hidden="true" />
                    Created locally in{" "}
                    {formatElapsed(reviewRun.updated - reviewRun.created)},
                    including queue and model loading.
                  </p>
                )}
              <button
                className="primary"
                disabled={busy}
                onClick={
                  isRefinement(reviewRun)
                    ? () => {
                        setOperationError("");
                        setInspecting(reviewRun.id);
                      }
                    : action(() => apply(reviewRun))
                }
              >
                {isRefinement(reviewRun)
                  ? "Review update"
                  : "Apply generated draft"}
                <ArrowRight size={15} />
              </button>
              {draft.editor && !isRefinement(reviewRun) && (
                <p className="helper">
                  Applying replaces your current website and editor changes.
                  Export your current website first if you want a separate copy.
                </p>
              )}
            </div>
          )}
          {state.runs
            .filter((run) =>
              ["failed", "cancelled", "interrupted"].includes(run.state),
            )
            .slice(0, 2)
            .map((run) => (
              <div className="site-run" key={run.id}>
                <span className="badge">{run.state}</span>
                <p>{run.message}</p>
                {["failed", "cancelled"].includes(run.state) && (
                  <>
                    <button
                      disabled={
                        busy ||
                        !!activeRun ||
                        !!draft.editor ||
                        (isRefinement(run) &&
                          state.site?.revision !== run.request.base_revision)
                      }
                      onClick={action(() => retry(run))}
                    >
                      <RefreshCw size={14} />
                      {isRefinement(run)
                        ? "Retry this output"
                        : "Retry unfinished steps"}
                    </button>
                    {!isRefinement(run) && (
                      <p className="helper">
                        {draft.editor
                          ? "Save your current website edits before retrying. "
                          : ""}
                        Completed writing and artwork are reused. Only
                        unfinished steps run again.
                      </p>
                    )}
                    {isRefinement(run) &&
                      (draft.editor ||
                        state.site?.revision !== run.request.base_revision) && (
                        <p className="helper">
                          Your website has newer edits. Start a new update from
                          the page or section to use them.
                        </p>
                      )}
                  </>
                )}
              </div>
            ))}
        </section>
        <div className="site-content">
          {!loaded ? (
            <div className="empty">
              <RefreshCw size={25} />
              <p>Opening your website workspace…</p>
            </div>
          ) : site && page ? (
            <>
              <div className="site-map panel">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">02 / REVIEW & REFINE</span>
                    <h3>Your site map</h3>
                  </div>
                  <span className="helper">
                    {site.pages.length} linked pages
                  </span>
                </div>
                <nav aria-label="Website pages">
                  {site.pages.map((item) => (
                    <button
                      key={item.slug}
                      className={page.slug === item.slug ? "chosen" : ""}
                      onClick={() => setSlug(item.slug)}
                    >
                      <FileText size={16} />
                      <span>
                        {item.title}
                        <small>/{item.slug === "index" ? "" : item.slug}</small>
                      </span>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                </nav>
              </div>
              <div className="preview-panel website-preview">
                <div className="preview-toolbar">
                  <span>
                    {draft.editor
                      ? "Saved version · save to update preview"
                      : "Local preview · linked website"}
                  </span>
                  <div className="actions">
                    <button
                      aria-label="Website preview desktop"
                      className={!mobile ? "chosen" : ""}
                      onClick={() => setMobile(false)}
                    >
                      <Monitor size={16} />
                    </button>
                    <button
                      aria-label="Website preview mobile"
                      className={mobile ? "chosen" : ""}
                      onClick={() => setMobile(true)}
                    >
                      <Smartphone size={16} />
                    </button>
                    <button
                      aria-label="Refresh website preview"
                      onClick={() => setPreviewVersion(Date.now())}
                    >
                      <RefreshCw size={16} />
                    </button>
                  </div>
                </div>
                <iframe
                  onLoad={(event) => {
                    try {
                      const loadedSlug = new URL(
                        event.currentTarget.contentWindow.location.href,
                      ).pathname
                        .split("/")
                        .pop();
                      if (site.pages.some((item) => item.slug === loadedSlug))
                        setSlug(loadedSlug);
                    } catch {}
                  }}
                  title="Website preview"
                  sandbox="allow-same-origin"
                  className={mobile ? "mobile-preview" : ""}
                  src={`/api/website-preview/${project.id}/${page.slug}?v=${previewVersion}-${state.site?.revision || 0}`}
                />
              </div>
              <section className="panel site-editor">
                <fieldset className="site-editor-fields" disabled={busy}>
                  <div className="section-heading">
                    <h3>Edit {page.title}</h3>
                    <span className="helper">
                      {draft.editor
                        ? "Draft saved in project"
                        : `Website revision ${state.site?.revision || 1}`}
                    </span>
                  </div>
                  <button
                    className="site-refine-trigger"
                    disabled={busy || !!activeRun}
                    onClick={() => beginRefinement("page-copy")}
                  >
                    <RefreshCw size={14} />
                    Rewrite page copy
                  </button>
                  <p className="helper">
                    Improve this page’s writing while keeping its media and
                    links.
                  </p>
                  <div className="row">
                    <label>
                      Site title
                      <input
                        value={site.title || ""}
                        onChange={(event) =>
                          editSite({ title: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Site theme
                      <select
                        value={site.theme || "light"}
                        onChange={(event) =>
                          editSite({ theme: event.target.value })
                        }
                      >
                        <option value="light">Light</option>
                        <option value="dark">Dark</option>
                      </select>
                    </label>
                  </div>
                  <label>
                    Page title
                    <input
                      value={page.title || ""}
                      onChange={(event) =>
                        editPage({ title: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Page description
                    <textarea
                      className="short-text"
                      aria-label="Page description"
                      value={page.description || ""}
                      onChange={(event) =>
                        editPage({ description: event.target.value })
                      }
                    />
                  </label>
                  {page.sections.map((section, index) => (
                    <details
                      className="site-section-editor"
                      key={`${page.slug}-${index}`}
                      open={index === 0}
                    >
                      <summary>
                        Section {index + 1} · {section.heading || "Untitled"}
                      </summary>
                      <label>
                        Section heading
                        <input
                          value={section.heading || ""}
                          onChange={(event) =>
                            editSection(index, { heading: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        Section text
                        <textarea
                          value={section.body || ""}
                          onChange={(event) =>
                            editSection(index, { body: event.target.value })
                          }
                        />
                      </label>
                      <fieldset>
                        <legend>Section media</legend>
                        {media.map((asset) => (
                          <label className="check-row" key={asset.id}>
                            <input
                              type="checkbox"
                              checked={(section.asset_ids || []).includes(
                                asset.id,
                              )}
                              onChange={(event) =>
                                editSection(index, {
                                  asset_ids: event.target.checked
                                    ? [
                                        ...new Set([
                                          ...(section.asset_ids || []),
                                          asset.id,
                                        ]),
                                      ]
                                    : (section.asset_ids || []).filter(
                                        (id) => id !== asset.id,
                                      ),
                                })
                              }
                            />
                            {asset.name}
                          </label>
                        ))}
                      </fieldset>
                      <button
                        className="site-refine-trigger"
                        disabled={busy || !!activeRun}
                        onClick={() =>
                          beginRefinement("section-artwork", index)
                        }
                      >
                        <ImageIcon size={14} />
                        Create section artwork
                      </button>
                    </details>
                  ))}
                  <div className="site-savebar">
                    <span className="helper">
                      All pages share navigation and real project assets.
                    </span>
                    <div className="actions">
                      <button
                        disabled={!draft.editor || busy}
                        onClick={action(save)}
                      >
                        Save website changes
                        <Check size={15} />
                      </button>
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={action(download)}
                      >
                        <Download size={16} />
                        Export full website
                      </button>
                    </div>
                  </div>
                </fieldset>
              </section>
            </>
          ) : (
            <div className="site-empty">
              <div className="site-placeholder" aria-hidden="true">
                <div className="placeholder-nav">
                  <span />
                  <i />
                  <i />
                  <i />
                </div>
                <div className="placeholder-hero">
                  <Globe size={35} />
                  <i />
                  <i />
                </div>
                <div className="placeholder-pages">
                  <span>
                    <FileText size={20} />
                  </span>
                  <span>
                    <ImageIcon size={20} />
                  </span>
                  <span>
                    <FileText size={20} />
                  </span>
                </div>
              </div>
              <h3>A connected home for your ideas</h3>
              <p>
                Describe your website and choose the real assets it should use.
                Your linked pages will appear here, ready to edit and export.
              </p>
              <div className="site-promises">
                <span>
                  <Check size={14} />
                  Real generated artwork
                </span>
                <span>
                  <Check size={14} />
                  Shared page navigation
                </span>
                <span>
                  <Check size={14} />
                  Works offline after export
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
