import React, { useEffect, useRef, useState } from "react";
import { Search, X, ArrowUpRight, Archive } from "lucide-react";
import "./project-search.css";

const labels = {
  chat: "Conversation",
  agent: "Agent result",
  document: "Document",
  asset: "Asset",
  code: "Code",
};
const coverageNotes = {
  result_limit:
    "More matches exist than can be displayed. A more specific phrase may help.",
  field_match_limit: "Repeated matches within the same text are shortened.",
  item_limit:
    "Only the most recent saved messages, agent results or Library entries were searched. Older items remain available in their workspace.",
  text_limit: "The text size limit was reached; later items were not searched.",
  code_workspace_limit:
    "Only code within Studio’s managed workspace limits was searched.",
  excluded_or_changed:
    "Some private, unreadable or changed items were excluded.",
};
function Snippet({ text, highlights }) {
  const pieces = [];
  let end = 0;
  for (const [start, stop] of highlights || []) {
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(stop) ||
      start < end ||
      stop <= start ||
      stop > text.length
    )
      continue;
    pieces.push(
      text.slice(end, start),
      <mark key={`${start}:${stop}`}>{text.slice(start, stop)}</mark>,
    );
    end = stop;
  }
  pieces.push(text.slice(end));
  return <span className="project-search-snippet">{pieces}</span>;
}

export default function ProjectSearch({ project, api, onOpen, report }) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const [result, setResult] = useState(null),
    [pending, setPending] = useState(null),
    [error, setError] = useState("");
  const [opening, setOpening] = useState(null);
  const modal = useRef(null),
    field = useRef(null),
    trigger = useRef(null),
    mounted = useRef(true),
    sequence = useRef(0);
  const identity = JSON.stringify([project?.id, query]);
  const current = useRef(identity);
  current.current = identity;
  const callbacks = useRef({ onOpen, report });
  callbacks.current = { onOpen, report };
  const data = result?.identity === identity ? result.value : null;
  const searching = pending === identity;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, []);
  useEffect(() => {
    sequence.current++;
    setOpen(false);
    setQuery("");
    setResult(null);
    setPending(null);
    setError("");
    setOpening(null);
  }, [project?.id]);
  useEffect(() => {
    const shortcut = (event) => {
      if (
        project &&
        event.shiftKey &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => field.current?.focus());
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [project?.id]);
  useEffect(() => {
    if (open && modal.current && !modal.current.open) {
      modal.current.showModal();
      field.current?.focus();
    } else if (!open && modal.current?.open) {
      modal.current.close();
      trigger.current?.focus();
    }
  }, [open]);
  function close() {
    sequence.current++;
    setOpen(false);
    setPending(null);
    setOpening(null);
  }
  function change(value) {
    sequence.current++;
    setQuery(value);
    setResult(null);
    setPending(null);
    setError("");
  }
  async function search(event) {
    event.preventDefault();
    if (!project || !query.trim() || searching || opening) return;
    const requested = identity,
      attempt = ++sequence.current;
    setPending(requested);
    setResult(null);
    setError("");
    try {
      const value = await api(
        `/projects/${project.id}/search?q=${encodeURIComponent(query)}`,
      );
      if (
        mounted.current &&
        attempt === sequence.current &&
        current.current === requested
      )
        setResult({ identity: requested, value });
    } catch (failure) {
      if (
        mounted.current &&
        attempt === sequence.current &&
        current.current === requested
      )
        setError(failure.message || String(failure));
    } finally {
      if (
        mounted.current &&
        attempt === sequence.current &&
        current.current === requested
      )
        setPending(null);
    }
  }
  async function navigate(item) {
    if (opening || !callbacks.current.onOpen) return;
    const attempt = ++sequence.current,
      requested = identity;
    setOpening(item.id);
    setError("");
    try {
      const success = await callbacks.current.onOpen(item.target);
      if (
        !mounted.current ||
        attempt !== sequence.current ||
        current.current !== requested
      )
        return;
      if (success === false)
        throw Error(
          "This result could not be opened. Search again to refresh it.",
        );
      close();
    } catch (failure) {
      if (
        mounted.current &&
        attempt === sequence.current &&
        current.current === requested
      ) {
        setError(failure.message || String(failure));
        callbacks.current.report?.(failure);
      }
    } finally {
      if (
        mounted.current &&
        attempt === sequence.current &&
        current.current === requested
      )
        setOpening(null);
    }
  }
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className="project-search-trigger"
        disabled={!project}
        onClick={() => setOpen(true)}
        title="Search project · Ctrl/⌘ Shift K"
      >
        <Search size={16} /> Search project
      </button>
      <dialog
        ref={modal}
        className="project-search-dialog"
        aria-labelledby="project-search-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        <header>
          <div>
            <h2 id="project-search-title">
              Search {project?.name || "project"}
            </h2>
            <p>
              Saved chats, documents, agent answers, code and asset details.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close project search"
            onClick={close}
          >
            <X size={19} />
          </button>
        </header>
        <form onSubmit={search} className="project-search-form">
          <label>
            <span>Find text in this project</span>
            <input
              ref={field}
              type="search"
              value={query}
              maxLength={200}
              disabled={Boolean(opening)}
              onChange={(event) => change(event.target.value)}
              placeholder="A phrase, filename or idea you remember…"
            />
          </label>
          <button
            type="submit"
            className="primary"
            disabled={!query.trim() || searching || Boolean(opening)}
          >
            <Search size={15} /> {searching ? "Searching…" : "Search"}
          </button>
        </form>
        <p className="project-search-scope">
          Literal text search, ignoring letter case. Includes archived chats.
          Unsaved drafts, live replies, private files and external sources are
          excluded. No AI runs.
        </p>
        {error && (
          <p className="project-search-error" role="alert">
            {error}
          </p>
        )}
        {searching && <p role="status">Searching saved project content…</p>}
        {data && (
          <>
            <p className="project-search-summary" role="status">
              {data.results.length}{" "}
              {data.results.length === 1 ? "match" : "matches"} across{" "}
              {Object.values(data.searched).reduce(
                (total, value) => total + value,
                0,
              )}{" "}
              searched items.
              {data.partial
                ? " Results are partial; some items or additional matches were excluded. See Search coverage."
                : ""}
            </p>
            <details className="project-search-coverage">
              <summary>Search coverage</summary>
              <ul>
                {Object.entries(data.searched).map(([kind, count]) => (
                  <li key={kind}>
                    {labels[kind] || kind}: {count} searched
                  </li>
                ))}
              </ul>
              <p>
                Up to {data.limits.results} results and{" "}
                {data.limits.matches_per_field} matches per field. Code uses
                saved file revisions.
              </p>
              <p>
                Search covers up to {data.limits.items} items, with at most{" "}
                {data.limits.category_items ?? 300} messages, agent runs or
                Library entries per group, and{" "}
                {(data.limits.text_bytes / 1048576).toLocaleString()} MB of
                text.
              </p>
              {(data.partial_reasons || []).map(
                (reason) =>
                  coverageNotes[reason] && (
                    <p key={reason}>{coverageNotes[reason]}</p>
                  ),
              )}
              {Object.entries(data.skipped || {})
                .filter(([, count]) => count > 0)
                .map(([reason, count]) => (
                  <p key={reason}>
                    {reason.replaceAll("_", " ")}: {count} excluded
                  </p>
                ))}
            </details>
            {!data.results.length ? (
              <p className="project-search-empty">
                No matching saved text. Try a shorter phrase or check another
                project.
              </p>
            ) : (
              <ol className="project-search-results">
                {data.results.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      disabled={Boolean(opening)}
                      onClick={() => navigate(item)}
                    >
                      <span className="project-search-result-heading">
                        <strong>{item.title}</strong>
                        <ArrowUpRight size={15} />
                      </span>
                      <span className="project-search-result-meta">
                        {labels[item.source]} · {item.field}
                        {item.target.line ? ` · line ${item.target.line}` : ""}
                        {item.archived && (
                          <span>
                            <Archive size={12} /> Archived
                          </span>
                        )}
                        {opening === item.id ? " · Opening…" : ""}
                      </span>
                      <Snippet
                        text={item.snippet}
                        highlights={item.highlights}
                      />
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
        {!data && !searching && !error && (
          <p className="project-search-empty">
            Search by what you remember, then open the exact message, result or
            saved file.
          </p>
        )}
      </dialog>
    </>
  );
}
