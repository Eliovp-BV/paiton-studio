import React, { useEffect, useId, useRef, useState } from "react";
import { FileText, Save, RefreshCw } from "lucide-react";
import "./project-brief.css";

// Keep unsaved edits across workspace navigation, scoped to this project/session.
const drafts = new Map();

export default function ProjectBrief({
  project,
  api,
  value = null,
  onChange,
  onBusyChange,
  disabled = false,
  selection = true,
}) {
  const identity = project?.id;
  const [saved, setSaved] = useState(null);
  const [draftBase, setDraftBase] = useState(null);
  const [needsReview, setNeedsReview] = useState(false);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const sequence = useRef(0),
    mounted = useRef(false),
    draftRef = useRef("");
  const callbacks = useRef({ onChange, onBusyChange });
  callbacks.current = { onChange, onBusyChange };
  draftRef.current = draft;
  const noteId = useId();
  const dirty = Boolean(draftBase) && draft !== draftBase.content;
  const included = selection && value !== null;
  const stale = included && saved && value !== saved.revision;
  const blocked =
    included &&
    (loading ||
      saving ||
      dirty ||
      needsReview ||
      stale ||
      !saved ||
      !saved.content.trim());

  async function load(preserveDraft = false) {
    const attempt = ++sequence.current;
    setLoading(true);
    if (included) callbacks.current.onBusyChange?.(true);
    setError("");
    try {
      const result = await api(`/projects/${identity}/brief`);
      if (!mounted.current || attempt !== sequence.current) return;
      setSaved(result);
      const cached = drafts.get(identity);
      const next = preserveDraft
        ? draftRef.current
        : cached?.dirty
          ? cached.content
          : result.content;
      const base =
        !preserveDraft && cached?.dirty && cached.base ? cached.base : result;
      const changed =
        base.revision !== result.revision || base.content !== result.content;
      setDraft(next);
      setDraftBase(base);
      setNeedsReview(changed);
      drafts.set(identity, {
        content: next,
        dirty: next !== base.content,
        base,
      });
      if (preserveDraft)
        setNotice(
          "Saved revision reloaded. Your edits are kept; review them before saving.",
        );
    } catch (failure) {
      if (mounted.current && attempt === sequence.current)
        setError(failure.message || String(failure));
    } finally {
      if (mounted.current && attempt === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    setSaved(null);
    setDraftBase(null);
    setNeedsReview(false);
    setDraft(drafts.get(identity)?.content || "");
    setNotice("");
    load();
    return () => {
      mounted.current = false;
      ++sequence.current;
    };
  }, [identity]);
  useEffect(() => {
    callbacks.current.onBusyChange?.(Boolean(blocked));
  }, [Boolean(blocked)]);
  useEffect(() => () => callbacks.current.onBusyChange?.(false), []);

  function edit(content) {
    setDraft(content);
    setNotice("");
    callbacks.current.onBusyChange?.(
      Boolean(
        included &&
          (content !== draftBase?.content ||
            needsReview ||
            stale ||
            !saved?.content?.trim()),
      ),
    );
    drafts.set(identity, {
      content,
      dirty: content !== draftBase?.content,
      base: draftBase,
    });
    if (drafts.size > 50) drafts.delete(drafts.keys().next().value);
  }
  async function save() {
    if (
      !saved ||
      !draftBase ||
      !dirty ||
      needsReview ||
      saving ||
      loading ||
      disabled
    )
      return;
    const attempt = ++sequence.current,
      content = draft,
      submittedCache = drafts.get(identity);
    setSaving(true);
    if (included) callbacks.current.onBusyChange?.(true);
    setError("");
    setNotice("");
    try {
      const result = await api(
        `/projects/${identity}/brief`,
        { content, expected_revision: draftBase.revision },
        "PUT",
      );
      if (!mounted.current || attempt !== sequence.current) return;
      setSaved(result);
      setDraftBase(result);
      setNeedsReview(false);
      setDraft(result.content);
      if (drafts.get(identity) === submittedCache)
        drafts.set(identity, {
          content: result.content,
          dirty: false,
          base: result,
        });
      if (included)
        callbacks.current.onChange?.(
          result.content.trim() ? result.revision : null,
        );
      setNotice(`Project brief saved · revision ${result.revision}.`);
    } catch (failure) {
      if (mounted.current && attempt === sequence.current)
        setError(failure.message || String(failure));
    } finally {
      if (mounted.current && attempt === sequence.current) setSaving(false);
    }
  }

  return (
    <section className="project-brief" aria-label="Project brief">
      <div className="project-brief-heading">
        <strong>
          <FileText size={14} />
          Project brief
        </strong>
        {selection && onChange && (
          <label className="project-brief-include">
            <input
              type="checkbox"
              checked={included}
              aria-describedby={noteId}
              disabled={
                disabled ||
                loading ||
                saving ||
                (!included && (dirty || needsReview || !saved?.content?.trim()))
              }
              onChange={(event) => {
                callbacks.current.onBusyChange?.(
                  Boolean(
                    event.target.checked &&
                      (dirty ||
                        needsReview ||
                        loading ||
                        saving ||
                        !saved?.content?.trim()),
                  ),
                );
                callbacks.current.onChange?.(
                  event.target.checked ? saved.revision : null,
                );
                setNotice("");
              }}
            />
            Include project brief
          </label>
        )}
      </div>
      <p id={noteId} className="project-brief-description">
        Shared notes for {project?.name || "this project"}.{" "}
        {selection
          ? included
            ? `Selected revision ${value} for the next request.`
            : "Excluded from requests until you choose to include it."
          : "Choose whether to include this brief in Chat, Coding or an agent run."}
      </p>
      {included && dirty && (
        <p className="project-brief-warning" role="status">
          Save or discard these edits before sending with the brief.
        </p>
      )}
      {needsReview && (
        <p className="project-brief-warning" role="alert">
          The saved brief changed from revision {draftBase?.revision} to{" "}
          {saved?.revision} while your draft was open. Your edits are kept.
          Compare the saved text, then reload its revision or discard your edits
          before saving.
        </p>
      )}
      {stale && !loading && (
        <div className="project-brief-warning" role="status">
          The shared brief is now revision {saved.revision}. Review it before
          including the updated version.
          <button
            type="button"
            disabled={
              disabled ||
              dirty ||
              needsReview ||
              saving ||
              !saved.content.trim()
            }
            onClick={() => callbacks.current.onChange?.(saved.revision)}
          >
            Use saved revision {saved.revision}
          </button>
        </div>
      )}
      <details open={!selection || undefined}>
        <summary>
          {saved?.content
            ? "Read or edit project brief"
            : "Write a project brief"}
          {dirty ? " · unsaved" : saved ? ` · revision ${saved.revision}` : ""}
        </summary>
        <div className="project-brief-editor">
          <p>
            Describe the goal, audience, constraints and terms to use. Keep
            reusable project facts here; attach longer source documents
            separately.
          </p>
          {loading && <p role="status">Loading project brief…</p>}
          <label>
            Shared project notes
            <textarea
              aria-label="Shared project notes"
              rows={5}
              maxLength={4000}
              value={draft}
              disabled={disabled || loading || saving || !saved}
              onChange={(event) => edit(event.target.value)}
              placeholder="Goal: …\nAudience: …\nConstraints: …"
            />
          </label>
          {(dirty || needsReview) && saved && (
            <details className="project-brief-comparison">
              <summary>Current saved brief · revision {saved.revision}</summary>
              <pre>{saved.content || "No saved notes."}</pre>
            </details>
          )}
          <div className="project-brief-actions">
            <small>{draft.length.toLocaleString()} / 4,000 characters</small>
            <button
              type="button"
              disabled={disabled || !dirty || needsReview || loading || saving}
              onClick={save}
            >
              <Save size={13} />
              {saving ? "Saving…" : "Save project brief"}
            </button>
            {(dirty || needsReview) && (
              <button
                type="button"
                disabled={disabled || loading || saving}
                onClick={() => {
                  setDraft(saved.content);
                  setDraftBase(saved);
                  setNeedsReview(false);
                  drafts.set(identity, {
                    content: saved.content,
                    dirty: false,
                    base: saved,
                  });
                  setNotice("");
                  setError("");
                }}
              >
                Discard brief edits
              </button>
            )}
            <button
              type="button"
              disabled={disabled || loading || saving}
              onClick={() => load(dirty || needsReview)}
            >
              <RefreshCw size={13} />
              Reload saved brief
            </button>
          </div>
        </div>
      </details>
      {error && (
        <div className="project-brief-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            disabled={disabled || loading || saving}
            onClick={() => load(dirty || needsReview)}
          >
            Reload saved brief
          </button>
        </div>
      )}
      {notice && (
        <p className="project-brief-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
