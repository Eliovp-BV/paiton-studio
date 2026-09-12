import React, { useEffect, useRef, useState } from "react";
import { Download, Film, ArrowRight, Scissors, Cpu } from "lucide-react";

const ACTIVE = ["queued", "encoding", "cancelling"];
export default function DeliveryStudio({
  project,
  assets,
  api,
  draft,
  onChange,
  refreshAssets,
  report,
  onVideo,
}) {
  const [presets, setPresets] = useState({});
  const [jobs, setJobs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [guides, setGuides] = useState(true);
  const signatures = useRef("");
  const videos = assets.filter((a) => a.kind === "video");
  const source =
    videos.find((a) => a.id === draft.source_id) ||
    videos.find((a) => a.metadata.origin !== "derived") ||
    videos[0];
  const preset = draft.preset || "portrait",
    fit = draft.fit || "contain";
  const dimensions = presets[preset];
  const focal = draft.focal_x ?? 0.5;
  const retained =
    dimensions && source?.metadata.width && source?.metadata.height
      ? Math.min(
          1,
          dimensions.width /
            dimensions.height /
            (source.metadata.width / source.metadata.height),
        )
      : 1;
  useEffect(() => {
    api("/delivery-presets").then(setPresets).catch(report);
  }, []);
  useEffect(() => {
    let ended = false;
    async function tick() {
      try {
        const result = await api("/projects/" + project.id + "/renditions");
        if (ended) return;
        setJobs(result);
        const signature = result
          .filter((j) => j.asset)
          .map((j) => j.asset)
          .join(",");
        if (signature !== signatures.current) {
          signatures.current = signature;
          await refreshAssets();
        }
      } catch (e) {
        if (!ended) report(e);
      }
    }
    tick();
    const timer = setInterval(tick, 1600);
    return () => {
      ended = true;
      clearInterval(timer);
    };
  }, [project.id]);
  async function submit() {
    setBusy(true);
    try {
      const job = await api("/projects/" + project.id + "/renditions", {
        source_id: source.id,
        preset,
        fit,
        focal_x: focal,
        audio: draft.audio || "preserve",
      });
      setJobs((old) => [job, ...old]);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="eyebrow">MADE HERE. READY TO SHARE.</div>
      <h1>Reels & shorts</h1>
      <p className="lead">
        Give your video a portrait, square or wide delivery format. Keep the
        original and save a new copy.
      </p>
      {!source ? (
        <div className="empty panel">
          <Film size={34} />
          <h2>Start with a real clip</h2>
          <p>Animate a project image, then prepare that video here.</p>
          <button className="primary" onClick={onVideo}>
            Create a video <ArrowRight size={16} />
          </button>
        </div>
      ) : (
        <div className="delivery-layout">
          <section className="panel delivery-controls">
            <label>
              Project video
              <select
                value={source.id}
                onChange={(e) => onChange({ source_id: e.target.value })}
              >
                {videos.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Delivery format
              <select
                value={preset}
                onChange={(e) => onChange({ preset: e.target.value })}
              >
                {Object.entries(presets).map(([id, p]) => (
                  <option key={id} value={id}>
                    {p.label} · {p.width} × {p.height}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Framing
              <select
                value={fit}
                onChange={(e) => onChange({ fit: e.target.value })}
              >
                <option value="contain">
                  Keep the whole picture · add borders
                </option>
                <option value="cover">Fill the frame · crop the picture</option>
              </select>
            </label>
            {fit === "cover" && (
              <>
                <label>
                  Horizontal focus
                  <input
                    aria-label="Horizontal focus"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={focal}
                    onChange={(e) =>
                      onChange({ focal_x: Number(e.target.value) })
                    }
                  />
                </label>
                <p className="helper">
                  <Scissors size={14} /> This frame retains about{" "}
                  {Math.round(retained * 100)}% of the source width. Check your
                  subject in the preview.
                </p>
              </>
            )}
            <label>
              Audio
              <select
                value={draft.audio || "preserve"}
                onChange={(e) => onChange({ audio: e.target.value })}
              >
                <option value="preserve">Keep original sound</option>
                <option value="mute">Save without sound</option>
              </select>
            </label>
            <label className="preference-row">
              <span>
                Show composition guides
                <small>Preview only · not platform guarantees</small>
              </span>
              <input
                type="checkbox"
                checked={guides}
                onChange={(e) => setGuides(e.target.checked)}
              />
            </label>
            <div className="delivery-facts">
              <Cpu size={17} />
              <p>
                This export uses the CPU. It preserves the source frame rate;
                resizing adds no new detail or motion. Generation settings stay
                with the original clip.
              </p>
            </div>
            <button
              className="primary"
              disabled={busy || !dimensions}
              onClick={submit}
            >
              {busy ? "Adding to media queue…" : "Create delivery copy"}
              <ArrowRight size={16} />
            </button>
          </section>
          <section className="panel delivery-preview">
            <div className="section-heading">
              <h2>Check the frame</h2>
              <span className="helper">
                {dimensions?.width} × {dimensions?.height}
              </span>
            </div>
            <div
              className="delivery-frame"
              style={{
                "--delivery-ratio": dimensions
                  ? dimensions.width / dimensions.height
                  : 9 / 16,
                aspectRatio: dimensions
                  ? `${dimensions.width}/${dimensions.height}`
                  : "9/16",
              }}
            >
              <video
                key={source.id}
                src={"/api/assets/" + source.id}
                controls
                muted={draft.audio === "mute"}
                preload="metadata"
                style={{
                  objectFit: fit,
                  objectPosition: `${focal * 100}% 50%`,
                }}
              />
              {guides && (
                <div className="composition-guide" aria-hidden="true">
                  <span>Keep key content away from the edges</span>
                </div>
              )}
            </div>
            <p className="helper">
              Preview uses your original video. The saved copy applies the
              selected framing and audio choice. Platform overlays vary; review
              it again in the destination app.
            </p>
          </section>
        </div>
      )}
      <div className="section-heading">
        <h2>Delivery copies</h2>
        <span className="helper">
          One CPU encode at a time · independent of the model queue
        </span>
      </div>
      <div className="delivery-results">
        {jobs.length ? (
          jobs.map((job) => (
            <article className="panel" key={job.id}>
              <div className="section-heading">
                <strong>{job.request.source_name}</strong>
                <span className="badge">{job.state}</span>
              </div>
              <p className="helper">
                {presets[job.request.preset]?.label} ·{" "}
                {job.request.fit === "cover" ? "Cropped" : "Whole picture"} ·{" "}
                {job.request.audio === "mute" ? "No audio" : "Original audio"}
              </p>
              {job.asset && (
                <video
                  src={"/api/assets/" + job.asset}
                  controls
                  preload="metadata"
                />
              )}
              <p role="status">{job.message}</p>
              {job.state === "encoding" && (
                <progress
                  value={job.progress || 0}
                  max="1"
                  aria-label="Encoding progress"
                />
              )}
              {ACTIVE.includes(job.state) && (
                <button
                  disabled={job.state === "cancelling"}
                  onClick={async () => {
                    try {
                      await api("/renditions/" + job.id + "/cancel", {});
                    } catch (e) {
                      report(e);
                    }
                  }}
                >
                  Cancel copy
                </button>
              )}
              {job.asset && (
                <a
                  className="button"
                  href={"/api/assets/" + job.asset + "?download=true"}
                  download
                >
                  <Download size={16} />
                  Download MP4
                </a>
              )}
            </article>
          ))
        ) : (
          <p className="helper">
            Your finished delivery copies will appear here and in the project
            library. This first version reframes one clip; sequencing, timed
            captions and trimming are next.
          </p>
        )}
      </div>
    </>
  );
}
