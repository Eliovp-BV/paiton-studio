import React, { useEffect, useRef } from "react";
import {
  ArrowRight,
  Image as ImageIcon,
  LockKeyhole,
  RefreshCw,
  X,
} from "lucide-react";
import { ModelChoice } from "./WorkspaceExtras";
import "./website-refinement.css";

export const isRefinement = (run) =>
  ["page-copy", "section-artwork"].includes(run?.request?.kind);
export function refinementName(run) {
  const request = run.request;
  const page = request.base_site?.pages?.find(
    (item) => item.slug === request.page_slug,
  );
  return request.kind === "page-copy"
    ? `Page copy · ${page?.title || request.page_slug}`
    : `Section ${(request.section_index ?? 0) + 1} artwork · ${page?.title || request.page_slug}`;
}

function Dialog({ title, subtitle, busy, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="website-refinement-dialog"
      aria-labelledby="website-refinement-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <div>
          <span className="eyebrow">REFINE YOUR WEBSITE</span>
          <h2 id="website-refinement-title">{title}</h2>
          <p>{subtitle}</p>
        </div>
        <button
          autoFocus
          type="button"
          aria-label="Close website refinement"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}

export function RefinementDialog({
  value,
  page,
  assets,
  tools,
  settings,
  draft,
  updateDraft,
  busy,
  error,
  onClose,
  onGenerate,
}) {
  const artwork = value.kind === "section-artwork";
  const section = artwork ? page?.sections[value.section_index] : null;
  const images = assets.filter(
    (asset) => asset.kind === "image" && section?.asset_ids.includes(asset.id),
  );
  const patch = (update) =>
    updateDraft({ refinement: { ...value, ...update } });
  return (
    <Dialog
      title={artwork ? "Create section artwork" : "Rewrite page copy"}
      subtitle={`${page?.title || value.page_slug}${artwork ? ` · Section ${value.section_index + 1}` : " · All text on this page"}`}
      busy={busy}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onGenerate();
        }}
      >
        <fieldset disabled={busy}>
          <p className="refinement-scope">
            {artwork
              ? "Create one new image for this section. The page’s writing and other media stay as they are."
              : "Rewrite this page’s title, description and section text. Its structure, media, links and other pages stay as they are."}
          </p>
          {artwork && (
            <label>
              Use the new image to
              <select
                value={value.asset_id || ""}
                onChange={(event) => patch({ asset_id: event.target.value })}
              >
                <option value="">Add artwork to this section</option>
                {images.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    Replace {asset.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {artwork && value.asset_id && (
            <p className="helper">
              The original image stays in your project library. This creates a
              new image from your description; it does not edit the original
              image.
            </p>
          )}
          <label>
            {artwork ? "Describe the new artwork" : "What should change?"}
            <textarea
              minLength={10}
              maxLength={2500}
              required
              value={value.instructions || ""}
              onChange={(event) => patch({ instructions: event.target.value })}
              placeholder={
                artwork
                  ? "A calm woodland retreat in soft morning light, no lettering or logos…"
                  : "Make the introduction more welcoming and shorten the paragraphs. Keep the facts and the call to action…"
              }
            />
          </label>
          <ModelChoice
            tools={tools}
            task={artwork ? "image" : "website"}
            value={
              draft[artwork ? "image_profile_id" : "writing_profile_id"] ||
              "auto"
            }
            defaultId={settings.defaults?.[artwork ? "image" : "website"]}
            label={artwork ? "Artwork model" : "Page writing model"}
            onChange={(profile) =>
              updateDraft({
                [artwork ? "image_profile_id" : "writing_profile_id"]: profile,
              })
            }
            details
          />
          <p className="refinement-save-note">
            {draft.editor
              ? "Your current website edits will be saved before this update is queued. "
              : "Your saved website remains available while this runs. "}
            Review the new output before applying it. Model loading can take
            several minutes.
          </p>
          {error && (
            <p role="alert" className="refinement-conflict">
              {error}
            </p>
          )}
          <div className="refinement-actions">
            <span>
              <LockKeyhole size={14} />
              Created on your machine
            </span>
            <button type="button" onClick={onClose}>
              Keep editing
            </button>
            <button
              className="primary"
              type="submit"
              disabled={!page || (value.instructions || "").trim().length < 10}
            >
              {busy ? "Saving and queuing…" : "Queue this update"}
              <ArrowRight size={16} />
            </button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}

function PageCopy({ page }) {
  if (!page) return <p>The original page is unavailable.</p>;
  return (
    <div className="refinement-document">
      <h3>{page.title}</h3>
      <p>{page.description}</p>
      {page.sections.map((section, i) => (
        <section key={i}>
          <h4>{section.heading}</h4>
          <p>{section.body}</p>
        </section>
      ))}
    </div>
  );
}

export function RefinementReview({
  run,
  currentRevision,
  unsaved,
  busy,
  error,
  onClose,
  onApply,
  onDiscard,
}) {
  const request = run.request;
  const artwork = request.kind === "section-artwork";
  const before = request.base_site?.pages?.find(
    (page) => page.slug === request.page_slug,
  );
  const after = run.result.pages.find(
    (page) => page.slug === request.page_slug,
  );
  const previousIds = before?.sections[request.section_index]?.asset_ids || [];
  const newImage = artwork
    ? after?.sections[request.section_index]?.asset_ids.find(
        (id) => !previousIds.includes(id),
      )
    : null;
  const stale = currentRevision !== request.base_revision;
  return (
    <Dialog
      title="Review your website update"
      subtitle={refinementName(run)}
      busy={busy}
      onClose={onClose}
    >
      <div className="refinement-comparison">
        <section aria-label="Original output">
          <span className="eyebrow">BEFORE · SAVED WHEN QUEUED</span>
          {artwork ? (
            request.asset_id ? (
              <img
                src={`/api/assets/${request.asset_id}`}
                alt="Original section artwork"
              />
            ) : (
              <div className="refinement-no-image">
                <ImageIcon size={32} />
                <p>Adding an image to this section</p>
                <small>Existing section media will stay in place.</small>
              </div>
            )
          ) : (
            <PageCopy page={before} />
          )}
        </section>
        <section aria-label="New output">
          <span className="eyebrow">AFTER · READY TO REVIEW</span>
          {artwork ? (
            newImage ? (
              <img src={`/api/assets/${newImage}`} alt="New section artwork" />
            ) : (
              <p>
                New artwork is unavailable. Keep your current website and try
                again.
              </p>
            )
          ) : (
            <PageCopy page={after} />
          )}
        </section>
      </div>
      <details>
        <summary>Your instructions</summary>
        <p className="refinement-instructions">{request.instructions}</p>
      </details>
      {(stale || unsaved) && (
        <p role="status" className="refinement-conflict">
          {stale
            ? "Your saved website changed after this update was queued. Applying is disabled to protect the newer version. Start a new update from the current page or section."
            : "You have newer editor changes. Save them, then start a new update from that version. Applying is disabled to protect your edits."}
        </p>
      )}
      {error && (
        <p role="alert" className="refinement-conflict">
          {error}
        </p>
      )}
      <p className="refinement-save-note">
        {artwork
          ? "Applying changes only this section’s selected artwork. Your original image stays in the project library."
          : "Applying changes only this page’s copy. Its media, links and other pages are preserved."}
      </p>
      <div className="refinement-actions">
        <button type="button" disabled={busy} onClick={onDiscard}>
          Discard update
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          Review later
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || stale || unsaved || (artwork && !newImage)}
          onClick={onApply}
        >
          <RefreshCw size={15} />
          Apply this update
        </button>
      </div>
    </Dialog>
  );
}
