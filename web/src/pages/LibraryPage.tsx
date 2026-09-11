/**
 * Prediction Ledger — Video Library: transcript import (0.2), video list, extraction trigger.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { JobSummary, VideoSummary } from "@prediction-ledger/shared";
import { content, fmtClock, pollJob, ApiError } from "../api";
import { navigate } from "../App";

export function LibraryPage() {
  const [videos, setVideos] = useState<VideoSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, JobSummary>>({});

  const reload = useCallback(() => content.listVideos().then(setVideos).catch((e: Error) => setError(e.message)), []);
  useEffect(() => void reload(), [reload]);

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

      <div className="import-grid">
        <ImportTranscriptCard onImported={reload} />
        <div className="card muted-card">
          <strong>Local video file</strong>
          <p className="muted">MP4/MPEG import with local Whisper transcription arrives in Release 0.4.</p>
          <strong>YouTube URL</strong>
          <p className="muted">Caption and audio acquisition arrives in Release 0.5. Until then, download the captions and import them as a transcript.</p>
        </div>
      </div>

      {videos === null ? (
        <p className="muted">Loading…</p>
      ) : videos.length === 0 ? (
        <div className="empty-state">
          <p>No videos yet.</p>
          <p className="muted">Import a transcript (SRT, VTT, TXT, or JSON) to get started. Local video and YouTube import follow in later releases.</p>
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
                    <td>{v.sourceKind}</td>
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
                      {running ? (
                        <span className="progress"><span className="bar" style={{ width: `${job.progress}%` }} /> {job.stage ?? job.status}</span>
                      ) : job?.status === "failed" ? (
                        <span className="result error" title={job.error}>Failed: {job.error?.slice(0, 80)}</span>
                      ) : (
                        <span>{v.status === "ready" ? (job?.status === "completed" ? job.stage ?? "Ready" : "Ready") : v.status}</span>
                      )}
                    </td>
                    <td className="row-actions">
                      <button type="button" onClick={() => extract(v)} disabled={!!running || v.segmentCount === 0}>
                        {v.predictionCount ? "Re-extract" : "Extract predictions"}
                      </button>
                      <button type="button" className="danger" onClick={() => remove(v)} disabled={!!running}>Delete</button>
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
