import React from "react";
import { weightsLabel, kvCacheLabel } from "./modelSelection";
import "./conversationControls.css";

export const defaultConversation = {
  context_mode: "short",
  reuse_cache: false,
  weights: "mxfp4",
};

export default function ConversationControls({
  value = defaultConversation,
  onChange,
  disabled = false,
  pending = false,
  component,
  technical,
}) {
  const longer = value.context_mode !== "short";
  const extra = value.context_mode === "extra_long";
  return (
    <div className="conversation-controls">
      <div className="conversation-profile-label">
        <span className="eyebrow">CONVERSATION MEMORY</span>
        <span>{extra ? "200K" : longer ? "64K" : "8K"}</span>
      </div>
      <label className="conversation-option">
        <span>
          <strong>Longer context</strong>
          <small>
            Let the model consider more of your conversation and documents. Long
            requests can take longer to start.
          </small>
        </span>
        <input
          type="checkbox"
          checked={longer}
          disabled={disabled}
          onChange={(e) =>
            onChange({
              ...value,
              context_mode: e.target.checked ? "long" : "short",
              reuse_cache: false,
            })
          }
        />
      </label>
      <label className="conversation-option">
        <span>
          <strong>Reuse conversation cache</strong>
          <small>
            Speed up follow-up replies by reusing unchanged conversation text.
            This mode uses memory differently and may generate responses more
            slowly.
          </small>
        </span>
        <input
          type="checkbox"
          checked={extra || value.reuse_cache}
          disabled={disabled || !longer || extra}
          onChange={(e) =>
            onChange({ ...value, reuse_cache: e.target.checked })
          }
        />
      </label>
      {!longer && (
        <p className="helper">Cache reuse requires Longer context.</p>
      )}
      {extra && (
        <p className="helper">
          Extra-long context enables conversation cache reuse automatically.
        </p>
      )}
      <details>
        <summary>Advanced &amp; technical details</summary>
        {component && (
          <label className="conversation-option">
            <span>
              <strong>Weights for this chat</strong>
              <small>
                Saved with each reply. Changing weights reloads the model.
              </small>
            </span>
            <select
              aria-label="Weights for this chat"
              value={value.weights || "mxfp4"}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...value, weights: event.target.value })
              }
            >
              <option value="mxfp4">MXFP4</option>
              <option
                value="w3a4"
                disabled={!component.verified && value.weights !== "w3a4"}
              >
                W3A4 3-bit{!component.verified ? " · verification needed" : ""}
              </option>
            </select>
          </label>
        )}
        <label className="conversation-option">
          <span>
            <strong>Extra-long context</strong>
            <small>
              For very large conversations. Processes one request at a time and
              leaves less memory available.
            </small>
          </span>
          <input
            type="checkbox"
            checked={extra}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...value,
                context_mode: e.target.checked ? "extra_long" : "long",
                reuse_cache: false,
                weights: value.weights || "mxfp4",
              })
            }
          />
        </label>
        <dl>
          <dt>Model context ceiling</dt>
          <dd>
            {extra ? "200,000" : longer ? "65,536" : "8,192"} tokens, including
            the reply
          </dd>
          <dt>Weights</dt>
          <dd>{weightsLabel(value)}</dd>
          {technical && (
            <>
              <dt>Backend / GPU cache</dt>
              <dd>
                {technical.gdn_backend} · APC{" "}
                {(technical.prefix_caching ?? value.reuse_cache) ? "on" : "off"}{" "}
                · {technical.mamba_cache_mode}
              </dd>
              {kvCacheLabel(technical) && (
                <>
                  <dt>KV cache precision</dt>
                  <dd>{kvCacheLabel(technical)}</dd>
                </>
              )}
              <dt>Reserved KV cache</dt>
              <dd>
                {Number(technical.kv_cache_gib).toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })}{" "}
                GiB · {technical.sequence_limit} request ·{" "}
                {Number(technical.prefill_chunk).toLocaleString()}-token chunks
              </dd>
              {technical.aggregate_kv_tokens != null && (
                <>
                  <dt>Total KV capacity</dt>
                  <dd>
                    {Number(technical.aggregate_kv_tokens).toLocaleString()}{" "}
                    tokens across the cache; the per-request ceiling above still
                    applies.
                  </dd>
                </>
              )}
              <dt>Tool parser</dt>
              <dd>{technical.tool_parser}</dd>
            </>
          )}
        </dl>
        <p>
          Exact token counts include instructions, documents and tools. A
          smaller context ceiling alone does not guarantee faster generation.
        </p>
      </details>
      <p className="conversation-memory-note">
        Conversations stay saved in every mode. Older material is summarized
        when needed; GPU cache is temporary and may be evicted.
      </p>
      {pending && (
        <p role="status" className="conversation-pending">
          Change saved for your next request. Current and queued work keeps its
          original settings. Switching profiles may reload the model.
        </p>
      )}
    </div>
  );
}
