import React from "react";
import "./conversationControls.css";

export const defaultConversation = {
  context_mode: "short",
  reuse_cache: false,
};

export default function ConversationControls({
  value = defaultConversation,
  onChange,
  disabled = false,
  pending = false,
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
          checked={value.reuse_cache}
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
          Cache reuse is unavailable with the released 200K profile.
        </p>
      )}
      <details>
        <summary>Advanced &amp; technical details</summary>
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
            disabled={disabled || value.reuse_cache}
            onChange={(e) =>
              onChange({
                context_mode: e.target.checked ? "extra_long" : "long",
                reuse_cache: false,
              })
            }
          />
        </label>
        {value.reuse_cache && (
          <p>
            Turn off cache reuse before choosing Extra-long context. The stock
            GDN APC configuration is not qualified for 200K.
          </p>
        )}
        <dl>
          <dt>Model context ceiling</dt>
          <dd>
            {extra ? "200,000" : longer ? "65,536" : "8,192"} tokens, including
            the reply
          </dd>
          <dt>Backend / GPU cache</dt>
          <dd>
            {value.reuse_cache
              ? "Stock vLLM GDN · APC on · align"
              : "Compact native GDN · APC off · none"}
          </dd>
          <dt>Reserved KV cache</dt>
          <dd>{extra ? "8" : "5"} GiB · one request · 4,096-token chunks</dd>
          <dt>Tool parser</dt>
          <dd>Corrected qwen3_xml in every mode</dd>
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
