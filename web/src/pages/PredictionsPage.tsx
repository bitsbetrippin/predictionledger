/**
 * Prediction Ledger — Predictions table (grouped by video) + detail panel (2.1 redesign: filled result chip and
 * outlined time-status chip on every row, "?" help beside the two-field verdict, card list below 880 px, detail as
 * a full-screen overlay on narrow screens).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Columns: Prediction | Deadline | Result | Time status | Brief explanation | Sources | Last checked.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { EVIDENCE_ASSESSMENT_LABEL, type JobSummary, type VideoSummary } from "@prediction-ledger/shared";
import { api, content, fmtClock, pollJob, type PredictionFull, type PredictionRow } from "../api";
import { PredictionDetail } from "../components/PredictionDetail";
import { HelpButton } from "../components/HelpButton";
import { AssessmentChip, EmptyState, ErrorState, Skeleton, TimeChip } from "../components/ui";

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [planJobs, setPlanJobs] = useState<Record<string, JobSummary>>({});

  const reload = useCallback(async () => {
    try {
      const [r, v, t] = await Promise.all([
        content.listPredictions({ videoId: videoId || undefined, kind: kind || undefined, topic: topic || undefined, userStatus: status || undefined, includeDismissed: !!status, result: result || undefined }),
        content.listVideos(),
        content.topics(),
      ]);
      setRows(r); setVideos(v); setTopics(t); setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [videoId, kind, topic, status, result]);
  useEffect(() => void reload(), [reload]);
  useEffect(() => { setSelectedId(initialPredictionId); }, [initialPredictionId]);

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
  const assessed = visible.filter((r) => r.result).length;

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
  const research = async (id: string, mode: "research" | "validate" | "forecast" = "research") => {
    try {
      const { jobId } = mode === "validate" ? await content.validateScore(id, !!rows?.find((r) => r.id === id)?.result) : await content.research(id, undefined, mode === "forecast" ? "forecast" : "verdict");
      let done = await pollJob(jobId, (j) => setResearchJobs((m) => ({ ...m, [id]: j })));
      for (let hops = 0; hops < 4 && done.status === "completed"; hops++) {
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

  /** 1.4: settle every sports pick of the selected video — one look-up per matchup, all picks reconciled. */
  const [validatingAll, setValidatingAll] = useState<string | null>(null);
  const validateAll = async () => {
    if (!videoId) return;
    try {
      const { jobs, picks, skipped } = await content.validateVideoScores(videoId);
      if (jobs.length === 0) { setError(picks === 0 && skipped > 0 ? "Every pick's game is still in the future." : "No sports picks to validate for this video."); return; }
      setValidatingAll(`Validating ${jobs.length} game(s) for ${picks} pick(s)…`);
      const results = await Promise.all(jobs.map((j) => pollJob(j.jobId)));
      const failed = results.filter((r) => r.status === "failed");
      if (failed.length) setError(`${failed.length} of ${results.length} game look-ups failed — ${failed[0].error ?? ""}`);
      setValidatingAll(null);
      await reload();
      if (selectedId) await loadSelected(selectedId);
    } catch (e) {
      setValidatingAll(null);
      setError((e as Error).message);
    }
  };

  /** Research every checked prediction that has no verdict yet, one after another. */
  const researchChecked = async () => {
    const ids = [...checked].filter((id) => { const r = rows?.find((x) => x.id === id); return r && !r.result && r.kind !== "sports_pick"; });
    for (const id of ids) await research(id);
    setChecked(new Set());
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

  const toggle = (id: string, on: boolean) => setChecked((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });

  return (
    <section className="page wide">
      {error && <div className="banner error" role="alert">{error} <button type="button" className="link" onClick={() => setError(null)}>dismiss</button></div>}

      <div className="filters">
        <label>Video <select value={videoId} onChange={(e) => setVideoId(e.target.value)}><option value="">All</option>{videos.map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}</select></label>
        <label>Kind <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="">All</option><option value="general">General</option><option value="sports_pick">Sports picks</option></select></label>
        <label>Topic <select value={topic} onChange={(e) => setTopic(e.target.value)}><option value="">All</option>{topics.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
        <label>Review status <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="">Pending + accepted</option><option value="pending">Pending review</option><option value="accepted">Accepted</option><option value="dismissed">Dismissed</option><option value="merged">Merged</option></select></label>
        <label>Deadline <select value={deadline} onChange={(e) => setDeadline(e.target.value as typeof deadline)}><option value="">Any</option><option value="pending">Pending</option><option value="reached">Reached</option><option value="unknown">Unknown</option></select></label>
        <label>Result <select value={result} onChange={(e) => setResult(e.target.value)}><option value="">Any</option><option value="not_researched">Not researched</option>{(Object.keys(EVIDENCE_ASSESSMENT_LABEL) as (keyof typeof EVIDENCE_ASSESSMENT_LABEL)[]).map((k) => <option key={k} value={k}>{EVIDENCE_ASSESSMENT_LABEL[k]}</option>)}</select></label>
        {checked.size >= 2 && <button type="button" onClick={mergeChecked}>Merge {checked.size} selected</button>}
        {checked.size >= 1 && <button type="button" onClick={() => void researchChecked()}>Research selected</button>}
        {videoId && (visible.some((r) => r.kind === "sports_pick") || kind === "sports_pick") && (
          <button type="button" className="primary" disabled={!!validatingAll} onClick={validateAll} title="Looks up each game once (winner, score, date) and settles every pick on it">
            {validatingAll ?? "Validate all scores"}
          </button>
        )}
      </div>
      {rows !== null && (
        <p className="small muted" style={{ margin: "0 0 10px" }}>
          {visible.length} prediction{visible.length === 1 ? "" : "s"} · {assessed} assessed · {visible.length - assessed} not researched
          {" · "}<span className="status filled tone-neutral" style={{ padding: "0 6px" }}>■</span> Evidence assessment = what the record shows{" "}
          <span className="status outlined" style={{ padding: "0 6px" }}>□</span> Time status = where the clock is <HelpButton topic="concept.evidence-assessment">Why two fields</HelpButton>
        </p>
      )}

      {loadError && rows === null ? <ErrorState title="Predictions could not be loaded" message={loadError} onRetry={() => void reload()} /> : rows === null ? <Skeleton rows={6} /> : visible.length === 0 ? (
        <EmptyState title="No predictions match." action={<a href="#/library">Go to the Library</a>}>Import a transcript in the Library and run “Extract predictions”, or widen the filters.</EmptyState>
      ) : (
        <div className={`split${selected ? " detail-open" : ""}`}>
          <div className="table-wrap">
            <table className="table predictions">
              <thead>
                <tr><th></th><th>Prediction</th><th>Deadline</th><th>Result</th><th>Time status</th><th>Brief explanation</th><th className="num">Sources</th><th>Last checked</th></tr>
              </thead>
              {grouped.map(([vid, list]) => (
                <tbody key={vid}>
                  <tr className="group"><td colSpan={8}>{list[0].videoTitle ?? vid} <span className="muted">({list.length})</span> <a href={`#/videos/${vid}`} className="small">open video</a></td></tr>
                  {list.map((p) => {
                    const pj = planJobs[p.id] ?? researchJobs[p.id];
                    const r = p.result;
                    return (
                      <tr key={p.id} className={selectedId === p.id ? "selected" : ""} onClick={() => setSelectedId(p.id)}>
                        <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label="select" checked={checked.has(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} /></td>
                        <td>
                          <div>{p.kind === "sports_pick" && p.sportsPick && <span className="chip sports" title="Sports pick — settled from the final score, no deep research">{pickLabel(p.sportsPick)}</span>}{p.normalizedStatement}</div>
                          <div className="meta">{fmtClock(p.startS)} · {p.userStatus}{p.components.length > 1 ? ` · ${p.components.length} components` : ""}{p.latestPlanVersion ? ` · plan v${p.latestPlanVersion}` : ""}{pj && (pj.status === "running" || pj.status === "queued") ? ` · ${pj.stage ?? "planning…"}` : ""}</div>
                        </td>
                        <td className="num" data-label="Deadline">{p.deadlineDate ?? <span className="muted">unknown</span>}</td>
                        <td data-label="Result">
                          {r ? <AssessmentChip value={r.evidenceAssessment} sports={p.kind === "sports_pick"} /> : p.processingStatus === "running" ? <span className="muted">{p.kind === "sports_pick" ? "validating…" : "researching…"}</span> : p.processingStatus === "failed" ? <span className="result error">{p.kind === "sports_pick" ? "validation failed" : "research failed"}</span> : <span className="muted">— {p.kind === "sports_pick" ? "not validated" : "not researched"}</span>}
                          {r && <div className="meta">confidence {r.confidence} · v{r.version}</div>}
                        </td>
                        <td data-label="Time status"><TimeChip value={p.timeStatus} /></td>
                        <td className="explain" data-label="Brief explanation">{r ? r.explanation : <span className="muted">—</span>}</td>
                        <td className="num" data-label="Sources">{r ? r.sourceCount : <span className="muted">—</span>}</td>
                        <td className="num small" data-label="Last checked">{r ? <>{r.researchedAt}{r.recheckAfter ? <div className="meta">recheck {r.recheckAfter}</div> : null}</> : <span className="muted">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
          {selected && (
            <aside className="detail">
              <PredictionDetail
                prediction={selected}
                planJob={planJobs[selected.id]}
                onGeneratePlan={() => generatePlan(selected.id)}
                onResearch={() => research(selected.id)}
                onForecast={() => research(selected.id, "forecast")}
                onValidateScore={() => research(selected.id, "validate")}
                researchJob={researchJobs[selected.id]}
                onChanged={async () => { await reload(); await loadSelected(selected.id); }}
                onClose={() => setSelectedId(undefined)}
              />
            </aside>
          )}
        </div>
      )}
    </section>
  );
}
