/**
 * Prediction Ledger — prediction detail panel: quotation, normalized claim, components, plan, history, controls.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { useEffect, useState } from "react";
import { EVIDENCE_ASSESSMENT_LABEL, TIME_STATUS_LABEL, type Assessment, type ComponentKind, type EvidenceItem, type JobSummary, type PredictionEdit, type ValidationPlan } from "@prediction-ledger/shared";
import { content, fmtClock, type PredictionFull, type RunDetail } from "../api";

const KIND_LABEL: Record<ComponentKind, string> = { future_claim: "future claim", premise: "premise", causal_link: "causal link" };

export function PredictionDetail(props: {
  prediction: PredictionFull;
  planJob?: JobSummary;
  researchJob?: JobSummary;
  onGeneratePlan: () => void;
  onResearch: () => void;
  onChanged: () => Promise<void> | void;
  onClose: () => void;
}) {
  const p = props.prediction;
  const [tab, setTab] = useState<"plan" | "evidence" | "history">(p.assessments?.length ? "evidence" : "plan");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const planRunning = props.planJob && (props.planJob.status === "queued" || props.planJob.status === "running");
  const researchRunning = props.researchJob && (props.researchJob.status === "queued" || props.researchJob.status === "running");
  const latest = p.assessments?.[0];

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try { await fn(); await props.onChanged(); } finally { setBusy(null); }
  };

  return (
    <div className="detail-inner">
      <div className="row space-between">
        <strong>Prediction detail</strong>
        <button type="button" className="link" onClick={props.onClose}>close</button>
      </div>

      <div className="quote">
        <div className="muted small">{fmtClock(p.startS)}–{fmtClock(p.endS)} · speaker: {p.speaker ?? "unknown"} · <a href={`#/videos/${p.videoId}`}>{p.videoTitle}</a></div>
        {p.contextBefore && <span className="muted">…{p.contextBefore} </span>}
        <mark>“{p.quoteExact}”</mark>
        {p.contextAfter && <span className="muted"> {p.contextAfter}…</span>}
        {p.occurrences.length > 1 && <div className="muted small">Said {p.occurrences.length} times: {p.occurrences.map((o) => fmtClock(o.startS)).join(", ")}</div>}
      </div>

      {editing ? (
        <EditForm prediction={p} onCancel={() => setEditing(false)} onSaved={async () => { setEditing(false); await props.onChanged(); }} />
      ) : (
        <>
          <dl className="facts">
            {p.kind === "sports_pick" && p.sportsPick && (
              <>
                <dt>Sports pick</dt>
                <dd>
                  <strong>{p.sportsPick.teams[0]} vs {p.sportsPick.teams[1]}</strong> · {p.sportsPick.sport}{p.sportsPick.league ? ` (${p.sportsPick.league})` : ""}{p.sportsPick.eventDate ? ` · game ${p.sportsPick.eventDate}` : " · game date unknown"}
                  <div className="muted small">
                    {p.sportsPick.pick.type === "moneyline" && <>Moneyline: <strong>{p.sportsPick.pick.team}</strong> to win</>}
                    {p.sportsPick.pick.type === "spread" && <>Spread: <strong>{p.sportsPick.pick.team}</strong> {p.sportsPick.pick.line !== undefined ? (p.sportsPick.pick.line > 0 ? `+${p.sportsPick.pick.line}` : p.sportsPick.pick.line) : "(no line)"}</>}
                    {p.sportsPick.pick.type === "total" && <>Total: <strong>{p.sportsPick.pick.side}</strong> {p.sportsPick.pick.line ?? "(no line)"}</>}
                    {" "}— settled from the final score; the validation plan is written by the app and research is capped at a few score look-ups.
                  </div>
                </dd>
              </>
            )}
            <dt>Normalized</dt><dd>{p.normalizedStatement}</dd>
            <dt>Made on</dt><dd>{p.madeOnDate ?? "unknown"} <span className="muted small">({p.madeOnBasis})</span></dd>
            <dt>Time expression</dt><dd>{p.timeExpression ?? <span className="muted">none</span>}</dd>
            <dt>Deadline</dt><dd>{p.deadlineDate ?? "unknown"} {p.deadlineBasis && <span className="muted small">({p.deadlineBasis})</span>}</dd>
            <dt>Modality</dt><dd>{p.modality ?? "—"}</dd>
            <dt>Topic</dt><dd>{p.topic ?? "—"}</dd>
            <dt>Geography</dt><dd>{p.geography ?? <span className="muted">unstated</span>}</dd>
            <dt>Scope</dt><dd>{p.scope ?? "—"}</dd>
            <dt>Entities</dt><dd>{p.entities.join(", ") || "—"}</dd>
            {p.conditions.length > 0 && <><dt>Conditions</dt><dd>{p.conditions.join("; ")}</dd></>}
            {p.thresholds.length > 0 && <><dt>Thresholds</dt><dd>{p.thresholds.join("; ")}</dd></>}
            <dt>Confidence</dt><dd>{p.extractionConfidence !== undefined ? `${Math.round(p.extractionConfidence * 100)}%` : "—"} <span className="muted small">{p.extractionProvider}/{p.extractionModel} · {p.extractionTemplate}</span></dd>
          </dl>

          <h3>Components</h3>
          <ul className="components">
            {p.components.map((c) => (
              <li key={c.id}>
                <span className={`chip kind-${c.kind}`}>{KIND_LABEL[c.kind]}</span> {c.statement}
                {c.deadlineDate && <span className="muted small"> · deadline {c.deadlineDate}</span>}
                {p.components.length > 1 && (
                  <button type="button" className="link small" disabled={!!busy} onClick={() => act("split", () => content.split(p.id, c.id))}>split out</button>
                )}
              </li>
            ))}
          </ul>

          {p.ambiguities.length > 0 && (
            <>
              <h3>Ambiguities</h3>
              <ul className="plain">{p.ambiguities.map((a, i) => <li key={i}>{a}</li>)}</ul>
            </>
          )}
        </>
      )}

      <div className="row controls">
        {p.userStatus !== "accepted" && p.userStatus !== "merged" && <button type="button" disabled={!!busy} onClick={() => act("accept", () => content.accept(p.id))}>Accept</button>}
        {p.userStatus !== "dismissed" && p.userStatus !== "merged" && <button type="button" disabled={!!busy} onClick={() => act("dismiss", () => content.dismiss(p.id))}>Dismiss</button>}
        {(p.userStatus === "dismissed" || p.userStatus === "accepted") && <button type="button" disabled={!!busy} onClick={() => act("restore", () => content.restore(p.id))}>Back to pending</button>}
        {!editing && <button type="button" onClick={() => setEditing(true)}>Edit</button>}
        <button type="button" className="primary" onClick={props.onGeneratePlan} disabled={!!planRunning}>
          {planRunning ? props.planJob?.stage ?? "Generating…" : p.plans.length ? "Regenerate plan" : "Generate validation plan"}
        </button>
        <button type="button" className="primary" onClick={props.onResearch} disabled={!!researchRunning || !!planRunning} title={p.plans.length ? "Run web research against the latest plan version" : "Generates a plan first, then researches"}>
          {researchRunning ? props.researchJob?.stage ?? "Researching…" : latest ? "Recheck" : "Research"}
        </button>
      </div>
      {props.planJob?.status === "failed" && <div className="banner error">{props.planJob.error}</div>}
      {props.researchJob?.status === "failed" && <div className="banner error">{props.researchJob.error}</div>}

      {latest && (
        <div className={`verdict-card v-${latest.evidenceAssessment}`}>
          <div className="row space-between">
            <strong>{EVIDENCE_ASSESSMENT_LABEL[latest.evidenceAssessment]}</strong>
            <span className="small">{TIME_STATUS_LABEL[latest.timeStatus]} · confidence {latest.confidence} · v{latest.version} · researched {latest.researchedAt}</span>
          </div>
          <p>{latest.explanation}</p>
          {latest.uncertainty && <p className="small"><strong>Remaining uncertainty:</strong> {latest.uncertainty}</p>}
          {latest.laterDevelopments && <p className="small"><strong>Later developments (after the deadline):</strong> {latest.laterDevelopments}</p>}
          {latest.guardNotes.length > 0 && <details className="small"><summary>Rules applied by the app ({latest.guardNotes.length})</summary><ul className="plain">{latest.guardNotes.map((n, i) => <li key={i}>{n}</li>)}</ul></details>}
          {latest.recheckAfter && <p className="small muted">Suggested recheck: {latest.recheckAfter}</p>}
        </div>
      )}

      <div className="tabs">
        <button type="button" className={tab === "plan" ? "tab active" : "tab"} onClick={() => setTab("plan")}>Validation plan {p.plans.length ? `(v${p.plans[0].version})` : ""}</button>
        <button type="button" className={tab === "evidence" ? "tab active" : "tab"} onClick={() => setTab("evidence")}>Evidence {latest ? `(${latest.supportingIds.length + latest.contradictingIds.length} cited)` : ""}</button>
        <button type="button" className={tab === "history" ? "tab active" : "tab"} onClick={() => setTab("history")}>History ({p.revisions.length + p.plans.length + (p.assessments?.length ?? 0)})</button>
      </div>

      {tab === "plan" && (p.plans.length === 0 ? (
        <div className="empty-state"><p className="muted">No validation plan yet. Generate one to write the evaluation criteria and search queries <em>before</em> any research runs.</p></div>
      ) : (
        <PlanView plans={p.plans} predictionId={p.id} onChanged={props.onChanged} />
      ))}
      {tab === "evidence" && (latest ? <EvidenceView prediction={p} assessment={latest} /> : (
        <div className="empty-state"><p className="muted">No research yet. Research runs the plan's queries through your configured search provider, fetches the pages, and stores every excerpt it cites.</p></div>
      ))}
      {tab === "history" && (
        <ul className="plain history">
          {(p.assessments ?? []).map((a) => <li key={a.id}>{a.createdAt.slice(0, 16).replace("T", " ")} — assessment v{a.version}: <strong>{EVIDENCE_ASSESSMENT_LABEL[a.evidenceAssessment]}</strong> ({a.confidence}) · plan v{a.planVersion} · {a.provider}{a.model ? ` (${a.model})` : ""}</li>)}
          {(p.runs ?? []).map((r) => <li key={r.id}>{r.startedAt.slice(0, 16).replace("T", " ")} — research run ({r.status}): {r.searchesUsed} searches, {r.sourcesFetched} sources, {r.evidenceCount} evidence items via {r.searchProvider}{r.error ? ` — ${r.error}` : ""}</li>)}
          {p.plans.map((pl) => <li key={pl.id}>{pl.createdAt.slice(0, 16).replace("T", " ")} — plan v{pl.version} by {pl.provider}{pl.model ? ` (${pl.model})` : ""} · {pl.templateVersion}</li>)}
          {p.revisions.map((r) => <li key={r.version}>{r.createdAt.slice(0, 16).replace("T", " ")} — revision {r.version}: {r.reason}</li>)}
          <li className="muted">{p.createdAt.slice(0, 16).replace("T", " ")} — extracted by {p.extractionProvider} ({p.extractionModel})</li>
        </ul>
      )}
    </div>
  );
}

function PlanView({ plans, predictionId, onChanged }: { plans: ValidationPlan[]; predictionId: string; onChanged: () => Promise<void> | void }) {
  const [versionId, setVersionId] = useState(plans[0].id);
  useEffect(() => setVersionId(plans[0].id), [plans]);
  const plan = plans.find((p) => p.id === versionId) ?? plans[0];
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(plan.researchPrompt);
  const [ambig, setAmbig] = useState(plan.plan.ambiguities.join("\n"));
  const [queries, setQueries] = useState({ neutral: plan.plan.queries.neutral.join("\n"), supporting: plan.plan.queries.supporting.join("\n"), disconfirming: plan.plan.queries.disconfirming.join("\n") });
  useEffect(() => { setPrompt(plan.researchPrompt); setAmbig(plan.plan.ambiguities.join("\n")); setQueries({ neutral: plan.plan.queries.neutral.join("\n"), supporting: plan.plan.queries.supporting.join("\n"), disconfirming: plan.plan.queries.disconfirming.join("\n") }); }, [plan]);

  const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
  const save = async () => {
    await content.savePlanEdit(predictionId, { ambiguities: lines(ambig), queries: { neutral: lines(queries.neutral), supporting: lines(queries.supporting), disconfirming: lines(queries.disconfirming) } }, prompt);
    setEditing(false);
    await onChanged();
  };

  const b = plan.plan;
  return (
    <div className="plan">
      <div className="row space-between">
        <label>Version <select value={versionId} onChange={(e) => setVersionId(e.target.value)}>{plans.map((p) => <option key={p.id} value={p.id}>v{p.version} · {p.provider}{p.editedByUser ? " (edited)" : ""} · {p.createdAt.slice(0, 10)}</option>)}</select></label>
        {!editing && <button type="button" onClick={() => setEditing(true)}>Edit (creates v{plans[0].version + 1})</button>}
      </div>
      <p><strong>Proposition.</strong> {b.proposition}</p>
      <p className="muted small">Made {b.dates.predictionMade ?? "unknown"} · deadline {b.dates.deadline ?? "unknown"} · research cutoff {b.dates.researchCutoff}{b.dates.notes ? ` · ${b.dates.notes}` : ""}</p>
      <h4>Components</h4>
      <ul className="plain">{b.components.map((c, i) => <li key={i}><span className={`chip kind-${c.kind}`}>{KIND_LABEL[c.kind]}</span> {c.statement}{c.conditions.length ? <span className="muted"> — if {c.conditions.join("; ")}</span> : null}</li>)}</ul>
      {b.definitions.length > 0 && <><h4>Working definitions</h4><ul className="plain">{b.definitions.map((d, i) => <li key={i}><strong>{d.term}:</strong> {d.workingDefinition}</li>)}</ul></>}
      <h4>Ambiguities</h4>
      {editing ? <textarea rows={3} value={ambig} onChange={(e) => setAmbig(e.target.value)} /> : <ul className="plain">{b.ambiguities.map((a, i) => <li key={i}>{a}</li>)}</ul>}
      <div className="grid-3">
        <div><h4>Would support</h4><ul className="plain">{b.supportingEvidence.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
        <div><h4>Would contradict</h4><ul className="plain">{b.contradictingEvidence.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
        <div><h4>Partial fulfilment</h4><ul className="plain">{b.partialFulfillmentCriteria.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
      </div>
      <h4>Search queries</h4>
      <div className="grid-3">
        {(["neutral", "supporting", "disconfirming"] as const).map((k) => (
          <div key={k}><strong className="small">{k}</strong>{editing ? <textarea rows={4} value={queries[k]} onChange={(e) => setQueries((q) => ({ ...q, [k]: e.target.value }))} /> : <ul className="plain">{b.queries[k].map((q, i) => <li key={i}><code>{q}</code></li>)}</ul>}</div>
        ))}
      </div>
      {b.preferredSourceTypes.length > 0 && <p className="small"><strong>Preferred sources:</strong> {b.preferredSourceTypes.join(", ")}</p>}
      <h4>Executable research prompt</h4>
      {editing ? <textarea rows={10} value={prompt} onChange={(e) => setPrompt(e.target.value)} /> : <pre className="prompt">{plan.researchPrompt}</pre>}
      {editing && <div className="row"><button type="button" className="primary" onClick={save}>Save as new version</button><button type="button" onClick={() => setEditing(false)}>Cancel</button></div>}
      <p className="muted small">Generated by {plan.provider}{plan.model ? ` · ${plan.model}` : ""} · template {plan.templateVersion} · {plan.createdAt.slice(0, 19).replace("T", " ")}</p>
    </div>
  );
}

function EditForm({ prediction: p, onCancel, onSaved }: { prediction: PredictionFull; onCancel: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<PredictionEdit>({
    normalizedStatement: p.normalizedStatement,
    topic: p.topic ?? "",
    geography: p.geography ?? "",
    scope: p.scope ?? "",
    speaker: p.speaker ?? "",
    madeOnDate: p.madeOnDate ?? "",
    deadlineDate: p.deadlineDate ?? "",
    conditions: p.conditions,
    ambiguities: p.ambiguities,
    components: p.components.map((c) => ({ kind: c.kind, statement: c.statement, deadlineDate: c.deadlineDate, notes: c.notes })),
  });
  const set = <K extends keyof PredictionEdit>(k: K, v: PredictionEdit[K]) => setForm((f) => ({ ...f, [k]: v }));
  const save = async () => {
    await content.editPrediction(p.id, { ...form, conditions: form.conditions, ambiguities: form.ambiguities });
    onSaved();
  };
  return (
    <div className="card">
      <label className="field"><span>Normalized statement</span><textarea rows={2} value={form.normalizedStatement} onChange={(e) => set("normalizedStatement", e.target.value)} /></label>
      <div className="grid-3">
        <label className="field"><span>Topic</span><input value={form.topic} onChange={(e) => set("topic", e.target.value)} /></label>
        <label className="field"><span>Geography</span><input value={form.geography} onChange={(e) => set("geography", e.target.value)} placeholder="leave blank if unstated" /></label>
        <label className="field"><span>Speaker</span><input value={form.speaker} onChange={(e) => set("speaker", e.target.value)} /></label>
        <label className="field"><span>Made on</span><input type="date" value={form.madeOnDate} onChange={(e) => set("madeOnDate", e.target.value)} /></label>
        <label className="field"><span>Deadline</span><input type="date" value={form.deadlineDate} onChange={(e) => set("deadlineDate", e.target.value)} /></label>
        <label className="field"><span>Scope</span><input value={form.scope} onChange={(e) => set("scope", e.target.value)} /></label>
      </div>
      <label className="field"><span>Conditions (one per line)</span><textarea rows={2} value={(form.conditions ?? []).join("\n")} onChange={(e) => set("conditions", e.target.value.split("\n").filter(Boolean))} /></label>
      <label className="field"><span>Ambiguities (one per line)</span><textarea rows={2} value={(form.ambiguities ?? []).join("\n")} onChange={(e) => set("ambiguities", e.target.value.split("\n").filter(Boolean))} /></label>
      <span className="small muted">Components</span>
      {(form.components ?? []).map((c, i) => (
        <div key={i} className="row">
          <select value={c.kind} onChange={(e) => set("components", form.components!.map((x, j) => (j === i ? { ...x, kind: e.target.value as ComponentKind } : x)))}>
            <option value="future_claim">future claim</option><option value="premise">premise</option><option value="causal_link">causal link</option>
          </select>
          <input value={c.statement} onChange={(e) => set("components", form.components!.map((x, j) => (j === i ? { ...x, statement: e.target.value } : x)))} />
          <button type="button" className="link" disabled={form.components!.length <= 1} onClick={() => set("components", form.components!.filter((_, j) => j !== i))}>remove</button>
        </div>
      ))}
      <button type="button" className="link" onClick={() => set("components", [...(form.components ?? []), { kind: "future_claim", statement: "" }])}>+ add component</button>
      <div className="row"><button type="button" className="primary" onClick={save}>Save (creates a revision)</button><button type="button" onClick={onCancel}>Cancel</button></div>
      <p className="muted small">The original quotation and timestamps are immutable; every save is recorded as a revision.</p>
    </div>
  );
}


function EvidenceView({ prediction: p, assessment: a }: { prediction: PredictionFull; assessment: Assessment }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  useEffect(() => { content.run(a.runId).then(setRun).catch(() => setRun(null)); }, [a.runId]);
  if (!run) return <p className="muted">Loading evidence…</p>;
  const byComponent = (cid?: string) => run.evidence.filter((e) => (e.componentId ?? undefined) === cid);
  const cited = new Set([...a.supportingIds, ...a.contradictingIds, ...a.citations.flatMap((c) => c.evidenceIds), ...a.components.flatMap((c) => c.evidenceIds)]);
  const groups = [...p.components.map((c) => ({ key: c.id, label: `${KIND_LABEL[c.kind]}: ${c.statement}`, items: byComponent(c.id), ca: a.components.find((x) => x.componentId === c.id) })), { key: "none", label: "Not tied to a component", items: byComponent(undefined), ca: undefined }].filter((g) => g.items.length > 0 || g.ca);
  return (
    <div className="evidence">
      <p className="muted small">Run {run.startedAt.slice(0, 10)} · {run.searchProvider} · {run.searchesUsed} searches · {run.sourcesFetched} sources read{run.sourcesFailed ? ` · ${run.sourcesFailed} unreadable` : ""} · cutoff {run.cutoffDate}</p>
      {run.coverageNotes.length > 0 && <details className="small"><summary>Coverage limitations ({run.coverageNotes.length})</summary><ul className="plain">{run.coverageNotes.map((n, i) => <li key={i}>{n}</li>)}</ul></details>}
      {groups.map((g) => (
        <div key={g.key} className="evidence-group">
          <h4>{g.label}</h4>
          {g.ca && <p className="small"><span className={`verdict v-${g.ca.assessment}`}>{EVIDENCE_ASSESSMENT_LABEL[g.ca.assessment]}</span> {g.ca.explanation}</p>}
          {g.items.length === 0 ? <p className="muted small">No evidence items.</p> : g.items.map((e) => <EvidenceCard key={e.id} e={e} cited={cited.has(e.id)} />)}
        </div>
      ))}
      {a.citations.length > 0 && (
        <>
          <h4>Claims → evidence</h4>
          <ul className="plain small">{a.citations.map((c, i) => <li key={i}>{c.claim} <span className="muted">[{c.evidenceIds.map((id) => run.evidence.find((e) => e.id === id)?.source?.publisher ?? "?").join(", ")}]</span></li>)}</ul>
        </>
      )}
      <details className="small"><summary>Queries run ({run.queries.length})</summary><ul className="plain">{run.queries.map((q, i) => <li key={i}><span className="chip">{q.group}</span> <code>{q.query}</code> → {q.error ? <span className="result error">{q.error}</span> : `${q.resultCount} results${q.cached ? " (cached)" : ""}`}</li>)}</ul></details>
    </div>
  );
}

function EvidenceCard({ e, cited }: { e: EvidenceItem; cited: boolean }) {
  const s = e.source;
  return (
    <div className={`evidence-card stance-${e.stance}${cited ? " cited" : ""}`}>
      <div className="row space-between small">
        <span><span className={`chip stance-${e.stance}`}>{e.stance}</span> {e.actionStage && e.actionStage !== "other" ? <span className="chip">{e.actionStage}</span> : null} {e.inWindow === false && <span className="chip late">after deadline</span>} {!e.independent && <span className="chip" title="Same text as another source">syndicated</span>}</span>
        <span className="muted">{e.eventDate ?? "undated"}</span>
      </div>
      <blockquote>“{e.excerpt}”</blockquote>
      {e.fact && <div className="small">{e.fact}</div>}
      <div className="small muted">
        {s ? <a href={s.url} target="_blank" rel="noreferrer noopener">{s.title ?? s.url}</a> : null}{s?.publisher ? ` · ${s.publisher}` : ""}{s?.publishedAt ? ` · published ${s.publishedAt}` : ""}{e.qualityNotes ? ` · ${e.qualityNotes}` : ""}
      </div>
    </div>
  );
}
