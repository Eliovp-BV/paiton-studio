import React from "react";
import { Cpu, PauseCircle, Settings2 } from "lucide-react";
import { ModelChoice } from "./WorkspaceExtras";
import { modelReadiness } from "./modelSelection";
import "./model-status.css";

export { modelReadiness } from "./modelSelection";

export default function ModelStatus({
  tools,
  task,
  value = "auto",
  defaultId = "auto",
  worker,
  conversation,
  onModels,
  onChange,
  disabled = false,
}) {
  const status = modelReadiness({
    tools,
    task,
    value,
    defaultId,
    worker,
    conversation,
  });
  return (
    <section className="model-status" aria-label="Local AI model">
      <div className="model-status-heading">
        {status.paused ? <PauseCircle size={17} /> : <Cpu size={17} />}
        <div>
          <small>
            {value === "auto"
              ? "Following Studio’s model preference"
              : "Your selected local model"}
          </small>
          <strong title={status.technical || undefined}>{status.label}</strong>
        </div>
        <span className={status.canRun ? "is-ready" : ""}>
          {status.paused
            ? "Paused"
            : status.ready
              ? "Installed"
              : "Setup needed"}
        </span>
      </div>
      <p>{status.reason}</p>
      {status.paused && !status.ready && (
        <p>
          AI execution is paused as well. Saving settings does not load a model.
        </p>
      )}
      {onChange && (
        <details>
          <summary>Change model</summary>
          <ModelChoice
            tools={tools}
            task={task}
            value={value}
            defaultId={defaultId}
            conversation={conversation}
            onChange={onChange}
            disabled={disabled}
            label={task === "code" ? "Coding model" : "Agent model"}
            details
          />
        </details>
      )}
      {onModels && (
        <button type="button" className="text-link" onClick={onModels}>
          <Settings2 size={13} /> Model settings
        </button>
      )}
    </section>
  );
}
