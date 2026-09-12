import React, { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Upload,
  Mic,
  ShieldCheck,
  FileText,
  Download,
  Play,
  Square,
} from "lucide-react";

const time = (s) =>
  `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, "0")}`;
export default function MeetingStudio({ api, project }) {
  const [readiness, setReadiness] = useState(null),
    [uploadProgress, setUploadProgress] = useState(0);
  const [meetings, setMeetings] = useState([]),
    [selected, setSelected] = useState(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [recording, setRecording] = useState(false);
  const [source, setSource] = useState("microphone"),
    [elapsed, setElapsed] = useState(0);
  const [track, setTrack] = useState(0),
    [channel, setChannel] = useState("");
  const capture = useRef(null),
    player = useRef(null),
    started = useRef(0);
  const refresh = async () => {
    const items = await api(
      "/meetings" + (project ? `?project=${project.id}` : ""),
    );
    setMeetings(items);
  };
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    api("/meetings/readiness")
      .then(setReadiness)
      .catch((e) => setError(e.message));
    return () => {
      if (capture.current?.recorder.state !== "inactive")
        capture.current?.recorder.stop();
      capture.current?.stream.getTracks().forEach((t) => t.stop());
    };
  }, []);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(
      () => setElapsed((Date.now() - started.current) / 1000),
      500,
    );
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => {
    setTrack(0);
    setChannel("");
  }, [selected?.id]);
  useEffect(() => {
    if (selected)
      setMeetings((items) =>
        items.map((item) =>
          item.id === selected.id ? { ...item, state: selected.state } : item,
        ),
      );
  }, [selected?.id, selected?.state]);
  useEffect(() => {
    if (
      !selected ||
      !["queued", "processing", "loading", "preparing"].includes(selected.state)
    )
      return;
    const timer = setInterval(
      () =>
        api(`/meetings/${selected.id}`)
          .then(setSelected)
          .catch((e) => setError(e.message)),
      3000,
    );
    return () => clearInterval(timer);
  }, [selected?.id, selected?.state]);
  async function processMeeting() {
    setError("");
    setBusy(true);
    try {
      setSelected(
        await api(`/meetings/${selected.id}/process`, {
          track,
          channel: channel === "" ? null : Number(channel),
        }),
      );
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function uploadPart(id, index, blob) {
    const form = new FormData();
    form.append("file", blob, "chunk");
    await api(`/meetings/${id}/chunks/${index}`, form);
  }
  async function importFile(file) {
    if (!file) return;
    if (!file.size || file.size > 4 * 1024 ** 3) {
      setError("Choose a recording between 1 byte and 4 GiB.");
      return;
    }
    setUploadProgress(0);
    setBusy(true);
    setError("");
    let item;
    try {
      item = await api("/meetings", {
        name: file.name,
        filename: file.name,
        source: "import",
        project: project?.id,
      });
      setSelected(item);
      for (
        let offset = 0, index = 0;
        offset < file.size;
        offset += 4 * 1024 * 1024, index++
      ) {
        await uploadPart(
          item.id,
          index,
          file.slice(offset, offset + 4 * 1024 * 1024),
        );
        setUploadProgress(
          Math.min(
            100,
            Math.round(((offset + 4 * 1024 * 1024) / file.size) * 100),
          ),
        );
      }
      setSelected(await api(`/meetings/${item.id}/finish`, {}));
      await refresh();
    } catch (e) {
      setError(e.message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function startCapture() {
    if (!window.isSecureContext) {
      setError(
        "Microphone and shared-audio capture need HTTPS or localhost. Recording import works here.",
      );
      return;
    }
    setError("");
    setBusy(true);
    let stream;
    try {
      stream =
        source === "microphone"
          ? await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true },
              video: false,
            })
          : await navigator.mediaDevices.getDisplayMedia({
              video: true,
              audio: true,
              systemAudio: "include",
            });
      if (!stream.getAudioTracks().length)
        throw Error(
          "No audio was shared. Select a browser tab with Share audio enabled, or import a recording.",
        );
      const audio = new MediaStream(stream.getAudioTracks());
      const mime = [
        "audio/webm;codecs=opus",
        "audio/ogg;codecs=opus",
        "audio/mp4",
      ].find((m) => MediaRecorder.isTypeSupported(m));
      if (!mime)
        throw Error(
          "This browser has no supported recording codec. Import a recording instead.",
        );
      const ext = mime.includes("webm")
        ? "webm"
        : mime.includes("ogg")
          ? "ogg"
          : "m4a";
      const item = await api("/meetings", {
        name: "Meeting " + new Date().toLocaleString(),
        filename: "capture." + ext,
        source,
        project: project?.id,
      });
      const recorder = new MediaRecorder(audio, {
        mimeType: mime,
        audioBitsPerSecond: 128000,
      });
      let chain = Promise.resolve(),
        index = 0,
        failed = false,
        pending = 0;
      recorder.ondataavailable = (e) => {
        if (!e.data.size || failed) return;
        pending += e.data.size;
        if (pending > 16 * 1024 * 1024) {
          failed = true;
          setError(
            "Capture stopped because uploads could not keep up. The saved partial recording is retained.",
          );
          if (recorder.state !== "inactive") recorder.stop();
          return;
        }
        chain = chain
          .then(async () => {
            for (let n = 0; n < e.data.size; n += 4 * 1024 * 1024)
              await uploadPart(
                item.id,
                index++,
                e.data.slice(n, n + 4 * 1024 * 1024),
              );
            pending -= e.data.size;
          })
          .catch((err) => {
            failed = true;
            setError(
              "Capture upload failed. Stop and retain the incomplete recording for recovery: " +
                err.message,
            );
            if (recorder.state !== "inactive") recorder.stop();
          });
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        capture.current = null;
        await chain;
        try {
          if (!failed)
            setSelected(await api(`/meetings/${item.id}/finish`, {}));
          await refresh();
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      };
      stream.getTracks().forEach((t) => {
        t.onended = () => {
          if (recorder.state !== "inactive") recorder.stop();
        };
      });
      recorder.onerror = () => {
        setError(
          "The recording device disconnected or failed. Stop and check the saved recording.",
        );
        if (recorder.state !== "inactive") recorder.stop();
      };
      capture.current = { recorder, stream };
      started.current = Date.now();
      setElapsed(0);
      setSelected(item);
      recorder.start(2000);
      setRecording(true);
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      setError(e.message);
      setBusy(false);
    }
  }
  async function remove(item) {
    try {
      await api(`/meetings/${item.id}`, undefined, "DELETE");
      setSelected(null);
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  }
  async function exportMeeting() {
    const data = await api(`/meetings/${selected.id}/export`);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "meeting.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function seek(seconds) {
    if (player.current) {
      player.current.currentTime = seconds;
      player.current.play().catch(() => {});
    }
  }
  const active =
    selected &&
    ["queued", "processing", "loading", "preparing", "cancelling"].includes(
      selected.state,
    );
  const canRecord =
    window.isSecureContext &&
    !!navigator.mediaDevices &&
    typeof MediaRecorder !== "undefined";
  return (
    <section className="meeting-studio">
      <div className="section-heading">
        <div>
          <span className="eyebrow">YOUR CONVERSATIONS. YOUR MACHINE.</span>
          <h1>Transcribe your meeting</h1>
          <p className="lead">
            Turn a recording into a transcript, speaker turns and useful notes.
            All inference stays local.
          </p>
        </div>
        <span className="mcp-state">
          <ShieldCheck size={17} /> Local audio processing
        </span>
      </div>
      <div className="meeting-import panel">
        <AudioLines size={34} />
        <div>
          <h2>Start with a recording</h2>
          <p>
            WAV, MP3, M4A / MP4, FLAC, Ogg or WebM · up to 4 GiB / 8 hours.
            English is the qualified language.
          </p>
          <small>
            Import a complete meeting recording to include every participant.
            Only record or upload with permission.
          </small>
        </div>
        <label className="button primary meeting-upload">
          <Upload size={17} /> Import recording
          <input
            aria-label="Import meeting recording"
            type="file"
            accept="audio/*,video/mp4,video/webm"
            disabled={busy}
            onChange={(e) => {
              importFile(e.target.files[0]);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {!readiness?.ready && (
        <div className="notice" role="status">
          <strong>
            {readiness
              ? "Meeting setup required"
              : "Checking your local meeting tools…"}
          </strong>
          {readiness && (
            <>
              <p>{readiness.message}</p>
              <a
                href="https://github.com/Eliovp-BV/paiton-vllm-plugin/blob/main/models/Meeting/REPRODUCE.md"
                target="_blank"
                rel="noreferrer"
              >
                Meeting package setup instructions ↗
              </a>
              <p className="helper">
                One-time setup downloads the runtime and pinned models. Speaker
                separation needs your own approved community-1 access. Importing
                is available while setup is pending.
              </p>
            </>
          )}
        </div>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {busy && !recording && selected?.state === "uploading" && (
        <div className="meeting-upload-progress" role="status">
          <span>Saving recording on the Studio host · {uploadProgress}%</span>
          <progress max="100" value={uploadProgress} />
          <small>Keep this tab open until the upload finishes.</small>
        </div>
      )}
      <details className="meeting-capture panel">
        <summary>
          <Mic size={17} /> Record from this device
        </summary>
        <p>
          Capture one source, then transcribe after stopping. Stay on this
          screen while recording; navigating away stops and saves the captured
          audio.
        </p>
        <div className="actions">
          <select
            aria-label="Recording source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            disabled={busy}
          >
            <option value="microphone">Microphone on this device</option>
            <option value="shared-audio">Shared tab or system audio</option>
          </select>
          {!recording ? (
            <button disabled={busy || !canRecord} onClick={startCapture}>
              <Mic size={16} /> Start recording
            </button>
          ) : (
            <button
              className="primary"
              onClick={() => capture.current?.recorder.stop()}
            >
              <Square size={16} /> Stop recording · {time(elapsed)}
            </button>
          )}
        </div>
        {!canRecord && (
          <p className="helper">
            Browser recording requires HTTPS or localhost and a supported
            browser. Import a recording over this LAN connection, or open Studio
            using trusted HTTPS.
          </p>
        )}
        {recording && (
          <p className="notice" role="status">
            Recording {source === "microphone" ? "microphone" : "shared audio"}{" "}
            · {time(elapsed)}
          </p>
        )}
        <p className="helper">
          Shared audio may omit your microphone. Tab sharing does not capture a
          native Teams app. This records one source at a time; browser and
          operating-system sharing options vary.
        </p>
      </details>
      <div className="meeting-layout">
        <aside className="meeting-list panel">
          <span className="eyebrow">SAVED ON THIS HOST</span>
          <h2>Recordings</h2>
          {!meetings.length && (
            <p className="helper">Your imported recordings will appear here.</p>
          )}
          {meetings.map((m) => (
            <button
              key={m.id}
              className={selected?.id === m.id ? "chosen" : ""}
              disabled={busy}
              onClick={() =>
                api(`/meetings/${m.id}`)
                  .then(setSelected)
                  .catch((e) => setError(e.message))
              }
            >
              <AudioLines size={18} />
              <span>
                <strong>{m.name}</strong>
                <small>
                  {m.duration ? time(m.duration) + " · " : ""}
                  {m.state}
                </small>
              </span>
            </button>
          ))}
        </aside>
        {!selected ? (
          <div className="meeting-empty panel">
            <AudioLines size={52} />
            <h2>Listen less. Find what matters.</h2>
            <p>
              Import a recording to review timestamped speech, anonymous
              speakers and partial meeting notes alongside playback.
            </p>
            <div>
              01 Import <span>→</span> 02 Transcribe <span>→</span> 03 Review &
              export
            </div>
          </div>
        ) : (
          <article className="meeting-result panel">
            <span className="eyebrow">
              {selected.duration ? time(selected.duration) + " · " : ""}
              {selected.state}
            </span>
            <h2>{selected.name}</h2>
            <p role="status" className={active ? "notice" : ""}>
              {selected.message}
            </p>
            {active && (
              <div className="meeting-progress">
                <progress aria-label="Meeting processing in progress" />
                <p>
                  Loading each local model can take a while. Your request is
                  saved in the shared GPU queue; keep the host running and
                  continue browsing.
                </p>
                <button
                  onClick={() =>
                    api(`/meetings/${selected.id}/cancel`, {})
                      .then(setSelected)
                      .catch((e) => setError(e.message))
                  }
                >
                  <Square size={15} /> Cancel processing
                </button>
              </div>
            )}
            {["imported", "failed", "cancelled"].includes(selected.state) && (
              <div className="meeting-process">
                <details>
                  <summary>Audio source & channels</summary>
                  <div className="meeting-source-controls">
                    <label>
                      Audio track
                      <select
                        aria-label="Audio track"
                        value={track}
                        onChange={(e) => {
                          setTrack(Number(e.target.value));
                          setChannel("");
                        }}
                      >
                        {selected.tracks?.map((t, i) => (
                          <option key={i} value={i}>
                            Track {i + 1} · {t.channels} channels · {t.codec}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Channel
                      <select
                        aria-label="Audio channel"
                        value={channel}
                        onChange={(e) => setChannel(e.target.value)}
                      >
                        <option value="">Ordinary stereo downmix</option>
                        {Array.from(
                          { length: selected.tracks?.[track]?.channels || 0 },
                          (_, i) => (
                            <option key={i} value={i}>
                              Channel {i + 1} only
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                  </div>
                  <p className="helper">
                    For separate microphone and system feeds, choose one track
                    or channel. Keep the original recording to preserve every
                    feed.
                  </p>
                </details>
                <button
                  className="primary"
                  disabled={busy || !readiness?.ready}
                  onClick={processMeeting}
                >
                  <Play size={16} /> Transcribe and summarize locally
                </button>
                <p className="helper">
                  Speech recognition → speaker turns → local notes. Models run
                  in sequence so they can share your GPU memory.
                </p>
              </div>
            )}
            {selected.state !== "uploading" &&
              selected.recording_retained !== false && (
                <audio
                  key={selected.id}
                  controls
                  ref={player}
                  src={`/api/meetings/${selected.id}/recording`}
                />
              )}
            {selected.state === "completed" && (
              <div className="actions meeting-exports">
                <button onClick={exportMeeting}>
                  <Download size={16} /> Export transcript and notes (JSON)
                </button>
                {["txt", "srt", "vtt"].map((format) => (
                  <a
                    className="button"
                    key={format}
                    href={`/api/meetings/${selected.id}/export?format=${format}`}
                    download
                  >
                    {format.toUpperCase()}
                  </a>
                ))}
              </div>
            )}
            {selected.summary && (
              <section className="meeting-notes">
                <span className="eyebrow">
                  NOTES WITH TRANSCRIPT REFERENCES
                </span>
                <h3>Meeting notes · partial draft</h3>
                <p className="helper">
                  These notes may omit discussion or decisions. Check the linked
                  transcript before acting on them.
                </p>
                <p>{selected.summary.overview}</p>
                {["topics", "decisions", "actions", "open_questions"].map(
                  (category) => (
                    <div key={category}>
                      <h4>{category.replace("_", " ")}</h4>
                      {!selected.summary[category].length && (
                        <p className="helper">None extracted.</p>
                      )}
                      {selected.summary[category].map((claim, i) => (
                        <div className="meeting-claim" key={i}>
                          {typeof claim === "string" ? (
                            claim
                          ) : (
                            <>
                              <p>{claim.text}</p>
                              {claim.owner && (
                                <small>
                                  Owner: {claim.owner} · Deadline:{" "}
                                  {claim.deadline || "Not specified"}
                                </small>
                              )}
                              <div className="actions">
                                {claim.segment_ids.map((id) => {
                                  const segment = selected.transcript.find(
                                    (s) => s.id === id,
                                  );
                                  return (
                                    segment && (
                                      <button
                                        key={id}
                                        onClick={() => seek(segment.start)}
                                      >
                                        {time(segment.start)}
                                      </button>
                                    )
                                  );
                                })}
                              </div>
                              <q>{claim.quote}</q>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  ),
                )}
              </section>
            )}
            {selected.transcript && (
              <>
                <details className="meeting-speakers">
                  <summary>Label speakers</summary>
                  <p className="helper">
                    Anonymous clusters are not verified identities. Add names
                    only when you know the participants.
                  </p>
                  {[...new Set(selected.transcript.map((s) => s.speaker))]
                    .filter((s) => !["UNKNOWN", "UNCERTAIN"].includes(s))
                    .map((s) => (
                      <label key={selected.id + s}>
                        {s}
                        <input
                          aria-label={`Name for ${s}`}
                          defaultValue={selected.speaker_names[s] || ""}
                          placeholder="Anonymous speaker"
                          onBlur={(e) => {
                            const name = e.target.value.trim();
                            if (name && name !== selected.speaker_names[s])
                              api(`/meetings/${selected.id}/speakers/${s}`, {
                                name,
                              })
                                .then(setSelected)
                                .catch((e) => setError(e.message));
                          }}
                        />
                      </label>
                    ))}
                </details>
                <h3>
                  <FileText size={18} /> Timestamped transcript
                </h3>
                <div className="meeting-transcript">
                  {selected.transcript.map((s) => (
                    <div key={s.id}>
                      <button onClick={() => seek(s.start)}>
                        {time(s.start)}
                      </button>
                      <p>
                        <strong>
                          {selected.speaker_names[s.speaker] || s.speaker}
                        </strong>
                        {s.text}
                      </p>
                    </div>
                  ))}
                </div>
              </>
            )}
            <details className="meeting-retention">
              <summary>Recording storage & deletion</summary>
              <label>
                Recording retention
                <select
                  aria-label="Recording retention"
                  value={selected.retention}
                  disabled={active || busy}
                  onChange={(e) =>
                    api(`/meetings/${selected.id}/retention`, {
                      retention: e.target.value,
                    })
                      .then(setSelected)
                      .catch((e) => setError(e.message))
                  }
                >
                  <option value="keep">Keep recording until I delete it</option>
                  <option value="delete-recording-after-processing">
                    Delete recording after successful processing
                  </option>
                </select>
              </label>
              <p className="helper">
                Deleting this import removes its recording, transcript and notes
                from Studio. Your original file is preserved.
              </p>
              <button
                disabled={active || busy}
                onClick={() => {
                  if (
                    window.confirm(
                      "Delete this Studio recording and its derived transcript and notes? Your original file is preserved.",
                    )
                  )
                    remove(selected);
                }}
              >
                Delete recording and derived content
              </button>
            </details>
          </article>
        )}
      </div>
    </section>
  );
}
