/**
 * Prediction Ledger — evidence dossier (1.11, SRC-03…SRC-06): every excerpt with its provenance,
 * independence group and status; dissent listed whatever the verdict; "known by" replay; withdraw/recheck.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { useEffect, useState } from "react";
import { EVIDENCE_ASSESSMENT_LABEL, type DossierItem, type EvidenceDossier } from "@prediction-ledger/shared";
import { dossierApi, fmtClock } from "../api";

export function DossierView(props: { predictionId: string; onChanged?: () => Promise<void> | void }) {
  const [d, setD] = useState<EvidenceDossier | null>(null);
  const [asOf, setAsOf] = useState("");
  const [assume, setAssume] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try { setD(await dossierApi.get(props.predictionId, { asOf: asOf ? new Date(asOf).toISOString() : undefined, assumePublished: assume })); } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, [props.predictionId, asOf, assume]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setError(null);
    try { await fn(); await load(); await props.onChanged?.(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  if (!d) return error ? <div className="banner error">{error}</div> : <p className="muted">Loading dossier…</p>;

  const item = (it: DossierItem) => {
    const s = it.source;
    return (
      <div key={it.evidenceId} className={`evidence-card stance-${it.stance}${it.knownAtAsOf === false ? " excluded" : ""}`}>
        <div className="row space-between small">
          <span>
            <span className={`chip stance-${it.stance}`}>{it.stance}</span>
            {it.runPurpose === "forecast" && <span className="chip" title="Gathered as prospective evidence; never part of a verdict">forecast</span>}
            {it.inWindow === false && <span className="chip late">after deadline</span>}
            {s.status !== "available" && <span className="chip late" title={s.statusChangedAt ? `since ${s.statusChangedAt}` : undefined}>{s.status}</span>}
            {s.independenceGroup && <span className="chip" title="Sources in one group share text or a publisher">{s.independenceGroup}</span>}
            {it.knownAtAsOf !== undefined && <span className={`chip ${it.knownAtAsOf ? "" : "late"}`}>{it.knownAtAsOf ? "known" : "not known"} by as-of ({it.availabilityBasis})</span>}
          </span>
          <span className="muted">{it.eventDate ?? "undated"}</span>
        </div>
        <blockquote>“{it.excerpt}”</blockquote>
        {it.fact && <div className="small">{it.fact}</div>}
        <div className="small muted">
          <a href={s.url} target="_blank" rel="noreferrer noopener">{s.title ?? s.url}</a>{s.publisher ? ` · ${s.publisher}` : ""}{s.publishedAt ? ` · published ${s.publishedAt}` : " · publication date unknown"} · first fetched {s.firstSeenAt?.slice(0, 16).replace("T", " ") ?? s.retrievedAt.slice(0, 16).replace("T", " ")}{s.contentHash ? ` · text hash ${s.contentHash.slice(0, 12)}…` : ""}
        </div>
        <div className="row small">
          {s.status === "withdrawn" ? (
            <button type="button" className="link" disabled={!!busy} onClick={() => act("restore", () => dossierApi.restoreSource(s.id))}>restore source</button>
          ) : (
            <button type="button" className="link" disabled={!!busy} onClick={() => act("withdraw", () => dossierApi.withdrawSource(s.id))}>withdraw source</button>
          )}
          <button type="button" className="link" disabled={!!busy} onClick={() => act("recheck", () => dossierApi.recheckSource(s.id))}>recheck URL</button>
        </div>
      </div>
    );
  };

  return (
    <div className="dossier">
      <p className="muted small">
        Quote hash {d.quote.hash?.slice(0, 12) ?? "—"}… · {fmtClock(d.quote.startS)}–{fmtClock(d.quote.endS)}{d.quote.timestampUrl && <> · <a href={d.quote.timestampUrl} target="_blank" rel="noreferrer noopener">open at timestamp</a></>}
        {" "}· prediction revision {d.versions.prediction}{d.versions.analysis ? ` · analysis v${d.versions.analysis}` : ""}{d.versions.plan ? ` · plan v${d.versions.plan}` : ""}{d.versions.latestAssessment ? ` · assessment v${d.versions.latestAssessment}` : ""}
      </p>
      {error && <div className="banner error" role="alert">{error} <button type="button" className="link" onClick={() => setError(null)}>dismiss</button></div>}
      <div className="row small">
        <label>Replay as of <input type="datetime-local" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
        <label title="Off: only sources the app had actually fetched by that instant count. On: a source's publication date is taken as when it could have been known (a labelled assumption)."><input type="checkbox" checked={assume} onChange={(e) => setAssume(e.target.checked)} /> assume published = known</label>
        {asOf && <span className="muted">{d.excludedAsOf} item(s) excluded as not known by then</span>}
        {asOf && <button type="button" className="link" onClick={() => setAsOf("")}>clear</button>}
      </div>
      {d.rationale && (
        <div className={`verdict-card v-${d.rationale.assessment}`}>
          <strong>{EVIDENCE_ASSESSMENT_LABEL[d.rationale.assessment]}</strong> <span className="small">v{d.rationale.version}</span>
          <p>{d.rationale.explanation}</p>
          {d.rationale.guardNotes.length > 0 && <details className="small"><summary>Rules applied ({d.rationale.guardNotes.length})</summary><ul className="plain">{d.rationale.guardNotes.map((n, i) => <li key={i}>{n}</li>)}</ul></details>}
        </div>
      )}
      {d.independenceGroups.length > 0 && (
        <details className="small">
          <summary>Independence groups ({d.independenceGroups.length})</summary>
          <ul className="plain">{d.independenceGroups.map((g) => <li key={g.group}><code>{g.group}</code> — {g.sourceIds.length} source(s) · {g.publishers.join(", ") || "unknown publisher"}</li>)}</ul>
        </details>
      )}
      {d.coverageLimitations.length > 0 && <details className="small"><summary>Coverage limitations ({d.coverageLimitations.length})</summary><ul className="plain">{d.coverageLimitations.map((n, i) => <li key={i}>{n}</li>)}</ul></details>}
      <h4>Supporting ({d.supporting.length})</h4>
      {d.supporting.length === 0 ? <p className="muted small">None.</p> : d.supporting.map(item)}
      <h4>Contradicting ({d.contradicting.length})</h4>
      {d.contradicting.length === 0 ? <p className="muted small">None.</p> : d.contradicting.map(item)}
      {d.context.length > 0 && <details><summary>Context ({d.context.length})</summary>{d.context.map(item)}</details>}
      {d.dissent.length > 0 && (
        <details className="small">
          <summary>Dissent ({d.dissent.length}) — contradicting items and their sources, listed whatever the verdict</summary>
          <ul className="plain">{d.dissent.map((x) => <li key={x.evidenceId}><a href={x.sourceUrl} target="_blank" rel="noreferrer noopener">{x.sourceUrl}</a> — “{x.excerpt}”</li>)}</ul>
        </details>
      )}
      <p className="muted small">Withdrawing a source changes its status only: the stored excerpt, text hash and every evidence item citing it stay exactly as recorded.</p>
    </div>
  );
}
