/**
 * Prediction Ledger — Polymarket US contract verification (1.11, MAT-01…MAT-06): candidate discovery,
 * the rule-by-rule checklist, documented facts for missing fields, and revalidation. Read-only towards
 * the venue; nothing here places, previews or prepares an order.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { useEffect, useState } from "react";
import type { ContractField, ContractVerification, PredictionMarketLink, UsCandidateSearch } from "@prediction-ledger/shared";
import { OUTCOME_LABEL, VERIFICATION_LABEL, contractsApi, decisionsApi, fmtPct, fmtUsd, marketsApi, type VerifyFacts } from "../api";
import type { TradeDecision } from "@prediction-ledger/shared";

const FIELD_STATUS_LABEL: Record<ContractField["status"], string> = { verified: "✓ verified", incompatible: "✗ incompatible", missing: "? missing", not_applicable: "n/a" };

export function VerificationBadge({ status }: { status: ContractVerification["status"] | undefined }) {
  const s = status ?? "unverified";
  return <span className={`chip verification v-${s}`} title={VERIFICATION_HELP[s]}>{VERIFICATION_LABEL[s]}</span>;
}

const VERIFICATION_HELP: Record<ContractVerification["status"], string> = {
  unverified: "No checklist has been run for this link.",
  incomplete: "A required field could not be established from the venue contract or a documented fact.",
  incompatible: "At least one rule of the venue contract contradicts the claim.",
  research_only: "This venue is not the US execution venue; the link informs research only.",
  verified_equivalent: "Every required rule matched and the side is mapped to a durable venue id.",
  stale: "The contract, the game or the claim changed since verification; verify again.",
};

export function ContractPanel(props: { predictionId: string; links: PredictionMarketLink[]; onChanged: () => Promise<void> | void }) {
  const [search, setSearch] = useState<UsCandidateSearch | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [lastDecision, setLastDecision] = useState<TradeDecision | null>(null);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setError(null);
    try { await fn(); await props.onChanged(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const find = () => run("Finding US contracts…", async () => { setSearch(await contractsApi.usCandidates(props.predictionId, url.trim() ? { url: url.trim() } : {})); });

  const usLinks = props.links.filter((l) => l.market?.provider === "polymarket_us" && l.status !== "rejected");

  return (
    <div className="contract-panel">
      <h4>Polymarket US contract verification</h4>
      <p className="muted small">
        Discovery scores and accepted links are research inputs. Only a complete rule checklist — exact event, rules text, period, threshold or line, units and side — makes a contract <em>verified equivalent</em>. Nothing in this build submits orders.
      </p>
      {error && <div className="banner error" role="alert">{error} <button type="button" className="link" onClick={() => setError(null)}>dismiss</button></div>}
      <div className="row small">
        <input value={url} placeholder="optional: paste a polymarket.us/event/… URL" onChange={(e) => setUrl(e.target.value)} style={{ minWidth: 300 }} />
        <button type="button" className="primary" disabled={!!busy} onClick={find}>{busy === "Finding US contracts…" ? busy : "Find US contracts"}</button>
      </div>
      {search && (
        <div className={`candidate-result outcome-${search.outcome}`}>
          <strong>
            {search.outcome === "none" && "No US contract matches this claim."}
            {search.outcome === "one" && "One US contract matches; verify it below."}
            {search.outcome === "multiple" && `${search.candidates.length} plausible US contracts — pick one by hand; nothing is chosen for you.`}
          </strong>
          {search.notes.length > 0 && <ul className="plain small muted">{search.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          {search.researchOnly.length > 0 && <p className="small muted">Research-only links on other venues: {search.researchOnly.map((r) => `${r.provider}: ${r.question}`).join(" · ")}</p>}
          <details className="small"><summary>Queries ({search.queries.length})</summary><ul className="plain">{search.queries.map((q, i) => <li key={i}><code>{q}</code></li>)}</ul></details>
        </div>
      )}
      {usLinks.length === 0 ? <p className="muted small">No Polymarket US links yet.</p> : (
        <ul className="plain">
          {usLinks.map((l) => (
            <li key={l.id} className="market-link">
              <div className="row space-between">
                <span><a href={l.market?.url} target="_blank" rel="noreferrer noopener"><strong>{l.market?.question}</strong></a> <VerificationBadge status={l.verificationStatus} /></span>
                <span className="small">
                  <button type="button" className="link" disabled={!!busy} onClick={() => setOpen(open === l.id ? null : l.id)}>{open === l.id ? "hide checklist" : "checklist"}</button>
                  {l.status !== "accepted" && <button type="button" className="link" disabled={!!busy} onClick={() => run("Accepting…", () => marketsApi.accept(l.id))}>accept link</button>}
                  {l.verificationStatus === "verified_equivalent" && (
                    <button type="button" className="link" disabled={!!busy} title="Builds a forecast from the creators' verified record, runs every risk gate, and — when eligible — reserves capacity and simulates an IOC fill in the US paper book. No order is sent." onClick={() => run("Evaluating…", async () => { setLastDecision(await decisionsApi.evaluate({ predictionId: props.predictionId, linkId: l.id })); })}>evaluate paper decision</button>
                  )}
                </span>
              </div>
              <div className="muted small">match {Math.round(l.score * 100)}% · {l.matchedBy}{l.side ? ` · side ${l.side} at ${fmtPct(l.market?.latest?.prices.find((x) => x.label === l.side)?.price)}` : ""}</div>
              {open === l.id && <Checklist link={l} busy={busy} run={run} />}
              {lastDecision && lastDecision.linkId === l.id && (
                <div className={`candidate-result outcome-${lastDecision.outcome === "eligible" ? "one" : "multiple"} small`}>
                  <strong>Paper decision: {OUTCOME_LABEL[lastDecision.outcome]}</strong>
                  {lastDecision.sizing && <> — {lastDecision.sizing.side.toUpperCase()} × {lastDecision.sizing.quantity} at {lastDecision.sizing.limitCost} (p {lastDecision.sizing.pChosen}, edge {lastDecision.sizing.netEdge}, worst cost {fmtUsd(lastDecision.sizing.worstCost)})</>}
                  {lastDecision.reasonCodes.length > 0 && <div className="muted">{lastDecision.reasonCodes.join(", ")}</div>}
                  {lastDecision.intent && <div className="muted">intent {lastDecision.intent.state}: {lastDecision.intent.filledQuantity}/{lastDecision.intent.quantity} filled (IOC)</div>}
                  <div><a href="#/trades">Open Trades for every gate and the evidence</a></div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Checklist({ link, busy, run }: { link: PredictionMarketLink; busy: string | null; run: (label: string, fn: () => Promise<unknown>) => Promise<void> }) {
  const [history, setHistory] = useState<ContractVerification[] | null>(null);
  const [facts, setFacts] = useState<VerifyFacts>({});
  const [notes, setNotes] = useState("");
  const [lastReasons, setLastReasons] = useState<string[] | null>(null);
  const load = async () => { try { setHistory((await contractsApi.verifications(link.id)).verifications); } catch { setHistory([]); } };
  useEffect(() => { void load(); }, [link.id, link.verificationId]);
  const latest = history?.[0];

  const verify = () => run("Verifying…", async () => {
    const f: VerifyFacts = {};
    for (const [k, v] of Object.entries(facts)) if (v.value.trim() && v.source.trim()) f[k] = { value: v.value.trim(), source: v.source.trim() };
    await contractsApi.verify(link.id, { facts: Object.keys(f).length ? f : undefined, notes: notes.trim() || undefined });
    setLastReasons(null);
    await load();
  });
  const revalidate = () => run("Revalidating…", async () => { const r = await contractsApi.revalidate(link.id); setLastReasons(r.reasons); await load(); });

  const missingNonGate = (latest?.fields ?? []).filter((f) => f.status === "missing" && f.required && !f.fact);
  return (
    <div className="checklist small">
      {history === null ? <p className="muted">Loading…</p> : !latest ? <p className="muted">Not verified yet. Run the checklist to compare every rule of the venue contract with the claim.</p> : (
        <>
          <div className="row space-between">
            <span><VerificationBadge status={latest.status} /> v{latest.version} · {latest.createdAt.slice(0, 16).replace("T", " ")} · reviewer {latest.reviewer}{latest.staleAt ? ` · stale since ${latest.staleAt.slice(0, 16).replace("T", " ")}` : ""}</span>
            <span className="muted">{latest.sideId ? <>side → <code>{latest.sideId}</code> ({latest.sideLabel})</> : "side not mapped"} · cutoff {latest.cutoffUnknown ? "unknown" : `${latest.cutoffAt?.slice(0, 16).replace("T", " ")} (${latest.cutoffBasis})`}</span>
          </div>
          {latest.staleReasons && latest.staleReasons.length > 0 && <ul className="plain muted">{latest.staleReasons.map((r, i) => <li key={i}>stale: {r}</li>)}</ul>}
          <table className="checklist-table">
            <thead><tr><th>Rule</th><th>Status</th><th>Claim requires</th><th>Contract states</th><th>Note</th></tr></thead>
            <tbody>
              {latest.fields.map((f) => (
                <tr key={f.id} className={`fs-${f.status}`}>
                  <td>{f.label}{f.required ? "" : <span className="muted"> (optional)</span>}</td>
                  <td>{FIELD_STATUS_LABEL[f.status]}</td>
                  <td>{f.expected ?? <span className="muted">—</span>}</td>
                  <td>{f.found ?? <span className="muted">—</span>}{f.fact && <div className="muted">fact: {f.fact.value} — {f.fact.source}</div>}</td>
                  <td className="muted">{f.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {latest.rulesHash && <p className="muted">rules hash <code>{latest.rulesHash.slice(0, 16)}…</code> · quote hash <code>{latest.quoteHash?.slice(0, 16) ?? "—"}…</code> · prediction revision {latest.predictionRevision}</p>}
        </>
      )}
      {missingNonGate.length > 0 && (
        <details open>
          <summary>Supply documented facts for missing fields ({missingNonGate.length})</summary>
          <p className="muted">A fact fills a <em>missing</em> field only; it never overrides an incompatible rule or a hard gate (venue, market open, rules text, side, teams, question, settlement). Each fact needs its source.</p>
          {missingNonGate.map((f) => (
            <div key={f.id} className="row">
              <span style={{ minWidth: 140 }}>{f.label}</span>
              <input placeholder="value" value={facts[f.id]?.value ?? ""} onChange={(e) => setFacts((m) => ({ ...m, [f.id]: { value: e.target.value, source: m[f.id]?.source ?? "" } }))} />
              <input placeholder="source (URL or document)" value={facts[f.id]?.source ?? ""} onChange={(e) => setFacts((m) => ({ ...m, [f.id]: { value: m[f.id]?.value ?? "", source: e.target.value } }))} style={{ minWidth: 220 }} />
            </div>
          ))}
        </details>
      )}
      <div className="row">
        <input placeholder="reviewer notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ minWidth: 260 }} />
        <button type="button" className="primary" disabled={!!busy} onClick={verify}>{latest ? `Verify again (v${latest.version + 1})` : "Run checklist"}</button>
        {latest && <button type="button" disabled={!!busy} onClick={revalidate}>Revalidate against the venue</button>}
      </div>
      {lastReasons && <p className="muted">{lastReasons.length === 0 ? "Nothing material changed; the verification stands." : `Marked stale: ${lastReasons.join("; ")}`}</p>}
      {history && history.length > 1 && <details><summary>Earlier versions ({history.length - 1})</summary><ul className="plain">{history.slice(1).map((v) => <li key={v.id}>v{v.version} · {VERIFICATION_LABEL[v.status]} · {v.createdAt.slice(0, 16).replace("T", " ")}{v.staleReasons?.length ? ` · stale: ${v.staleReasons.join("; ")}` : ""}</li>)}</ul></details>}
    </div>
  );
}
