import React, { useEffect, useRef, useState } from "react";
import {
  MessageSquare,
  Plus,
  Paperclip,
  ArrowUp,
  Square,
  Image as ImageIcon,
  Code,
  FileText,
  X,
  Copy,
  Sparkles,
} from "lucide-react";
import { ModelChoice, taskProfiles, selectedProfile } from "./WorkspaceExtras";
import { stageForJob, formatElapsed, studioNow } from "./creationFeedback";
import "./gptpaiton.css";
import ConversationControls from "./ConversationControls";
import { MachineStatus } from "./StudioIdentity";
const terminal = ["completed", "failed", "cancelled"];
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  try {
    if (!document.execCommand("copy"))
      throw Error(
        "Copy is unavailable in this browser. Select and copy the text.",
      );
  } finally {
    field.remove();
  }
}
function inline(text) {
  return text
    .split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g)
    .map((part, i) =>
      part.startsWith("**") ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : part.startsWith("`") ? (
        <code key={i}>{part.slice(1, -1)}</code>
      ) : (
        part
      ),
    );
}
function Reply({ text, report }) {
  return (
    <div className="gpt-answer">
      {text.split(/(```[\s\S]*?```)/g).map((part, i) =>
        part.startsWith("```") ? (
          <div className="gpt-code" key={i}>
            <div>
              <span>{part.slice(3).split("\n")[0] || "Code"}</span>
              <button
                aria-label="Copy code"
                onClick={() =>
                  copyText(
                    part.replace(/^```[^\n]*\n?/, "").replace(/```$/, ""),
                  ).catch(report)
                }
              >
                <Copy size={14} />
              </button>
            </div>
            <pre>
              <code>
                {part.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")}
              </code>
            </pre>
          </div>
        ) : (
          <div key={i} className="gpt-prose">
            {inline(part)}
          </div>
        ),
      )}
    </div>
  );
}
export default function GPTPaiton({
  gpu,
  project,
  api,
  tools,
  report,
  onSetup,
  initialIntent,
  defaultProfile = "auto",
  defaultCodeProfile = "auto",
  defaultConversationOptions,
}) {
  useEffect(() => {
    if (initialIntent?.text) setPrompt(initialIntent.text);
    if (initialIntent?.profile) setProfile(initialIntent.profile);
  }, [initialIntent?.id]);
  const [optionsDraft, setOptionsDraft] = useState(null);
  const optionsVersion = useRef(0);
  const [chats, setChats] = useState([]),
    [chat, setChat] = useState(null),
    [prompt, setPrompt] = useState(""),
    [mode, setMode] = useState("auto"),
    [profile, setProfile] = useState("auto"),
    [imageProfile, setImageProfile] = useState("auto"),
    [effort, setEffort] = useState("low"),
    [files, setFiles] = useState([]),
    [sending, setSending] = useState(false),
    [uploading, setUploading] = useState(false);
  const replyRole = mode === "code" ? "code" : "chat";
  const replyDefault = mode === "code" ? defaultCodeProfile : defaultProfile;
  const replyProfile = selectedProfile(tools, replyRole, profile, replyDefault);
  const adjustableReasoning =
    (replyProfile?.package.reasoning_efforts || []).length > 0;
  const selected = useRef(null),
    alive = useRef(true),
    upload = useRef(null),
    bottom = useRef(null),
    scrollBox = useRef(null),
    nearBottom = useRef(true),
    nonce = useRef(null);
  const busy = chat?.turns?.find((t) => !terminal.includes(t.job.state));
  async function refresh() {
    const list = await api(`/projects/${project.id}/chats`);
    if (!alive.current) return;
    setChats(list);
    return list;
  }
  async function open(id) {
    selected.current = id;
    setChat(null);
    setPrompt("");
    setFiles([]);
    nonce.current = null;
    const value = await api(`/chats/${id}?compact=true`);
    if (alive.current && selected.current === id) setChat(value);
  }
  useEffect(() => {
    alive.current = true;
    refresh()
      .then((list) => {
        if (list?.length && !selected.current) return open(list[0].id);
      })
      .catch(report);
    return () => {
      alive.current = false;
    };
  }, [project.id]);
  useEffect(() => {
    let stopped = false,
      pending = false;
    async function retainModel() {
      if (stopped || pending) return;
      pending = true;
      try {
        await api("/chat-presence", {});
      } catch {
        /* Retry next heartbeat; ordinary requests still report connection errors. */
      } finally {
        pending = false;
      }
    }
    retainModel();
    const timer = setInterval(retainModel, 30000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!chat?.id) return;
    let done = false,
      inFlight = false;
    const id = chat.id;
    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const generation = optionsVersion.current;
        const value = await api(`/chats/${id}?compact=true`);
        if (
          !done &&
          alive.current &&
          selected.current === id &&
          generation === optionsVersion.current
        )
          setChat(value);
      } catch (e) {
        if (!done) report(e);
      } finally {
        inFlight = false;
      }
    }, 1200);
    return () => {
      done = true;
      clearInterval(timer);
    };
  }, [chat?.id]);
  useEffect(() => {
    if (nearBottom.current)
      bottom.current?.scrollIntoView({ block: "nearest" });
  }, [chat]);
  async function newChat() {
    try {
      const value = await api(`/projects/${project.id}/chats`, {});
      await refresh();
      if (alive.current) {
        selected.current = value.id;
        setChat(value);
        setPrompt("");
        setFiles([]);
        nonce.current = null;
      }
    } catch (e) {
      report(e);
    }
  }
  async function saveOptions(patch) {
    if (optionsDraft) return;
    setOptionsDraft({ ...chat?.options, ...patch });
    optionsVersion.current += 1;
    try {
      let current = chat;
      if (!current) {
        current = await api(`/projects/${project.id}/chats`, {});
        selected.current = current.id;
      }
      await api(
        `/chats/${current.id}/options`,
        { ...current.options, ...patch },
        "PUT",
      );
      if (alive.current && selected.current === current.id)
        setChat(await api(`/chats/${current.id}?compact=true`));
      await refresh();
    } catch (error) {
      report(error);
    } finally {
      optionsVersion.current += 1;
      setOptionsDraft(null);
    }
  }
  async function retryReply(job) {
    try {
      await api(`/chats/${chat.id}/retry/${job.id}`, {});
      setChat(await api(`/chats/${chat.id}?compact=true`));
    } catch (error) {
      report(error);
    }
  }
  async function send(event) {
    event.preventDefault();
    if (sending || uploading || busy || !prompt.trim()) return;
    setSending(true);
    try {
      let current = chat;
      if (!current) {
        current = await api(`/projects/${project.id}/chats`, {});
        if (!alive.current) return;
        selected.current = current.id;
        setChat(current);
      }
      const id = current.id;
      nonce.current =
        nonce.current ||
        Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
          n.toString(16).padStart(2, "0"),
        ).join("");
      await api(`/chats/${id}/messages`, {
        prompt,
        mode,
        profile_id: profile,
        image_profile_id: imageProfile,
        reasoning_effort: effort,
        document_ids: files.length ? files.map((f) => f.id) : undefined,
        client_id: nonce.current,
      });
      if (!alive.current || selected.current !== id) return;
      nonce.current = null;
      setPrompt("");
      setFiles([]);
      const value = await api(`/chats/${id}?compact=true`);
      if (alive.current && selected.current === id) setChat(value);
      await refresh();
    } catch (e) {
      report(e);
    } finally {
      if (alive.current) setSending(false);
    }
  }
  async function attach(event) {
    const chosen = [...event.target.files];
    event.target.value = "";
    if (!chosen.length) return;
    const at = selected.current;
    setUploading(true);
    nonce.current = null;
    try {
      for (const file of chosen) {
        if (file.size > 8 * 1024 * 1024)
          throw Error("Choose documents smaller than 8 MB.");
        const body = new FormData();
        body.append("file", file);
        const saved = await api(`/projects/${project.id}/attachments`, body);
        if (alive.current && selected.current === at)
          setFiles((old) => [...old, saved].slice(0, 8));
      }
    } catch (e) {
      report(e);
    } finally {
      if (alive.current) setUploading(false);
    }
  }
  return (
    <section className="gpt-studio">
      <aside className="gpt-history">
        <div className="gpt-history-title">
          <MessageSquare size={18} />
          <strong>Conversations</strong>
        </div>
        <button onClick={newChat} disabled={sending}>
          <Plus size={16} />
          New conversation
        </button>
        <div className="gpt-chat-list">
          {chats.map((c) => (
            <button
              key={c.id}
              className={chat?.id === c.id ? "selected" : ""}
              onClick={() => open(c.id).catch(report)}
              disabled={sending}
            >
              {c.title}
            </button>
          ))}
        </div>
        <small>
          Saved in this project.
          <br />
          All inference stays on your Studio host.
        </small>
      </aside>
      <div className="gpt-conversation">
        <header>
          <div>
            <span className="eyebrow">YOUR LOCAL ASSISTANT</span>
            <h1>
              Think deeper.<span>Create further.</span>
            </h1>
          </div>
          <span className="gpt-local">● Local AI</span>
        </header>
        <div
          className="gpt-transcript"
          ref={scrollBox}
          onScroll={(e) => {
            const el = e.currentTarget;
            nearBottom.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          }}
        >
          {!chat?.turns?.length && (
            <div className="gpt-welcome">
              <Sparkles size={36} />
              <h2>What shall we work on?</h2>
              <p>
                Ask a question, explore a document, draft code or create an
                image. Your conversation stays here.
              </p>
              {!taskProfiles(tools, "chat").some(
                (p) =>
                  p.state === "ready" && p.compatibility?.compatible !== false,
              ) && (
                <p>
                  Prepare a local conversation model to start chatting. MiniCPM
                  offers quick replies; larger models offer more capable
                  answers. Download progress is shown in Settings.{" "}
                  <button onClick={onSetup}>Set up models</button>
                </p>
              )}
              <div>
                {[
                  [
                    "Explain something",
                    "Explain how solar panels work in plain language.",
                    "chat",
                  ],
                  [
                    "Analyze a document",
                    "Summarize the attached document and cite the relevant excerpts.",
                    "chat",
                  ],
                  [
                    "Create an image",
                    "Generate an image of a peaceful mountain cabin at sunrise.",
                    "image",
                  ],
                  [
                    "Help with code",
                    "Write a Python function that removes duplicates while preserving order.",
                    "code",
                  ],
                ].map(([label, text, m]) => (
                  <button
                    key={label}
                    onClick={() => {
                      setPrompt(text);
                      setMode(m);
                      nonce.current = null;
                    }}
                  >
                    {label}
                    <ArrowUp size={16} />
                  </button>
                ))}
              </div>
            </div>
          )}
          {chat?.turns?.map((turn) => (
            <article key={turn.id} className="gpt-turn">
              <div className="gpt-user">{turn.prompt}</div>
              {turn.documents.length > 0 && (
                <p className="gpt-doc-count">
                  <FileText size={13} />
                  {turn.documents.length} local document
                  {turn.documents.length > 1 ? "s" : ""}
                </p>
              )}
              <div className="gpt-assistant">
                <div className="gpt-avatar">✦</div>
                <div className="gpt-response">
                  {turn.answer ? (
                    <Reply text={turn.answer} report={report} />
                  ) : turn.asset?.kind === "image" ? (
                    <figure>
                      <p className="helper">
                        Done — your image is saved. You can keep chatting.
                        Studio restores saved conversation context when the chat
                        model reloads.
                      </p>
                      <img
                        src={`/api/assets/${turn.asset.id}`}
                        alt={turn.prompt}
                      />
                      <figcaption>
                        Created locally · saved in your project{" "}
                        <a href={`/api/assets/${turn.asset.id}?download=true`}>
                          Download
                        </a>
                      </figcaption>
                    </figure>
                  ) : !terminal.includes(turn.job.state) ? (
                    <>
                      <p className="gpt-stage" role="status">
                        {stageForJob(turn.job).title}
                      </p>
                      {studioNow() / 1000 - turn.job.created >= 60 && (
                        <div className="gpt-wait-note">
                          <p>
                            Still working locally. Loading a different creation
                            tool can take several minutes; your saved
                            conversation survives the switch.
                          </p>
                          {taskProfiles(
                            tools,
                            turn.mode === "image"
                              ? "image"
                              : turn.mode === "code"
                                ? "code"
                                : "chat",
                          ).filter(
                            (p) =>
                              p.state === "ready" &&
                              p.compatibility?.compatible !== false &&
                              p.id !== turn.job.request.profile.id,
                          ).length === 0 && (
                            <p>
                              There is no other ready, compatible model for this
                              task yet.
                            </p>
                          )}
                          <p>
                            For future requests, check Model choices &amp;
                            document limits below. A smaller compatible model
                            can load faster, with a tradeoff in answer quality.
                            Only models supported for that task can be selected.
                            Changing a selection does not change this queued
                            request; stop it first if you want to retry.
                          </p>
                        </div>
                      )}
                      {turn.partial ? (
                        <Reply text={turn.partial} report={report} />
                      ) : (
                        <p className="helper">
                          {turn.job.message} You can keep browsing; the Studio
                          host must stay running.
                        </p>
                      )}
                    </>
                  ) : (
                    <div role="status">
                      <p>{turn.job.message}</p>
                      {chat.turns.at(-1)?.id === turn.id && (
                        <button onClick={() => retryReply(turn.job)}>
                          Retry saved request
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setPrompt(turn.prompt);
                          setMode(turn.mode);
                          setEffort(turn.job.request.reasoning_effort || "low");
                          if (turn.mode !== "image")
                            setProfile(turn.job.request.profile.id);
                          nonce.current = null;
                        }}
                      >
                        Edit and retry
                      </button>
                    </div>
                  )}
                  {turn.job.state === "completed" && (
                    <div className="gpt-meta">
                      <span>
                        {turn.job.request.profile.model} ·{" "}
                        {formatElapsed(turn.job.updated - turn.job.created)}
                      </span>
                      {turn.answer && (
                        <button
                          onClick={() => copyText(turn.answer).catch(report)}
                          aria-label="Copy reply"
                        >
                          <Copy size={13} />
                        </button>
                      )}
                      {turn.asset?.metadata?.finish_reason === "length" && (
                        <strong>
                          Response budget reached; ask to continue.
                        </strong>
                      )}
                    </div>
                  )}
                  {turn.context && (
                    <div className="gpt-context-note">
                      {turn.context.summarized
                        ? "Older material summarized locally. Original messages remain saved."
                        : "Saved conversation context included."}{" "}
                      {turn.context.input_tokens?.toLocaleString()} input tokens
                      · {turn.context.output_reserved?.toLocaleString()}{" "}
                      reserved for the reply.{" "}
                      <a
                        href={`/api/chats/${chat.id}/context/${turn.job.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View submitted context
                      </a>
                    </div>
                  )}
                  {turn.asset?.metadata?.tool_artifacts?.length > 0 && (
                    <p className="gpt-context-note">
                      {turn.asset.metadata.tool_artifacts.length} code draft(s)
                      saved in the project Library for review. Nothing executed.
                    </p>
                  )}
                  {turn.job.request.sources?.length > 0 && (
                    <details className="gpt-sources">
                      <summary>Saved document sources</summary>
                      <p>
                        Source versions are preserved with this conversation.
                        Older material may be summarized to fit the selected
                        context.
                      </p>
                      {turn.job.request.sources.map((source) => (
                        <p key={source.id}>
                          {source.name} ·{" "}
                          {source.sha256
                            ? `saved version ${source.sha256.slice(0, 8)}`
                            : `excerpts ${(source.excerpts || []).join(", ")}`}
                        </p>
                      ))}
                    </details>
                  )}
                </div>
              </div>
            </article>
          ))}
          <div ref={bottom} />
        </div>
        <form className="gpt-composer" onSubmit={send}>
          {files.length > 0 && (
            <div className="gpt-files">
              {files.map((file) => (
                <span key={file.id}>
                  <FileText size={14} />
                  {file.name}
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => {
                      setFiles((old) => old.filter((f) => f.id !== file.id));
                      nonce.current = null;
                    }}
                  >
                    <X size={13} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            aria-label="Message GPTPaiton"
            placeholder="Message GPTPaiton…"
            value={prompt}
            disabled={sending}
            onChange={(e) => {
              setPrompt(e.target.value);
              nonce.current = null;
            }}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                if (!busy && !sending) send(e);
              }
            }}
            maxLength={200000}
          />
          <div className="gpt-compose-actions">
            <input
              ref={upload}
              type="file"
              multiple
              hidden
              accept=".pdf,.docx,.txt,.md,.csv,.json,.py,.js,.ts,.html,.css,.log"
              onChange={attach}
            />
            <button
              type="button"
              aria-label="Attach documents"
              disabled={uploading || sending || files.length >= 8}
              onClick={() => upload.current.click()}
            >
              <Paperclip size={18} />
              {uploading ? "Reading…" : "Attach"}
            </button>
            <select
              aria-label="Conversation mode"
              value={mode}
              onChange={(e) => {
                setMode(e.target.value);
                nonce.current = null;
              }}
            >
              <option value="auto">Auto</option>
              <option value="chat">Chat</option>
              <option value="code">Code</option>
              <option value="image">Create image</option>
            </select>
            <select
              aria-label="Reasoning effort"
              value={adjustableReasoning ? effort : "low"}
              disabled={mode === "image" || !adjustableReasoning}
              title={
                adjustableReasoning
                  ? "Choose how much reasoning to use"
                  : "This model uses direct answers with extended thinking off"
              }
              onChange={(e) => {
                setEffort(e.target.value);
                nonce.current = null;
              }}
            >
              <option value="low">
                {adjustableReasoning ? "Quick reasoning" : "Direct answers"}
              </option>
              <option value="medium">Balanced reasoning</option>
              <option value="high">Deeper reasoning</option>
            </select>
            {busy ? (
              <button
                type="button"
                onClick={() =>
                  api(`/jobs/${busy.job.id}/cancel`, {}).catch(report)
                }
              >
                <Square size={16} />
                Stop
              </button>
            ) : (
              <button
                className="primary gpt-send"
                disabled={sending || uploading || !prompt.trim()}
                aria-label="Send message"
              >
                <ArrowUp size={20} />
              </button>
            )}
          </div>
          <details>
            <summary>Model choices & document limits</summary>
            <ModelChoice
              tools={tools}
              task={mode === "code" ? "code" : "chat"}
              value={profile}
              onChange={(value) => {
                setProfile(value);
                nonce.current = null;
              }}
              defaultId={replyDefault}
              label="Conversation model"
              details
            />
            <ModelChoice
              tools={tools}
              task="image"
              value={imageProfile}
              onChange={(value) => {
                setImageProfile(value);
                nonce.current = null;
              }}
              label="Image model"
            />
            <p>
              Reasoning is bounded to reserve room for your answer. Recent
              conversation turns and relevant document excerpts are included;
              long turns may be excerpted, and older turns remain saved. PDF,
              DOCX and UTF-8 files, up to 8 MB each. Scanned PDFs need OCR
              first. Generated code is never executed.
            </p>
            <p>
              Auto recognizes direct “create/generate an image…” requests.
              Choose Create image explicitly for other phrasing. Image
              generation uses your prompt; the text model cannot see the result.
            </p>
          </details>
          <p className="gpt-disclaimer">
            Local processing. Review facts and code. Model loading can take
            several minutes.
          </p>
        </form>
      </div>
      <aside className="gpt-context">
        <section>
          <h2>Project context</h2>
          <strong>{project.name}</strong>
          <p>
            Conversation history and attached document excerpts stay with this
            project.
          </p>
          {files.map((file) => (
            <div className="context-file" key={file.id}>
              <FileText size={16} />
              {file.name}
            </div>
          ))}
        </section>
        <section>
          <h2>Model & mode</h2>{" "}
          <div className="gpt-model-mode">
            <div className="reply-speed" aria-label="Reply style">
              {[
                ["qwen38-mxfp4-chat", "Recommended"],
                ["minicpm5-chat", "Quick replies"],
                ["gptoss-chat", "Deeper work"],
              ]
                .filter(([id]) =>
                  taskProfiles(tools, mode === "code" ? "code" : "chat").some(
                    (p) =>
                      p.id === id &&
                      p.state === "ready" &&
                      p.compatibility?.compatible !== false,
                  ),
                )
                .map(([id, label]) => (
                  <button
                    type="button"
                    key={id}
                    aria-pressed={replyProfile?.id === id}
                    onClick={() => {
                      setProfile(id);
                      nonce.current = null;
                    }}
                  >
                    {label}
                  </button>
                ))}
            </div>
            <span className="eyebrow">LOCAL CREATIVE PARTNER</span>
            <ModelChoice
              tools={tools}
              task={mode === "code" ? "code" : "chat"}
              value={profile}
              onChange={(value) => {
                setProfile(value);
                nonce.current = null;
              }}
              defaultId={replyDefault}
              label="Reply model"
            />
          </div>
          {replyProfile?.package?.id === "qwen38-mxfp4" && (
            <ConversationControls
              value={
                optionsDraft?.conversation ||
                chat?.options?.conversation ||
                defaultConversationOptions
              }
              disabled={Boolean(optionsDraft)}
              onChange={(conversation) => saveOptions({ conversation })}
              pending={chat?.profile_change_pending}
            />
          )}
          {replyProfile?.id === "minicpm5-chat" && (
            <p className="fast-model-note">
              Fast replies · MiniCPM5-2B uses a smaller model and skips extended
              reasoning. Expect lower quality on complex questions, arithmetic
              and code. Switch to GPT-OSS for deeper work.
            </p>
          )}
          <p>
            {adjustableReasoning
              ? "Choose conversation mode and reasoning effort in the composer."
              : "This profile gives direct answers. Choose GPT-OSS for adjustable reasoning effort."}
          </p>
        </section>
        <section>
          <h2>Local tools</h2>
          <label className="conversation-option">
            <span>
              <strong>Project code tools</strong>
              <small>
                Allow reading selected source documents and saving new drafts.
                No code execution, arbitrary files or sending messages.
              </small>
            </span>
            <input
              type="checkbox"
              checked={
                optionsDraft?.tools_enabled ??
                chat?.options?.tools_enabled ??
                false
              }
              disabled={
                Boolean(optionsDraft) ||
                (replyProfile?.package?.id !== "qwen38-mxfp4" &&
                  !chat?.options?.tools_enabled)
              }
              onChange={(e) => saveOptions({ tools_enabled: e.target.checked })}
            />
          </label>
          <p>
            Document analysis · image generation · writing & code assistance
          </p>
          <small>
            Generated code is not executed. Image generation shares the GPU
            queue.
          </small>
        </section>
        <MachineStatus gpu={gpu} active={Boolean(busy)} />
      </aside>
    </section>
  );
}
