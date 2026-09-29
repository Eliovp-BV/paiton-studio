import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Bell,
  Check,
  CheckCheck,
  ChevronRight,
  RefreshCw,
  X,
} from "lucide-react";
import "./completion-inbox.css";

const statusLabel = {
  completed: "Ready",
  failed: "Failed",
  cancelled: "Stopped",
  needs_attention: "Review needed",
  applied: "Applied",
  discarded: "Discarded",
};

export default function CompletionInbox({
  api,
  project,
  onOpen,
  report,
  embedded = false,
  onUnread,
  onNavigate,
}) {
  const [open, setOpen] = useState(embedded),
    [scope, setScope] = useState("all"),
    [result, setResult] = useState(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [acting, setActing] = useState(false);
  const root = useRef(null),
    trigger = useRef(null),
    mounted = useRef(false),
    sequence = useRef(0),
    operation = useRef(false),
    current = useRef(null),
    callbacks = useRef({ api, onOpen, report });
  callbacks.current = { api, onOpen, report };
  const projectId = scope === "project" ? project?.id || null : null;
  const identity = projectId || "all";
  current.current = identity;
  const panelId = useId();
  const data = result?.identity === identity ? result.value : null;
  const events = data?.events || [];
  useEffect(() => {
    onUnread?.(data?.unread || 0);
  }, [data?.unread, onUnread]);

  const refresh = useCallback(
    async (quiet = false) => {
      if (operation.current) return;
      const request = ++sequence.current;
      if (!quiet) setLoading(true);
      try {
        const value = await callbacks.current.api(
          `/inbox${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ""}`,
        );
        if (
          !mounted.current ||
          request !== sequence.current ||
          current.current !== identity
        )
          return;
        setResult({ identity, value });
        setError("");
      } catch (failure) {
        if (
          mounted.current &&
          request === sequence.current &&
          current.current === identity
        )
          setError(failure.message || "The inbox could not be loaded.");
      } finally {
        if (
          mounted.current &&
          request === sequence.current &&
          current.current === identity
        )
          setLoading(false);
      }
    },
    [identity, projectId],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, []);
  useEffect(() => {
    sequence.current++;
    setError("");
    setLoading(false);
    refresh();
    // Completion status is useful while browsing; only this bounded metadata
    // endpoint is polled, and hidden tabs perform no background requests.
    const timer = setInterval(
      () => {
        if (!document.hidden) refresh(true);
      },
      open ? 10000 : 30000,
    );
    const visible = () => {
      if (!document.hidden) refresh(true);
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      sequence.current++;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh, open]);
  useEffect(() => {
    if (!open || embedded) return;
    const outside = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    const keyboard = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keyboard);
    };
  }, [open, embedded]);

  async function act(items, navigate = false) {
    if (operation.current || !items.length) return;
    operation.current = true;
    sequence.current++;
    setActing(true);
    setError("");
    const requested = identity;
    try {
      if (navigate) {
        if (!callbacks.current.onOpen)
          throw Error("This result cannot be opened here yet.");
        if ((await callbacks.current.onOpen(items[0].target)) === false) return;
      }
      const unread = items.filter((item) => !item.read).map((item) => item.id);
      if (unread.length) {
        const value = await callbacks.current.api("/inbox/read", {
          event_ids: unread,
        });
        const read = new Set(value.read_ids);
        if (mounted.current)
          setResult((previous) => {
            if (previous?.identity !== requested) return previous;
            const updated = previous.value.events.map((event) =>
              read.has(event.id) ? { ...event, read: true } : event,
            );
            return {
              ...previous,
              value: {
                ...previous.value,
                events: updated,
                unread: updated.filter((event) => !event.read).length,
              },
            };
          });
        if (value.unavailable_ids.length)
          callbacks.current.report?.(
            "Some outcomes changed. Refresh the inbox to see their current status.",
          );
      }
      if (mounted.current && navigate) {
        if (!embedded) setOpen(false);
        onNavigate?.();
      }
    } catch (failure) {
      if (mounted.current && requested === current.current)
        setError(
          failure.message ||
            "The outcome could not be opened or marked as read.",
        );
      else
        callbacks.current.report?.(
          failure.message || "The outcome remains unread.",
        );
    } finally {
      operation.current = false;
      if (mounted.current) {
        setActing(false);
        setLoading(false);
      }
    }
  }

  return (
    <div
      className={"completion-inbox" + (embedded ? " embedded" : "")}
      ref={root}
    >
      {!embedded && (
        <button
          type="button"
          ref={trigger}
          className="completion-inbox-trigger"
          aria-label={`Completion inbox${data?.unread ? `, ${data.unread} unread in recent outcomes` : ""}`}
          aria-expanded={open}
          aria-controls={panelId}
          title="Recent completed and stopped work"
          onClick={() => setOpen((value) => !value)}
        >
          <Bell size={17} />
          <span className="completion-inbox-label">Inbox</span>
          {!!data?.unread && (
            <span className="completion-inbox-badge">{data.unread}</span>
          )}
        </button>
      )}
      {(embedded || open) && (
        <section
          className="completion-inbox-panel"
          id={panelId}
          aria-label="Completion inbox"
        >
          <header>
            <div>
              <strong>Completion inbox</strong>
              <p>Saved outcomes across Studio.</p>
            </div>
            {!embedded && (
              <button
                type="button"
                aria-label="Close completion inbox"
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                }}
              >
                <X size={16} />
              </button>
            )}
          </header>
          <div className="completion-inbox-controls">
            <label>
              Show
              <select
                aria-label="Inbox projects"
                value={scope}
                onChange={(event) => setScope(event.target.value)}
                disabled={acting}
              >
                <option value="all">All projects</option>
                <option value="project" disabled={!project?.id}>
                  Current project
                </option>
              </select>
            </label>
            <button
              type="button"
              aria-label="Refresh completion inbox"
              disabled={loading || acting}
              onClick={() => refresh()}
            >
              <RefreshCw size={14} />
            </button>
            <button
              type="button"
              disabled={!data?.unread || acting}
              onClick={() => act(events)}
            >
              <CheckCheck size={14} />
              Mark shown as read
            </button>
          </div>
          {error && (
            <div className="completion-inbox-error" role="alert">
              <p>{error}</p>
              <button
                type="button"
                disabled={acting || loading}
                onClick={() => refresh()}
              >
                Retry inbox
              </button>
            </div>
          )}
          {loading && !data && <p role="status">Loading saved outcomes…</p>}
          {data && !events.length && !error && (
            <div className="completion-inbox-empty">
              <CheckCheck size={23} />
              <strong>No completed or stopped work yet</strong>
              <p>
                Saved replies, creations, agent runs and website drafts appear
                here when ready or stopped.
              </p>
            </div>
          )}
          {!!events.length && (
            <ol className="completion-inbox-events">
              {events.map((event) => (
                <li
                  key={event.id}
                  className={event.read ? "" : "completion-inbox-unread"}
                >
                  <button
                    type="button"
                    className="completion-inbox-open"
                    disabled={acting}
                    onClick={() => act([event], true)}
                  >
                    <span className="completion-inbox-event-title">
                      <strong>{event.title}</strong>
                      <ChevronRight size={14} />
                    </span>
                    <span>{event.summary}</span>
                    <span className="completion-inbox-meta">
                      <span
                        className={`completion-inbox-state completion-inbox-state-${event.state}`}
                      >
                        {statusLabel[event.state] || event.state}
                      </span>
                      <span>{event.project_name}</span>
                      <time
                        dateTime={new Date(event.updated * 1000).toISOString()}
                      >
                        {new Date(event.updated * 1000).toLocaleString()}
                      </time>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="completion-inbox-read"
                    aria-label={`Mark ${event.title} as read`}
                    disabled={event.read || acting}
                    title={event.read ? "Read" : "Mark as read"}
                    onClick={() => act([event])}
                  >
                    <Check size={15} />
                    {event.read ? "Read" : "Mark read"}
                  </button>
                </li>
              ))}
            </ol>
          )}
          <footer>
            Latest {data?.limit || 100} saved outcomes in this view.{" "}
            {data ? `${data.unread} unread.` : ""}
            {data?.has_more
              ? " Older work remains in each workspace and the queue."
              : ""}
          </footer>
        </section>
      )}
    </div>
  );
}
