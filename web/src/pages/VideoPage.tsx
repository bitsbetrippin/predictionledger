/**
 * Prediction Ledger — Video detail: metadata, timestamped transcript with corrections, predictions in this video.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { useCallback, useEffect, useState } from "react";
import type { JobSummary, TranscriptSegment, VideoDetail } from "@prediction-ledger/shared";
import { content, fmtClock, pollJob, type PredictionRow } from "../api";

export function VideoPage({ id }: { id: string }) {
  const [video, setVideo] = useState<VideoDetail | null>(null);
  const [preds, setPreds] = useState<PredictionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<JobSummary | null>(null);
  const [editingMeta, setEditingMeta] = useState(false);
  const [publishedAt, setPublishedAt] = useState("");
  const [title, setTitle] = useState("");

  const reload = useCallback(async () => {
    try {
      const v = await content.getVideo(id);
      setVideo(v);
      setTitle(v.title);
      setPublishedAt(v.publishedAt ?? "");
      setPreds(await content.listPredictions({ videoId: id }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => void reload(), [reload]);

  const extract = async () => {
    setError(null);
    try {
      const { jobId } = await content.extract(id);
      const done = await pollJob(jobId, setJob);
      if (done.status === "failed") setError(done.error ?? "Extraction failed.");
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const saveMeta = async () => {
    await content.updateVideo(id, { title, publishedAt: publishedAt || null });
    setEditingMeta(false);
    await reload();
  };

  if (error && !video) return <section className="page"><div className="banner error">{error}</div></section>;
  if (!video) return <section className="page">Loading…</section>;
  const running = job && (job.status === "queued" || job.status === "running");

  return (
    <section className="page">
      <p><a href="#/library">← Library</a></p>
      {editingMeta ? (
        <div className="card">
          <label className="field"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="field"><span>Published / recorded on</span><input type="date" value={publishedAt} onChange={(e) => setPublishedAt(e.target.value)} /><small>Changing this does not re-date existing predictions; re-extract or edit them individually.</small></label>
          <div className="row"><button type="button" className="primary" onClick={saveMeta}>Save</button><button type="button" onClick={() => setEditingMeta(false)}>Cancel</button></div>
        </div>
      ) : (
        <>
          <h1>{video.title}</h1>
          <p className="muted">
            {video.sourceKind}{video.sourceRef ? ` · ${video.sourceRef}` : ""} · {fmtClock(video.durationS)} · published {video.publishedAt ?? "unknown"} · {video.language ?? "language unknown"} · imported {video.importedAt.slice(0, 10)}
            {" "}<button type="button" className="link" onClick={() => setEditingMeta(true)}>edit</button>
          </p>
        </>
      )}
      {video.notes && <div className="banner">{video.notes}</div>}
      {error && <div className="banner error" role="alert">{error}</div>}

      <div className="row">
        <button type="button" className="primary" onClick={extract} disabled={!!running}>{preds.length ? "Re-extract predictions" : "Extract predictions"}</button>
        {running && <span className="progress"><span className="bar" style={{ width: `${job!.progress}%` }} /> {job!.stage ?? job!.status}</span>}
        {job?.status === "completed" && <span className="result ok">✓ {job.stage}</span>}
        {preds.length > 0 && <a href={`#/predictions?videoId=${video.id}`}>Open in Predictions →</a>}
      </div>

      <div className="two-col">
        <div>
          <h2>Transcript <span className="muted">({video.segments.length} segments)</span></h2>
          <div className="transcript">
            {video.segments.map((s) => (
              <SegmentRow key={s.id} videoId={video.id} seg={s} highlighted={preds.some((p) => p.startS !== undefined && p.endS !== undefined && s.startS >= p.startS - 0.01 && s.endS <= p.endS + 0.01)} onChanged={reload} />
            ))}
          </div>
        </div>
        <div>
          <h2>Predictions <span className="muted">({preds.length})</span></h2>
          {preds.length === 0 ? (
            <div className="empty-state"><p className="muted">{job?.status === "completed" ? "No predictions found in this transcript." : "Run extraction to find predictions."}</p></div>
          ) : (
            <ul className="pred-list">
              {preds.map((p) => (
                <li key={p.id}>
                  <a href={`#/predictions?videoId=${video.id}&id=${p.id}`}>
                    <span className="muted">{fmtClock(p.startS)}</span> {p.normalizedStatement}
                  </a>
                  <div className="muted small">
                    Deadline {p.deadlineDate ?? "unknown"} · {p.userStatus}{p.latestPlanVersion ? ` · plan v${p.latestPlanVersion}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function SegmentRow({ videoId, seg, highlighted, onChanged }: { videoId: string; seg: TranscriptSegment; highlighted: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(seg.textCorrected ?? seg.textOriginal);
  const save = async () => {
    await content.correctSegment(videoId, seg.id, text === seg.textOriginal ? null : text);
    setEditing(false);
    onChanged();
  };
  return (
    <div className={`segment${highlighted ? " highlighted" : ""}`}>
      <span className="stamp">{fmtClock(seg.startS)}</span>
      <div className="segment-body">
        {editing ? (
          <>
            <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="row"><button type="button" className="primary" onClick={save}>Save correction</button><button type="button" onClick={() => setEditing(false)}>Cancel</button></div>
            <small className="muted">Original: “{seg.textOriginal}”</small>
          </>
        ) : (
          <>
            {seg.speaker && <strong>{seg.speaker}: </strong>}
            <span>{seg.textCorrected ?? seg.textOriginal}</span>
            {seg.textCorrected && <span className="chip local" title={`Original: ${seg.textOriginal}`}>corrected</span>}
            <button type="button" className="link small" onClick={() => setEditing(true)}>✎</button>
          </>
        )}
      </div>
    </div>
  );
}
