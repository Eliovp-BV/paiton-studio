import React, { useState } from "react";
import WorkspaceDialog from "./WorkspaceDialog";
import { destinationName } from "./workspaceLinks";

export default function TransferReview({ source, onApply, onClose }) {
  const [filename, setFilename] = useState(source.filename || "result.txt");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function apply(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onApply({ ...source, filename: filename.trim() });
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  const destination = destinationName(source.target);
  return (
    <WorkspaceDialog
      title={`Continue in ${destination}`}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={apply}>
        <p className="workspace-source-note">
          From {source.title || "a saved result"} · {source.project_name}
        </p>
        {source.kind === "image" ? (
          <img
            src={`/api/assets/${source.asset_id}`}
            alt={source.title || "Selected image"}
          />
        ) : (
          <pre>{source.text}</pre>
        )}
        {source.target === "coding" && (
          <label>
            New file name
            <input
              aria-label="Result file name"
              value={filename}
              maxLength={240}
              onChange={(event) => setFilename(event.target.value)}
              required
            />
          </label>
        )}
        <p>
          {source.target === "coding"
            ? "Opens a new, unsaved file draft. Review it in Coding and save when ready. Existing files keep their contents."
            : source.target === "chat"
              ? "Attaches this saved result to your next Chat draft. Review the selected excerpts in Request context before sending."
              : source.target === "write"
                ? "Adds this text to your Writing draft. Your existing draft text is kept, and the original result stays in the project."
                : source.target === "image"
                  ? "Opens this original in Image editing. Describe your changes and review the profile before generating a separate result."
                  : "Selects this image as the source in Video. Review the video settings before generating."}
        </p>
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={busy || (source.target === "coding" && !filename.trim())}
          >
            {busy ? "Opening…" : `Open ${destination} draft`}
          </button>
        </div>
      </form>
    </WorkspaceDialog>
  );
}
