/**
 * Prediction Ledger — Predictions table (grouped by video) + detail panel.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Columns: Prediction | Deadline | Result | Time status | Brief explanation | Sources | Last checked.
 * Result/explanation/sources/last-checked are populated by Release 0.3; here they show "not researched".
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JobSummary, VideoSummary } from "@prediction-ledger/shared";
import { content, fmtClock, pollJob, type PredictionFull, type PredictionRow } from "../api";
import { PredictionDetail } from "../components/PredictionDetail";

const TIME_LABEL: Record<PredictionRow["timeStatus"], string> = { pending: "Deadline pending", reached: "Deadline reached", unknown: "Deadline unknown" };

export function PredictionsPage({ initialVideoId, initialPredictionId }: { initialVideoId?: string; initialPredictionId?: string }) {
  const [rows, setRows] = useState<PredictionRow[] | null>(null);
  const [videos, setVideos] = useState<VideoSummary[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [videoId, setVideoId] = useState(initialVideoId ?? "");
  const [topic, setTopic] = useState("");
  const [status, setStatus] = useState<"" | "pending" | "accepted" | "dismissed" | "merged">("");
  const [deadline, setDeadline] = useState<"" | "pending" | "reached" | "unknown">("");
  const [selectedId, setSelectedId] = useState<string | undefined>(initialPredictionId);
  const [selected, setSelected] = useState<PredictionFull | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [planJobs, setPlanJobs] = useState<Record<string, JobSummary>>({});

  const reload = useCallback(async () => {
    try {
      const [r, v, t] = await Promise.all([
        content.listPredictions({ videoId: videoId || undefined, topic: topic || undefined, userStatus: status || undefined, includeDismissed: !!status }),
        content.listVideos(),
        content.topics(),
      ]);
      setRows(r); setVideos(v); setTopics(t);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [videoId, topic, status]);
  useEffect(() => void reload(), [reload]);

  const loadSelected = useCallback(async (id: string | undefined) => {
    if (!id) return setSelected(null);
    try { setSelected(await content.getPrediction(id)); } catch { setSelected(null); }
  }, []);
  useEffect(() => void loadSelected(selectedId), [selectedId, loadSelected]);

  const visible = useMemo(() => (rows ?? []).filter((r) => !deadline || r.timeStatus === deadline), [rows, deadline]);
  const grouped = useMemo(() => {
    const m = new Map<string, PredictionRow[]>();
    for (const r of visible) m.set(r.videoId, [...(m.get(r.videoId) ?? []), r]);
    return [...m.entries()];
  }, [visible]);

  const generatePlan = async (id: string) => {
    try {
      const { jobId } = await content.generatePlan(id);
      const done = await pollJob(jobId, (j) => setPlanJobs((m) => ({ ...m, [id]: j })));
      if (done.status === "failed") setError(done.error ?? "Plan generation failed.");
      await reload();
      await loadSelected(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const mergeChecked = async () => {
    const ids = [...checked];
    if (ids.length < 2) return;
    const target = selectedId && ids.includes(selectedId) ? selectedId : ids[0];
    await content.merge(target, ids.filter((i) => i !== target));
    setChecked(new Set());
    await reload();
    setSelectedId(target);
    await loadSelected(target);
  };

  return (
    <section className="page wide">
      <h1>Predictions</h1>
      {error && <div className="banner error" role="alert">{error} <button type="button" className="link" onClick={() => setError(null)}>dismiss</button></div>}

      <div className="filters">
        <label>Video <select value={videoId} onChange={(e) => setVideoId(e.target.value)}><option value="">All</option>{videos.map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}</select></label>
        <label>Topic <select value={topic} onChange={(e) => setTopic(e.target.value)}><option value="">All</option>{topics.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
        <label>Review status <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="">Pending + accepted</option><option value="pending">Pending review</option><option value="accepted">Accepted</option><option value="dismissed">Dismissed</option><option value="merged">Merged</option></select></label>
        <label>Deadline <select value={deadline} onChange={(e) => setDeadline(e.target.value as typeof deadline)}><option value="">Any</option><option value="pending">Pending</option><option value="reached">Reached</option><option value="unknown">Unknown</option></select></label>
        <label>Result <select disabled><option>Any (Release 0.3)</option></select></label>
        {checked.size >= 2 && <button type="button" onClick={mergeChecked}>Merge {checked.size} selected</button>}
      </div>

      {rows === null ? <p className="muted">Loading…</p> : visible.length === 0 ? (
        <div className="empty-state"><p>No predictions match.</p><p className="muted">Import a transcript in the Library and run “Extract predictions”.</p></div>
      ) : (
        <div className="split">
          <div className="table-wrap">
            <table className="table predictions">
              <thead>
                <tr><th></th><th>Prediction</th><th>Deadline</th><th>Result</th><th>Time status</th><th>Brief explanation</th><th>Sources</th><th>Last checked</th></tr>
              </thead>
              {grouped.map(([vid, list]) => (
                <tbody key={vid}>
                  <tr className="group"><td colSpan={8}>▸ {list[0].videoTitle ?? vid} <span className="muted">({list.length})</span> <a href={`#/videos/${vid}`} className="small">open video</a></td></tr>
                  {list.map((p) => {
                    const pj = planJobs[p.id];
                    return (
                      <tr key={p.id} className={selectedId === p.id ? "selected" : ""} onClick={() => setSelectedId(p.id)}>
                        <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label="select for merge" checked={checked.has(p.id)} onChange={(e) => setChecked((s) => { const n = new Set(s); e.target.checked ? n.add(p.id) : n.delete(p.id); return n; })} /></td>
                        <td>
                          <div>{p.normalizedStatement}</div>
                          <div className="muted small">{fmtClock(p.startS)} · {p.userStatus}{p.components.length > 1 ? ` · ${p.components.length} components` : ""}{p.latestPlanVersion ? ` · plan v${p.latestPlanVersion}` : ""}{pj && (pj.status === "running" || pj.status === "queued") ? ` · ${pj.stage ?? "planning…"}` : ""}</div>
                        </td>
                        <td>{p.deadlineDate ?? <span className="muted">unknown</span>}</td>
                        <td><span className="muted">— not researched</span></td>
                        <td>{TIME_LABEL[p.timeStatus]}</td>
                        <td className="muted">—</td>
                        <td className="muted">—</td>
                        <td className="muted">—</td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
          <aside className="detail">
            {selected ? (
              <PredictionDetail
                prediction={selected}
                planJob={planJobs[selected.id]}
                onGeneratePlan={() => generatePlan(selected.id)}
                onChanged={async () => { await reload(); await loadSelected(selected.id); }}
                onClose={() => setSelectedId(undefined)}
              />
            ) : (
              <div className="empty-state"><p className="muted">Select a prediction to see the quotation, components, validation plan, and history.</p></div>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
