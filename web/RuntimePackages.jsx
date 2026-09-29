import OptionalWeights from "./OptionalWeights";
import Diagnostics from "./Diagnostics";
import React, { useEffect, useRef, useState } from "react";
import { Check, Download, Package, RefreshCw, Search } from "lucide-react";
import "./runtime-packages.css";

const terminal = new Set(["completed", "cancelled", "failed", "interrupted"]);
const size = (value) =>
  Number.isFinite(value) ? `${(value / 1024 ** 3).toFixed(1)} GiB` : "";
const installed = (item) =>
  Boolean(item.current.image_id) ||
  item.versions.some((version) => version.installed);

export default function RuntimePackages({
  api,
  onToolsRefresh,
  tools = [],
  memory,
}) {
  const [snapshot, setSnapshot] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [setupTools, setSetupTools] = useState([]);
  const [choices, setChoices] = useState({});
  const [custom, setCustom] = useState({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const live = useRef(false);
  const callbacks = useRef({ api, onToolsRefresh });
  callbacks.current = { api, onToolsRefresh };
  const pending = useRef(null);
  const observed = useRef(null);
  const modelTools = new Map(tools.map((tool) => [tool.id, tool]));
  const packages = snapshot?.packages || [];
  const filtered = packages.filter((item) => {
    const tool = modelTools.get(item.id);
    const text = [
      item.id,
      item.model,
      item.current.reference,
      ...item.versions.map(
        (version) => `${version.label} ${version.reference}`,
      ),
    ]
      .join(" ")
      .toLowerCase();
    return (
      query
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .every((word) => text.includes(word)) &&
      (filter === "all" ||
        (filter === "installed" && installed(item)) ||
        (filter === "ready" && tool?.state === "ready") ||
        (filter === "compatible" && tool?.compatibility?.compatible === true) ||
        (filter === "setup" && tool?.state !== "ready"))
    );
  });

  async function refresh() {
    if (pending.current) return pending.current;
    const request = (async () => {
      try {
        const [next, setup] = await Promise.all([
          callbacks.current.api("/runtime-packages"),
          callbacks.current.api("/setup"),
        ]);
        if (!live.current) return;
        setSnapshot(next);
        setJobs(setup.jobs);
        setSetupTools(setup.tools || []);
        const completed = setup.jobs
          .filter((job) => job.state === "completed")
          .map((job) => job.id)
          .join();
        if (observed.current !== null && observed.current !== completed)
          await callbacks.current.onToolsRefresh?.();
        observed.current = completed;
        setError("");
      } catch (failure) {
        if (live.current)
          setError(failure.message || "Runtime packages could not be checked.");
      } finally {
        pending.current = null;
      }
    })();
    pending.current = request;
    return request;
  }

  useEffect(() => {
    live.current = true;
    refresh();
    return () => {
      live.current = false;
    };
  }, []);
  const active = jobs.some((job) => !terminal.has(job.state));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [active]);

  async function choose(item, reference, download) {
    setBusy(item.id);
    setError("");
    setNotice("");
    try {
      await callbacks.current.api(
        `/runtime-packages/${item.id}/${download ? "pull" : "select"}`,
        { reference },
      );
      await pending.current;
      await refresh();
      await callbacks.current.onToolsRefresh?.();
      if (live.current)
        setNotice(
          download
            ? "Download queued. The current package stays connected until the new one passes verification."
            : "Package selected. New requests will use this version.",
        );
    } catch (failure) {
      if (live.current) setError(failure.message);
    } finally {
      if (live.current) setBusy("");
    }
  }

  return (
    <section className="panel settings-section runtime-packages">
      <div className="section-heading">
        <div>
          <h2>Runtime packages</h2>
          <p className="helper">
            Choose a version for each model. Keep installed versions to switch
            back later.
          </p>
        </div>
        <button
          disabled={Boolean(busy)}
          onClick={refresh}
          aria-label="Refresh runtime packages"
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </div>
      <p className="helper">
        Model defaults choose what you create with. Packages choose the
        installed release behind that model. Saved requests keep their original
        package identity.
      </p>
      {snapshot && (
        <>
          <div
            className="runtime-library-summary"
            aria-label="Model library status"
          >
            <span>
              <strong>{packages.filter(installed).length}</strong> runtimes
              installed
            </span>
            <span>
              <strong>
                {
                  packages.filter(
                    (item) => modelTools.get(item.id)?.state === "ready",
                  ).length
                }
              </strong>{" "}
              models ready to create
            </span>
            <span>
              {memory?.retained_model
                ? `${memory.retained_model.model} · ${memory.retained_model.state === "ready" ? "kept ready" : "releasing when idle"}`
                : "Models load when you create"}
            </span>
          </div>
          <div className="runtime-library-search">
            <label htmlFor="runtime-model-search">
              <Search size={15} /> Find a model or package
            </label>
            <input
              id="runtime-model-search"
              type="search"
              placeholder="Search Qwen, images, package version…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div
            className="runtime-library-filters"
            aria-label="Filter runtime packages"
          >
            {[
              ["all", "All models"],
              ["installed", "Installed runtimes"],
              ["ready", "Ready to create"],
              ["compatible", "Compatible GPU"],
              ["setup", "Needs setup"],
            ].map(([value, label]) => (
              <button
                key={value}
                aria-pressed={filter === value}
                className={filter === value ? "chosen" : ""}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="helper">
            A runtime on disk still needs model weights and a compatible GPU.
            Opening this library never loads a model.
          </p>
        </>
      )}
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {snapshot?.message && (
        <p className="notice" role="status">
          {snapshot.message}
        </p>
      )}
      {!snapshot && !error && <p role="status">Checking installed packages…</p>}
      {snapshot && !filtered.length && (
        <div className="runtime-empty">
          <p>No packages match these filters.</p>
          <button
            onClick={() => {
              setQuery("");
              setFilter("all");
            }}
          >
            Clear filters
          </button>
        </div>
      )}
      {filtered.map((item) => {
        const tool = modelTools.get(item.id);
        const retained = memory?.retained_model;
        const retainedHere =
          retained?.package === item.id &&
          typeof retained.runtime_image === "string" &&
          retained.runtime_image.length > 0 &&
          [item.current.image_id, item.current.configured].includes(
            retained.runtime_image,
          );
        const selected = item.versions.find((version) => version.selected);
        const choice =
          choices[item.id] ||
          selected?.reference ||
          item.versions[0]?.reference ||
          "";
        const version = item.versions.find(
          (value) => value.reference === choice,
        );
        const job = jobs.find(
          (value) => value.package === item.id && !value.component,
        );
        const running = job && !terminal.has(job.state);
        return (
          <article key={item.id} className="runtime-package-card">
            <div className="section-heading">
              <h3>
                <Package size={18} /> {item.model}
              </h3>
              <span className={`badge ${item.current.image_id ? "ready" : ""}`}>
                {item.current.image_id
                  ? "Installed"
                  : installed(item)
                    ? "Installed · choose a version"
                    : "Not installed"}
              </span>
            </div>
            <p className="runtime-current">
              <strong>Current:</strong>{" "}
              {selected?.label ||
                item.current.reference ||
                "No package selected"}
            </p>
            {tool && (
              <p className="runtime-model-state" role="status">
                {retainedHere
                  ? retained.state === "ready"
                    ? "Loaded · kept ready for another request"
                    : "Loaded · releasing when idle"
                  : tool.state === "ready"
                    ? "Ready to create · loads on your next request"
                    : tool.compatibility?.compatible === false
                      ? tool.compatibility.reason
                      : "Model setup needed · open Tool setup & downloads"}
              </p>
            )}
            {item.pinned ? (
              <>
                <p className="helper">{item.message}</p>
                <ul
                  className="runtime-pinned-versions"
                  aria-label="Release images"
                >
                  {item.versions.map((value) => (
                    <li key={value.reference}>
                      {value.label}
                      {value.installed ? " · installed" : " · not installed"}
                    </li>
                  ))}
                </ul>
              </>
            ) : item.versions.length > 0 ? (
              <>
                <label htmlFor={`runtime-${item.id}`}>Package version</label>
                <div className="runtime-package-controls">
                  <select
                    id={`runtime-${item.id}`}
                    value={choice}
                    disabled={Boolean(busy) || Boolean(running)}
                    onChange={(event) =>
                      setChoices((values) => ({
                        ...values,
                        [item.id]: event.target.value,
                      }))
                    }
                  >
                    {item.versions.map((value) => (
                      <option key={value.reference} value={value.reference}>
                        {value.label}
                        {value.selected
                          ? " · current"
                          : value.installed
                            ? " · installed"
                            : " · download required"}
                      </option>
                    ))}
                  </select>
                  <button
                    className="primary"
                    disabled={
                      !version ||
                      version.selected ||
                      Boolean(busy) ||
                      Boolean(item.blocked_reason) ||
                      (version.installed
                        ? !item.can_switch
                        : !version.can_pull || !item.can_pull)
                    }
                    onClick={() =>
                      choose(item, version.reference, !version.installed)
                    }
                  >
                    {version?.selected ? (
                      <Check size={15} />
                    ) : version?.installed ? (
                      <Package size={15} />
                    ) : (
                      <Download size={15} />
                    )}
                    {busy === item.id
                      ? "Working…"
                      : version?.selected
                        ? "In use"
                        : version?.installed
                          ? "Use package"
                          : "Download & use"}
                  </button>
                </div>
                {version && (
                  <p className="helper">
                    {version.channel === "candidate"
                      ? "Candidate release. "
                      : ""}
                    {version.installed
                      ? `${size(version.size_bytes)} on disk. Selecting it does not delete the previous version.`
                      : "Downloads use the Studio host’s registry credentials. Model weights are installed separately in Tool setup & downloads."}
                  </p>
                )}
              </>
            ) : (
              <p className="helper">{item.message}</p>
            )}
            {item.blocked_reason && (
              <p className="helper" role="status">
                {item.blocked_reason}
              </p>
            )}
            {job && (
              <div className="runtime-download-status" role="status">
                <span>{job.message}</span>
                {running && (
                  <button
                    disabled={Boolean(busy)}
                    onClick={async () => {
                      setBusy(item.id);
                      try {
                        await callbacks.current.api(
                          `/setup-jobs/${job.id}/cancel`,
                          {},
                        );
                        await pending.current;
                        await refresh();
                      } catch (failure) {
                        if (live.current) setError(failure.message);
                      } finally {
                        if (live.current) setBusy("");
                      }
                    }}
                  >
                    Cancel download
                  </button>
                )}
              </div>
            )}
            {job && ["failed", "interrupted"].includes(job.state) && (
              <Diagnostics
                api={api}
                endpoint={`/setup-jobs/${job.id}/diagnostics`}
              />
            )}
            {(item.optional_components || []).map((component) => {
              const actions = setupTools
                .find((tool) => tool.id === item.id)
                ?.optional_components?.find(
                  (value) => value.id === component.id,
                );
              return (
                <OptionalWeights
                  key={component.id}
                  packageId={item.id}
                  component={{ ...component, ...actions }}
                  api={api}
                  disabled={Boolean(busy)}
                  onChanged={async () => {
                    await pending.current;
                    await refresh();
                    await callbacks.current.onToolsRefresh?.();
                  }}
                />
              );
            })}
            <details>
              <summary>
                Package details{item.can_pull ? " & another GHCR tag" : ""}
              </summary>
              {item.current.image_id && (
                <>
                  <p>Saved package identity</p>
                  <code>{item.current.image_id}</code>
                </>
              )}
              {item.current.digests?.map((digest) => (
                <code key={digest}>{digest}</code>
              ))}
              {item.can_pull && (
                <>
                  <label htmlFor={`runtime-ref-${item.id}`}>
                    Full GHCR tag or digest
                  </label>
                  <input
                    id={`runtime-ref-${item.id}`}
                    spellCheck={false}
                    value={custom[item.id] || ""}
                    placeholder={`${snapshot.repository}:version-tag`}
                    onChange={(event) =>
                      setCustom((values) => ({
                        ...values,
                        [item.id]: event.target.value,
                      }))
                    }
                  />
                  <p className="helper">
                    Studio connects only packages approved for this model’s
                    adapter. An incompatible tag leaves your current selection
                    in place.
                  </p>
                  <button
                    disabled={Boolean(busy) || !custom[item.id]?.trim()}
                    onClick={() => choose(item, custom[item.id].trim(), true)}
                  >
                    <Download size={15} /> Download & verify
                  </button>
                </>
              )}
            </details>
          </article>
        );
      })}
    </section>
  );
}
