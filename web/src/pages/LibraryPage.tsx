/**
 * Prediction Ledger — Video Library: transcript import (0.2), local media upload + transcription (0.4),
 * video list with progress, extraction trigger.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { JobSummary, MediaStatus, VideoSummary } from "@prediction-ledger/shared";
import { content, fmtClock, media, pollJob, ApiError } from "../api";
import { navigate } from "../App";

export function LibraryPage() {
  const [videos, setVideos] = useState<VideoSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, JobSummary>>({});
  const [mediaStatus, setMediaStatus] = useState<MediaStatus | null>(null);

  const reload = useCallback(() => content.listVideos().then(setVideos).catch((e: Error) => setError(e.message)), []);
  useEffect(() => void reload(), [reload]);
  useEffect(() => { media.status().then(setMediaStatus).catch(() => setMediaStatus(null)); }, []);

  // While any video is importing/transcribing, refresh the list so chunk progress stays live.
  const busyCount = videos?.filter((v) => v.status === "importing" || v.status === "transcribing").length ?? 0;
  useEffect(() => {
    if (!busyCount) return;
    const t = setInterval(() => void reload(), 1500);
    return () => clearInterval(t);
  }, [busyCount, reload]);

  const transcribe = async (v: VideoSummary, restart: boolean) => {
    if (restart && !window.confirm(`Re-transcribe "${v.title}" from scratch? The current transcript (and any corrections) will be replaced.`)) return;
    try {
      await media.transcribe(v.id, restart);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const extract = async (v: VideoSummary) => {
    try {
      const { jobId } = await content.extract(v.id);
      await pollJob(jobId, (j) => setJobs((m) => ({ ...m, [v.id]: j })));
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (v: VideoSummary) => {
    if (!window.confirm(`Delete "${v.title}" and all of its predictions? This cannot be undone.`)) return;
    await content.deleteVideo(v.id);
    await reload();
  };

  return (
    <section className="page">
      <div className="row space-between">
        <h1>Video Library</h1>
        <span className="row small">Export: <a href="/api/export/json" download>JSON</a> · <a href="/api/export/csv" download>CSV</a> <span className="muted">(never includes API keys)</span></span>
      </div>
      {error && <div className="banner error" role="alert">{error}</div>}

      {mediaStatus && (!mediaStatus.ffmpeg.ok || !mediaStatus.engine.ok) && (
        <div className="banner warn" role="status">
          {!mediaStatus.ffmpeg.ok && <div><strong>Video import needs ffmpeg.</strong> {mediaStatus.ffmpeg.message}</div>}
          {mediaStatus.ffmpeg.ok && !mediaStatus.engine.ok && <div><strong>Transcription engine not ready.</strong> {mediaStatus.engine.message} <a href="#/setup">Open Setup</a></div>}
        </div>
      )}

      <div className="import-grid">
        <UploadMediaCard onImported={reload} disabled={mediaStatus ? !mediaStatus.ffmpeg.ok : false} />
        <ImportTranscriptCard onImported={reload} />
        <div className="card muted-card">
          <strong>YouTube URL</strong>
          <p className="muted">Caption and audio acquisition arrives in Release 0.5. Until then, download the captions and import them as a transcript, or import the downloaded file above.</p>
        </div>
      </div>

      {videos === null ? (
        <p className="muted">Loading…</p>
      ) : videos.length === 0 ? (
        <div className="empty-state">
          <p>No videos yet.</p>
          <p className="muted">Drop a video or audio file to transcribe it locally, or import a transcript (SRT, VTT, TXT, or JSON). YouTube import follows in Release 0.5.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Title</th><th>Source</th><th>Duration</th><th>Published</th><th>Predictions</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {videos.map((v) => {
                const job = jobs[v.id];
                const running = job && (job.status === "queued" || job.status === "running");
                return (
                  <tr key={v.id}>
                    <td><a href={`#/videos/${v.id}`}>{v.title}</a></td>
                    <td>{v.sourceKind}{v.transcriptionEngine ? <small className="muted"> · {v.transcriptionEngine}</small> : null}</td>
                    <td>{fmtClock(v.durationS)}</td>
                    <td>{v.publishedAt ?? <span className="muted">unknown</span>}</td>
                    <td>
                      {v.predictionCount > 0 ? (
                        <a href={`#/predictions?videoId=${v.id}`}>{v.predictionCount}{v.pendingPredictionCount ? ` (${v.pendingPredictionCount} to review)` : ""}</a>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {v.status === "importing" ? (
                        <span className="progress"><span className="bar" style={{ width: "10%" }} /> Extracting audio…</span>
                      ) : v.status === "transcribing" ? (
                        <span className="progress">
                          <span className="bar" style={{ width: `${v.chunksTotal ? Math.round(((v.chunksDone ?? 0) / v.chunksTotal) * 100) : 5}%` }} />
                          {v.chunksTotal ? ` Transcribing ${v.chunksDone ?? 0}/${v.chunksTotal} chunks` : " Transcribing…"}
                        </span>
                      ) : v.status === "failed" ? (
                        <span className="result error" title={v.error}>Failed: {(v.error ?? "unknown error").slice(0, 80)}</span>
                      ) : running ? (
                        <span className="progress"><span className="bar" style={{ width: `${job.progress}%` }} /> {job.stage ?? job.status}</span>
                      ) : job?.status === "failed" ? (
                        <span className="result error" title={job.error}>Failed: {job.error?.slice(0, 80)}</span>
                      ) : (
                        <span title={v.error}>{v.status === "ready" ? (job?.status === "completed" ? job.stage ?? "Ready" : v.error ? "Ready (no speech found)" : "Ready") : v.status}</span>
                      )}
                    </td>
                    <td className="row-actions">
                      {v.mediaSize !== undefined && v.status === "failed" && (
                        <button type="button" onClick={() => transcribe(v, false)}>Retry</button>
                      )}
                      {v.mediaSize !== undefined && v.status === "ready" && (
                        <button type="button" onClick={() => transcribe(v, true)} disabled={!!running}>Re-transcribe</button>
                      )}
                      <button type="button" onClick={() => extract(v)} disabled={!!running || v.segmentCount === 0 || v.status === "importing" || v.status === "transcribing"}>
                        {v.predictionCount ? "Re-extract" : "Extract predictions"}
                      </button>
                      <button type="button" className="danger" onClick={() => remove(v)} disabled={!!running || v.status === "importing" || v.status === "transcribing"}>Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ImportTranscriptCard({ onImported }: { onImported: () => void }) {
  const [title, setTitle] = useState("");
  const [publishedAt, setPublishedAt] = useState("");
  const [language, setLanguage] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    setMsg(null);
    const text = file ? await file.text() : pasted;
    if (!text.trim()) return setMsg({ kind: "error", text: "Choose a file or paste transcript text first." });
    setBusy(true);
    try {
      const { video, warnings } = await content.importTranscript({
        title: title || file?.name.replace(/\.[^.]+$/, "") || "Imported transcript",
        content: text,
        format: "auto",
        filename: file?.name,
        publishedAt: publishedAt || undefined,
        language: language || undefined,
      });
      setMsg({ kind: "ok", text: `Imported ${video.segmentCount} segments${warnings.length ? ` — ${warnings.join(" ")}` : ""}.` });
      setFile(null); setPasted(""); setTitle("");
      if (inputRef.current) inputRef.current.value = "";
      onImported();
      navigate(`/videos/${video.id}`);
    } catch (e) {
      setMsg({ kind: "error", text: e instanceof ApiError ? e.message : (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`card dropzone${dragging ? " dragging" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) setFile(f); }}
    >
      <strong>Import a transcript</strong>
      <p className="muted">SRT, WebVTT, plain text (optionally with [hh:mm:ss] stamps), or JSON. Drop a file here or choose one.</p>
      <div className="row">
        <input ref={inputRef} type="file" accept=".srt,.vtt,.txt,.json,text/plain,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {file && <span className="chip local">{file.name}</span>}
      </div>
      <details>
        <summary>…or paste text</summary>
        <textarea rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Paste transcript text here" />
      </details>
      <div className="grid-3">
        <label className="field"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to the file name" /></label>
        <label className="field">
          <span>Published / recorded on</span>
          <input type="date" value={publishedAt} onChange={(e) => setPublishedAt(e.target.value)} />
          <small>Used as the statement date for deadlines like "within two years". Leave blank if unknown — it is never guessed.</small>
        </label>
        <label className="field"><span>Language</span><input value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en" /></label>
      </div>
      {msg && <div className={`banner ${msg.kind}`} role="status">{msg.text}</div>}
      <div className="row">
        <button type="button" className="primary" onClick={submit} disabled={busy}>{busy ? "Importing…" : "Import transcript"}</button>
      </div>
    </div>
  );
}

const MEDIA_ACCEPT = ".mp4,.m4v,.mpg,.mpeg,.mov,.mkv,.webm,.m4a,.mp3,.wav,.aac,.ogg,.flac,video/*,audio/*";

function UploadMediaCard({ onImported, disabled }: { onImported: () => void; disabled: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [publishedAt, setPublishedAt] = useState("");
  const [language, setLanguage] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    setMsg(null);
    if (!file) return setMsg({ kind: "error", text: "Choose a video or audio file first." });
    setBusy(true);
    try {
      const res = await media.upload(file, { title: title || undefined, publishedAt: publishedAt || undefined, language: language || undefined });
      setMsg(res.duplicate
        ? { kind: "ok", text: `This file was already imported as "${res.video.title}".` }
        : { kind: "ok", text: `Uploaded. Extracting audio and transcribing "${res.video.title}" — progress shows in the list below.` });
      setFile(null); setTitle("");
      if (inputRef.current) inputRef.current.value = "";
      onImported();
    } catch (e) {
      setMsg({ kind: "error", text: e instanceof ApiError ? e.message : (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`card dropzone${dragging ? " dragging" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) setFile(f); }}
    >
      <strong>Import a local video or audio file</strong>
      <p className="muted">MP4, MPEG, MOV, MKV, WebM, or audio (M4A, MP3, WAV…). The file is copied into your data folder and transcribed with the engine chosen in Setup. Drop it here or choose one.</p>
      <div className="row">
        <input ref={inputRef} type="file" accept={MEDIA_ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={disabled} />
        {file && <span className="chip local">{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</span>}
      </div>
      <div className="grid-3">
        <label className="field"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to the file name" /></label>
        <label className="field">
          <span>Published / recorded on</span>
          <input type="date" value={publishedAt} onChange={(e) => setPublishedAt(e.target.value)} />
          <small>Statement date for deadlines. Leave blank if unknown — it is never guessed.</small>
        </label>
        <label className="field"><span>Language</span><input value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en (blank = auto-detect)" /></label>
      </div>
      {msg && <div className={`banner ${msg.kind}`} role="status">{msg.text}</div>}
      <div className="row">
        <button type="button" className="primary" onClick={submit} disabled={busy || disabled || !file}>{busy ? "Uploading…" : "Upload and transcribe"}</button>
        {disabled && <small className="muted">Install ffmpeg to enable video import (see Setup).</small>}
      </div>
    </div>
  );
}
