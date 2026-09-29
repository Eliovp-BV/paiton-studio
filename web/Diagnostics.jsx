import React, { useEffect, useRef, useState } from "react";
import { Copy, RefreshCw } from "lucide-react";
import { copyText } from "./codeWorkspace";
import "./diagnostics.css";

export default function Diagnostics({ api, endpoint }) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [manualCopy, setManualCopy] = useState(false);
  const copyGeneration = useRef(0);
  const data = record?.endpoint === endpoint ? record.data : null;

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setCopying(false);
    setError("");
    setRecord(null);
    setCopied(false);
    setManualCopy(false);
    Promise.resolve()
      .then(() => api(endpoint))
      .then((value) => {
        if (active) setRecord({ endpoint, data: value });
      })
      .catch(() => {
        if (active) setError("Details could not be loaded. Try again.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      copyGeneration.current += 1;
    };
  }, [open, endpoint, attempt, api]);

  async function copy() {
    const generation = ++copyGeneration.current;
    setCopying(true);
    setCopied(false);
    setManualCopy(false);
    try {
      await copyText(data.copy_text);
      if (generation === copyGeneration.current) setCopied(true);
    } catch {
      if (generation === copyGeneration.current) setManualCopy(true);
    } finally {
      if (generation === copyGeneration.current) setCopying(false);
    }
  }

  return (
    <details
      className="studio-diagnostics"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Show details</summary>
      {loading && (
        <p className="helper" role="status">
          Loading details…
        </p>
      )}
      {error && (
        <div className="diagnostics-error" role="alert">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            <RefreshCw size={13} /> Try again
          </button>
        </div>
      )}
      {data && (
        <>
          {data.log?.available ? (
            <>
              {data.log.truncated && (
                <p className="helper">Showing the last portion of the log.</p>
              )}
              <pre tabIndex={0} aria-label="Diagnostics log">
                {data.log.text}
              </pre>
            </>
          ) : (
            <p className="helper">No log was saved for this request.</p>
          )}
          <div className="diagnostics-actions">
            <button
              type="button"
              disabled={copying || !data.copy_text}
              onClick={copy}
            >
              <Copy size={13} /> {copying ? "Copying…" : "Copy diagnostics"}
            </button>
            {copied && <span role="status">Diagnostics copied.</span>}
          </div>
          {manualCopy && (
            <div className="diagnostics-manual-copy">
              <p role="status">
                Copy was blocked. Select the diagnostics below and copy them.
              </p>
              <textarea
                aria-label="Diagnostics to copy"
                readOnly
                value={data.copy_text}
                onFocus={(event) => event.target.select()}
              />
            </div>
          )}
        </>
      )}
    </details>
  );
}
