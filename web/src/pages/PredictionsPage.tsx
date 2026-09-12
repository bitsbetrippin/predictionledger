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
import { EVIDENCE_ASSESSMENT_LABEL, type JobSummary, type VideoSummary } from "@prediction-ledger/shared";
import { api, content, fmtClock, pollJob, type PredictionFull, type PredictionRow } from "../api";
import { PredictionDetail } from "../components/PredictionDetail";

const TIME_LABEL: Record<PredictionRow["timeStatus"], string> = { pending: "Deadline pending", reached: "Deadline reached", unknown: "Deadline unknown" };

/** Sports picks read as bets settle: hit / miss / push. Same underlying two-field verdict. */
const SPORTS_RESULT_LABEL: Partial<Record<string, string>> = { supported: "Hit ✓", contradicted: "Miss ✗", partially_supported: "Push", insufficient: "No final score yet", not_assessable: "Not settleable" };

function pickLabel(sp: NonNullable<import("@prediction-ledger/shared").Prediction["sportsPick"]>): string {
  const line = (l?: number) => (l === undefined ? "" : l > 0 ? ` +${l}` : ` ${l}`);
  if (sp.pick.type === "moneyline") return `${sp.sport} · ML ${sp.pick.team ?? "?"}`;
  if (sp.pick.type === "spread") return `${sp.sport} · ${sp.pick.team ?? "?"}${line(sp.pick.line)}`;
  return `${sp.sport} · ${sp.pick.side === "over" ? "O" : "U"} ${sp.pick.line ?? "?"}`;
}

export function PredictionsPage({ initialVideoId, initialPredictionId }: { initialVideoId?: string; initialPredictionId?: string }) {
  const [rows, setRows] = useState<PredictionRow[] | null>(null);
  const [videos, setVideos] = useState<VideoSummary[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [videoId, setVideoId] = useState(initialVideoId ?? "");
  const [topic, setTopic] = useState("");
  const [kind, setKind] = useState<"" | "general" | "sports_pick">("");
  const [status, setStatus] = useState<"" | "pending" | "accepted" | "dismissed" | "merged">("");
  const [deadline, setDeadline] = useState<"" | "pending" | "reached" | "unknown">("");
  const [result, setResult] = useState("");
  const [researchJobs, setResearchJobs] = useState<Record<string, JobSummary>>({});
  const [selectedId, setSelectedId] = useState<string | undefined>(initialPredictionId);
  const [selected, setSelected] = useState<PredictionFull | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [planJobs, setPlanJobs] = useState<Record<string, JobSummary>>({});

  const reload = useCallback(async () => {
    try {
      const [r, v, t] = await Promise.all([
        content.listPredictions({ videoId: videoId || undefined, kind: kind || undefined, topic: topic || undefined, userStatus: status || undefined, includeDismissed: !!status, result: result || undefined }),
        content.listVideos(),
        content.topics(),
      ]);
      setRows(r); setVideos(v); setTopics(t);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [videoId, kind, topic, status, result]);
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

  /** Research (or recheck). Follows the chain plan → research → assessment by polling each job. */
  const research = async (id: string, mode: "research" | "validate" = "research") => {
    try {
      const { jobId } = mode === "validate" ? await content.validateScore(id) : await content.research(id);
      let done = await pollJob(jobId, (j) => setResearchJobs((m) => ({ ...m, [id]: j })));
      // Chained jobs (research after plan, assessment after research) show up in the job list for this subject.
      for (let hops = 0; hops < 3 && done.status === "completed"; hops++) {
        await new Promise((r) => setTimeout(r, 1200));
        const next = (await api.listJobs()).find((j) => j.subjectId === id && j.id !== done.id && (j.status === "queued" || j.status === "running"));
        if (!next) break;
        done = await pollJob(next.id, (j) => setResearchJobs((m) => ({ ...m, [id]: j })));
      }
      if (done.status === "failed") setError(done.error ?? "Research failed.");
      setResearchJobs((m) => { const n = { ...m }; delete n[id]; return n; });
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
        <label>Kind <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="">All</option><option value="general">General</option><option value="sports_pick">Sports picks</option></select></label>
        <label>Topic <select value={topic} onChange={(e) => setTopic(e.target.value)}><option value="">All</option>{topics.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
        <label>Review status <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="">Pending + accepted</option><option value="pending">Pending review</option><option value="accepted">Accepted</option><option value="dismissed">Dismissed</option><option value="merged">Merged</option></select></label>
        <label>Deadline <select value={deadline} onChange={(e) => setDeadline(e.target.value as typeof deadline)}><option value="">Any</option><option value="pending">Pending</option><option value="reached">Reached</option><option value="unknown">Unknown</option></select></label>
        <label>Result <select value={result} onChange={(e) => setResult(e.target.value)}><option value="">Any</option><option value="not_researched">Not researched</option>{(Object.keys(EVIDENCE_ASSESSMENT_LABEL) as (keyof typeof EVIDENCE_ASSESSMENT_LABEL)[]).map((k) => <option key={k} value={k}>{EVIDENCE_ASSESSMENT_LABEL[k]}</option>)}</select></label>
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
                    const pj = planJobs[p.id] ?? researchJobs[p.id];
                    const r = p.result;
                    return (
                      <tr key={p.id} className={selectedId === p.id ? "selected" : ""} onClick={() => setSelectedId(p.id)}>
                        <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label="select for merge" checked={checked.has(p.id)} onChange={(e) => setChecked((s) => { const n = new Set(s); e.target.checked ? n.add(p.id) : n.delete(p.id); return n; })} /></td>
                        <td>
                          <div>{p.kind === "sports_pick" && p.sportsPick && <span className="chip sports" title="Sports pick — settled from the final score, no deep research">{pickLabel(p.sportsPick)}</span>} {p.normalizedStatement}</div>
                          <div className="muted small">{fmtClock(p.startS)} · {p.userStatus}{p.components.length > 1 ? ` · ${p.components.length} components` : ""}{p.latestPlanVersion ? ` · plan v${p.latestPlanVersion}` : ""}{pj && (pj.status === "running" || pj.status === "queued") ? ` · ${pj.stage ?? "planning…"}` : ""}</div>
                        </td>
                        <td>{p.deadlineDate ?? <span className="muted">unknown</span>}</td>
                        <td>
                          {r ? <span className={`verdict v-${r.evidenceAssessment}`}>{p.kind === "sports_pick" ? (SPORTS_RESULT_LABEL[r.evidenceAssessment] ?? EVIDENCE_ASSESSMENT_LABEL[r.evidenceAssessment]) : EVIDENCE_ASSESSMENT_LABEL[r.evidenceAssessment]}</span> : p.processingStatus === "running" ? <span className="muted">{p.kind === "sports_pick" ? "validating…" : "researching…"}</span> : p.processingStatus === "failed" ? <span className="result error">{p.kind === "sports_pick" ? "validation failed" : "research failed"}</span> : <span className="muted">{p.kind === "sports_pick" ? "— not validated" : "— not researched"}</span>}
                          {r && <div className="muted small">confidence {r.confidence} · v{r.version}</div>}
                        </td>
                        <td>{TIME_LABEL[p.timeStatus]}</td>
                        <td className="explain">{r ? r.explanation : <span className="muted">—</span>}</td>
                        <td>{r ? r.sourceCount : <span className="muted">—</span>}</td>
                        <td>{r ? <>{r.researchedAt}{r.recheckAfter ? <div className="muted small">recheck {r.recheckAfter}</div> : null}</> : <span className="muted">—</span>}</td>
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
                onResearch={() => research(selected.id)}
                onValidateScore={() => research(selected.id, "validate")}
                researchJob={researchJobs[selected.id]}
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
