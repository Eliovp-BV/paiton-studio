import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Cpu,
  HardDrive,
  Info,
  Monitor,
  RefreshCw,
  Server,
} from "lucide-react";

const reported = (value) =>
  value === null || value === undefined || value === ""
    ? "Not reported"
    : String(value);
const memorySize = (value) =>
  Number.isFinite(value) && value >= 0
    ? `${(value / 1024 ** 3).toFixed(1)} GiB`
    : "Not reported";

function Facts({ entries }) {
  return (
    <dl style={{ margin: "12px 0 0" }}>
      {entries.map(([label, value]) => (
        <div
          key={label}
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "space-between",
            gap: "4px 20px",
            padding: "6px 0",
          }}
        >
          <dt className="helper">{label}</dt>
          <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Group({ title, icon: Icon, children }) {
  return (
    <div className="default-model">
      <span className="setting-icon" aria-hidden="true">
        <Icon size={20} />
      </span>
      <div style={{ minWidth: 0 }}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export default function SystemDetails({ api }) {
  const [snapshot, setSnapshot] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const requestNumber = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++requestNumber.current;
    setBusy(true);
    setError("");
    try {
      const next = await api("/system");
      if (current === requestNumber.current) setSnapshot(next);
    } catch (failure) {
      if (current === requestNumber.current)
        setError(failure.message || "The Studio host could not be checked.");
    } finally {
      if (current === requestNumber.current) setBusy(false);
    }
  }, [api]);

  useEffect(() => {
    refresh();
    return () => {
      requestNumber.current += 1;
    };
  }, [refresh]);

  const host = snapshot?.platform || {};
  const driver = snapshot?.driver || {};
  const docker = snapshot?.docker || {};
  const memory = snapshot?.memory || {};
  const storage = snapshot?.storage || {};
  const sampled = snapshot?.sampled_at ? new Date(snapshot.sampled_at) : null;

  return (
    <section
      className="panel settings-section"
      aria-label="Studio host system details"
      aria-busy={busy}
    >
      <div className="section-heading">
        <div>
          <h2>The computer running Studio</h2>
          <p className="helper">
            Creation runs on this host, even when you open Studio from another
            computer. These readings help explain which Paiton tools it can use.
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          onClick={refresh}
          disabled={busy}
          aria-label="Refresh Studio host details"
        >
          <RefreshCw size={15} aria-hidden="true" />
          {busy ? "Checking…" : "Refresh"}
        </button>
      </div>
      {error && (
        <p className="notice" role="alert">
          {error}
          {snapshot && " The last available reading is shown below."}
        </p>
      )}
      {!snapshot && !error && (
        <p className="helper" role="status">
          Reading hardware, driver and local storage details…
        </p>
      )}
      {snapshot && (
        <>
          <Group title="Operating system & driver" icon={Monitor}>
            <Facts
              entries={[
                [
                  "Operating system",
                  reported(host.distribution || host.system),
                ],
                ["Linux kernel / OS release", reported(host.release)],
                [
                  "Radeon host driver",
                  driver.name
                    ? `${driver.name} · ${reported(driver.version)}`
                    : "Not detected",
                ],
                ["Host ROCm installation", reported(driver.host_rocm_version)],
                ...(host.wsl
                  ? [["Environment", "Windows Subsystem for Linux"]]
                  : []),
              ]}
            />
            <p className="helper">
              The host driver and a model package's ROCm libraries are separate.
              A missing version reading does not by itself mean the driver is
              broken.
            </p>
          </Group>
          <Group title="Detected graphics devices" icon={Cpu}>
            {(snapshot.gpus || []).length ? (
              snapshot.gpus.map((gpu) => (
                <div key={gpu.id} style={{ marginTop: 16 }}>
                  <strong>
                    {gpu.name ||
                      ({
                        "0x8086": "Intel graphics device",
                        "0x10de": "NVIDIA graphics device",
                        "0x1002": "Radeon graphics device",
                      }[gpu.vendor_id] ??
                        "Graphics device")}
                  </strong>
                  <Facts
                    entries={[
                      [
                        "Reported dedicated memory",
                        memorySize(gpu.total_bytes),
                      ],
                      ["GPU architecture", reported(gpu.architecture)],
                    ]}
                  />
                  <details>
                    <summary>Device identification</summary>
                    <Facts
                      entries={[
                        ["PCI address", reported(gpu.pci_address)],
                        ["Device ID", reported(gpu.device_id)],
                        [
                          "Render node",
                          gpu.render_nodes?.join(", ") || "Not reported",
                        ],
                      ]}
                    />
                  </details>
                </div>
              ))
            ) : (
              <p className="helper">
                No graphics devices could be identified through this host's
                hardware interface.
              </p>
            )}
            <p className="helper">
              Detection does not establish model support. Tool setup checks each
              Paiton package's qualified GPU and memory requirements.
            </p>
          </Group>
          <Group title="System memory" icon={Cpu}>
            <Facts
              entries={[
                [
                  "RAM installed / available",
                  `${memorySize(memory.total_bytes)} / ${memorySize(memory.available_bytes)}`,
                ],
                [
                  "Swap capacity / free",
                  `${memorySize(memory.swap_total_bytes)} / ${memorySize(memory.swap_free_bytes)}`,
                ],
              ]}
            />
            <p className="helper">
              System RAM helps load model files. It does not replace the
              dedicated GPU memory required by the current Paiton packages.
            </p>
          </Group>
          <Group title="Local runtime" icon={Server}>
            <Facts
              entries={[
                [
                  "Docker Engine",
                  docker.available
                    ? `Detected · ${reported(docker.server_version)}`
                    : "Unavailable",
                ],
                [
                  "Runtime platform",
                  [docker.os, docker.architecture]
                    .filter(Boolean)
                    .join(" / ") || "Not reported",
                ],
              ]}
            />
            <p className="helper">{docker.message}</p>
            <p className="helper">
              Runtime and setup commands keep the same local Docker endpoint
              until Studio restarts. Inventory describes the currently selected
              context.
            </p>
          </Group>
          <Group title="Storage space" icon={HardDrive}>
            <Facts
              entries={[
                [
                  "Studio storage available",
                  memorySize(storage.data?.free_bytes),
                ],
                [
                  "Docker storage available",
                  memorySize(storage.docker?.free_bytes),
                ],
              ]}
            />
            <p className="helper">
              These locations may share the same disk; their free space does not
              add together. Downloads and model preparation also need temporary
              space.
            </p>
          </Group>
          <details>
            <summary>Technical details & readings</summary>
            <Facts
              entries={[
                ["CPU architecture", reported(host.machine)],
                ["Studio Python", reported(snapshot.python_version)],
                ["Docker client", reported(docker.client_version)],
                ["Docker API", reported(docker.api_version)],
                [
                  "Captured runtime endpoint",
                  reported(snapshot.runtime_docker_endpoint),
                ],
                ["Driver version source", reported(driver.version_source)],
              ]}
            />
            {(snapshot.checks || []).map((check) => (
              <p key={check.id} className="helper">
                {check.status === "known" ? (
                  <Check size={13} aria-hidden="true" />
                ) : (
                  <Info size={13} aria-hidden="true" />
                )}{" "}
                {check.message}
              </p>
            ))}
          </details>
          <p className="helper" role="status">
            {sampled && !Number.isNaN(sampled.getTime())
              ? `Read ${sampled.toLocaleTimeString()}. `
              : ""}
            Host checks are cached for {snapshot.cache_seconds || 10} seconds.
            Live generation activity appears in the GPU monitor.
          </p>
        </>
      )}
    </section>
  );
}
