import React, { useEffect, useRef, useState } from "react";
import { copyText } from "./codeWorkspace";
import "./network-access.css";

export function PairingScreen({ api, enabled, onPaired, overlay = false }) {
  const card = useRef(null);
  useEffect(() => {
    if (!overlay) return;
    const trap = (event) => {
      if (event.key !== "Tab") return;
      const fields = [...card.current.querySelectorAll("input, button")].filter(
        (element) => !element.disabled,
      );
      const first = fields[0],
        last = fields.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    const element = card.current;
    element.addEventListener("keydown", trap);
    return () => element.removeEventListener("keydown", trap);
  }, [overlay]);
  const [code, setCode] = useState("");
  const [name, setName] = useState("My browser");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div
      className={overlay ? "pairing-overlay" : "pairing-startup"}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <section
        ref={card}
        className="panel pairing-card"
        role={overlay ? "dialog" : undefined}
        aria-modal={overlay || undefined}
        aria-labelledby="pairing-title"
      >
        <h1 id="pairing-title">Pair this browser</h1>
        <p>
          On the Studio host, open Studio using localhost, then Settings →
          Network access.
        </p>
        <p>
          {enabled
            ? "Enter the one-time pairing token shown there."
            : "Turn on “Allow other devices on my network” to create a pairing token."}
        </p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            try {
              await api.pair(code.trim(), name);
              setCode("");
              onPaired();
            } catch (failure) {
              setError(failure.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Browser name
            <input
              autoComplete="off"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Pairing token
            <input
              autoFocus
              type="password"
              autoComplete="one-time-code"
              value={code}
              maxLength={128}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <button className="primary" disabled={busy || !code.trim()}>
            {busy ? "Pairing…" : "Pair browser"}
          </button>
        </form>
        <p className="helper">
          Your Studio projects stay on the host. Paired browsers can use them
          and run local jobs.
        </p>
      </section>
    </div>
  );
}

export default function NetworkAccess({ api }) {
  const [value, setValue] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    api("/network-access")
      .then((result) => {
        if (active) {
          setValue(result);
          setError("");
        }
      })
      .catch((failure) => {
        if (active) setError(failure.message);
      });
    return () => {
      active = false;
    };
  }, [api, attempt]);
  async function update(path, body, method) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await api(path, body, method);
      setValue((previous) =>
        method === "GET" &&
        previous?.pairing_token &&
        next.pairing_expires === previous.pairing_expires
          ? { ...next, pairing_token: previous.pairing_token }
          : next,
      );
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel network-access" aria-label="Network access">
      <h2>Network access</h2>
      {error && (
        <p role="alert">
          {error}{" "}
          <button onClick={() => setAttempt((n) => n + 1)}>Refresh</button>
        </p>
      )}
      {!value && !error && <p role="status">Loading network access…</p>}
      {value?.local_owner === false && (
        <p>Manage paired browsers from Studio on the host using localhost.</p>
      )}
      {value?.local_owner && (
        <>
          <label className="preference-row">
            <span>
              <strong>Allow other devices on my network</strong>
              <small>
                Each browser needs a one-time token. Turning this off revokes
                every paired browser.
              </small>
            </span>
            <input
              type="checkbox"
              checked={value.enabled}
              disabled={busy}
              onChange={(event) =>
                update(
                  "/network-access",
                  { enabled: event.target.checked },
                  "PUT",
                )
              }
            />
          </label>
          {value.enabled && (
            <>
              <button
                disabled={busy}
                onClick={() => update("/network-access/token", {})}
              >
                Create pairing token
              </button>
              {value.pairing_token && (
                <div className="pairing-token">
                  <label>
                    One-time pairing token
                    <input
                      readOnly
                      value={value.pairing_token}
                      onFocus={(event) => event.target.select()}
                    />
                  </label>
                  <p className="helper">
                    Valid for one browser for 10 minutes. Creating another token
                    replaces this one.
                  </p>
                  <button
                    onClick={async () => {
                      try {
                        await copyText(value.pairing_token);
                        setNotice("Pairing token copied.");
                      } catch {
                        setNotice(
                          "Select the token above and copy it manually.",
                        );
                      }
                    }}
                  >
                    Copy pairing token
                  </button>
                </div>
              )}
              {notice && <p role="status">{notice}</p>}
              <h3>Paired browsers</h3>
              <button
                disabled={busy}
                onClick={() => update("/network-access", undefined, "GET")}
              >
                Refresh paired browsers
              </button>
              <p className="helper">Access lasts 30 days unless revoked.</p>
              {value.devices?.length ? (
                <ul>
                  {value.devices.map((device) => (
                    <li key={device.id}>
                      <span>{device.name}</span>
                      <button
                        disabled={busy}
                        aria-label={`Revoke ${device.name}`}
                        onClick={() =>
                          update(
                            `/network-access/devices/${device.id}`,
                            undefined,
                            "DELETE",
                          )
                        }
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No paired browsers.</p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
