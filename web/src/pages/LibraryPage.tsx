/**
 * Prediction Ledger — Video Library: transcript import (0.2), local media upload + transcription (0.4),
 * YouTube URL import (0.5), playlist/channel bulk import and subscriptions (1.8/1.11), video list with live progress,
 * extraction trigger. 2.1: one tabbed import panel instead of stacked cards, status chips with the next action,
 * loading / empty / error states, and the Guided start on the empty state.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { JobSummary, MediaStatus, ToolsStatus, VideoSummary } from "@prediction-ledger/shared";
import { api, content, fmtClock, media, pollJob, youtube, ApiError } from "../api";
import { navigate } from "../App";
import { SubscriptionsCard } from "../components/SubscriptionsCard";
import { HelpButton } from "../components/HelpButton";
import { Icon } from "../components/Icons";
import { EmptyState, ErrorState, Skeleton, StatusChip } from "../components/ui";
import { useGuidedStart } from "../hooks/useGuidedStart";

type ImportTab = "youtube" | "list" | "file" | "transcript" | "follow";
type ListFilter = "all" | "needs_extraction" | "in_progress";

export function LibraryPage() {
  const [videos, setVideos] = useState<VideoSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, JobSummary>>({});
  const [mediaStatus, setMediaStatus] = useState<MediaStatus | null>(null);
  const [tools, setTools] = useState<ToolsStatus | null>(null);
  const [liveJobs, setLiveJobs] = useState<Record<string, JobSummary>>({});
  const [tab, setTab] = useState<ImportTab>("youtube");
  const [panelOpen, setPanelOpen] = useState(true);
  const [filter, setFilter] = useState<ListFilter>("all");
  const guided = useGuidedStart();

  const reload = useCallback(() => content.listVideos().then((v) => { setVideos(v); setLoadError(null); }).catch((e: Error) => setLoadError(e.message)), []);
  useEffect(() => void reload(), [reload]);
  useEffect(() => { media.status().then(setMediaStatus).catch(() => setMediaStatus(null)); }, []);
  const reloadTools = useCallback(() => youtube.toolsStatus().then(setTools).catch(() => setTools(null)), []);
  useEffect(() => void reloadTools(), [reloadTools]);

  // While any video is importing/transcribing, refresh the list (and the latest job stage per video) so progress stays live.
  const busyCount = videos?.filter((v) => v.status === "importing" || v.status === "transcribing").length ?? 0;
  useEffect(() => {
    if (!busyCount) return;
    const tick = async () => {
      await reload();
      try {
        const js = await api.listJobs();
        const byVideo: Record<string, JobSummary> = {};
        for (const j of js) if (j.subjectType === "video" && j.subjectId && (j.status === "running" || j.status === "queued") && !byVideo[j.subjectId]) byVideo[j.subjectId] = j;
        setLiveJobs(byVideo);
      } catch { /* list refresh is best-effort */ }
    };
    void tick();
    const t = setInterval(() => void tick(), 1500);
    return () => clearInterval(t);
  }, [busyCount, reload]);

  const transcribe = async (v: VideoSummary, restart: boolean) => {
    const viaAudio = v.sourceKind === "youtube" && v.mediaSize === undefined;
    if (restart && !window.confirm(`Re-transcribe "${v.title}" from scratch?${viaAudio ? " The audio will be downloaded from YouTube and" : ""} the current transcript (and any corrections) will be replaced.`)) return;
    try { await media.transcribe(v.id, restart); await reload(); } catch (e) { setError((e as Error).message); }
  };
  const extract = async (v: VideoSummary) => {
    try {
      const { jobId } = await content.extract(v.id);
      await pollJob(jobId, (j) => setJobs((m) => ({ ...m, [v.id]: j })));
      await reload();
      void guided.refresh();
    } catch (e) { setError((e as Error).message); }
  };
  const remove = async (v: VideoSummary) => {
    if (!window.confirm(`Delete "${v.title}" and all of its predictions? This cannot be undone.`)) return;
    await content.deleteVideo(v.id);
    await reload();
  };
  const imported = () => { void reload(); void guided.refresh(); };

  const shown = (videos ?? []).filter((v) => filter === "all" ? true : filter === "in_progress" ? v.status === "importing" || v.status === "transcribing" || (jobs[v.id] && (jobs[v.id].status === "running" || jobs[v.id].status === "queued")) : v.status === "ready" && v.segmentCount > 0 && v.predictionCount === 0);
  const channels = new Set((videos ?? []).map((v) => v.subscriptionId).filter(Boolean)).size;

  return (
    <section className="page">
      <div className="row space-between" style={{ marginBottom: 10 }}>
        <div className="row tight">
          <button type="button" className={tab === "youtube" && panelOpen ? "primary" : undefined} onClick={() => { setTab("youtube"); setPanelOpen(true); }}><Icon name="plus" size={12} /> Import a video</button>
          <button type="button" onClick={() => { setTab("transcript"); setPanelOpen(true); }}>Import a transcript</button>
          <button type="button" onClick={() => { setTab("follow"); setPanelOpen(true); }}>Follow a channel</button>
        </div>
        <span className="row small muted">Export <a href="/api/export/json" download>JSON</a> · <a href="/api/export/csv" download>CSV</a> <span className="meta">never includes API keys</span></span>
      </div>
      {error && <div className="banner error" role="alert">{error} <button type="button" className="link" onClick={() => setError(null)}>dismiss</button></div>}

      {mediaStatus && (!mediaStatus.ffmpeg.ok || !mediaStatus.engine.ok) && (
        <div className="banner warn" role="status">
          {!mediaStatus.ffmpeg.ok && <div><strong>Video import needs ffmpeg.</strong> {mediaStatus.ffmpeg.message}</div>}
          {mediaStatus.ffmpeg.ok && !mediaStatus.engine.ok && <div><strong>Transcription engine not ready.</strong> {mediaStatus.engine.message} <a href="#/setup?section=transcription">Open Setup</a></div>}
        </div>
      )}

      {panelOpen && (
        <div className="card" style={{ paddingTop: 6 }}>
          <div className="tabs" role="tablist" aria-label="Import">
            {([["youtube", "YouTube link"], ["list", "Playlist or channel"], ["file", "Local video / audio"], ["transcript", "Transcript file"], ["follow", "Follow a channel"]] as [ImportTab, string][]).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "tab active" : "tab"} onClick={() => setTab(id)}>{label}</button>
            ))}
            <span style={{ flex: 1 }} />
            <button type="button" className="link" onClick={() => setPanelOpen(false)} aria-label="Hide the import panel">hide</button>
          </div>
          {tab === "youtube" && <ImportYouTubeCard onImported={imported} tools={tools} onToolsChanged={reloadTools} />}
          {tab === "list" && <ImportListCard onImported={imported} tools={tools} />}
          {tab === "file" && <UploadMediaCard onImported={imported} disabled={mediaStatus ? !mediaStatus.ffmpeg.ok : false} />}
          {tab === "transcript" && <ImportTranscriptCard onImported={imported} />}
          {tab === "follow" && <SubscriptionsCard onImported={imported} tools={tools} />}
        </div>
      )}

      <div className="row space-between" style={{ margin: "16px 0 8px" }}>
        <h2 style={{ margin: 0 }}>Videos <span className="muted small">{videos ? `${videos.length}${channels ? ` · ${channels} followed channel${channels === 1 ? "" : "s"}` : ""}` : ""}</span></h2>
        {videos && videos.length > 0 && (
          <div className="subtabs" role="group" aria-label="Filter videos">
            <button type="button" className={filter === "all" ? "active" : undefined} onClick={() => setFilter("all")}>All</button>
            <button type="button" className={filter === "needs_extraction" ? "active" : undefined} onClick={() => setFilter("needs_extraction")}>Needs extraction</button>
            <button type="button" className={filter === "in_progress" ? "active" : undefined} onClick={() => setFilter("in_progress")}>In progress</button>
          </div>
        )}
      </div>

      {loadError && videos === null ? (
        <ErrorState title="The library could not be loaded" message={<>{loadError}. <a href="#/learn?topic=troubleshoot.server">What to check</a></>} onRetry={() => void reload()} />
      ) : videos === null ? (
        <Skeleton rows={5} />
      ) : videos.length === 0 ? (
        <EmptyState title="No videos yet." action={<><button type="button" className="primary" onClick={() => { setTab("youtube"); setPanelOpen(true); }}>Paste a YouTube link</button><button type="button" onClick={() => { setTab("transcript"); setPanelOpen(true); }}>Import a transcript</button><a href="#/learn?topic=example.worked">See the worked example</a></>}>
          Paste a YouTube link, drop a video or audio file to transcribe it locally, or import a transcript (SRT, VTT, TXT, or JSON).
          {!guided.dismissed && guided.loaded && <span> Guided start: {guided.done} of {guided.total} steps done{guided.next ? ` — next: ${guided.next.title}` : ""}. <a href="#/setup?section=guided">Open</a></span>}
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState title="Nothing in this view.">{filter === "needs_extraction" ? "Every ready video already has predictions." : "Nothing is importing or transcribing right now."}</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Video</th><th>Source</th><th className="num">Duration</th><th>Published</th><th className="num">Predictions</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {shown.map((v) => {
                const job = jobs[v.id];
                const running = job && (job.status === "queued" || job.status === "running");
                const canTranscribe = v.mediaSize !== undefined || v.sourceKind === "youtube";
                return (
                  <tr key={v.id}>
                    <td><a href={`#/videos/${v.id}`}>{v.title}</a>{v.channel && <div className="meta">{v.channel}</div>}</td>
                    <td className="small">
                      {v.sourceKind === "youtube" && v.sourceRef ? <a href={v.sourceRef} target="_blank" rel="noreferrer noopener">YouTube ↗</a> : v.sourceKind === "transcript" ? "transcript import" : "local file"}
                      {v.transcriptSource && <div className="meta">{SOURCE_LABEL[v.transcriptSource]}</div>}
                    </td>
                    <td className="num">{fmtClock(v.durationS)}</td>
                    <td className="num">{v.publishedAt ?? <span className="muted">unknown</span>}</td>
                    <td className="num">
                      {v.predictionCount > 0 ? (
                        <a href={`#/predictions?videoId=${v.id}`}>{v.predictionCount}{v.pendingPredictionCount ? <span className="meta"> ({v.pendingPredictionCount} to review)</span> : ""}</a>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td><VideoStatus v={v} job={job} live={liveJobs[v.id]} /></td>
                    <td className="row-actions">
                      {canTranscribe && v.status === "failed" && <button type="button" className="small" onClick={() => transcribe(v, false)}>Retry</button>}
                      {v.status === "failed" && v.sourceKind === "youtube" && <button type="button" className="small" onClick={() => { setTab("transcript"); setPanelOpen(true); }}>Import transcript</button>}
                      {canTranscribe && v.status === "ready" && (
                        <button type="button" className="small" onClick={() => transcribe(v, true)} disabled={!!running} title={v.sourceKind === "youtube" && v.mediaSize === undefined ? "Downloads the audio and transcribes it with your engine instead of using YouTube captions" : undefined}>Re-transcribe</button>
                      )}
                      {v.status === "ready" && v.segmentCount > 0 && (
                        <button type="button" className={v.predictionCount ? "small" : "small primary"} onClick={() => extract(v)} disabled={!!running}>
                          {v.predictionCount ? "Re-extract" : "Extract predictions"}
                        </button>
                      )}
                      {v.predictionCount > 0 && <a className="small" href={`#/predictions?videoId=${v.id}`}>Open predictions</a>}
                      <button type="button" className="link danger" onClick={() => remove(v)} disabled={!!running || v.status === "importing" || v.status === "transcribing"}>delete</button>
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

/** Status chip + the sentence that says what happens next. */
function VideoStatus({ v, job, live }: { v: VideoSummary; job?: JobSummary; live?: JobSummary }) {
  const running = job && (job.status === "queued" || job.status === "running");
  if (v.status === "importing") return <><StatusChip variant="filled" tone="info"><Icon name="spinnerGap" size={11} className="spin" /> Importing</StatusChip><div className="meta">{live?.stage ?? (v.sourceKind === "youtube" ? "contacting YouTube…" : "extracting audio…")}</div></>;
  if (v.status === "transcribing") return <><StatusChip variant="filled" tone="info"><Icon name="spinnerGap" size={11} className="spin" /> Transcribing</StatusChip><div className="meta">{v.chunksTotal ? `chunk ${Math.min((v.chunksDone ?? 0) + 1, v.chunksTotal)} of ${v.chunksTotal}` : "starting…"} · safe to close the tab; resumes after restart</div></>;
  if (v.status === "failed") return <><StatusChip variant="filled" tone="bad"><Icon name="xCircle" size={11} /> Failed</StatusChip><div className="meta" title={v.error}>{(v.error ?? "unknown error").slice(0, 110)}</div></>;
  if (running) return <><StatusChip variant="filled" tone="info"><Icon name="spinnerGap" size={11} className="spin" /> Extracting</StatusChip><div className="meta">{job.stage ?? job.status} · {job.progress}%</div></>;
  if (job?.status === "failed") return <><StatusChip variant="filled" tone="bad"><Icon name="xCircle" size={11} /> Extraction failed</StatusChip><div className="meta" title={job.error}>{job.error?.slice(0, 110)}</div></>;
  if (v.status === "ready") {
    const note = job?.status === "completed" ? job.stage : v.error ? "no speech found" : v.segmentCount === 0 ? "empty transcript" : v.predictionCount === 0 ? "next: extract predictions" : undefined;
    return <><StatusChip variant="filled" tone="ok"><Icon name="checkCircle" size={11} /> Ready</StatusChip>{note && <div className="meta">{note}</div>}</>;
  }
  return <StatusChip variant="outlined">{v.status}</StatusChip>;
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
      className={`dropzone${dragging ? " dragging" : ""}`}
      style={{ padding: "8px 4px 4px", borderRadius: 8 }}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) setFile(f); }}
    >
      <p className="muted">SRT, WebVTT, plain text (optionally with [hh:mm:ss] stamps), or JSON. Drop a file here or choose one. Nothing is sent anywhere. <HelpButton topic="guide.import">What happens</HelpButton></p>
      <div className="row">
        <input ref={inputRef} type="file" accept=".srt,.vtt,.txt,.json,text/plain,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {file && <span className="chip local">{file.name}</span>}
      </div>
      <details>
        <summary className="small">…or paste text</summary>
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

const SOURCE_LABEL: Record<NonNullable<VideoSummary["transcriptSource"]>, string> = {
  "captions-manual": "creator captions",
  "captions-auto": "auto captions",
  transcribed: "transcribed",
  imported: "imported transcript",
};

function ImportYouTubeCard({ onImported, tools, onToolsChanged }: { onImported: () => void; tools: ToolsStatus | null; onToolsChanged: () => void }) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [publishedAt, setPublishedAt] = useState("");
  const [language, setLanguage] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [installing, setInstalling] = useState<JobSummary | null>(null);

  const submit = async () => {
    setMsg(null);
    if (!url.trim()) return setMsg({ kind: "error", text: "Paste a YouTube link first." });
    setBusy(true);
    try {
      const res = await youtube.import({ url: url.trim(), title: title || undefined, publishedAt: publishedAt || undefined, language: language || undefined });
      setMsg(res.duplicate
        ? { kind: "ok", text: `Already imported as "${res.video.title}".` }
        : { kind: "ok", text: "Import started — captions are used when available; otherwise the audio is downloaded and transcribed. Progress shows in the list below." });
      setUrl(""); setTitle("");
      onImported();
    } catch (e) {
      setMsg({ kind: "error", text: e instanceof ApiError ? e.message : (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    setMsg(null);
    if (!window.confirm("Download yt-dlp (about 30 MB) from its official GitHub release into your Prediction Ledger data folder? The file is checksum-verified before it is used.")) return;
    try {
      const { jobId } = await youtube.installYtDlp();
      const done = await pollJob(jobId, setInstalling);
      setInstalling(null);
      if (done.status === "failed") setMsg({ kind: "error", text: done.error ?? "Install failed." });
      else setMsg({ kind: "ok", text: "yt-dlp installed. Paste a link to import." });
      onToolsChanged();
    } catch (e) {
      setInstalling(null);
      setMsg({ kind: "error", text: (e as Error).message });
    }
  };

  const offline = tools ? !tools.internet : false;
  const needsTool = tools ? !tools.ytdlp.ok : false;

  return (
    <div>
      <p className="muted">Creator captions are used first, then auto-generated captions, then the audio is downloaded and transcribed with your engine (Setup → YouTube). Everything fetched is stored locally. <HelpButton topic="guide.import">What happens</HelpButton></p>
      {offline && <div className="banner warn">Internet access is off in Setup → Privacy, so YouTube import is disabled. <a href="#/learn?topic=troubleshoot.privacy-pending">Why</a></div>}
      {!offline && needsTool && (
        <div className="banner warn">
          <div><strong>yt-dlp is needed for YouTube import.</strong> {tools?.ytdlp.message}</div>
          <div className="row">
            <button type="button" className="primary" onClick={install} disabled={!!installing}>{installing ? `Installing… ${installing.progress}%` : "Install yt-dlp"}</button>
            {installing?.stage && <small className="muted">{installing.stage}</small>}
          </div>
        </div>
      )}
      <label className="field">
        <span>Video link</span>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=… or https://youtu.be/…" disabled={offline} />
      </label>
      <div className="grid-3">
        <label className="field"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to the YouTube title" /></label>
        <label className="field">
          <span>Recorded on</span>
          <input type="date" value={publishedAt} onChange={(e) => setPublishedAt(e.target.value)} />
          <small>Defaults to the upload date. Set it when the talk was recorded earlier than it was posted.</small>
        </label>
        <label className="field"><span>Language</span><input value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="auto" /></label>
      </div>
      {msg && <div className={`banner ${msg.kind}`} role="status">{msg.text}</div>}
      <div className="row">
        <button type="button" className="primary" onClick={submit} disabled={busy || offline || needsTool || !url.trim()}>{busy ? "Starting…" : "Import from YouTube"}</button>
        <span className="meta">Private, members-only and removed videos cannot be fetched — import a transcript for those.</span>
      </div>
    </div>
  );
}

function ImportListCard({ onImported, tools }: { onImported: () => void; tools: ToolsStatus | null }) {
  const [url, setUrl] = useState("");
  const [limit, setLimit] = useState(20);
  const [autoExtract, setAutoExtract] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const offline = tools ? !tools.internet : false;
  const needsTool = tools ? !tools.ytdlp.ok : false;
  const submit = async () => {
    setMsg(null);
    setBusy("Listing…");
    try {
      const { jobId } = await youtube.importList({ url: url.trim(), limit, autoExtract });
      const done = await pollJob(jobId, (j) => setBusy(j.stage ?? "Listing…"));
      if (done.status === "failed") setMsg({ kind: "error", text: done.error ?? "Listing failed." });
      else {
        const r = (done.result ?? {}) as { found?: number; queued?: number; skipped?: number; listTitle?: string };
        setMsg({ kind: "ok", text: `${r.listTitle ? `"${r.listTitle}": ` : ""}${r.found ?? 0} video(s) found, ${r.queued ?? 0} queued${r.skipped ? `, ${r.skipped} already in the ledger` : ""}. Imports run one by one below${autoExtract ? "; predictions are extracted as each transcript lands" : ""}.` });
        setUrl("");
      }
      onImported();
    } catch (e) {
      setMsg({ kind: "error", text: e instanceof ApiError ? e.message : (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div>
      <p className="muted">Lists the videos (newest first) without downloading them, then queues each one through the normal YouTube import. Use it to load a channel's picks or macro calls in one go so the same claims can be compared across videos (Signals → Consensus).</p>
      {offline && <div className="banner warn">Internet access is off in Setup → Privacy, so YouTube import is disabled.</div>}
      <div className="grid-3">
        <label className="field"><span>Playlist or channel link</span><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.youtube.com/@channel/videos or …/playlist?list=…" disabled={offline} /></label>
        <label className="field"><span>Max videos</span><input type="number" min={1} max={200} value={limit} onChange={(e) => setLimit(Math.min(200, Math.max(1, Number(e.target.value) || 1)))} /><small>Each import fetches captions or audio; keep it modest the first time.</small></label>
        <label className="row"><input type="checkbox" checked={autoExtract} onChange={(e) => setAutoExtract(e.target.checked)} /> <span>Extract predictions automatically</span></label>
      </div>
      {msg && <div className={`banner ${msg.kind}`} role="status">{msg.text}</div>}
      <div className="row">
        <button type="button" className="primary" onClick={submit} disabled={!!busy || offline || needsTool || !url.trim()}>{busy ?? "Import list"}</button>
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
      className={`dropzone${dragging ? " dragging" : ""}`}
      style={{ padding: "8px 4px 4px", borderRadius: 8 }}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) setFile(f); }}
    >
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
