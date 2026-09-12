import React from "react";
import {
  Cpu,
  ShieldCheck,
  ArrowRight,
  Image,
  Film,
  PenLine,
  PanelsTopLeft,
  MessageSquare,
} from "lucide-react";
import machineArt from "./art/local-machine-gold.svg";

export function EditorialHero({
  label,
  title,
  accent,
  children,
  compact = false,
}) {
  return (
    <section className={"editorial-hero" + (compact ? " compact" : "")}>
      <img className="machine-art" src={machineArt} alt="" aria-hidden="true" />
      <div className="editorial-copy">
        <span className="eyebrow">PAITON STUDIO · {label}</span>
        <h1>
          {title} <em>{accent}</em>
        </h1>
        {children && <p>{children}</p>}
      </div>
    </section>
  );
}
function Meter({ label, value, detail }) {
  const known = Number.isFinite(value);
  const pct = known ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <div className="machine-meter">
      <div className="meter-ring" style={{ "--meter-value": `${pct}%` }}>
        <strong>{known ? `${Math.round(value)}%` : "—"}</strong>
      </div>
      <b>{label}</b>
      <small>{detail}</small>
    </div>
  );
}
export function MachineStatus({ gpu = {}, active = false, onDetails }) {
  const gb = (n) => (Number.isFinite(n) ? (n / 1024 ** 3).toFixed(1) : "—");
  // `available` means idle, not detected: loaded models and other applications
  // make an otherwise supported GPU unavailable for a new Studio request.
  const checked =
    typeof gpu.available === "boolean" ||
    typeof gpu.supported === "boolean" ||
    Boolean(gpu.sampled_at);
  const detected =
    gpu.gpu_count > 0 ||
    Boolean(gpu.name || gpu.architecture) ||
    gpu.total > 0 ||
    gpu.supported === true ||
    gpu.available === true;
  const controllable = gpu.supported === true;
  const ready = controllable && gpu.available === true;
  const inUse = controllable && gpu.available === false;
  const status = !checked
    ? "Checking hardware"
    : !detected
      ? "GPU not detected"
      : !controllable
        ? "Review GPU setup"
        : ready
          ? "GPU ready"
          : inUse
            ? "GPU in use"
            : "Checking availability";
  const needsAttention = checked && !controllable;
  const description = !checked
    ? "Checking this machine’s local GPU."
    : needsAttention
      ? "Review system details to prepare local inference."
      : inUse
        ? active
          ? "Studio requests share this GPU through your queue."
          : "The GPU is occupied. New requests wait safely in your queue."
        : "Local inference uses your machine. Tools check compatibility separately.";
  return (
    <section className="machine-status">
      <div className="section-heading">
        <h2>Local machine</h2>
        <span className={ready || inUse ? "machine-online" : "helper"}>
          {ready || inUse ? "● " : ""}
          {status}
        </span>
      </div>
      <p>{description}</p>
      <div className="machine-device">
        <Cpu size={27} />
        <div>
          <strong>
            {gpu.name ||
              (!checked
                ? "Detecting your GPU…"
                : gpu.gpu_count > 1
                  ? `${gpu.gpu_count} GPUs detected`
                  : detected
                    ? "Local GPU"
                    : "GPU not detected")}
          </strong>
          <small>
            {(needsAttention && gpu.message) ||
              gpu.architecture ||
              gpu.message ||
              "See system details for setup"}
            {gpu.total ? ` · ${gb(gpu.total)} GB VRAM` : ""}
          </small>
        </div>
      </div>
      <div className="machine-meters">
        <Meter
          label="GPU"
          value={gpu.utilization_percent}
          detail={
            gpu.power_state === "suspended" ? "Energy saving" : "Activity"
          }
        />
        <Meter
          label="VRAM"
          value={
            gpu.total > 0 && Number.isFinite(gpu.used)
              ? (100 * gpu.used) / gpu.total
              : null
          }
          detail={`${gb(gpu.used)} / ${gb(gpu.total)} GB`}
        />
        <div className="machine-thermal">
          <strong>
            {Number.isFinite(gpu.temperature_c) ? `${gpu.temperature_c}°` : "—"}
          </strong>
          <b>Temperature</b>
          <small>
            {Number.isFinite(gpu.power_w)
              ? `${Math.round(gpu.power_w)} W`
              : "Sensor unavailable"}
          </small>
        </div>
      </div>
      {onDetails && (
        <button className="machine-details" onClick={onDetails}>
          <ShieldCheck size={18} />
          <span>
            System details & compatibility
            <small>Drivers, memory and local setup</small>
          </span>
          <ArrowRight size={16} />
        </button>
      )}
    </section>
  );
}
export function CapabilityShelf({ tools, onNavigate }) {
  const items = [
    ["image", Image, "Image", "Turn ideas into visuals.", "image.generate"],
    ["video", Film, "Video", "Bring your images to life.", "video.generate"],
    ["write", PenLine, "Writing", "Give your ideas a voice.", "text"],
    ["page", PanelsTopLeft, "Website", "Build with your real assets.", "text"],
    [
      "chat",
      MessageSquare,
      "GPT & assistants",
      "Think, plan and create.",
      "text.chat",
    ],
  ];
  return (
    <section className="capability-shelf">
      {items.map(([route, Icon, title, copy, cap]) => {
        const task = route === "page" || route === "chat" ? "write" : route;
        const role = route === "page" ? "website" : route;
        const ready = tools.some((t) =>
          (t.profiles || []).some(
            (p) =>
              p.task === task &&
              (!p.roles || p.roles.includes(role)) &&
              (p.state ?? t.state) === "ready" &&
              (p.compatibility ?? t.compatibility)?.compatible !== false,
          ),
        );
        return (
          <button
            className={"capability-card capability-" + route}
            key={route}
            onClick={() => onNavigate(route)}
          >
            <div className="capability-art">
              <Icon size={46} />
            </div>
            <span className="capability-copy">
              <strong>{title}</strong>
              <small>{copy}</small>
              <span className={ready ? "machine-online" : "helper"}>
                {ready ? "● Ready locally" : "Setup required"}
              </span>
            </span>
            <ArrowRight size={18} />
          </button>
        );
      })}
    </section>
  );
}
