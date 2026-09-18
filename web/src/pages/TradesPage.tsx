/**
 * Prediction Ledger — Trades page (1.12 paper decisions; 1.13 manual-live orders; 1.14 ledger, alerts, automation;
 * 2.1 plain-English redesign): mode banner with its REAL MONEY / PAPER tag, Arm blockers listed by their actual gate,
 * summary tiles with "?" help, alerts split into action-required / informational, one three-column card per hold
 * (what it means · what the app did · what only you can do) with the required note, External holdings marked
 * INFORMATIONAL, and the ledger / decisions tabs with "Why this decision?".
 *
 * Nothing on this page sends an order without the preview dialog's explicit confirmation, and the server re-checks
 * every gate on both calls. Arm blockers come from /api/trading/status (gates, dispatchBlockers), /api/trading/automation
 * and the qualification report — never from the page's own opinion.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { useEffect, useState } from "react";
import type { AutomationRun, DecisionOutcome, ExternalLedgerRow, LivePosition, OrderPreviewRecord, PaperUsBook, ReconciliationHold, TradeDecision, TradeIntent, TradeLedgerFilter, TradeLedgerRow, TradingAlert, TradingGate, TradingMode, TradingStatus, TradingSummary, VenueOrderRecord } from "@prediction-ledger/shared";
import { ApiError, INTENT_LABEL, LEDGER_STATUSES, OUTCOME_LABEL, automationApi, decisionsApi, executionApi, fmtUsd, paperUsApi, tradingApi, type AutomationInfo, type DecisionEvidence, type QualificationReportView, type ReconcileReport } from "../api";
import { INTENT_HELP, alertNeedsAction, alertTopic, holdTopic } from "../help/topics";
import { HelpButton } from "../components/HelpButton";
import { useLearn } from "../components/LearnPanel";
import { Icon } from "../components/Icons";
import { EmptyState, ErrorState, Skeleton, Tabs, Tag, Tile, fmtStamp } from "../components/ui";

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
  const [summary, setSummary] = useState<TradingSummary | null>(null);
  const [ledger, setLedger] = useState<(TradeLedgerRow | ExternalLedgerRow)[] | null>(null);
  const [alerts, setAlerts] = useState<TradingAlert[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [info, setInfo] = useState<AutomationInfo | null>(null);
  const [qual, setQual] = useState<QualificationReportView | null>(null);
  const [filter, setFilter] = useState<TradeLedgerFilter>({ limit: 300 });
  const [view, setView] = useState<"ledger" | "decisions">("ledger");
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    try {
      const [d, b, st] = await Promise.all([decisionsApi.list({ mode: mode || undefined, outcome: outcome || undefined, limit: 300 }), paperUsApi.get(), tradingApi.status()]);
      setDecisions(d); setBook(b); setStatus(st); setLoadError(null);
      const [i, o, p, h, sm, lg, al, rn] = await Promise.all([executionApi.intents({ mode: "live", limit: 300 }), executionApi.orders({ limit: 300 }), executionApi.positions(), executionApi.holds(true), automationApi.summary(), automationApi.ledger({ ...filter, mode: (mode || filter.mode) as TradingMode | undefined }), automationApi.alerts(true), automationApi.runs(10)]);
      setIntents(i); setOrders(o); setPositions(p); setHolds(h); setSummary(sm); setLedger(lg); setAlerts(al); setRuns(rn);
      // Arm blockers: the automation view (categories, scheduler reasons) and the qualification report (pending / eventsNeeded).
      const [ai, qr] = await Promise.all([automationApi.info().catch(() => null), automationApi.qualificationReport().catch(() => null)]);
      setInfo(ai); setQual(qr);
    } catch (e) { setLoadError((e as Error).message); }
  };
  useEffect(() => { void load(); }, [mode, outcome, filter]);
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
  const stop = async () => {
    if (!window.confirm("EMERGENCY STOP: disarm now, pause new orders, and request cancellation of every open order this app placed (positions and history are kept; orders placed elsewhere are untouched). Continue?")) return;
    await run("Stopping…", async () => { const r = await automationApi.emergencyStop("owner pressed Emergency stop"); setError(`Stopped at ${r.stoppedAt}: ${r.cancellations.length} app-owned order(s) targeted (${r.cancellations.filter((c) => c.outcome === "requested").length} requested, ${r.cancellations.filter((c) => c.outcome === "failed").length} failed), ${r.positionsRetained} position(s) retained. ${r.note}`); });
  };

  if (loadError && !status) return <section className="page wide"><ErrorState title="Trades could not be loaded" message={loadError} onRetry={() => void load()} /></section>;
  if (!status || !summary) return <section className="page wide"><Skeleton rows={6} /></section>;

  const actionAlerts = alerts.filter((a) => alertNeedsAction(a.kind));
  const infoAlerts = alerts.filter((a) => !alertNeedsAction(a.kind));
  const external = positions.filter((p) => p.external);
  const own = positions.filter((p) => !p.external);

  return (
    <section className="page wide">
      {error && <div className="banner error" role="alert">{error} <button type="button" className="link" onClick={() => setError(null)}>dismiss</button></div>}
      {loadError && <div className="banner warn" role="status">Some sections did not refresh: {loadError} <button type="button" className="link" onClick={() => void load()}>retry</button></div>}

      <ModeBanner status={status} summary={summary} holds={holds.length} busy={!!busy}
        onStop={() => void stop()}
        onResume={() => void run("Resuming…", () => automationApi.resume())}
        onPause={() => void run("Pausing…", () => automationApi.pause("owner pause (Trades)"))}
        onDisarm={() => void run("Disarming…", () => tradingApi.disarm("owner disarm (Trades)"))}
        onReconcile={status.binding ? () => void run("Reconciling…", async () => setReport(await executionApi.reconcile())) : undefined}
      />
      {!armed && <ArmBlockers status={status} info={info} qual={qual} />}

      <SummaryTiles s={summary} book={book} />

      {report && <p className="small muted">Reconciled at {fmtStamp(report.syncedAt, true)}: {report.ordersChecked} order(s) read back, {report.executionsAdded} execution(s) added from {report.activitiesRead} activities, {report.settlements} settlement event(s), {report.unknownIntents.length} unknown submission(s), {report.discrepancies.length} discrepancy(ies), {report.holdsOpen} hold(s) open{report.paused ? " — dispatch paused" : ""}{report.externalHoldings ? `, ${report.externalHoldings} external holding(s) (not placed by this app)` : ""}{report.reclassifiedHolds ? `, ${report.reclassifiedHolds} legacy hold(s) reclassified as external holdings` : ""}. <button type="button" className="link" onClick={() => setReport(null)}>dismiss</button></p>}

      {alerts.length > 0 && (
        <>
          <h2 style={{ marginTop: 6 }}>Alerts <span className="muted small">{alerts.length} open · {actionAlerts.length} need action</span> <HelpButton topic="trades.alerts">Which need action</HelpButton></h2>
          <div className="alert-list">
            {[...actionAlerts, ...infoAlerts].map((a) => <AlertItem key={a.id} a={a} busy={!!busy} onAck={() => void run("Acknowledging…", () => automationApi.ackAlert(a.id))} />)}
          </div>
        </>
      )}

      {holds.length > 0 && (
        <>
          <h2 style={{ marginTop: 6 }}>Reconciliation holds <span className="muted small">{holds.length} open — new app orders are paused until each is resolved</span> <HelpButton topic="trades.holds-alerts-breaker">What a hold is</HelpButton></h2>
          {holds.map((h) => <HoldCard key={h.id} hold={h} intents={intents} orders={orders} busy={!!busy} onResolve={(fn) => run("Resolving…", fn)} />)}
        </>
      )}

      {preview && <PreviewDialog decision={preview.decision} preview={preview.preview} busy={!!busy} onCancel={() => setPreview(null)} onConfirm={() => void confirm()} />}

      {external.length > 0 && <ExternalHoldings positions={external} />}
      {(intents.length > 0 || orders.length > 0 || own.length > 0) && <LiveSection intents={intents} orders={orders} positions={own} busy={!!busy} onCancel={(id) => run("Cancelling…", () => executionApi.cancel(id))} />}

      <Tabs value={view} onChange={setView} ariaLabel="Trades views" items={[{ id: "ledger", label: "Ledger — every decision, order, position" }, { id: "decisions", label: "Decisions — gates and forecasts" }]} />
      <div className="row controls small">
        {view === "decisions" && <>
          <label>Mode <select value={mode} onChange={(e) => setMode(e.target.value as TradingMode | "")}><option value="">all</option><option value="paper">paper</option><option value="disabled">disabled</option><option value="manual_live">manual live</option><option value="auto_live">auto live</option></select></label>
          <label>Outcome <select value={outcome} onChange={(e) => setOutcome(e.target.value as DecisionOutcome | "")}><option value="">all</option><option value="eligible">eligible</option><option value="skipped">skipped</option><option value="needs_review">needs review</option></select></label>
        </>}
        <button type="button" disabled={!!busy} onClick={() => void load()}>Refresh</button>
        <a className="small" href={executionApi.exportUrl} target="_blank" rel="noreferrer noopener">Export live lineage (JSON, secret-free)</a>
        {book && book.positions.length > 0 && <button type="button" disabled={!!busy} onClick={() => { if (window.confirm("Delete every US paper position and fill? Decisions and reservations stay as history. Live records are never touched.")) void run("Resetting…", () => paperUsApi.reset()); }}>Reset US paper book</button>}
      </div>

      {view === "ledger" && <LedgerView rows={ledger} filter={filter} setFilter={setFilter} onOpen={(id) => void open(id)} selectedId={selected?.decision.id} runs={runs} />}
      {view === "ledger" && selected && <aside className="detail"><DecisionDetail ev={selected} onClose={() => setSelected(null)} /></aside>}
      {view === "decisions" && (decisions === null ? <Skeleton /> : decisions.length === 0 ? (
        <EmptyState title="No decisions yet.">Open a prediction with a verified Polymarket US contract and choose <em>Evaluate paper decision</em> on its Markets tab.</EmptyState>
      ) : (
        <div className={`split${selected ? " detail-open" : ""}`}>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>When (clock)</th><th>Contract</th><th>Side</th><th>p</th><th>Cost / wire</th><th>Qty</th><th>Worst cost</th><th>Edge</th><th>Outcome</th><th>Intent</th><th>Reasons</th></tr></thead>
              <tbody>
                {decisions.map((d) => (
                  <tr key={d.id} className={selected?.decision.id === d.id ? "selected" : ""} onClick={() => void open(d.id)} style={{ cursor: "pointer" }}>
                    <td className="small num">{fmtStamp(d.clockAt, true)}<div className="muted">{d.mode} · {d.dailyBucket}</div></td>
                    <td><a href={d.marketUrl} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{d.question ?? d.venueMarketId}</a></td>
                    <td>{d.sizing ? <>{d.sizing.side.toUpperCase()} <span className="muted small">{d.sizing.sideLabel}</span></> : "—"}</td>
                    <td className="num">{d.sizing?.pChosen ?? "—"}</td>
                    <td className="num">{d.sizing ? `${d.sizing.limitCost} / ${d.sizing.wirePrice}` : "—"}</td>
                    <td className="num">{d.sizing?.quantity ?? "—"}</td>
                    <td className="num">{d.sizing ? fmtUsd(d.sizing.worstCost) : "—"}</td>
                    <td className="num">{d.sizing?.netEdge ?? "—"}</td>
                    <td><span className={`chip outcome-${d.outcome}`}>{OUTCOME_LABEL[d.outcome]}</span>{d.mode === "manual_live" && d.outcome === "needs_review" && !d.intent && armed && <div><button type="button" className="small" disabled={!!busy} onClick={(e) => { e.stopPropagation(); void startPreview(d); }}>Preview order…</button></div>}</td>
                    <td className="small">{d.intent ? <>{INTENT_LABEL[d.intent.state] ?? d.intent.state}<div className="muted">{d.intent.filledQuantity}/{d.intent.quantity} filled</div></> : <span className="muted">none</span>}</td>
                    <td className="small muted">{d.reasonCodes.join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selected && <aside className="detail"><DecisionDetail ev={selected} onClose={() => setSelected(null)} /></aside>}
        </div>
      ))}
    </section>
  );
}

/** The mode banner: what mode this is, what it means for money, and the controls that belong to it. */
function ModeBanner({ status, summary, holds, busy, onStop, onResume, onPause, onDisarm, onReconcile }: { status: TradingStatus; summary: TradingSummary; holds: number; busy: boolean; onStop: () => void; onResume: () => void; onPause: () => void; onDisarm: () => void; onReconcile?: () => void }) {
  const armed = status.armed;
  const auto = status.policy.mode === "auto_live";
  const paused = !!summary.paused;
  const blockers = status.dispatchBlockers.filter((b) => !/^mode is |^live authorization absent|^no connected account/.test(b));
  return (
    <div className={`mode-banner${armed ? " live" : ""}${armed && (paused || holds) ? " paused" : ""}`} role="status">
      <Icon name={armed ? "warningCircle" : "flask"} />
      <div className="body">
        {armed ? (
          <>
            <strong>{auto ? `Automatic trading is armed — the scheduler places bounded orders under policy ${status.policy.authorizedPolicyHash?.slice(0, 12)}…` : "Manual live is armed — orders go to Polymarket US after preview → confirm"} <Tag kind="money" /></strong>
            {status.submissionAvailable ? <p>New orders can be placed. Nothing is cancelled, resent or settled on its own.</p> : <p>New orders are blocked: {blockers.length ? blockers.join("; ") : status.dispatchBlockers.join("; ")}. Nothing is cancelled, resent or settled on its own.</p>}
          </>
        ) : (
          <>
            <strong>Paper mode — decisions are evaluated, reserved and simulated; nothing is sent <Tag kind="paper" /></strong>
            <p>Live modes are enabled only in Setup → Polymarket US account with a typed acknowledgement. Automatic execution additionally needs a production-qualified strategy — the reasons it is unavailable are listed below, by their actual gate.</p>
          </>
        )}
      </div>
      <div className="actions">
        {summary.account && armed && <button type="button" className="danger" disabled={busy} onClick={onStop}>Emergency stop</button>}
        {summary.account && (paused ? <button type="button" disabled={busy} onClick={onResume}>Resume new orders</button> : armed ? <button type="button" disabled={busy} onClick={onPause}>Pause new orders</button> : null)}
        {armed && <button type="button" disabled={busy} onClick={onDisarm}>Disarm</button>}
        {onReconcile && <button type="button" disabled={busy} onClick={onReconcile}>Reconcile with venue</button>}
        {!armed && <HelpButton topic="trades.arm-unavailable">Why unavailable</HelpButton>}
      </div>
    </div>
  );
}

/** Why Arm is unavailable, sourced from the server's gates, the automation view and the qualification report. Nothing here is invented by the page. */
function ArmBlockers({ status, info, qual }: { status: TradingStatus; info: AutomationInfo | null; qual: QualificationReportView | null }) {
  const noAccount = status.gates.some((g) => g.id === "credentials_valid" && !g.satisfied);
  // Without a connected account the freshness / reconciliation gates are consequences, not separate reasons.
  const unmet = status.gates.filter((g) => !g.satisfied && g.id !== "live_authorization" && !(noAccount && (g.id === "account_fresh" || g.id === "reconciled")));
  const extra = (info?.live.reasons ?? []).filter((r) => !/^mode is |^no automation authorization|dispatch lease/.test(r) && !status.dispatchBlockers.includes(r));
  if (unmet.length === 0 && extra.length === 0) return null;
  const items = [...unmet.map((g) => gateItem(g, qual)), ...extra.map((r) => ({ key: r, title: r, meta: "reported by the scheduler", link: undefined as { href: string; label: string } | undefined }))];
  return (
    <div className="blockers" aria-label="Why automatic execution cannot be armed">
      {items.map((it) => (
        <div key={it.key} className="blocker">
          <Icon name="circle" />
          <div>
            <strong>{it.title}</strong>
            <span className="meta">{it.meta}</span>
            {it.link && <a href={it.link.href} target={it.link.href.startsWith("/api/") ? "_blank" : undefined} rel="noreferrer noopener" className="small">{it.link.label}</a>}
          </div>
        </div>
      ))}
    </div>
  );
}

function gateItem(g: TradingGate, qual: QualificationReportView | null): { key: string; title: string; meta: string; link?: { href: string; label: string } } {
  switch (g.id) {
    case "strategy_qualified":
      return { key: g.id, title: "No production strategy qualification exists", meta: qual ? `${qual.cohort.settledEvents} of ≥ ${qual.cohort.settledEvents + qual.eventsNeeded} distinct settled events with a market baseline (${qual.category}, ${qual.strategyVersion}) — report says ${qual.status}` : g.detail, link: { href: automationApi.qualificationReportUrl(qual?.category), label: "Qualification report" } };
    case "credentials_valid":
      return { key: g.id, title: "Polymarket US account not connected", meta: `arming needs a validated key, this process holding the dispatch lease and a fresh account sync — ${g.detail}`, link: { href: "#/setup?section=account", label: "Connect account" } };
    case "account_fresh":
      return { key: g.id, title: "Account state not fresh", meta: `the snapshot is ${g.detail}; orders are refused on a snapshot older than 30 s`, link: { href: "#/setup?section=account", label: "Account" } };
    case "reconciled":
      return { key: g.id, title: "Binding requires reconciliation", meta: g.detail, link: { href: "#/setup?section=account", label: "Account" } };
    case "paper_rehearsal":
      return { key: g.id, title: `Fewer than ${g.label.match(/≥ (\d+)/)?.[1] ?? "the required"} settled paper positions`, meta: `${g.detail} · the paper autopilot budget accumulates these without sending anything`, link: { href: "#/setup?section=automation", label: "Scheduler budgets" } };
    case "contract_verification":
      return { key: g.id, title: "No verified executable contract", meta: g.detail, link: { href: "#/predictions", label: "Predictions → Markets tab" } };
    case "no_holds":
      return { key: g.id, title: "Unresolved holds or unknown submissions", meta: g.detail };
    case "not_paused":
      return { key: g.id, title: "New orders paused by the owner", meta: g.detail };
    case "breaker_closed":
      return { key: g.id, title: "Circuit breaker open", meta: g.detail };
    default:
      return { key: g.id, title: g.label, meta: g.detail };
  }
}

/** DASH-01: live figures come only from the venue's sync and official settlements; paper books are shown apart and never summed in. */
function SummaryTiles({ s, book }: { s: TradingSummary; book: PaperUsBook | null }) {
  const modeValue = s.armed ? `${s.armedKind === "auto" ? "AUTO" : "MANUAL"} live${s.paused ? " · PAUSED" : ""}` : `${s.mode}${s.paused ? " · PAUSED" : ""}`;
  return (
    <div className="tiles">
      <Tile label="Mode / account" help={<HelpButton topic="trades.mode" />} value={modeValue} tone={s.armed ? "bad" : "info"} meta={`${s.account ? `key ${s.account.keyIdHint ?? "—"} · ${s.account.state}` : "no account connected"} · lease ${s.lease.heldByThisProcess ? "held" : "not held"} · stream ${s.stream}`} />
      <Tile label="Buying power (venue)" help={<HelpButton topic="trades.buying-power" />} value={s.buyingPower ? fmtUsd(s.buyingPower) : "—"} tone={s.stale && s.account ? "warn" : undefined} meta={<span className={s.stale ? "warn" : undefined}>{s.syncAt ? `synced ${s.syncAgeSeconds ?? "?"} s ago${s.stale ? " — STALE (orders refused past 30 s)" : ""}` : "never synced"}</span>} />
      <Tile label="Committed risk (live)" help={<HelpButton topic="trades.committed-risk" />} value={fmtUsd(s.committed)} meta={`${s.openPositions} open position${s.openPositions === 1 ? "" : "s"} · ${s.openIntents} order${s.openIntents === 1 ? "" : "s"} in flight${s.unknownIntents ? ` · ${s.unknownIntents} UNKNOWN` : ""}`} tone={s.unknownIntents ? "warn" : undefined} />
      <Tile label="Realized P&L (official settlements)" help={<HelpButton topic="trades.realized-pnl" />} value={<span className={s.realizedPnl.startsWith("-") ? "neg" : "pos"}>{fmtUsd(s.realizedPnl)}</span>} meta={`fees ${fmtUsd(s.fees)}`} />
      <Tile label="Unrealized (marked)" help={<HelpButton topic="trades.unrealized" />} value={s.unrealizedPnl ? <span className={s.unrealizedPnl.startsWith("-") ? "neg" : "pos"}>{fmtUsd(s.unrealizedPnl)}</span> : "—"} tone={s.markStale && s.openPositions ? "warn" : undefined} meta={<span className={s.markStale ? "warn" : undefined}>{s.markAt ? `mark ${fmtStamp(s.markAt)}${s.markStale ? " — STALE mark" : ""}` : s.openPositions ? "no mark available" : "no open live position"}</span>} />
      <Tile label="Holds / alerts / breaker" help={<HelpButton topic="trades.holds-alerts-breaker" />} value={`${s.holdsOpen} / ${s.alertsOpen} / ${s.breaker.state}`} tone={s.holdsOpen || s.breaker.state === "open" ? "warn" : undefined} meta={`last reconcile ${s.lastReconcileAt ? s.lastReconcileAt.slice(11, 19) : "—"} · last tick ${s.lastAutomationRunAt ? s.lastAutomationRunAt.slice(11, 19) : "—"}`} />
      {book && <Tile label="US paper book (separate)" help={<HelpButton topic="trades.paper-book" />} value={fmtUsd(book.bankroll)} tone="info" meta={`start ${fmtUsd(book.bankrollStart)} · realized ${fmtUsd(book.realizedPnl)} · ${book.open} open · ${book.wins + book.losses + book.voids} settled · never summed with live`} />}
    </div>
  );
}

function AlertItem({ a, busy, onAck }: { a: TradingAlert; busy: boolean; onAck: () => void }) {
  const learn = useLearn();
  const action = alertNeedsAction(a.kind);
  const topic = alertTopic(a.kind);
  return (
    <div className={`alert-item${action ? " action" : ""}`} role={action ? "alert" : "status"}>
      <div className="body">
        <span className="kind">{a.kind.replace(/_/g, " ")}</span>
        <span className="lvl">{action ? "Action required" : "Informational"}</span>
        <span>{a.message}</span>
        <div className="meta">first {fmtStamp(a.firstAt, true)}{a.count > 1 ? ` · ×${a.count} (same incident seen again, not a new one)` : ""}{a.subject ? ` · ${a.subject}` : ""}</div>
      </div>
      <div className="actions">
        {topic && <button type="button" className="help-link" onClick={() => learn.open(topic.id)}><Icon name="question" size={13} />Explain</button>}
        <button type="button" disabled={busy} onClick={onAck}>Acknowledge</button>
      </div>
    </div>
  );
}

/** One hold, in three columns: what it means · what the app did · what only you can do — then the resolution controls. */
function HoldCard({ hold, intents, orders, busy, onResolve }: { hold: ReconciliationHold; intents: TradeIntent[]; orders: VenueOrderRecord[]; busy: boolean; onResolve: (fn: () => Promise<unknown>) => void }) {
  const [note, setNote] = useState("");
  const [pick, setPick] = useState("");
  const learn = useLearn();
  const topic = holdTopic(hold.kind, hold.subject);
  const intent = hold.kind === "submission_unknown" ? intents.find((i) => i.id === hold.subject) : undefined;
  const candidates = ((hold.detail.candidates as string[] | undefined) ?? []).map((id) => orders.find((o) => o.id === id) ?? ({ id } as VenueOrderRecord));
  const title = hold.subject?.startsWith("settlement:") ? "Contested settlement" : { submission_unknown: "Submission unknown", discrepancy: "Discrepancy", failed_cancel: "Failed cancel", stale_sync: "Stale sync", stream_gap: "Stream gap" }[hold.kind] ?? hold.kind;
  return (
    <div className="hold-card">
      <div className="head">
        <Tag kind="action" />
        <strong>{title}</strong>
        <span className="meta">opened {fmtStamp(hold.openedAt, true)}{hold.subject ? ` · ${hold.kind === "submission_unknown" ? "intent" : "subject"} ${hold.subject.slice(0, 24)}` : ""}</span>
        {topic && <button type="button" className="help-link" onClick={() => learn.open(topic.id)}><Icon name="bookOpenText" size={13} />Full reference</button>}
      </div>
      {topic && (
        <div className="hold-cols">
          <div><h6>What this means</h6><p>{topic.what}</p></div>
          <div><h6>What the app did</h6><p>{topic.doing}</p></div>
          <div><h6>What only you can do</h6><p>{topic.next}</p></div>
        </div>
      )}
      <div className="hold-resolve">
        {hold.kind === "submission_unknown" && intent ? (
          <div>
            <div className="small">Intent {intent.id.slice(0, 8)}: BUY {intent.side.toUpperCase()} {intent.quantity} at YES {intent.wirePrice} on {intent.venueMarketId} · reason: {intent.unknownReason ?? "—"}. {String(hold.detail.note ?? "")}</div>
            <div className="small muted" style={{ marginTop: 6 }}>Candidate venue orders that look like this submission ({candidates.length}):</div>
            <ul className="candidates">
              {candidates.length === 0 && <li className="muted small">none listed — press Reconcile with venue, then check the venue's order history.</li>}
              {candidates.map((c) => <li key={c.id}><label className="row tight"><input type="radio" name={`cand-${hold.id}`} value={c.id} checked={pick === c.id} onChange={() => setPick(c.id)} /> <code className="small">{c.id}</code> <span className="small">{c.side ?? "?"} {c.quantity ?? "?"} at {c.yesPrice ?? "?"} · {c.state ?? "?"} · {c.venueCreatedAt ?? ""}</span></label></li>)}
            </ul>
            <div className="row">
              <input type="text" placeholder="What you checked on the venue (required)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Resolution note" />
              <button type="button" disabled={busy || !pick || !note} onClick={() => onResolve(() => executionApi.resolveUnknown(intent.id, { venueOrderId: pick, note }))}>This order is mine</button>
              <button type="button" disabled={busy || !note} onClick={() => { if (window.confirm("Declare that the venue never created this order? Its reservation is released and the contract can be traded again. Only do this after checking the venue's order history.")) onResolve(() => executionApi.resolveUnknown(intent.id, { outcome: "not_submitted", note })); }}>Venue shows no order</button>
            </div>
          </div>
        ) : (
          <div>
            <details className="small"><summary>Detail recorded by the app</summary><pre className="prompt">{JSON.stringify(hold.detail, null, 2)}</pre></details>
            <div className="row" style={{ marginTop: 6 }}>
              <input type="text" placeholder="Resolution note — what you checked on the venue (required)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Resolution note" />
              <button type="button" disabled={busy || !note} onClick={() => onResolve(() => executionApi.resolveHold(hold.id, note))}>Resolve</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ExternalHoldings({ positions }: { positions: LivePosition[] }) {
  return (
    <div className="card">
      <div className="row space-between">
        <h3 style={{ margin: 0 }}>External holdings <Tag kind="informational" /> <HelpButton topic="trades.external-holdings" /></h3>
        <span className="meta">{positions.length} position{positions.length === 1 ? "" : "s"} this app did not place</span>
      </div>
      <p className="muted small">Positions on this account on markets where the app has no order of its own (hand-placed on the website, or older than the app). They count toward your exposure limits at the venue's cost basis and block app entry on the same contract; they are not discrepancies and never pause the account.</p>
      <div className="table-wrap">
        <table className="table"><thead><tr><th>Contract</th><th className="num">Venue net (+ long YES / − short)</th><th className="num">Venue cost basis</th><th>As of</th></tr></thead>
          <tbody>{positions.map((p) => <tr key={p.marketSlug}><td>{p.marketSlug}</td><td className="num">{p.venueNet ?? "—"}</td><td className="num">{p.venueCost ? fmtUsd(p.venueCost) : "unknown (counted at $1 per contract)"}</td><td className="small num">{fmtStamp(p.venueAt, true)}</td></tr>)}</tbody></table>
      </div>
    </div>
  );
}

/** DASH-02/04: one row per decision (skipped included) joined with its intent, order, position and settlement; external orders labelled. */
function LedgerView({ rows, filter, setFilter, onOpen, selectedId, runs }: { rows: (TradeLedgerRow | ExternalLedgerRow)[] | null; filter: TradeLedgerFilter; setFilter: (f: TradeLedgerFilter) => void; onOpen: (decisionId: string) => void; selectedId?: string; runs: AutomationRun[] }) {
  const set = (patch: Partial<TradeLedgerFilter>) => setFilter({ ...filter, ...patch });
  return (
    <div>
      <div className="row controls small">
        <label>From <input type="date" value={filter.from?.slice(0, 10) ?? ""} onChange={(e) => set({ from: e.target.value ? `${e.target.value}T00:00:00Z` : undefined })} /></label>
        <label>To <input type="date" value={filter.to?.slice(0, 10) ?? ""} onChange={(e) => set({ to: e.target.value ? `${e.target.value}T23:59:59Z` : undefined })} /></label>
        <label>Status <select value={filter.status ?? ""} onChange={(e) => set({ status: e.target.value || undefined })}>{LEDGER_STATUSES.map((s) => <option key={s} value={s}>{s || "all"}</option>)}</select></label>
        <label>Mode <select value={filter.mode ?? ""} onChange={(e) => set({ mode: (e.target.value || undefined) as TradingMode | undefined })}><option value="">all</option><option value="paper">paper</option><option value="manual_live">manual live</option><option value="auto_live">auto live</option></select></label>
        <label>Creator <input type="text" placeholder="channel id or name" value={filter.creator ?? ""} onChange={(e) => set({ creator: e.target.value || undefined })} /></label>
        <label>Category / event <input type="text" placeholder="sports, ev-…" value={filter.category ?? ""} onChange={(e) => set({ category: e.target.value || undefined })} /></label>
        <label>Reason code <input type="text" placeholder="OPPORTUNITY_CONSUMED" value={filter.reason ?? ""} onChange={(e) => set({ reason: e.target.value || undefined })} /></label>
        <a className="small" href={automationApi.ledgerCsvUrl(filter)} target="_blank" rel="noreferrer noopener">Export CSV</a>
        <a className="small" href={automationApi.ledgerJsonUrl(filter)} target="_blank" rel="noreferrer noopener">Export JSON</a>
        <HelpButton topic="trades.intent-states">Intent · order · position</HelpButton>
      </div>
      {rows === null ? <Skeleton rows={5} /> : rows.length === 0 ? <EmptyState title="No rows match.">Every evaluation — skipped ones included — appears here once a decision exists.</EmptyState> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Contract</th><th>Side · p</th><th>Price (cost / wire)</th><th>Requested</th><th>Filled</th><th>Fees</th><th>Order state</th><th>Position</th><th>Cutoff</th><th>Source</th><th>Outcome / reason</th></tr></thead>
            <tbody>
              {rows.map((r) => r.external ? (
                <tr key={`x-${r.venueOrderId}`} className="fs-not_applicable">
                  <td className="small num">{fmtStamp(r.firstSeenAt)}</td>
                  <td className="small">{r.marketSlug}</td>
                  <td>{r.side?.toUpperCase() ?? "?"}</td>
                  <td className="small num">{r.yesPrice ?? "?"} YES</td>
                  <td className="num">{r.quantity ?? "?"}</td>
                  <td className="num">{r.filledQuantity}</td>
                  <td className="num">{fmtUsd(r.fees)}</td>
                  <td><span className="chip">{r.orderState}</span></td>
                  <td className="small muted">—</td>
                  <td className="small muted">—</td>
                  <td><span className="chip">EXTERNAL</span></td>
                  <td className="small muted">not placed by this app — no rationale exists</td>
                </tr>
              ) : (
                <tr key={r.decisionId} className={selectedId === r.decisionId ? "selected" : r.intentState === "submission_unknown" ? "fs-incompatible" : ""} onClick={() => onOpen(r.decisionId)} style={{ cursor: "pointer" }}>
                  <td className="small num">{fmtStamp(r.clockAt)}<div className="muted">{r.mode}{r.submittedAt ? ` · sent ${r.submittedAt.slice(11, 19)}` : ""}</div></td>
                  <td className="small">{r.marketUrl ? <a href={r.marketUrl} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{r.question ?? r.marketSlug ?? r.venueMarketId}</a> : r.question ?? r.venueMarketId}{r.category && <div className="muted">{r.category}</div>}</td>
                  <td>{r.side ? <>{r.side.toUpperCase()} <span className="muted small">{r.sideLabel}</span><div className="small num">p {r.pChosen}</div></> : "—"}</td>
                  <td className="small num">{r.limitCost ? `${r.limitCost} / ${r.wirePrice}` : "—"}{r.avgFillPrice && <div className="muted">filled avg {r.avgFillPrice} YES</div>}</td>
                  <td className="small num">{r.requestedQuantity ? `${r.requestedQuantity} · ${fmtUsd(r.requestedBudget)}` : "—"}</td>
                  <td className="small num">{r.filledQuantity ? `${r.filledQuantity}${r.filledCost ? ` · ${fmtUsd(r.filledCost)}` : ""}` : "—"}</td>
                  <td className="num">{fmtUsd(r.fees)}</td>
                  <td>{r.intentState ? <><span className={`chip intent-${r.intentState}`} title={INTENT_HELP[r.intentState]}>{INTENT_LABEL[r.intentState] ?? r.intentState}</span>{r.orderState && <div className="muted small">venue: {r.orderState}{r.rejectReason ? ` · ${r.rejectReason}` : ""}</div>}</> : <span className="muted small">no order</span>}</td>
                  <td className="small">{r.positionState}{r.settlement && <div className="muted">{r.settlement.kind} {r.settlement.outcome ?? ""} {r.settlement.amount ? fmtUsd(r.settlement.amount) : ""}</div>}{r.mark && <div className={`muted ${r.mark.stale ? "warn" : ""}`}>mark {r.mark.price ?? "?"}{r.mark.stale ? " (stale)" : ""}{r.mark.unrealizedPnl ? ` · ${fmtUsd(r.mark.unrealizedPnl)}` : ""}</div>}</td>
                  <td className="small num">{r.cutoffAt ? fmtStamp(r.cutoffAt) : "—"}</td>
                  <td className="small">{r.creatorName ?? r.creatorKey ?? "—"}{r.timestampUrl && <div><a href={r.timestampUrl} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>quote ↗</a></div>}</td>
                  <td className="small"><span className={`chip outcome-${r.outcome}`}>{OUTCOME_LABEL[r.outcome]}</span>{r.reasonCodes.length > 0 && <div className="muted mono">{r.reasonCodes.join(", ")}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {runs.length > 0 && (
        <details className="small" style={{ marginTop: 10 }}>
          <summary>Automation runs (last {runs.length})</summary>
          <div className="table-wrap"><table className="table"><thead><tr><th>Started</th><th>Mode</th><th>Outcome</th><th>Candidates</th><th>Evaluated</th><th>Ordered</th><th>Skipped</th><th>Notes</th></tr></thead>
            <tbody>{runs.map((r) => <tr key={r.id}><td className="num">{fmtStamp(r.startedAt, true)}</td><td>{r.mode}</td><td>{r.outcome}{r.reason ? ` — ${r.reason}` : ""}</td><td className="num">{r.candidates}</td><td className="num">{r.evaluated}</td><td className="num">{r.ordered}</td><td>{Object.entries(r.skipped).map(([k, v]) => `${k} ×${v}`).join(", ") || "—"}</td><td className="muted">{r.notes.join(" · ")}</td></tr>)}</tbody></table></div>
        </details>
      )}
    </div>
  );
}

function DecisionDetail({ ev, onClose }: { ev: DecisionEvidence; onClose: () => void }) {
  const d = ev.decision;
  const f = ev.forecast;
  return (
    <div className="detail-inner">
      <div className="row space-between"><strong style={{ fontWeight: 500 }}>Why this decision? <HelpButton topic="trades.reason-codes" /></strong><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button></div>
      <p className="meta">Decision {d.id.slice(0, 8)} · clock {d.clockAt} · policy {d.policyVersion} ({d.policyHash?.slice(0, 12)}…) · rationale hash {d.rationaleHash.slice(0, 12)}… · {d.currency} · bucket {d.dailyBucket} ({d.budgetTimezone})</p>
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
      {ev.current && (
        <details className="small" open={ev.current.verificationChanged || ev.current.forecastChanged}>
          <summary>Current analysis (separate from the record above{ev.current.verificationChanged || ev.current.forecastChanged ? " — has changed since the decision" : ""})</summary>
          <p className="muted">As of {ev.current.asOf}{ev.current.predictionMissing ? " · the prediction has since been deleted (the record above stands)" : ` · prediction revision ${ev.current.predictionRevision ?? "?"}`}{ev.current.normalizedStatement ? ` · now reads: “${ev.current.normalizedStatement}”` : ""}</p>
          {ev.current.verification && <p>Contract verification now v{ev.current.verification.version}: <strong>{ev.current.verification.status}</strong> · cutoff {ev.current.verification.cutoffAt ?? "unknown"}</p>}
          {ev.current.forecast && <p>Latest forecast: pYes <strong>{ev.current.forecast.pYes}</strong> / pNo <strong>{ev.current.forecast.pNo}</strong> · {ev.current.forecast.status} · as of {ev.current.forecast.asOf}</p>}
          {!ev.current.verificationChanged && !ev.current.forecastChanged && <p className="muted">No newer verification or forecast exists.</p>}
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
      <p><Tag kind="money" /> <strong>Real order — confirm to send once.</strong> {left > 0 ? `This preview expires in ${left} s.` : "This preview has expired; request a new one."}</p>
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

function LiveSection({ intents, orders, positions, busy, onCancel }: { intents: TradeIntent[]; orders: VenueOrderRecord[]; positions: LivePosition[]; busy: boolean; onCancel: (intentId: string) => void }) {
  const external = orders.filter((o) => o.external && !o.id.startsWith("external:"));
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Live orders and positions <HelpButton topic="trades.intent-states" /> <span className="muted small">intent = what the app tried · order = what the venue says · position = what is held</span></h3>
      {intents.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Contract</th><th>Order</th><th>Intent state</th><th>Venue order</th><th>Filled</th><th>Avg (YES) / fees</th><th>Reservation</th><th></th></tr></thead>
            <tbody>
              {intents.map((i) => (
                <tr key={i.id} className={i.state === "submission_unknown" ? "fs-incompatible" : ""}>
                  <td className="small num">{fmtStamp(i.createdAt, true)}</td>
                  <td className="small">{i.venueMarketId}</td>
                  <td className="small">BUY {i.side.toUpperCase()} {i.quantity} @ YES {i.wirePrice} <span className="muted">(cost {i.limitCost})</span></td>
                  <td><span className={`chip intent-${i.state}`} title={INTENT_HELP[i.state]}>{INTENT_LABEL[i.state] ?? i.state}</span>{i.lastError && <div className="muted small">{i.lastError}</div>}{i.unknownReason && <div className="muted small">{i.unknownReason}</div>}</td>
                  <td className="small">{i.order ? <>{i.order.id} · {i.order.state}{i.order.rejectReason ? ` · ${i.order.rejectReason}` : ""}</> : <span className="muted">none</span>}</td>
                  <td className="num">{i.filledQuantity}/{i.quantity}</td>
                  <td className="small num">{i.order?.avgPrice ?? "—"} / {fmtUsd(i.order?.fees)}</td>
                  <td className="small">{i.reservationId.slice(0, 8)}</td>
                  <td>{i.order && ["pending", "open", "partial", "cancel_pending"].includes(i.order.state) && <button type="button" className="small" disabled={busy} onClick={() => onCancel(i.id)}>Cancel</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {external.length > 0 && (
        <details className="small" style={{ marginTop: 8 }}>
          <summary>{external.length} order(s) on this account not placed by this app (no rationale exists for them)</summary>
          <div className="table-wrap"><table className="table"><thead><tr><th>Venue id</th><th>Contract</th><th>Side</th><th>Qty</th><th>YES price</th><th>State</th><th>Filled</th><th>Created</th></tr></thead>
            <tbody>{external.map((o) => <tr key={o.id}><td>{o.id}</td><td>{o.marketSlug}</td><td>{o.side ?? "?"}</td><td className="num">{o.quantity ?? "?"}</td><td className="num">{o.yesPrice ?? "?"}</td><td>{o.state}</td><td className="num">{o.filledQuantity}</td><td className="num">{o.venueCreatedAt ?? "—"}</td></tr>)}</tbody></table></div>
        </details>
      )}
      {positions.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="table small">
            <thead><tr><th>Contract</th><th className="num">Venue net</th><th className="num">Ours (YES-denominated)</th><th>As of</th><th>Settled</th><th>Discrepancy</th></tr></thead>
            <tbody>{positions.map((p) => <tr key={p.marketSlug} className={p.discrepancy ? "fs-incompatible" : ""}><td>{p.marketSlug}</td><td className="num">{p.venueNet ?? "—"}</td><td className="num">{p.localNet}</td><td className="num">{fmtStamp(p.venueAt, true)}</td><td>{p.settled ? `${p.settled.outcome} · ${p.settled.at.slice(0, 10)}` : "open"}</td><td className="muted">{p.discrepancy ?? ""}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
