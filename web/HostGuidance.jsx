import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

function useHostGuidance(api) {
  const [data, setData] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true,
      timer;
    const load = async () => {
      try {
        const result = await api("/host-guidance");
        if (active) {
          setData(result);
          setError("");
        }
      } catch {
        if (active)
          setError(
            "Studio could not check this host. Open System details to retry; hardware readiness is unknown.",
          );
      } finally {
        if (active) timer = setTimeout(load, 30000);
      }
    };
    load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api]);
  return { data, error };
}

export function HostNotice({ api, onDetails }) {
  const { data, error } = useHostGuidance(api);
  if (!error && !data?.needs_attention) return null;
  const warnings = data?.checks?.filter((c) => c.severity === "warning") || [];
  return (
    <div className="host-notice" role="status">
      <AlertTriangle size={20} />
      <div>
        <strong>
          {error
            ? "Host check unavailable"
            : warnings[0]?.title || "Review this Studio host"}
        </strong>
        <p>
          {error || warnings[0]?.message || data?.consumer_support?.message}
        </p>
        {!error && (
          <small>
            {warnings.length > 1
              ? `${warnings.length} host checks need attention. `
              : ""}
            Projects stay available. Setup help applies to the Studio host,
            including when you connect over the network.
          </small>
        )}
      </div>
      <button onClick={onDetails}>Review system setup</button>
    </div>
  );
}

export default function HostGuidance({ api }) {
  const { data, error } = useHostGuidance(api);
  const [result, setResult] = useState(null),
    [busy, setBusy] = useState(false);
  async function check() {
    setBusy(true);
    try {
      setResult(await api("/host-guidance/check-source", {}));
    } catch {
      setResult({
        state: "unavailable",
        message: "Online check unavailable. Your local tools are unaffected.",
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="host-guidance panel"
      aria-label="Host setup and driver guidance"
    >
      <span className="eyebrow">
        <ShieldCheck size={15} /> YOUR STUDIO HOST
      </span>
      <h2>System setup &amp; driver guidance</h2>
      <p className="helper">
        Local checks run automatically. Online checks below only run when you
        ask; no prompts or project files are sent.
      </p>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">Checking the local host…</p>}
      {data && (
        <>
          {data.consumer_support && (
            <div className={"host-check " + data.consumer_support.severity}>
              <strong>{data.consumer_support.title}</strong>
              <p>{data.consumer_support.message}</p>
              {data.consumer_support.memory_message && (
                <p>{data.consumer_support.memory_message}</p>
              )}
              <p className="helper">{data.consumer_support.platform_message}</p>
            </div>
          )}
          <div className="host-summary">
            <strong>
              {data.host.distribution || data.host.system} · {data.host.machine}
            </strong>
            <span>
              Kernel {data.host.release || "unknown"} · amdgpu{" "}
              {data.driver.version || "version not reported"}
            </span>
            <p>{data.note}</p>
            <p>{data.driver_policy}</p>
          </div>
          {data.checks.map((c) => (
            <div key={c.id} className={"host-check " + c.severity}>
              <strong>{c.title}</strong>
              <p>{c.message}</p>
            </div>
          ))}
          {!data.needs_attention && (
            <p className="host-ok">
              Host prerequisites detected. Model qualification is checked
              separately below.
            </p>
          )}
          <div className="actions">
            <a href={data.official_url} target="_blank" rel="noreferrer">
              AMD installation documentation <ExternalLink size={14} />
            </a>
          </div>
          <details className="host-source">
            <summary>Community setup guide · JoergR75</summary>
            <p>{data.source.advertised_stack}</p>
            <p>{data.source.qualification}</p>
            <p
              className={
                data.source.os_matches_documentation
                  ? "helper"
                  : "host-check warning"
              }
            >
              {data.source.os_message}
            </p>
            <p className="host-check warning">
              <strong>Review before making system changes.</strong>{" "}
              {data.source.warning}
            </p>
            <p className="helper">
              Studio does not execute this installer. Installation needs the
              host administrator, a maintenance window and a reviewed recovery
              plan. A browser visitor cannot grant host administrator access.
            </p>
            <div className="actions">
              <a
                href={data.source.reviewed_url}
                target="_blank"
                rel="noreferrer"
              >
                Open reviewed source <ExternalLink size={14} />
              </a>
              <button disabled={busy} onClick={check}>
                <RefreshCw size={14} />
                {busy ? "Checking GitHub…" : "Check community source online"}
              </button>
            </div>
            <p className="helper">
              Contacts GitHub from the Studio host. This compares repository
              revisions, not installed driver versions or upgrade safety. No
              files are installed.
            </p>
            {result && (
              <div role="status" className="host-source-result">
                <p>{result.message}</p>
                {result.checked_at && (
                  <small>
                    Checked {new Date(result.checked_at).toLocaleString()}
                    {result.cached ? " · recent cached check" : ""}
                  </small>
                )}
                {result.url && (
                  <a href={result.url} target="_blank" rel="noreferrer">
                    Inspect checked revision <ExternalLink size={14} />
                  </a>
                )}
              </div>
            )}
          </details>
        </>
      )}
    </section>
  );
}
