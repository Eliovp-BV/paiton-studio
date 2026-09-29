import React, { useEffect, useRef, useState } from "react";
import { Eye, RefreshCw } from "lucide-react";
import "./context-inspector.css";

const count = (value) =>
  value == null
    ? "unknown"
    : Array.isArray(value)
      ? value.length
      : Number(value);
const characters = (value) => [...String(value || "")].length;
const name = (source) =>
  String(source.name || source.path || source.id || "Source")
    .split(/[\\/]/)
    .at(-1);
export function contextSnapshot(request) {
  if (!request) return null;
  const kind = request.kind || (request.task === "image" ? "image" : "text");
  const messages =
    request.messages ||
    (kind === "image" ? [{ role: "user", content: request.prompt || "" }] : []);
  return {
    ...request,
    kind,
    messages,
    history: request.history ||
      request.context_history || {
        included_turns:
          request.history_messages == null
            ? null
            : Number(request.history_messages) / 2,
        omitted_turns: null,
        excerpted: Boolean(request.history_excerpted),
      },
    characters:
      request.characters ??
      request.context_characters ??
      messages.reduce(
        (total, message) => total + characters(message.content),
        0,
      ),
  };
}

export default function ContextInspector({
  api,
  endpoint,
  body,
  disabled = false,
  onChange,
  onBusyChange,
  snapshot = null,
  load = null,
}) {
  const identity = JSON.stringify([endpoint, body]);
  const [result, setResult] = useState(null),
    [pending, setPending] = useState(null),
    [failure, setFailure] = useState(null),
    [loaded, setLoaded] = useState(null),
    [loadingSaved, setLoadingSaved] = useState(false);
  const sequence = useRef(0),
    current = useRef(identity),
    mounted = useRef(true);
  const callbacks = useRef({ onChange, onBusyChange });
  callbacks.current = { onChange, onBusyChange };
  current.current = identity;
  const liveResult = result?.identity === identity ? result.value : null;
  // Compact polling omits saved message text; it is fetched on request.
  const value = contextSnapshot(
    snapshot ? (loaded ? { ...snapshot, ...loaded } : snapshot) : liveResult,
  );
  const savedTextMissing = Boolean(
    snapshot &&
      load &&
      !snapshot.messages &&
      !loaded &&
      value?.kind !== "image",
  );
  async function loadSaved() {
    if (loadingSaved || !load) return;
    setLoadingSaved(true);
    setFailure(null);
    try {
      const data = await load();
      if (mounted.current) setLoaded(data);
    } catch (error) {
      if (mounted.current)
        setFailure({ identity, message: error.message || String(error) });
    } finally {
      if (mounted.current) setLoadingSaved(false);
    }
  }
  const loading = pending === identity;
  const error = failure?.identity === identity ? failure.message : "";
  useEffect(() => {
    ++sequence.current;
    setPending(null);
    callbacks.current.onChange?.(null);
    callbacks.current.onBusyChange?.(false);
  }, [identity]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ++sequence.current;
    };
  }, []);
  useEffect(() => () => callbacks.current.onBusyChange?.(false), []);
  async function preview() {
    if (disabled || loading || snapshot || !endpoint) return;
    const attempt = ++sequence.current,
      requested = identity;
    setPending(requested);
    setResult(null);
    setFailure(null);
    callbacks.current.onChange?.(null);
    callbacks.current.onBusyChange?.(true);
    try {
      const data = await api(endpoint, body);
      if (
        !mounted.current ||
        attempt !== sequence.current ||
        current.current !== requested
      )
        return;
      setResult({ identity: requested, value: data });
      callbacks.current.onChange?.(data.fingerprint || null);
    } catch (error) {
      if (
        mounted.current &&
        attempt === sequence.current &&
        current.current === requested
      ) {
        setResult(null);
        setFailure({
          identity: requested,
          message: error.message || String(error),
        });
      }
    } finally {
      if (
        mounted.current &&
        attempt === sequence.current &&
        current.current === requested
      ) {
        setPending(null);
        callbacks.current.onBusyChange?.(false);
      }
    }
  }
  return (
    <details className="context-inspector">
      <summary>
        <Eye size={14} />
        {snapshot ? "Context used for this reply" : "Request context"}
      </summary>
      <div className="context-inspector-body">
        {!snapshot && (
          <>
            <p>
              Preview the exact text prepared for your next request. This does
              not run a model or create a conversation.
            </p>
            <button
              type="button"
              disabled={disabled || loading}
              onClick={preview}
            >
              {value ? <RefreshCw size={13} /> : <Eye size={13} />}
              {loading
                ? "Preparing preview…"
                : value
                  ? "Refresh context preview"
                  : "Preview context"}
            </button>
          </>
        )}
        {error && (
          <p className="context-inspector-error" role="alert">
            {error}
          </p>
        )}
        {value && (
          <>
            <div className="context-inspector-summary" role="status">
              <strong>
                {Number(value.characters).toLocaleString()} characters
              </strong>
              <span>
                {value.messages.length} message
                {value.messages.length === 1 ? "" : "s"}
              </span>
              {!snapshot && (
                <span>Preview ready · verified again when sent</span>
              )}
            </div>
            {value.kind === "image" ? (
              <p>
                Image request: prompt only. Chat history, documents, response
                instructions and project brief are excluded.
              </p>
            ) : (
              <>
                <p>
                  History: {count(value.history?.included_turns)} earlier turns
                  included; {count(value.history?.omitted_turns)} omitted.
                  {value.history?.excerpted
                    ? " Some earlier messages were excerpted; full messages remain saved."
                    : ""}
                </p>
                <p>
                  {value.project_brief
                    ? `Project brief included · revision ${value.project_brief.revision}`
                    : "Project brief excluded."}
                </p>
                {value.sources?.length ? (
                  <ul className="context-inspector-sources">
                    {value.sources.map((source, index) => (
                      <li key={source.id || index}>
                        {name(source)} ·{" "}
                        {source.sha256
                          ? `complete saved version ${source.sha256.slice(0, 8)}${source.characters ? ` · ${Number(source.characters).toLocaleString()} characters` : ""}`
                          : source.excerpts?.length
                            ? `included excerpts ${source.excerpts.join(", ")}`
                            : "no excerpts included"}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No documents included.</p>
                )}
              </>
            )}
            <div
              className="context-inspector-messages"
              aria-label={
                snapshot
                  ? "Saved request messages"
                  : "Prepared request messages"
              }
            >
              {value.messages.map((message, index) => (
                <details
                  key={index}
                  open={value.messages.length === 1 || undefined}
                >
                  <summary>
                    {index + 1}.{" "}
                    {{
                      system: "System instructions",
                      user: "User message",
                      assistant: "Earlier assistant reply",
                    }[message.role] || message.role}{" "}
                    · {characters(message.content).toLocaleString()} characters
                  </summary>
                  <pre>{String(message.content || "")}</pre>
                </details>
              ))}
              {!value.messages.length && savedTextMissing && (
                <button
                  type="button"
                  disabled={loadingSaved}
                  onClick={loadSaved}
                >
                  <Eye size={13} />
                  {loadingSaved
                    ? "Loading saved text…"
                    : "Show saved request text"}
                </button>
              )}
              {!value.messages.length && !savedTextMissing && (
                <p>
                  The exact request text is unavailable for this older reply.
                </p>
              )}
            </div>
            <p className="context-inspector-note">
              Character counts describe text, not model tokens.
              {snapshot
                ? " This is the saved request snapshot; later edits do not change it."
                : " Edit the request to clear this preview, or refresh to check changes saved elsewhere."}
            </p>
          </>
        )}
      </div>
    </details>
  );
}
