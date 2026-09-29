import React, { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import "./workspace-links.css";

export default function WorkspaceDialog({
  title,
  onClose,
  children,
  wide = false,
  busy = false,
}) {
  const dialog = useRef(null),
    heading = useId();
  const close = useRef(onClose),
    pending = useRef(busy);
  close.current = onClose;
  pending.current = busy;
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    const keyboard = (event) => {
      if (event.key === "Escape" && !pending.current) {
        event.preventDefault();
        event.stopPropagation();
        close.current?.();
      }
      if (event.key === "Tab") {
        const items = [
          ...dialog.current.querySelectorAll(
            "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary",
          ),
        ].filter((item) => item.getClientRects().length);
        const first = items[0],
          last = items.at(-1);
        if (!first) {
          event.preventDefault();
          return;
        }
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === dialog.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            document.activeElement === dialog.current)
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    dialog.current?.addEventListener("keydown", keyboard);
    const element = dialog.current;
    return () => {
      element?.removeEventListener("keydown", keyboard);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="workspace-dialog-backdrop">
      <section
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={heading}
        className={`workspace-dialog${wide ? " wide" : ""}`}
      >
        <header>
          <h2 id={heading}>{title}</h2>
          <button
            type="button"
            aria-label={`Close ${title}`}
            onClick={onClose}
            disabled={busy}
          >
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
