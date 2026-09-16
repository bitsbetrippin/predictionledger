/**
 * Prediction Ledger — Trades page (1.12 paper decisions; 1.13 manual-live orders): decisions with every gate,
 * forecast contributions and fills; live intents, venue orders (external ones labelled), positions, holds and
 * reconciliation; preview → confirm for a manual-live decision. Nothing on this page sends an order without the
 * preview dialog's explicit confirmation, and the server re-checks every gate on both calls.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { useEffect, useState } from "react";
import type { DecisionOutcome, LivePosition, OrderPreviewRecord, PaperUsBook, ReconciliationHold, TradeDecision, TradeIntent, TradingMode, TradingStatus, VenueOrderRecord } from "@prediction-ledger/shared";
import { ApiError, INTENT_LABEL, OUTCOME_LABEL, decisionsApi, executionApi, fmtUsd, paperUsApi, tradingApi, type DecisionEvidence, type ReconcileReport } from "../api";

export function TradesPage() {
  const [decisions, setDecisions] = useState<TradeDecision[] | null>(null);
  const [book, setBook] = useState<PaperUsBook | null>(null);
  const [status, setStatus] = useState<TradingStatus | null>(null);
  const [intents, setIntents] = useState<TradeIntent[]>([]);
  const [orders, setOrders] = useState<VenueOrderRecord[]>([]);
  const [positions, setPositions] = useState<LivePosition[]>([]);
  const [holds, setHolds] = useState<ReconciliationHold[]>([]);
  const [mode, setMode] = useState<TradingMode | "">("");
  const [outcome, setOutcome] = useState<DecisionOutcome | "">("");
  const [selected, setSelected] = useState<DecisionEvidence | null>(null);
  const [preview, setPreview] = useState<{ decision: TradeDecision; preview: OrderPreviewRecord } | null>(null);
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    try {
      const [d, b, st] = await Promise.all([decisionsApi.list({ mode: mode || undefined, outcome: outcome || undefined, limit: 300 }), paperUsApi.get(), tradingApi.status()]);
      setDecisions(d); setBook(b); setStatus(st);
      const [i, o, p, h] = await Promise.all([executionApi.intents({ mode: "live", limit: 300 }), executionApi.orders({ limit: 300 }), executionApi.positions(), executionApi.holds(true)]);
      setIntents(i); setOrders(o); setPositions(p); setHolds(h);
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, [mode, outcome]);
  // Live intents change from the venue side (stream / reconciliation): poll while any is open.
  useEffect(() => {
    const open = intents.some((i) => ["submitting", "acknowledged", "submission_unknown"].includes(i.state));
    if (!open) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [intents]);

  const open = async (id: string) => {
    setBusy("Loading…");
    try { setSelected(await decisionsApi.evidence(id)); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const apiMessage = (e: unknown) => { const b = (e as ApiError).body as { message?: string; error?: string } | undefined; return b?.message ?? (e as Error).message; };
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setError(null);
    try { await fn(); await load(); } catch (e) { setError(apiMessage(e)); } finally { setBusy(null); }
  };
  const startPreview = async (d: TradeDecision) => {
    setBusy("Previewing…"); setError(null);
    try { setPreview({ decision: d, preview: await executionApi.preview(d.id) }); } catch (e) { setError(apiMessage(e)); } finally { setBusy(null); }
  };
  const confirm = async () => {
    if (!preview) return;
    const { decision, preview: pv } = preview;
    setBusy("Sending once…"); setError(null);
    try {
      const intent = await executionApi.submit(decision.id, pv.id, decision.rationaleHash);
      setPreview(null);
      if (intent.state === "submission_unknown") setError("The venue's answer was lost. The order MAY exist: nothing will be re-sent, capacity stays reserved and new orders are paused until you resolve it below (Reconcile lists candidates).");
      await load();
    } catch (e) { setError(apiMessage(e)); setPreview(null); await load(); } finally { setBusy(null); }
  };
  const armed = status?.armed ?? false;

  return (
    <section className="page">
      <div className="row space-between">
        <h1>Trades</h1>
        <span className="muted small">{armed ? `Manual live is ARMED: orders go to Polymarket US after preview → confirm. ${status?.submissionAvailable ? "" : `New orders blocked: ${status?.dispatchBlockers.join("; ")}.`}` : "Paper mode: decisions are evaluated, reserved and simulated against the venue's book; nothing is sent. Manual live is enabled in Setup → Polymarket US account."}</span>
      </div>
      {error && <div className="banner error" role="alert">{error} <button type="button" className="link" onClick={() => setError(null)}>dismiss</button></div>}
      {holds.length > 0 && (
        <div className="banner warn" role="alert">
          <strong>{holds.length} reconciliation hold(s) — new orders are paused until each is resolved.</strong>
          {holds.map((h) => <HoldRow key={h.id} hold={h} intents={intents} orders={orders} busy={!!busy} onResolve={(fn) => run("Resolving…", fn)} />)}
        </div>
      )}
      {preview && <PreviewDialog decision={preview.decision} preview={preview.preview} busy={!!busy} onCancel={() => setPreview(null)} onConfirm={() => void confirm()} />}
      {book && (
        <div className="stats">
          <div className="stat"><span className="label">US paper bankroll</span><strong>{fmtUsd(book.bankroll)}</strong><span className="muted small">start {fmtUsd(book.bankrollStart)} · {book.currency} · {book.method}</span></div>
          <div className="stat"><span className="label">Committed (open)</span><strong>{fmtUsd(book.committed)}</strong><span className="muted small">{book.open} open position(s)</span></div>
          <div className="stat"><span className="label">Realized</span><strong className={book.realizedPnl.startsWith("-") ? "neg" : "pos"}>{fmtUsd(book.realizedPnl)}</strong><span className="muted small">{book.wins}W / {book.losses}L / {book.voids} void · fees {fmtUsd(book.fees)}</span></div>
          <div className="stat"><span className="label">Live account (USD)</span><strong>{status?.latestSync?.ok ? fmtUsd(status.latestSync.balances.find((x) => x.currency === "USD")?.buyingPower?.value) : "—"}</strong><span className="muted small">{status?.syncAgeSeconds === undefined ? "not synced" : `synced ${status.syncAgeSeconds} s ago${status.stale ? " — STALE" : ""}`} · never summed with paper</span></div>
        </div>
      )}
      <div className="row controls small">
        <label>Mode <select value={mode} onChange={(e) => setMode(e.target.value as TradingMode | "")}><option value="">all</option><option value="paper">paper</option><option value="disabled">disabled</option><option value="manual_live">manual live</option><option value="auto_live">auto live (1.14)</option></select></label>
        <label>Outcome <select value={outcome} onChange={(e) => setOutcome(e.target.value as DecisionOutcome | "")}><option value="">all</option><option value="eligible">eligible</option><option value="skipped">skipped</option><option value="needs_review">needs review</option></select></label>
        <button type="button" disabled={!!busy} onClick={() => void load()}>Refresh</button>
        {status?.binding && <button type="button" disabled={!!busy} onClick={() => void run("Reconciling…", async () => setReport(await executionApi.reconcile()))}>Reconcile with venue</button>}
        <a className="small" href={executionApi.exportUrl} target="_blank" rel="noreferrer noopener">Export live lineage (JSON, secret-free)</a>
        {book && book.positions.length > 0 && <button type="button" disabled={!!busy} onClick={() => { if (window.confirm("Delete every US paper position and fill? Decisions and reservations stay as history. Live records are never touched.")) void run("Resetting…", () => paperUsApi.reset()); }}>Reset US paper book</button>}
      </div>
      {report && <p className="small muted">Reconciled at {report.syncedAt}: {report.ordersChecked} order(s) read back, {report.executionsAdded} execution(s) added from {report.activitiesRead} activities, {report.settlements} settlement event(s), {report.unknownIntents.length} unknown submission(s), {report.discrepancies.length} discrepancy(ies), {report.holdsOpen} hold(s) open{report.paused ? " — dispatch paused" : ""}. <button type="button" className="link" onClick={() => setReport(null)}>dismiss</button></p>}
      {(intents.length > 0 || orders.length > 0) && <LiveSection intents={intents} orders={orders} positions={positions} busy={!!busy} onCancel={(id) => run("Cancelling…", () => executionApi.cancel(id))} />}
      {decisions === null ? <p className="muted">Loading…</p> : decisions.length === 0 ? (
        <div className="empty-state"><p className="muted">No decisions yet. Open a prediction with a verified Polymarket US contract and choose <em>Evaluate paper decision</em> on its Markets tab.</p></div>
      ) : (
        <div className="split">
          <div className="table-wrap">
            <table>
              <thead><tr><th>When (clock)</th><th>Contract</th><th>Side</th><th>p</th><th>Cost / wire</th><th>Qty</th><th>Worst cost</th><th>Edge</th><th>Outcome</th><th>Intent</th><th>Reasons</th></tr></thead>
              <tbody>
                {decisions.map((d) => (
                  <tr key={d.id} className={selected?.decision.id === d.id ? "selected" : ""} onClick={() => void open(d.id)} style={{ cursor: "pointer" }}>
                    <td className="small">{d.clockAt.slice(0, 19).replace("T", " ")}<div className="muted">{d.mode} · {d.dailyBucket}</div></td>
                    <td><a href={d.marketUrl} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{d.question ?? d.venueMarketId}</a></td>
                    <td>{d.sizing ? <>{d.sizing.side.toUpperCase()} <span className="muted small">{d.sizing.sideLabel}</span></> : "—"}</td>
                    <td>{d.sizing?.pChosen ?? "—"}</td>
                    <td>{d.sizing ? `${d.sizing.limitCost} / ${d.sizing.wirePrice}` : "—"}</td>
                    <td>{d.sizing?.quantity ?? "—"}</td>
                    <td>{d.sizing ? fmtUsd(d.sizing.worstCost) : "—"}</td>
                    <td>{d.sizing?.netEdge ?? "—"}</td>
                    <td><span className={`chip outcome-${d.outcome}`}>{OUTCOME_LABEL[d.outcome]}</span>{d.mode === "manual_live" && d.outcome === "needs_review" && !d.intent && armed && <div><button type="button" className="small" disabled={!!busy} onClick={(e) => { e.stopPropagation(); void startPreview(d); }}>Preview order…</button></div>}</td>
                    <td className="small">{d.intent ? <>{INTENT_LABEL[d.intent.state] ?? d.intent.state}<div className="muted">{d.intent.filledQuantity}/{d.intent.quantity} filled</div></> : <span className="muted">none</span>}</td>
                    <td className="small muted">{d.reasonCodes.join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <aside className="detail">
            {selected ? <DecisionDetail ev={selected} onClose={() => setSelected(null)} /> : <div className="empty-state"><p className="muted">Select a decision to see every gate, the forecast's contributions, the fills and the evidence it was made on.</p></div>}
          </aside>
        </div>
      )}
    </section>
  );
}

function DecisionDetail({ ev, onClose }: { ev: DecisionEvidence; onClose: () => void }) {
  const d = ev.decision;
  const f = ev.forecast;
  return (
    <div className="detail-inner">
      <div className="row space-between"><strong>Why this decision?</strong><button type="button" className="link" onClick={onClose}>close</button></div>
      <p className="small muted">Decision {d.id.slice(0, 8)} · clock {d.clockAt} · policy {d.policyVersion} ({d.policyHash?.slice(0, 12)}…) · rationale hash {d.rationaleHash.slice(0, 12)}… · {d.currency} · bucket {d.dailyBucket} ({d.budgetTimezone})</p>
      {d.sizing && (
        <dl className="facts">
          <dt>Chosen side</dt><dd>{d.sizing.side.toUpperCase()} {d.sizing.sideLabel && <span className="muted">({d.sizing.sideLabel}, id {d.sizing.sideId})</span>} at p {d.sizing.pChosen}</dd>
          <dt>Cost</dt><dd>{d.sizing.limitCost} per contract (wire {d.sizing.wirePrice} YES-denominated) · {d.sizing.quantity} contracts · fee bound {fmtUsd(d.sizing.feeBound)} · worst cost {fmtUsd(d.sizing.worstCost)} · bound by {d.sizing.boundBy}</dd>
          <dt>Edge / EV</dt><dd>net edge {d.sizing.netEdge} per contract · estimated EV {fmtUsd(d.sizing.estimatedEv)} <span className="muted small">(model-based estimate, not a promise)</span></dd>
        </dl>
      )}
      <h4>Gates ({d.gates.filter((g) => !g.satisfied).length} unmet)</h4>
      <table className="checklist-table">
        <thead><tr><th>Gate</th><th>Status</th><th>Detail</th></tr></thead>
        <tbody>{d.gates.map((g) => <tr key={g.id} className={g.satisfied ? "fs-verified" : "fs-incompatible"}><td>{g.label}</td><td>{g.satisfied ? "✓" : `✗ ${g.code ?? ""}`}</td><td className="muted small">{g.detail}</td></tr>)}</tbody>
      </table>
      {ev.reservation && <p className="small">Reservation {ev.reservation.state}: {fmtUsd(ev.reservation.amount)} reserved, {fmtUsd(ev.reservation.filledAmount)} consumed · bucket {ev.reservation.dailyBucket}{ev.reservation.note ? ` · ${ev.reservation.note}` : ""}</p>}
      {d.paperPosition && (
        <>
          <h4>Paper position ({d.paperPosition.method})</h4>
          <p className="small">{d.paperPosition.quantity} × {d.paperPosition.side.toUpperCase()} at avg {d.paperPosition.avgCost} · cost {fmtUsd(d.paperPosition.costTotal)} + fees {fmtUsd(d.paperPosition.fees)} · {d.paperPosition.status}{d.paperPosition.outcome ? ` · ${d.paperPosition.outcome} ${fmtUsd(d.paperPosition.pnl)}` : ""}</p>
          <ul className="plain small">{d.paperPosition.fills.map((x) => <li key={x.id}>fill {x.seq}: {x.quantity} at {x.chosenCost} (YES {x.yesPrice}) fee {fmtUsd(x.fee)} · {x.at}</li>)}</ul>
        </>
      )}
      {f && (
        <>
          <h4>Forecast {f.strategyVersion} · {f.status}</h4>
          <p className="small">pYes <strong>{f.pYes}</strong> / pNo <strong>{f.pNo}</strong> · prior {f.prior.p0} ({f.prior.source}{f.prior.bookAt ? ` at ${f.prior.bookAt}` : ""}) · as of {f.asOf} · hash {f.hash.slice(0, 12)}… · expires {f.expiresAt ?? "—"}</p>
          <p className="muted small">{f.formula.text}</p>
          <table className="checklist-table">
            <thead><tr><th>Source</th><th>Cluster</th><th>Stance</th><th>n</th><th>e</th><th>d</th><th>w</th><th>Used</th><th>Why</th></tr></thead>
            <tbody>{f.contributions.map((c) => <tr key={c.id} className={c.selected ? "fs-verified" : "fs-not_applicable"}><td>{c.sourceKey}</td><td>{c.clusterKey}</td><td>{c.stance === 1 ? "YES" : "NO"}</td><td>{c.n}</td><td>{c.meanEdge ?? "—"}</td><td>{c.shrunkEdge ?? "—"}</td><td>{c.weight ?? "—"}</td><td>{c.selected ? "✓" : "—"}</td><td className="muted small">{c.reason}</td></tr>)}</tbody>
          </table>
          {f.exclusions.length > 0 && <p className="muted small">Excluded: {f.exclusions.map((e) => `${e.kind} ×${e.count}`).join(" · ")}</p>}
          <p className="muted small">Inputs: prediction revision {f.inputs.predictionRevision} · analysis v{f.inputs.analysisVersion ?? "—"} · plan v{f.inputs.planVersion ?? "—"} · verification v{f.inputs.verificationVersion ?? "—"} · quote {f.inputs.quoteHash?.slice(0, 12) ?? "—"}… · rules {f.inputs.rulesHash?.slice(0, 12) ?? "—"}…</p>
        </>
      )}
      {ev.verification && <p className="small">Contract verification v{ev.verification.version}: {ev.verification.status} · cutoff {ev.verification.cutoffAt ?? "unknown"} ({ev.verification.cutoffBasis ?? "—"}) · side {ev.verification.sideId ?? "—"}</p>}
      {ev.dossier && (
        <details className="small">
          <summary>Evidence at decision time — {ev.dossier.supporting.length} supporting · {ev.dossier.contradicting.length} contradicting · {ev.dossier.excludedAsOf} not yet known</summary>
          <p>“{ev.dossier.quote.text}” {ev.dossier.quote.timestampUrl && <a href={ev.dossier.quote.timestampUrl} target="_blank" rel="noreferrer noopener">open at timestamp</a>}</p>
          <ul className="plain">{[...ev.dossier.supporting, ...ev.dossier.contradicting].map((it) => <li key={it.evidenceId}><span className={`chip stance-${it.stance}`}>{it.stance}</span> <a href={it.source.url} target="_blank" rel="noreferrer noopener">{it.source.title ?? it.source.url}</a> — “{it.excerpt.slice(0, 160)}”</li>)}</ul>
        </details>
      )}
      <details className="small"><summary>Raw inputs (immutable)</summary><pre className="prompt">{JSON.stringify(d.inputs, null, 2)}</pre></details>
    </div>
  );
}

/** EXE-02: everything the owner must see before confirming, bound to the decision's immutable hash; expires in 60 s. */
function PreviewDialog({ decision, preview, busy, onCancel, onConfirm }: { decision: TradeDecision; preview: OrderPreviewRecord; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const [left, setLeft] = useState(Math.max(0, Math.round((Date.parse(preview.expiresAt) - Date.now()) / 1000)));
  useEffect(() => { const t = setInterval(() => setLeft(Math.max(0, Math.round((Date.parse(preview.expiresAt) - Date.now()) / 1000))), 1000); return () => clearInterval(t); }, [preview.expiresAt]);
  const d = preview.display;
  return (
    <div className="banner warn" role="dialog" aria-label="Confirm live order">
      <p><strong>Real order — confirm to send once.</strong> {left > 0 ? `This preview expires in ${left} s.` : "This preview has expired; request a new one."}</p>
      <dl className="facts">
        <dt>Contract</dt><dd>{d.question ?? decision.venueMarketId} {d.marketUrl && <a href={d.marketUrl} target="_blank" rel="noreferrer noopener">open on venue</a>}</dd>
        <dt>Order</dt><dd>BUY <strong>{d.side.toUpperCase()}</strong> {d.sideLabel && <span className="muted">({d.sideLabel})</span>} · {d.quantity} contracts · limit IOC · chosen-side cost {d.chosenCost} (wire YES price {d.yesWirePrice}) · manual</dd>
        <dt>Money</dt><dd>worst case {fmtUsd(d.worstCost)} (= {d.quantity} × {d.chosenCost} + fee bound {fmtUsd(d.feeBound)}) · estimated EV {fmtUsd(d.estimatedEv)} <span className="muted small">(model estimate, not a promise)</span> · p {d.pChosen} · net edge {d.netEdge}</dd>
        <dt>Why</dt><dd>decision {decision.id.slice(0, 8)} · rationale hash {decision.rationaleHash.slice(0, 16)}… · policy {d.policyHash?.slice(0, 12)}… · deadline {d.deadlineAt ?? "—"} · <a href={d.evidenceUrl} target="_blank" rel="noreferrer noopener">evidence at decision time</a></dd>
        <dt>Wire request</dt><dd><code className="small">{JSON.stringify(preview.request)}</code></dd>
      </dl>
      <p className="small muted">The server re-decides with a fresh book and account before sending; if anything moved, the preview is refused and nothing is sent. A lost answer is never re-sent: it becomes “Unknown — reconciling”.</p>
      <div className="row">
        <button type="button" className="danger" disabled={busy || left <= 0} onClick={onConfirm}>Confirm — place real order</button>
        <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function HoldRow({ hold, intents, orders, busy, onResolve }: { hold: ReconciliationHold; intents: TradeIntent[]; orders: VenueOrderRecord[]; busy: boolean; onResolve: (fn: () => Promise<unknown>) => void }) {
  const [note, setNote] = useState("");
  const [pick, setPick] = useState("");
  const intent = hold.kind === "submission_unknown" ? intents.find((i) => i.id === hold.subject) : undefined;
  const candidates = ((hold.detail.candidates as string[] | undefined) ?? []).map((id) => orders.find((o) => o.id === id) ?? { id } as VenueOrderRecord);
  return (
    <div className="small">
      <strong>{hold.kind.replace("_", " ")}</strong> · opened {hold.openedAt.slice(0, 19).replace("T", " ")} · {hold.subject ?? ""}
      {hold.kind === "submission_unknown" && intent && (
        <div>
          Intent {intent.id.slice(0, 8)}: BUY {intent.side.toUpperCase()} {intent.quantity} at YES {intent.wirePrice} on {intent.venueMarketId}; reason: {intent.unknownReason ?? "—"}. {String(hold.detail.note ?? "")}
          <div className="row">
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">— candidate venue order —</option>
              {candidates.map((c) => <option key={c.id} value={c.id}>{c.id} · {c.side ?? "?"} {c.quantity ?? "?"} at {c.yesPrice ?? "?"} · {c.state ?? "?"} · {c.venueCreatedAt ?? ""}</option>)}
            </select>
            <input type="text" placeholder="What you checked on the venue (required)" value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: "18rem" }} />
            <button type="button" disabled={busy || !pick || !note} onClick={() => onResolve(() => executionApi.resolveUnknown(intent.id, { venueOrderId: pick, note }))}>This order is mine</button>
            <button type="button" disabled={busy || !note} onClick={() => { if (window.confirm("Declare that the venue never created this order? Its reservation is released and the contract can be traded again. Only do this after checking the venue's order history.")) onResolve(() => executionApi.resolveUnknown(intent.id, { outcome: "not_submitted", note })); }}>Venue shows no order</button>
          </div>
        </div>
      )}
      {hold.kind !== "submission_unknown" && (
        <div className="row">
          <span className="muted">{JSON.stringify(hold.detail).slice(0, 240)}</span>
          <input type="text" placeholder="Resolution note (required)" value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: "18rem" }} />
          <button type="button" disabled={busy || !note} onClick={() => onResolve(() => executionApi.resolveHold(hold.id, note))}>Resolve</button>
        </div>
      )}
    </div>
  );
}

function LiveSection({ intents, orders, positions, busy, onCancel }: { intents: TradeIntent[]; orders: VenueOrderRecord[]; positions: LivePosition[]; busy: boolean; onCancel: (intentId: string) => void }) {
  const external = orders.filter((o) => o.external && !o.id.startsWith("external:"));
  return (
    <div className="card">
      <h3>Live orders and positions <span className="muted small">(intent = what the app tried; order = what the venue says; position = what is held — three separate states)</span></h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Contract</th><th>Order</th><th>Intent state</th><th>Venue order</th><th>Filled</th><th>Avg (YES) / fees</th><th>Reservation</th><th></th></tr></thead>
          <tbody>
            {intents.map((i) => (
              <tr key={i.id} className={i.state === "submission_unknown" ? "fs-incompatible" : ""}>
                <td className="small">{i.createdAt.slice(0, 19).replace("T", " ")}</td>
                <td className="small">{i.venueMarketId}</td>
                <td className="small">BUY {i.side.toUpperCase()} {i.quantity} @ YES {i.wirePrice} <span className="muted">(cost {i.limitCost})</span></td>
                <td><span className={`chip intent-${i.state}`}>{INTENT_LABEL[i.state] ?? i.state}</span>{i.lastError && <div className="muted small">{i.lastError}</div>}{i.unknownReason && <div className="muted small">{i.unknownReason}</div>}</td>
                <td className="small">{i.order ? <>{i.order.id} · {i.order.state}{i.order.rejectReason ? ` · ${i.order.rejectReason}` : ""}</> : <span className="muted">none</span>}</td>
                <td>{i.filledQuantity}/{i.quantity}</td>
                <td className="small">{i.order?.avgPrice ?? "—"} / {fmtUsd(i.order?.fees)}</td>
                <td className="small">{i.reservationId.slice(0, 8)}</td>
                <td>{i.order && ["pending", "open", "partial", "cancel_pending"].includes(i.order.state) && <button type="button" className="small" disabled={busy} onClick={() => onCancel(i.id)}>Cancel</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {external.length > 0 && (
        <details className="small">
          <summary>{external.length} order(s) on this account not placed by this app (no rationale exists for them)</summary>
          <table><thead><tr><th>Venue id</th><th>Contract</th><th>Side</th><th>Qty</th><th>YES price</th><th>State</th><th>Filled</th><th>Created</th></tr></thead>
            <tbody>{external.map((o) => <tr key={o.id}><td>{o.id}</td><td>{o.marketSlug}</td><td>{o.side ?? "?"}</td><td>{o.quantity ?? "?"}</td><td>{o.yesPrice ?? "?"}</td><td>{o.state}</td><td>{o.filledQuantity}</td><td>{o.venueCreatedAt ?? "—"}</td></tr>)}</tbody></table>
        </details>
      )}
      {positions.length > 0 && (
        <table className="small">
          <thead><tr><th>Contract</th><th>Venue net</th><th>Ours (YES-denominated)</th><th>As of</th><th>Settled</th><th>Discrepancy</th></tr></thead>
          <tbody>{positions.map((p) => <tr key={p.marketSlug} className={p.discrepancy ? "fs-incompatible" : ""}><td>{p.marketSlug}</td><td>{p.venueNet ?? "—"}</td><td>{p.localNet}</td><td>{p.venueAt?.slice(0, 19).replace("T", " ") ?? "—"}</td><td>{p.settled ? `${p.settled.outcome} · ${p.settled.at.slice(0, 10)}` : "open"}</td><td className="muted">{p.discrepancy ?? ""}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}
