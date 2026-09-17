/**
 * Prediction Ledger — the Trades ledger, summary, CSV export and counters (1.14, DASH-01…05, OPS-04).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Read-only joins over what the other services wrote: one row per decision (skipped ones included) with its intent,
 * venue order, position state and official settlement; external orders as separately labelled rows with no
 * rationale. Live money figures come only from the venue's sync and official settlement events; paper figures come
 * from the paper books; nothing sums a paper, mana or international balance into a live USD total. A row keeps
 * rendering from the decision's own snapshot after its video or prediction is gone (paper lineage can be deleted;
 * live lineage cannot).
 */

import type { DecisionOutcome, ExternalLedgerRow, IntentState, OrderState, SettlementEventRecord, TradeLedgerFilter, TradeLedgerRow, TradingMetrics, TradingMode, TradingSummary } from "@prediction-ledger/shared";
import type { AppContext } from "../context.js";
import { D, Dec, dsum } from "../analysis/decimal.js";
import { chosenCostOf } from "../analysis/orderState.js";

/** A stored snapshot older than this is a stale mark (DASH-04). */
export const MARK_STALE_MS = 15 * 60_000;

interface LedgerJoinRow {
  id: string; clock_at: string; mode: TradingMode; outcome: DecisionOutcome; reason_codes_json: string; inputs_json: string; prediction_id: string; market_id: string; venue_market_id: string; event_id: string | null; verification_id: string | null;
  side: "yes" | "no" | null; side_label: string | null; p_chosen: string | null; quantity: string | null; limit_cost: string | null; wire_price: string | null; worst_cost: string | null; intent_id: string | null;
  p_quote: string | null; p_start_s: number | null; p_video_id: string | null; v_title: string | null; v_youtube_id: string | null; v_channel: string | null; v_channel_id: string | null;
  m_question: string | null; m_url: string | null; m_slug: string | null; m_constraints_json: string | null; m_resolved: number | null;
  i_state: IntentState | null; i_filled: string | null; i_order_id: string | null; i_submitted_at: string | null; i_acknowledged_at: string | null; i_mode: "paper" | "live" | null;
  o_state: OrderState | null; o_filled: string | null; o_avg: string | null; o_fees: string | null; o_reject: string | null;
  pp_status: string | null; pp_qty: string | null; pp_cost: string | null; pp_fees: string | null; pp_avg: string | null; pp_outcome: string | null; pp_pnl: string | null; pp_settled_at: string | null;
  cv_cutoff_at: string | null;
}

const LEDGER_SQL = `
  SELECT d.id, d.clock_at, d.mode, d.outcome, d.reason_codes_json, d.inputs_json, d.prediction_id, d.market_id, d.venue_market_id, d.event_id, d.verification_id,
         d.side, d.side_label, d.p_chosen, d.quantity, d.limit_cost, d.wire_price, d.worst_cost, d.intent_id,
         p.quote_exact AS p_quote, p.start_s AS p_start_s, p.video_id AS p_video_id, v.title AS v_title, v.youtube_id AS v_youtube_id, v.channel AS v_channel, v.channel_id AS v_channel_id,
         m.question AS m_question, m.url AS m_url, m.slug AS m_slug, m.constraints_json AS m_constraints_json, m.resolved AS m_resolved,
         i.state AS i_state, i.filled_quantity AS i_filled, i.venue_order_id AS i_order_id, i.submitted_at AS i_submitted_at, i.acknowledged_at AS i_acknowledged_at, i.mode AS i_mode,
         o.state AS o_state, o.filled_quantity AS o_filled, o.avg_price AS o_avg, o.fees AS o_fees, o.reject_reason AS o_reject,
         pp.status AS pp_status, pp.quantity AS pp_qty, pp.cost_total AS pp_cost, pp.fees AS pp_fees, pp.avg_cost AS pp_avg, pp.outcome AS pp_outcome, pp.pnl AS pp_pnl, pp.settled_at AS pp_settled_at,
         cv.cutoff_at AS cv_cutoff_at
  FROM trade_decisions d
  LEFT JOIN predictions p ON p.id = d.prediction_id
  LEFT JOIN videos v ON v.id = p.video_id
  LEFT JOIN markets m ON m.id = d.market_id
  LEFT JOIN trade_intents i ON i.id = d.intent_id
  LEFT JOIN venue_orders o ON o.id = i.venue_order_id
  LEFT JOIN paper_us_positions pp ON pp.intent_id = d.intent_id
  LEFT JOIN contract_verifications cv ON cv.id = d.verification_id`;

export class TradeLedgerService {
  constructor(private readonly ctx: AppContext, private readonly now: () => Date = () => new Date()) {}

  // ---- rows (DASH-02/04) -----------------------------------------------------------------------------

  rows(f: TradeLedgerFilter = {}): (TradeLedgerRow | ExternalLedgerRow)[] {
    const where: string[] = []; const args: unknown[] = [];
    if (f.from) { where.push("d.clock_at >= ?"); args.push(f.from); }
    if (f.to) { where.push("d.clock_at <= ?"); args.push(f.to); }
    if (f.mode) { where.push("d.mode = ?"); args.push(f.mode); }
    if (f.reason) { where.push("d.reason_codes_json LIKE ?"); args.push(`%"${f.reason}"%`); }
    if (f.creator) { where.push("(v.channel_id = ? OR v.channel = ?)"); args.push(f.creator, f.creator); }
    if (f.category) { where.push("(d.event_id = ? OR m.constraints_json LIKE ? OR m.slug LIKE ?)"); args.push(f.category, `%"category":"${f.category}"%`, `%${f.category}%`); }
    const limit = Math.min(f.limit ?? 500, 10_000);
    const rows = this.ctx.db.all<LedgerJoinRow>(`${LEDGER_SQL} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY d.clock_at DESC, d.rowid DESC LIMIT ?`, ...args, limit);
    const now = this.now().getTime();
    const settledByIntent = this.settlementsByIntent();
    const marks = new Map<string, { price?: string; at?: string }>();
    const out: (TradeLedgerRow | ExternalLedgerRow)[] = [];
    for (const r of rows) {
      const row = this.hydrate(r, now, settledByIntent, marks);
      if (f.status && !this.statusMatches(row, f.status)) continue;
      out.push(row);
    }
    if (f.includeExternal !== false) {
      for (const o of this.ctx.execution.orders({ external: true, limit: 500 })) {
        if (o.id.startsWith("external:")) continue;
        if (f.mode && f.mode !== "auto_live" && f.mode !== "manual_live") continue;
        if (f.from && o.firstSeenAt < f.from) continue;
        if (f.to && o.firstSeenAt > f.to) continue;
        if (f.creator || f.reason) continue;
        if (f.status && f.status !== "external") continue;
        out.push({ external: true, venueOrderId: o.id, marketSlug: o.marketSlug, side: o.side, quantity: o.quantity, filledQuantity: o.filledQuantity, yesPrice: o.yesPrice, avgPrice: o.avgPrice, fees: o.fees, orderState: o.state, venueCreatedAt: o.venueCreatedAt, firstSeenAt: o.firstSeenAt });
      }
    }
    return out;
  }

  private statusMatches(row: TradeLedgerRow | ExternalLedgerRow, status: string): boolean {
    if (row.external) return status === "external";
    switch (status) {
      case "skipped": return row.outcome === "skipped";
      case "needs_review": return row.outcome === "needs_review" && !row.intentId;
      case "eligible": return row.outcome === "eligible";
      case "unknown": return row.intentState === "submission_unknown";
      case "pending": return row.intentState === "reserved" || row.intentState === "submitting" || row.intentState === "acknowledged";
      case "partial": return row.intentState === "partially_filled";
      case "filled": return row.intentState === "filled";
      case "rejected": return row.intentState === "rejected" || row.intentState === "rejected_local";
      case "canceled": return row.intentState === "canceled" || row.intentState === "expired";
      case "open": return row.positionState === "open";
      case "settled": return row.positionState === "settled";
      default: return row.intentState === status || row.outcome === status;
    }
  }

  private settlementsByIntent(): Map<string, SettlementEventRecord> {
    const map = new Map<string, SettlementEventRecord>();
    for (const e of this.ctx.execution.settlements(5000)) if (e.intentId && !map.has(e.intentId)) map.set(e.intentId, e); // newest first
    return map;
  }

  private markFor(marketId: string, marks: Map<string, { price?: string; at?: string }>): { price?: string; at?: string } {
    const cached = marks.get(marketId);
    if (cached) return cached;
    const snap = this.ctx.markets.latestSnapshot(marketId);
    const yes = snap?.prices.find((p) => /^yes$/i.test(p.label))?.price ?? snap?.prices[0]?.price;
    const m = { price: yes !== undefined ? D(yes.toFixed(4)).toString() : undefined, at: snap?.retrievedAt };
    marks.set(marketId, m);
    return m;
  }

  private hydrate(r: LedgerJoinRow, nowMs: number, settled: Map<string, SettlementEventRecord>, marks: Map<string, { price?: string; at?: string }>): TradeLedgerRow {
    const inputs = JSON.parse(r.inputs_json) as { deadlineAt?: string; question?: string; contract?: { venueMarketId?: string } };
    const constraints = r.m_constraints_json ? (JSON.parse(r.m_constraints_json) as { category?: string; slug?: string }) : undefined;
    const live = r.i_mode === "live";
    const filledQuantity = live ? (r.o_filled ?? r.i_filled ?? undefined) : r.pp_qty ?? r.i_filled ?? undefined;
    const avg = live ? r.o_avg ?? undefined : r.pp_avg ?? undefined;
    const fees = live ? r.o_fees ?? undefined : r.pp_fees ?? undefined;
    const filledCost = live && filledQuantity && avg && r.side ? D(chosenCostOf(r.side, avg)).mul(filledQuantity).toString() : r.pp_cost ?? undefined;
    const settlement = r.intent_id ? settled.get(r.intent_id) : undefined;
    let positionState: TradeLedgerRow["positionState"] = "none";
    if (r.i_state === "submission_unknown") positionState = "unknown";
    else if (live) positionState = settlement ? "settled" : filledQuantity && D(filledQuantity).isPos() ? "open" : "none";
    else if (r.pp_status) positionState = r.pp_status === "open" ? "open" : "settled";
    const mark = this.markFor(r.market_id, marks);
    const markStale = !mark.at || nowMs - Date.parse(mark.at) > MARK_STALE_MS;
    let unrealized: string | undefined;
    if (positionState === "open" && mark.price && filledQuantity && filledCost && r.side) {
      const chosenMark = chosenCostOf(r.side, mark.price);
      unrealized = D(chosenMark).mul(filledQuantity).sub(filledCost).sub(fees ?? "0").toString();
    }
    return {
      decisionId: r.id, clockAt: r.clock_at, mode: r.mode, outcome: r.outcome, reasonCodes: JSON.parse(r.reason_codes_json) as string[],
      predictionId: r.prediction_id, creatorKey: r.v_channel_id ?? r.v_channel ?? undefined, creatorName: r.v_channel ?? undefined, videoId: r.p_video_id ?? undefined, videoTitle: r.v_title ?? undefined,
      quote: r.p_quote ?? undefined, timestampUrl: r.v_youtube_id ? `https://www.youtube.com/watch?v=${r.v_youtube_id}${r.p_start_s !== null && r.p_start_s !== undefined ? `&t=${Math.max(0, Math.floor(r.p_start_s))}s` : ""}` : undefined,
      marketId: r.market_id, venueMarketId: r.venue_market_id, marketSlug: constraints?.slug ?? r.m_slug ?? undefined, marketUrl: r.m_url ?? undefined, question: r.m_question ?? inputs.question ?? undefined, category: constraints?.category ?? undefined, eventId: r.event_id ?? undefined,
      cutoffAt: r.cv_cutoff_at ?? inputs.deadlineAt ?? undefined,
      side: r.side ?? undefined, sideLabel: r.side_label ?? undefined, pChosen: r.p_chosen ?? undefined, limitCost: r.limit_cost ?? undefined, wirePrice: r.wire_price ?? undefined,
      requestedQuantity: r.quantity ?? undefined, requestedBudget: r.worst_cost ?? undefined, filledQuantity, filledCost, avgFillPrice: avg, fees,
      intentId: r.intent_id ?? undefined, intentState: r.i_state ?? undefined, venueOrderId: r.i_order_id ?? undefined, orderState: r.o_state ?? undefined, rejectReason: r.o_reject ?? undefined,
      submittedAt: r.i_submitted_at ?? undefined, acknowledgedAt: r.i_acknowledged_at ?? undefined,
      positionState,
      settlement: settlement ? { kind: settlement.kind, outcome: settlement.outcome, amount: settlement.amount, at: settlement.observedAt } : r.pp_status && r.pp_status !== "open" ? { kind: r.pp_outcome === "void" || r.pp_status === "void" ? "void" : "resolved", outcome: r.pp_outcome ?? undefined, amount: r.pp_pnl ?? undefined, at: r.pp_settled_at ?? r.clock_at } : undefined,
      mark: positionState === "open" ? { price: mark.price, at: mark.at, stale: markStale, unrealizedPnl: unrealized } : undefined,
      external: false,
    };
  }

  // ---- summary (DASH-01) -----------------------------------------------------------------------------

  summary(): TradingSummary {
    const st = this.ctx.trading.status();
    const policy = st.policy;
    const binding = st.binding;
    const nowMs = this.now().getTime();
    const usd = st.latestSync?.ok ? st.latestSync.balances.find((b) => b.currency === "USD") : undefined;
    const live = binding ? this.ctx.risk.exposure(binding.id, this.now().toISOString().slice(0, 10)) : undefined;
    const settlements = binding ? this.ctx.execution.settlements(5000).filter((e) => e.bindingId === binding.id && e.intentId && e.amount) : [];
    const realized = dsum(settlements.map((e) => D(e.amount!)));
    const orders = binding ? this.ctx.execution.orders({ bindingId: binding.id, external: false, limit: 5000 }) : [];
    const fees = dsum(orders.map((o) => D(o.fees ?? "0")));
    const positions = binding ? this.ctx.execution.positions(binding.id).filter((p) => !p.settled && !D(p.localNet).isZero()) : [];
    // Marked unrealized P&L over open live positions from the latest stored snapshot of each market (stale when old).
    let unrealized = Dec.ZERO; let markAt: string | undefined; let markStale = false; let marked = 0;
    for (const p of positions) {
      const m = p.venueMarketId ? this.ctx.markets.findByVenue("polymarket_us", p.venueMarketId) : undefined;
      const snap = m ? this.ctx.markets.latestSnapshot(m.id) : undefined;
      const yes = snap?.prices.find((x) => /^yes$/i.test(x.label))?.price ?? snap?.prices[0]?.price;
      if (yes === undefined || !snap) { markStale = true; continue; }
      const net = D(p.localNet);
      const cost = dsum(orders.filter((o) => p.intentIds.includes(o.intentId ?? "") && o.avgPrice && o.side).map((o) => D(chosenCostOf(o.side!, o.avgPrice!)).mul(o.filledQuantity).add(o.fees ?? "0")));
      const value = net.isNeg() ? D(chosenCostOf("no", D(yes.toFixed(4)).toString())).mul(net.neg()) : D(yes.toFixed(4)).mul(net);
      unrealized = unrealized.add(value.sub(cost));
      marked++;
      if (!markAt || snap.retrievedAt > markAt) markAt = snap.retrievedAt;
      if (nowMs - Date.parse(snap.retrievedAt) > MARK_STALE_MS) markStale = true;
    }
    const liveIntents = binding ? this.ctx.execution.intents({ bindingId: binding.id, mode: "live", limit: 5000 }) : [];
    const lastReconcile = this.ctx.trading.auditEvents(500).find((e) => e.kind === "reconcile.completed")?.at;
    const lastRun = this.ctx.db.get<{ started_at: string }>("SELECT started_at FROM automation_runs ORDER BY started_at DESC LIMIT 1")?.started_at;
    return {
      mode: policy.mode, armed: st.armed, armedKind: st.armed ? (policy.mode === "auto_live" ? "auto" : "manual") : undefined, paused: policy.pauseReason,
      account: binding ? { bindingId: binding.id, keyIdHint: binding.keyIdHint, state: binding.state } : undefined,
      buyingPower: usd?.buyingPower?.value, currentBalance: usd?.currentBalance?.value, syncAt: st.latestSync?.ok ? st.latestSync.at : undefined, syncAgeSeconds: st.syncAgeSeconds, stale: st.stale,
      committed: live ? live.openRiskTotal : "0", realizedPnl: realized.toString(), fees: fees.toString(),
      unrealizedPnl: marked > 0 ? unrealized.toString() : undefined, markAt, markStale: positions.length > 0 && (markStale || marked < positions.length),
      openPositions: positions.length, openIntents: liveIntents.filter((i) => ["reserved", "submitting", "acknowledged"].includes(i.state)).length, unknownIntents: liveIntents.filter((i) => i.state === "submission_unknown").length,
      holdsOpen: binding ? this.ctx.execution.holds(binding.id, true).length : 0, alertsOpen: this.ctx.tradingAlerts.openCount(), breaker: st.breaker, lease: this.ctx.lease.status(), stream: this.ctx.execution.streamState,
      lastReconcileAt: lastReconcile, lastAutomationRunAt: lastRun,
    };
  }

  // ---- counters (OPS-04) -----------------------------------------------------------------------------

  metrics(): TradingMetrics {
    const n = (sql: string, ...args: unknown[]) => this.ctx.db.get<{ n: number }>(sql, ...args)?.n ?? 0;
    const lastReconcile = this.ctx.trading.auditEvents(500).find((e) => e.kind === "reconcile.completed")?.at;
    const lastRun = this.ctx.db.get<{ started_at: string }>("SELECT started_at FROM automation_runs ORDER BY started_at DESC LIMIT 1")?.started_at;
    return {
      at: this.now().toISOString(),
      decisions: n("SELECT COUNT(*) AS n FROM trade_decisions"),
      noTrades: n("SELECT COUNT(*) AS n FROM trade_decisions WHERE outcome = 'skipped'"),
      intents: n("SELECT COUNT(*) AS n FROM trade_intents"),
      liveIntents: n("SELECT COUNT(*) AS n FROM trade_intents WHERE mode = 'live'"),
      readRetries: this.ctx.execution.counters.readRetries,
      unknownSubmissions: n("SELECT COUNT(*) AS n FROM trade_intents WHERE state = 'submission_unknown'"),
      fills: n("SELECT COUNT(*) AS n FROM executions WHERE type IN ('fill','partial_fill')"),
      droppedDuplicateEvents: this.ctx.execution.counters.droppedDuplicates,
      reconciliationLagSeconds: lastReconcile ? Math.max(0, Math.round((this.now().getTime() - Date.parse(lastReconcile)) / 1000)) : undefined,
      lastReconcileAt: lastReconcile,
      automationRuns: n("SELECT COUNT(*) AS n FROM automation_runs"),
      lastAutomationRunAt: lastRun,
      alertsOpen: this.ctx.tradingAlerts.openCount(),
      breaker: this.ctx.trading.breaker(),
    };
  }

  // ---- CSV (DASH-05) ---------------------------------------------------------------------------------

  csv(rows: (TradeLedgerRow | ExternalLedgerRow)[]): string {
    const cols = ["kind", "decision_id", "clock_at", "mode", "outcome", "reason_codes", "creator", "video", "quote", "timestamp_url", "market", "question", "category", "cutoff_at", "side", "side_label", "p_chosen", "limit_cost", "wire_price", "requested_quantity", "requested_budget", "filled_quantity", "filled_cost", "avg_fill_price", "fees", "intent_id", "intent_state", "venue_order_id", "order_state", "reject_reason", "submitted_at", "acknowledged_at", "position_state", "settlement_kind", "settlement_outcome", "settlement_amount", "settlement_at", "mark_price", "mark_at", "mark_stale", "unrealized_pnl"];
    const esc = (v: unknown) => { const s = v === undefined || v === null ? "" : Array.isArray(v) ? v.join("|") : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [cols.join(",")];
    for (const r of rows) {
      if (r.external) {
        lines.push([ "external", "", r.firstSeenAt, "", "", "", "", "", "", "", r.marketSlug, "", "", "", r.side ?? "", "", "", "", r.yesPrice ?? "", r.quantity ?? "", "", r.filledQuantity, "", r.avgPrice ?? "", r.fees ?? "", "", "", r.venueOrderId, r.orderState, "", r.venueCreatedAt ?? "", "", "", "", "", "", "", "", "", "", "" ].map(esc).join(","));
        continue;
      }
      lines.push([ "decision", r.decisionId, r.clockAt, r.mode, r.outcome, r.reasonCodes, r.creatorName ?? r.creatorKey, r.videoTitle, r.quote, r.timestampUrl, r.marketSlug ?? r.venueMarketId, r.question, r.category, r.cutoffAt, r.side, r.sideLabel, r.pChosen, r.limitCost, r.wirePrice, r.requestedQuantity, r.requestedBudget, r.filledQuantity, r.filledCost, r.avgFillPrice, r.fees, r.intentId, r.intentState, r.venueOrderId, r.orderState, r.rejectReason, r.submittedAt, r.acknowledgedAt, r.positionState, r.settlement?.kind, r.settlement?.outcome, r.settlement?.amount, r.settlement?.at, r.mark?.price, r.mark?.at, r.mark ? String(r.mark.stale) : "", r.mark?.unrealizedPnl ].map(esc).join(","));
    }
    return lines.join("\n") + "\n";
  }
}
