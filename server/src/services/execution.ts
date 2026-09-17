/**
 * Prediction Ledger — manual-live execution: preview → confirm → dispatch → reconcile → settle (1.13, EXE-01…08, OPS-03).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * The only code that calls the adapter's order methods. The shape of a submission, in order:
 *   preview   — read-only venue preview bound to one immutable decision hash; expires in 60 s.
 *   submit    — re-decides with a fresh book and account (a changed price, policy or account → `preview_stale`);
 *               T1: intent + reservation + the contract's single entry opportunity, one transaction;
 *               T2: the `submitting` marker, only while this process holds the dispatch lease and the policy is still
 *                   live and authorized — committed BEFORE the POST;
 *               POST: one attempt, never retried by anything. An id is acceptance, not a fill.
 *               ambiguous failure (timeout / reset / 5xx / crash after the marker) → `submission_unknown`, the
 *               reservation is kept, the account is paused and a hold is opened. Nothing resends.
 *   stream    — executions arrive on the private stream; REST reconciliation runs at startup, after every reconnect
 *               and on demand; executions are unique by execution id and trade id; order states only move forward.
 *   reconcile — unknown submissions get candidate orders listed for the owner, never auto-linked; local fills are
 *               compared with the venue's positions; a mismatch opens a discrepancy hold.
 *   settle    — only official account activity (position resolutions) settles a live position.
 * Fault-injection points (`faults.at(...)`) exist so crash drills run against this exact code path.
 */

import crypto from "node:crypto";
import { CANCEL_ALL_ACKNOWLEDGEMENT, type EmergencyStopResult, type ExecutionRecord, type IntentState, type LivePosition, type MarketProviderId, type OrderPreviewRecord, type OrderState, type ReconciliationHold, type SettlementEventRecord, type TradeIntent, type VenueOrderRecord } from "@prediction-ledger/shared";
import type { AppContext } from "../context.js";
import { D, Dec, dsum } from "../analysis/decimal.js";
import { LIVE_INTENT_STATES, TERMINAL_ORDER_STATES, chosenCostOf, intentStateFor, mergeFilled, mergeOrderState, toVenueCreateBody, signedFilledQuantity } from "../analysis/orderState.js";
import { decide, type DecisionBook, type DecisionInput } from "../analysis/tradeDecision.js";
import { rulesHash } from "../analysis/contractVerification.js";
import type { ActivityRecord, OrderRequest, PrivateStreamHandle, VenueExecution, VenueOrder } from "../providers/trading/types.js";
import { TradingAdapterError } from "../providers/trading/types.js";

export type FaultPoint = "before_reserve" | "after_reserve" | "after_marker" | "after_post";
export interface FaultInjector { at(point: FaultPoint): void }

export class ExecutionError extends Error {
  constructor(message: string, public readonly code: string, public readonly httpStatus = 409, public readonly detail?: unknown) { super(message); this.name = "ExecutionError"; }
}

interface IntentRow {
  id: string; decision_id: string; reservation_id: string; mode: "paper" | "live"; account_key: string; provider: TradeIntent["provider"]; venue_market_id: string; side: "yes" | "no"; side_id: string | null; quantity: string; wire_price: string; limit_cost: string;
  time_in_force: "IOC"; state: IntentState; payload_hash: string; filled_quantity: string; dispatch_marker_at: string | null; created_at: string; updated_at: string; binding_id: string | null; venue_order_id: string | null; preview_id: string | null; decision_hash: string | null;
  submitted_at: string | null; acknowledged_at: string | null; unknown_reason: string | null; last_error: string | null; market_slug: string | null;
}
interface OrderRow {
  id: string; binding_id: string; intent_id: string | null; external: number; market_slug: string; venue_market_id: string | null; side: "yes" | "no" | null; intent_raw: string | null; state_raw: string | null; state: OrderState; quantity: string | null; filled_quantity: string; leaves_quantity: string | null;
  yes_price: string | null; avg_price: string | null; fees: string | null; venue_created_at: string | null; updated_at: string; first_seen_at: string; cancel_requested_at: string | null; reject_reason: string | null; raw_json: string | null;
}
interface ExecutionRow { id: string; order_id: string; intent_id: string | null; trade_id: string | null; type: ExecutionRecord["type"]; quantity: string | null; yes_price: string | null; chosen_cost: string | null; fee: string | null; at: string | null; source: ExecutionRecord["source"]; note: string | null; received_at: string }
interface PreviewRow { id: string; decision_id: string; decision_hash: string; binding_id: string; request_json: string; venue_json: string | null; display_json: string; expires_at: string; created_at: string; consumed_at: string | null; consumed_by: OrderPreviewRecord["consumedBy"] | null }
interface HoldRow { id: string; binding_id: string; kind: ReconciliationHold["kind"]; subject: string | null; detail_json: string; opened_at: string; resolved_at: string | null; resolution: string | null }

export interface ReconcileReport {
  bindingId: string;
  syncedAt: string;
  ordersChecked: number;
  executionsAdded: number;
  activitiesRead: number;
  settlements: number;
  unknownIntents: { intentId: string; candidates: string[] }[];
  discrepancies: { marketSlug: string; venueNet: string; localNet: string }[];
  holdsOpen: number;
  paused: boolean;
  /** 2.0.0-rc.2: positions the app did not place (listed, counted, never a hold) and holds reclassified this run. */
  externalHoldings?: number;
  reclassifiedHolds?: number;
}

const PREVIEW_TTL_MS = 60_000;
const CANDIDATE_WINDOW_MS = 120_000;
/** The emergency stop waits at most this long for a POST already in flight (the adapter's own timeout is 20 s). */
const IN_FLIGHT_WAIT_MS = 25_000;
const MAX_ACTIVITY_PAGES = 200;

export class ExecutionService {
  private readonly now: () => Date;
  faults?: FaultInjector;
  private stream?: PrivateStreamHandle;
  private streamBinding?: string;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelayMs = 2_000;
  streamState: "closed" | "connecting" | "open" | "reconnecting" = "closed";
  /** OPS-04 counters (process lifetime; the durable ones are derived from tables in the ledger service). */
  readonly counters = { readRetries: 0, droppedDuplicates: 0, streamEvents: 0 };
  /** Dispatches whose POST is in flight (2.0, RV-13): the emergency stop waits for them before its sweep. */
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly ctx: AppContext, opts: { now?: () => Date; faults?: FaultInjector } = {}) {
    this.now = opts.now ?? (() => new Date());
    this.faults = opts.faults;
  }

  // ---- preview (EXE-02) ---------------------------------------------------------------------------------

  async preview(decisionId: string, o: { now?: string; book?: DecisionBook; origin?: "owner" | "scheduler" } = {}): Promise<OrderPreviewRecord> {
    const { decision, binding } = this.liveGate(decisionId);
    // RV-03: the instant is taken after the fresh book and account state were gathered (unless the caller pinned it).
    const fresh = await this.redecide(decision.id, o.now, o.book);
    const now = fresh.now;
    if (fresh.result.outcome === "skipped") throw new ExecutionError(`The decision no longer passes its gates: ${fresh.result.reasonCodes.join(", ")}.`, "decision_not_eligible", 409, fresh.result.reasonCodes);
    if (!fresh.sameSizing) throw new ExecutionError("Price or account state changed since the decision was made; evaluate a new decision.", "decision_changed", 409, fresh.diff);
    // RV-09: the venue's manual/automatic indicator follows who sends the order, not the mode the decision was made in.
    const origin = o.origin ?? "owner";
    const req = this.requestFor(decision, fresh.marketSlug, origin === "owner");
    const venue = await this.ctx.trading.withCredentials((creds, adapter) => adapter.previewOrder(creds, req));
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.parse(now) + PREVIEW_TTL_MS).toISOString();
    const s = decision.sizing!;
    const display: OrderPreviewRecord["display"] = {
      side: s.side, sideLabel: s.sideLabel, pChosen: s.pChosen, netEdge: s.netEdge, quantity: s.quantity, chosenCost: s.limitCost, yesWirePrice: s.wirePrice, worstCost: s.worstCost, feeBound: s.feeBound, estimatedEv: s.estimatedEv,
      deadlineAt: (decision.inputs.deadlineAt as string | undefined) ?? undefined, policyHash: decision.policyHash, question: decision.question, marketUrl: decision.marketUrl, evidenceUrl: `/api/trading/decisions/${decision.id}/evidence`, origin,
    };
    this.ctx.db.run(
      "INSERT INTO order_previews (id, decision_id, decision_hash, binding_id, request_json, venue_json, display_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, decision.id, decision.rationaleHash, binding.id, JSON.stringify(toVenueCreateBody(req)), JSON.stringify(venue.raw ?? null), JSON.stringify(display), expiresAt, now,
    );
    this.ctx.trading.audit("order.previewed", binding.id, { previewId: id, decisionId: decision.id, decisionHash: decision.rationaleHash, side: s.side, quantity: s.quantity, yesWirePrice: s.wirePrice, worstCost: s.worstCost, expiresAt });
    return this.getPreview(id)!;
  }

  getPreview(id: string): OrderPreviewRecord | undefined {
    const r = this.ctx.db.get<PreviewRow>("SELECT * FROM order_previews WHERE id = ?", id);
    return r ? hydratePreview(r) : undefined;
  }

  // ---- submit (EXE-03 / EXE-04) --------------------------------------------------------------------------

  async submit(previewId: string, o: { decisionHash: string; now?: string; book?: DecisionBook }): Promise<TradeIntent> {
    let now = o.now ?? this.now().toISOString();
    const preview = this.getPreview(previewId);
    if (!preview) throw new ExecutionError("Preview not found.", "not_found", 404);
    // Idempotent re-entry (E04/E05): the same contract can only ever have one live intent per account, and a repeat
    // of a confirmation returns that intent — even while the account is paused for it — instead of a second send.
    const decision0 = this.ctx.decisions.get(preview.decisionId);
    const market0 = decision0 ? this.ctx.markets.get(decision0.marketId) : undefined;
    const binding0 = this.ctx.trading.connected();
    if (decision0 && market0 && binding0 && preview.decisionHash === decision0.rationaleHash && o.decisionHash === decision0.rationaleHash) {
      const existing = this.liveIntentFor(binding0.id, market0.provider, market0.venueId);
      if (existing && existing.previewId === preview.id) return existing;
    }
    const { decision, binding, market, policy } = this.liveGate(preview.decisionId);
    if (preview.decisionHash !== decision.rationaleHash || o.decisionHash !== decision.rationaleHash) throw new ExecutionError("The confirmation does not reference this decision's immutable hash.", "hash_mismatch", 409);
    const existing = this.liveIntentFor(binding.id, market.provider, market.venueId);
    if (existing) return existing;
    if (preview.consumedAt) throw new ExecutionError(`Preview already ${preview.consumedBy}; request a new preview.`, "preview_consumed", 409);
    if (Date.parse(preview.expiresAt) <= Date.parse(now)) { this.consumePreview(preview.id, "expired", now); throw new ExecutionError("Preview expired; request a new preview.", "preview_expired", 409); }
    if (preview.display.policyHash && preview.display.policyHash !== policy.policyHash) { this.consumePreview(preview.id, "stale", now); throw new ExecutionError("Policy changed since the preview; evaluate a new decision.", "preview_stale", 409); }
    // Fresh inputs (E02): a changed price, evidence, policy or account state invalidates the preview.
    const fresh = await this.redecide(decision.id, o.now, o.book);
    now = fresh.now;
    if (fresh.result.outcome === "skipped" || !fresh.sameSizing) {
      this.consumePreview(preview.id, "stale", now);
      throw new ExecutionError(`Inputs changed since the preview (${fresh.result.outcome === "skipped" ? fresh.result.reasonCodes.join(", ") : "sizing differs"}); evaluate a new decision and preview again.`, "preview_stale", 409, fresh.diff);
    }
    const req = this.requestFor(decision, fresh.marketSlug, preview.display.origin !== "scheduler");
    const s = decision.sizing!;
    this.faults?.at("before_reserve");

    // T1: intent + reservation + opportunity, atomically — with the caps re-checked inside the transaction (RSK-05).
    const intentId = crypto.randomUUID();
    try {
      this.ctx.db.transaction(() => {
        const again = fresh.recheck();
        if (again.result.outcome === "skipped" || !again.sameSizing) {
          this.consumePreview(preview.id, "stale", now);
          throw new ExecutionError(`Capacity changed while confirming (${again.result.outcome === "skipped" ? again.result.reasonCodes.join(", ") : "sizing differs"}); evaluate a new decision and preview again.`, "preview_stale", 409, again.diff);
        }
        const res = this.ctx.risk.insert({ decisionId: decision.id, accountKey: binding.id, provider: market.provider, venueMarketId: market.venueId, eventId: decision.eventId, amount: s.worstCost, dailyBucket: decision.dailyBucket, now, note: `live: ${s.quantity} × ${s.limitCost} + fees ${s.feeBound}` });
        this.ctx.db.run(
          "INSERT INTO trade_intents (id, decision_id, reservation_id, mode, account_key, provider, venue_market_id, side, side_id, quantity, wire_price, limit_cost, time_in_force, state, payload_hash, created_at, updated_at, binding_id, preview_id, decision_hash, market_slug) VALUES (?, ?, ?, 'live', ?, ?, ?, ?, ?, ?, ?, ?, 'IOC', 'reserved', ?, ?, ?, ?, ?, ?, ?)",
          intentId, decision.id, res.id, binding.id, market.provider, market.venueId, s.side, s.sideId ?? null, s.quantity, s.wirePrice, s.limitCost, crypto.createHash("sha256").update(JSON.stringify(toVenueCreateBody(req))).digest("hex"), now, now, binding.id, preview.id, decision.rationaleHash, req.marketSlug,
        );
        this.ctx.risk.consumeOpportunity(binding.id, market.provider, market.venueId, intentId, now);
        this.consumePreview(preview.id, "submit", now);
        this.ctx.db.run("UPDATE trade_decisions SET reservation_id = ?, intent_id = ? WHERE id = ?", res.id, intentId, decision.id);
      });
    } catch (err) {
      if (err instanceof ExecutionError && err.code === "preview_stale") {
        // The transaction rolled back the recheck's own writes; record the consumed preview outside it.
        this.consumePreview(preview.id, "stale", now);
        throw err;
      }
      if (/UNIQUE|PRIMARY KEY|constraint/i.test((err as Error).message)) {
        const dup = this.liveIntentFor(binding.id, market.provider, market.venueId) ?? this.intentForOpportunity(binding.id, market.provider, market.venueId);
        if (dup) return dup;
      }
      throw err;
    }
    this.faults?.at("after_reserve");
    return this.dispatch(intentId, req, now);
  }

  /** T2 (marker) → POST → T3. Split from submit so recovery and tests can reason about each commit point. */
  private async dispatch(intentId: string, req: OrderRequest, now: string): Promise<TradeIntent> {
    const binding = this.ctx.trading.connected();
    // T2: the marker. Lease, live mode and authorization are re-read inside this transaction (OPS-03 / disarm serialization).
    const marked = this.ctx.db.transaction(() => {
      const p = this.ctx.trading.policy();
      const live = (p.mode === "manual_live" || p.mode === "auto_live") && !!p.liveAuthorizedAt;
      const blockers = this.ctx.trading.dispatchBlockers();
      if (!live || !this.ctx.lease.held() || blockers.length || !binding) {
        const reason = !live ? "disarmed before dispatch" : !this.ctx.lease.held() ? "dispatch lease not held by this process" : blockers.join("; ");
        this.finishUnsent(intentId, "rejected_local", reason, now);
        return { ok: false as const, reason };
      }
      // RV-02: the marker must actually move THIS row from `reserved`; if another process expired or recovered it meanwhile, nothing is sent.
      const changed = Number(this.ctx.db.run("UPDATE trade_intents SET state = 'submitting', dispatch_marker_at = ?, submitted_at = ?, updated_at = ? WHERE id = ? AND state = 'reserved'", now, now, now, intentId).changes);
      if (changed !== 1) return { ok: false as const, reason: "intent is no longer reserved (recovered or expired by another process)" };
      return { ok: true as const };
    });
    if (!marked.ok) throw new ExecutionError(`Not sent: ${marked.reason}.`, "dispatch_blocked", 409);
    this.ctx.trading.audit("order.submitting", binding!.id, { intentId, marketSlug: req.marketSlug, side: req.side, quantity: req.quantity, yesWirePrice: req.yesPrice });
    this.faults?.at("after_marker");

    // POST: exactly one attempt. The adapter's own request timeout bounds it; a timeout is ambiguous, never a retry.
    const post = this.createOnce(req);
    this.inFlight.add(post);
    let result: Awaited<typeof post>;
    try { result = await post; } finally { this.inFlight.delete(post); }
    this.faults?.at("after_post");
    const at = this.now().toISOString();
    if (result.kind === "created") {
      const before = this.ctx.db.get<{ state: string }>("SELECT state FROM trade_intents WHERE id = ?", intentId)?.state;
      this.ctx.db.transaction(() => {
        // RV-02: only a `submitting` (or a meanwhile-recovered `submission_unknown`) intent becomes acknowledged; the venue's answer settles the identity question.
        this.ctx.db.run("UPDATE trade_intents SET state = 'acknowledged', venue_order_id = ?, acknowledged_at = ?, unknown_reason = NULL, updated_at = ? WHERE id = ? AND state IN ('submitting','submission_unknown')", result.orderId, at, at, intentId);
        this.upsertOrder(binding!.id, { id: result.orderId, marketSlug: req.marketSlug, side: req.side, state: "pending", filledQuantity: "0", quantity: req.quantity, yesPrice: req.yesPrice, createTime: at }, "rest", { intentId });
        this.ctx.db.run("UPDATE risk_reservations SET acknowledged = 1, updated_at = ? WHERE id = (SELECT reservation_id FROM trade_intents WHERE id = ?)", at, intentId);
        for (const ex of result.executions) this.applyExecution(binding!.id, ex, "create_response");
        if (before === "submission_unknown") {
          const hold = this.openHoldFor(binding!.id, "submission_unknown", intentId);
          if (hold) this.ctx.db.run("UPDATE reconciliation_holds SET resolved_at = ?, resolution = ? WHERE id = ?", at, `venue answered the original POST with order ${result.orderId} (recovered by another process while in flight)`, hold.id);
        }
      });
      this.ctx.trading.audit("order.acknowledged", binding!.id, { intentId, venueOrderId: result.orderId, recoveredWhileInFlight: before === "submission_unknown" || undefined });
      if (before === "submission_unknown") { this.ctx.tradingAlerts.resolve(`unknown_submission:${intentId}`); this.refreshPause(binding!.id); }
      // Best effort: read the order back now; the stream and reconciliation carry the rest.
      try {
        const order = await this.ctx.trading.withCredentials((creds, adapter) => adapter.getOrder(creds, result.orderId));
        if (order) this.applyOrderSnapshot(binding!.id, order, "rest");
      } catch { /* reconciliation will retry */ }
      return this.intent(intentId)!;
    }
    if (result.kind === "not_created") {
      this.ctx.db.transaction(() => this.finishUnsent(intentId, "rejected_local", `venue refused the request (no order created): ${result.message}`, at));
      this.ctx.trading.audit("order.refused", binding!.id, { intentId, message: result.message });
      return this.intent(intentId)!;
    }
    // Ambiguous: the order may exist. Keep the reservation, pause the account, open a hold. Never resend.
    this.markUnknown(intentId, result.message, at);
    return this.intent(intentId)!;
  }

  private async createOnce(req: OrderRequest): Promise<{ kind: "created"; orderId: string; executions: VenueExecution[] } | { kind: "not_created"; message: string } | { kind: "ambiguous"; message: string }> {
    try {
      const r = await this.ctx.trading.withCredentials((creds, adapter) => adapter.createOrder(creds, req));
      return { kind: "created", orderId: r.orderId, executions: r.executions };
    } catch (err) {
      const adapter = this.ctx.trading.adapterForClassification();
      const cls = adapter.classifySubmitFailure(err);
      const message = err instanceof Error ? err.message.slice(0, 300) : String(err);
      return cls === "not_created" ? { kind: "not_created", message } : { kind: "ambiguous", message };
    }
  }

  private markUnknown(intentId: string, reason: string, at: string): void {
    const intent = this.intent(intentId)!;
    this.ctx.db.transaction(() => {
      this.ctx.db.run("UPDATE trade_intents SET state = 'submission_unknown', unknown_reason = ?, updated_at = ? WHERE id = ? AND state IN ('submitting','reserved')", reason, at, intentId);
      this.openHold(intent.bindingId!, "submission_unknown", intentId, { reason, marketSlug: intent.venueMarketId, side: intent.side, quantity: intent.quantity, yesWirePrice: intent.wirePrice, dispatchMarkerAt: intent.dispatchMarkerAt, candidates: [] }, at);
      this.ctx.trading.setDispatchPause(intent.bindingId!, `submission ${intentId.slice(0, 8)} has an unknown outcome`);
    });
    this.ctx.trading.audit("order.submission_unknown", intent.bindingId, { intentId, reason });
    this.ctx.tradingAlerts.raise("unknown_submission", `unknown_submission:${intentId}`, `Submission ${intentId.slice(0, 8)} has an unknown outcome (${reason}). New orders are paused until you resolve it.`, { subject: intentId, details: { reason, marketSlug: intent.venueMarketId } });
    // AUTO-04: an ambiguous submission during automatic trading returns to disarmed; the owner re-arms after resolving it.
    if (this.ctx.trading.policy().mode === "auto_live") this.ctx.trading.disarm(`unknown submission ${intentId.slice(0, 8)}`);
  }

  /** An intent that never reached the venue: release its reservation and give the opportunity back. */
  private finishUnsent(intentId: string, state: "rejected_local" | "expired", reason: string, at: string): void {
    const r = this.ctx.db.get<IntentRow>("SELECT * FROM trade_intents WHERE id = ?", intentId);
    if (!r) return;
    // RV-02: only an intent that is still pre-wire can be finished as unsent; a concurrent acknowledgement wins.
    const changed = Number(this.ctx.db.run("UPDATE trade_intents SET state = ?, last_error = ?, updated_at = ? WHERE id = ? AND state IN ('reserved','submitting','submission_unknown')", state, reason, at, intentId).changes);
    if (changed !== 1) return;
    this.ctx.risk.release(r.reservation_id, at, reason);
    this.ctx.db.run("DELETE FROM trade_opportunities WHERE intent_id = ?", intentId);
  }

  // ---- crash recovery (EXE-04 / E06) ---------------------------------------------------------------------

  /** At startup: a `reserved` intent without a marker provably never reached the venue; one with a marker might have. */
  recoverAfterCrash(): { expired: string[]; unknown: string[] } {
    const at = this.now().toISOString();
    const expired: string[] = [];
    const unknown: string[] = [];
    for (const r of this.ctx.db.all<IntentRow>("SELECT * FROM trade_intents WHERE mode = 'live' AND state IN ('reserved','submitting')")) {
      if (r.state === "reserved" && !r.dispatch_marker_at) {
        this.ctx.db.transaction(() => this.finishUnsent(r.id, "expired", "recovered after restart before dispatch; never sent", at));
        expired.push(r.id);
      } else {
        this.markUnknown(r.id, "process stopped after the dispatch marker; the venue may hold this order", at);
        unknown.push(r.id);
      }
    }
    if (expired.length || unknown.length) this.ctx.trading.audit("execution.recovered", this.ctx.trading.connected()?.id, { expired, unknown });
    return { expired, unknown };
  }

  // ---- executions and orders (EXE-06) ------------------------------------------------------------------------

  upsertOrder(bindingId: string, order: VenueOrder, source: "rest" | "stream", opts: { intentId?: string; external?: boolean } = {}): VenueOrderRecord {
    const at = this.now().toISOString();
    const existing = this.ctx.db.get<OrderRow>("SELECT * FROM venue_orders WHERE id = ?", order.id);
    const intentId = opts.intentId ?? existing?.intent_id ?? this.ctx.db.get<{ id: string }>("SELECT id FROM trade_intents WHERE venue_order_id = ?", order.id)?.id ?? null;
    const external = intentId ? 0 : (opts.external ?? true) ? 1 : 0;
    if (!existing) {
      this.ctx.db.run(
        "INSERT INTO venue_orders (id, binding_id, intent_id, external, market_slug, venue_market_id, side, intent_raw, state_raw, state, quantity, filled_quantity, leaves_quantity, yes_price, avg_price, fees, venue_created_at, updated_at, first_seen_at, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        order.id, bindingId, intentId, external, order.marketSlug, this.venueMarketIdFor(order.marketSlug), order.side ?? null, order.intentRaw ?? null, order.stateRaw ?? null, mergeOrderState("unknown", order.state), order.quantity ?? null, order.filledQuantity, order.leavesQuantity ?? null, order.yesPrice ?? null, order.avgPrice ?? null, order.feesCollected ?? null, order.createTime ?? null, at, at, JSON.stringify(order.raw ?? null),
      );
    } else {
      const state = mergeOrderState(existing.state, order.state);
      const filled = mergeFilled(existing.filled_quantity, order.filledQuantity);
      this.ctx.db.run(
        "UPDATE venue_orders SET intent_id = COALESCE(intent_id, ?), external = ?, state_raw = COALESCE(?, state_raw), state = ?, quantity = COALESCE(?, quantity), filled_quantity = ?, leaves_quantity = COALESCE(?, leaves_quantity), yes_price = COALESCE(?, yes_price), avg_price = COALESCE(?, avg_price), fees = COALESCE(?, fees), venue_created_at = COALESCE(?, venue_created_at), side = COALESCE(?, side), intent_raw = COALESCE(?, intent_raw), updated_at = ?, raw_json = COALESCE(?, raw_json) WHERE id = ?",
        intentId, intentId ? 0 : existing.external, order.stateRaw ?? null, state, order.quantity ?? null, filled, order.leavesQuantity ?? null, order.yesPrice ?? null, order.avgPrice ?? null, order.feesCollected ?? null, order.createTime ?? null, order.side ?? null, order.intentRaw ?? null, at, order.raw ? JSON.stringify(order.raw) : null, order.id,
      );
    }
    this.syncIntentFromOrder(order.id, at);
    return this.order(order.id)!;
  }

  applyOrderSnapshot(bindingId: string, order: VenueOrder, source: "rest" | "stream"): VenueOrderRecord {
    return this.upsertOrder(bindingId, order, source);
  }

  /** Idempotent: an execution id or trade id seen before is ignored; the order and intent follow forward-only. */
  applyExecution(bindingId: string, ex: VenueExecution, source: ExecutionRecord["source"]): { applied: boolean; orderId: string } {
    const at = this.now().toISOString();
    return this.ctx.db.transaction(() => {
      let orderRow = this.ctx.db.get<OrderRow>("SELECT * FROM venue_orders WHERE id = ?", ex.orderId);
      if (!orderRow) {
        const base: VenueOrder = ex.order ?? { id: ex.orderId, marketSlug: ex.marketSlug ?? "", state: "unknown", filledQuantity: "0" };
        this.upsertOrder(bindingId, { ...base, id: ex.orderId, marketSlug: base.marketSlug || ex.marketSlug || "" }, source === "stream" ? "stream" : "rest");
        orderRow = this.ctx.db.get<OrderRow>("SELECT * FROM venue_orders WHERE id = ?", ex.orderId)!;
      }
      const side = orderRow.side ?? ex.order?.side;
      const dup = this.ctx.db.get<{ id: string }>("SELECT id FROM executions WHERE id = ? OR (trade_id IS NOT NULL AND trade_id = ?)", ex.id, ex.tradeId ?? "");
      let applied = false;
      if (dup) this.counters.droppedDuplicates++;
      if (!dup) {
        this.ctx.db.run(
          "INSERT INTO executions (id, order_id, intent_id, trade_id, type, quantity, yes_price, chosen_cost, fee, at, source, note, received_at, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ex.id, ex.orderId, orderRow.intent_id, ex.tradeId ?? null, ex.type, ex.quantity ?? null, ex.yesPrice ?? null, ex.quantity && ex.yesPrice && side ? chosenCostOf(side, ex.yesPrice) : null, ex.fee ?? null, ex.at ?? null, source, ex.rejectReason ?? ex.text ?? null, at, JSON.stringify(ex.raw ?? null),
        );
        applied = true;
      }
      // Order state: the execution's order snapshot when present, else the execution type; quantities never shrink.
      const reported: VenueOrder = ex.order ?? { id: ex.orderId, marketSlug: orderRow.market_slug, state: ex.type === "fill" ? "filled" : ex.type === "partial_fill" ? "partial" : ex.type === "canceled" ? "canceled" : ex.type === "rejected" ? "rejected" : ex.type === "expired" ? "expired" : ex.type === "new" ? "open" : "unknown", filledQuantity: this.filledFromExecutions(ex.orderId) };
      if (!ex.order && applied && (ex.type === "fill" || ex.type === "partial_fill")) reported.filledQuantity = this.filledFromExecutions(ex.orderId);
      const feesKnown = this.feesFromExecutions(ex.orderId);
      const merged = { ...reported, feesCollected: reported.feesCollected ?? (feesKnown.isPos() ? feesKnown.toString() : undefined), avgPrice: reported.avgPrice ?? this.avgFromExecutions(ex.orderId) };
      this.upsertOrder(bindingId, merged, source === "stream" ? "stream" : "rest");
      if (ex.rejectReason) this.ctx.db.run("UPDATE venue_orders SET reject_reason = ? WHERE id = ?", ex.rejectReason, ex.orderId);
      return { applied, orderId: ex.orderId };
    });
  }

  private filledFromExecutions(orderId: string): string {
    return dsum(this.ctx.db.all<{ quantity: string | null }>("SELECT quantity FROM executions WHERE order_id = ? AND type IN ('fill','partial_fill')", orderId).map((r) => D(r.quantity ?? "0"))).toString();
  }
  private feesFromExecutions(orderId: string): Dec {
    return dsum(this.ctx.db.all<{ fee: string | null }>("SELECT fee FROM executions WHERE order_id = ? AND type IN ('fill','partial_fill')", orderId).map((r) => D(r.fee ?? "0")));
  }
  private avgFromExecutions(orderId: string): string | undefined {
    const rows = this.ctx.db.all<{ quantity: string | null; yes_price: string | null }>("SELECT quantity, yes_price FROM executions WHERE order_id = ? AND type IN ('fill','partial_fill')", orderId).filter((r) => r.quantity && r.yes_price);
    if (!rows.length) return undefined;
    const qty = dsum(rows.map((r) => D(r.quantity!)));
    if (!qty.isPos()) return undefined;
    return dsum(rows.map((r) => D(r.quantity!).mul(r.yes_price!))).div(qty, "half_up").round(4).toString();
  }

  /** The intent follows its order: state, filled quantity, and — on a terminal order — the reservation settles once. */
  private syncIntentFromOrder(orderId: string, at: string): void {
    const o = this.ctx.db.get<OrderRow>("SELECT * FROM venue_orders WHERE id = ?", orderId);
    if (!o || !o.intent_id) return;
    const intent = this.ctx.db.get<IntentRow>("SELECT * FROM trade_intents WHERE id = ?", o.intent_id);
    if (!intent || intent.state === "submission_unknown" && !intent.venue_order_id) return;
    if (!["acknowledged", "filled", "partially_filled", "canceled", "rejected", "submission_unknown", "submitting"].includes(intent.state)) return;
    const next = intentStateFor(o.state, o.filled_quantity, intent.quantity);
    const terminal = TERMINAL_ORDER_STATES.includes(o.state);
    if (intent.state !== next || intent.filled_quantity !== o.filled_quantity) {
      this.ctx.db.run("UPDATE trade_intents SET state = ?, filled_quantity = ?, venue_order_id = COALESCE(venue_order_id, ?), updated_at = ? WHERE id = ?", next, o.filled_quantity, orderId, at, intent.id);
    }
    if (terminal) {
      const consumed = this.consumedFor(o);
      this.ctx.risk.settleFill(intent.reservation_id, consumed.toString(), at, o.state === "rejected" ? `venue rejected: ${o.reject_reason ?? ""}` : `${o.state}: ${o.filled_quantity} of ${intent.quantity} filled`);
    }
  }

  /** All-in amount an order consumed: filled × chosen cost (from the venue's average price) + fees. */
  private consumedFor(o: OrderRow): Dec {
    const filled = D(o.filled_quantity);
    if (!filled.isPos() || !o.side) return Dec.ZERO;
    const avg = o.avg_price ?? this.avgFromExecutions(o.id) ?? o.yes_price;
    if (!avg) return Dec.ZERO;
    const cost = D(chosenCostOf(o.side, avg)).mul(filled);
    const fees = o.fees ? D(o.fees) : this.feesFromExecutions(o.id);
    return cost.add(fees);
  }

  // ---- cancel (EXE-06 / E10) --------------------------------------------------------------------------------

  async cancelIntent(intentId: string): Promise<{ outcome: string; message?: string }> {
    const intent = this.intent(intentId);
    if (!intent) throw new ExecutionError("Intent not found.", "not_found", 404);
    if (!intent.venueOrderId) throw new ExecutionError("This intent has no venue order id to cancel (unknown submissions are resolved through the hold).", "no_order", 409);
    const order = this.order(intent.venueOrderId);
    if (!order || TERMINAL_ORDER_STATES.includes(order.state)) return { outcome: "not_open", message: `order is ${order?.state ?? "unknown"}` };
    const at = this.now().toISOString();
    this.ctx.db.run("UPDATE venue_orders SET state = 'cancel_pending', cancel_requested_at = ?, updated_at = ? WHERE id = ? AND state IN ('pending','open','partial')", at, at, order.id);
    try {
      const r = await this.ctx.trading.withCredentials((creds, adapter) => adapter.cancelOrder(creds, order.id, order.marketSlug));
      this.ctx.trading.audit("order.cancel_requested", intent.bindingId, { intentId, venueOrderId: order.id, outcome: r.outcome });
      if (r.outcome === "failed") { this.openHold(intent.bindingId!, "failed_cancel", intentId, { venueOrderId: order.id, message: r.message }, at); this.ctx.tradingAlerts.raise("failed_cancel", `failed_cancel:${order.id}`, `Cancel of order ${order.id} failed: ${r.message ?? "unknown"}`, { subject: order.id }); }
      return { outcome: r.outcome, message: r.message };
    } catch (err) {
      this.openHold(intent.bindingId!, "failed_cancel", intentId, { venueOrderId: order.id, message: (err as Error).message }, at);
      this.ctx.tradingAlerts.raise("failed_cancel", `failed_cancel:${order.id}`, `Cancel of order ${order.id} failed: ${(err as Error).message.slice(0, 200)}`, { subject: order.id });
      return { outcome: "failed", message: (err as Error).message };
    }
  }

  // ---- 1.14: emergency stop and account-wide cancel (AUTO-03) ---------------------------------------------

  /**
   * Emergency stop: ONE statement disarms and pauses (the dispatch marker re-reads that row, so no send can begin
   * afterwards), then every app-owned order that is not terminal is targeted for cancellation. Positions and history
   * are untouched; an in-flight POST is reconciled like any other (its id arrives, its remainder is canceled here or
   * by the next reconcile). Orders the app did not place are never cancelled by this action.
   */
  async emergencyStop(reason = "emergency stop"): Promise<EmergencyStopResult> {
    const stoppedAt = this.now().toISOString();
    const previousMode = this.ctx.trading.policy().mode;
    this.ctx.trading.disarm(reason, { pause: true });
    this.ctx.trading.audit("trading.emergency_stop", this.ctx.trading.connected()?.id, { reason, previousMode });
    this.ctx.tradingAlerts.raise("emergency_stop", `emergency_stop:${stoppedAt}`, `Emergency stop at ${stoppedAt}: disarmed, new orders paused, app-owned open orders targeted for cancellation.`, { details: { reason, previousMode } });
    const cancellations: EmergencyStopResult["cancellations"] = [];
    const binding = this.ctx.trading.connected();
    if (binding) {
      // RV-13: wait (bounded) for any POST that was already in flight when the stop was recorded, so its order id is
      // persisted and the sweep below targets it too; then sweep every app-owned non-terminal order.
      await this.awaitInFlight(IN_FLIGHT_WAIT_MS);
      const open = this.ctx.db.all<{ id: string; intent_id: string }>("SELECT id, intent_id FROM venue_orders WHERE binding_id = ? AND intent_id IS NOT NULL AND state IN ('pending','open','partial','cancel_pending')", binding.id);
      for (const o of open) {
        const r = await this.cancelIntent(o.intent_id).catch((err: Error) => ({ outcome: "failed", message: err.message }));
        cancellations.push({ intentId: o.intent_id, venueOrderId: o.id, outcome: r.outcome, message: r.message });
      }
    }
    const positionsRetained = binding ? this.positions(binding.id).filter((p) => !p.settled && !D(p.localNet).isZero()).length : 0;
    return { stoppedAt, previousMode, cancellations, positionsRetained, note: "Disarmed and paused. Only orders placed by this app were targeted; positions and history are retained. Resolve any failed cancellation, reconcile, then resume and re-arm deliberately." };
  }

  /** Resolve once every in-flight dispatch has settled, or after `maxMs` — whichever comes first. */
  async awaitInFlight(maxMs: number): Promise<number> {
    const pending = [...this.inFlight];
    if (!pending.length) return 0;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled(pending), new Promise<void>((resolve) => { timer = setTimeout(resolve, maxMs); timer.unref?.(); })]);
    if (timer) clearTimeout(timer);
    return pending.length;
  }

  /** Account-wide cancellation — a separately labelled owner action that needs its own acknowledgement; never the default. */
  async cancelAllAccountOrders(acknowledge: string): Promise<{ requested: string[]; failed: { orderId: string; message?: string }[] }> {
    if (acknowledge !== CANCEL_ALL_ACKNOWLEDGEMENT) throw new ExecutionError(`Account-wide cancel requires the exact acknowledgement "${CANCEL_ALL_ACKNOWLEDGEMENT}".`, "acknowledgement_required", 409);
    const binding = this.ctx.trading.connected();
    if (!binding) throw new ExecutionError("No connected account.", "not_connected", 409);
    const sync = await this.ctx.trading.sync();
    const requested: string[] = []; const failed: { orderId: string; message?: string }[] = [];
    for (const o of sync.openOrders) {
      try {
        const r = await this.ctx.trading.withCredentials((creds, adapter) => adapter.cancelOrder(creds, o.id, o.marketSlug));
        if (r.outcome === "requested") requested.push(o.id); else failed.push({ orderId: o.id, message: r.message });
      } catch (err) { failed.push({ orderId: o.id, message: (err as Error).message }); }
    }
    this.ctx.trading.audit("orders.cancel_all", binding.id, { requested: requested.length, failed: failed.length, acknowledged: true });
    return { requested, failed };
  }

  // ---- reconciliation (EXE-05 / EXE-07 / EXE-08) --------------------------------------------------------------

  async reconcile(o: { now?: string } = {}): Promise<ReconcileReport> {
    const binding = this.ctx.trading.connected();
    if (!binding) throw new ExecutionError("No connected account.", "not_connected", 409);
    const now = o.now ?? this.now().toISOString();
    // 1. Authoritative snapshot: balances, every page of positions, open orders.
    const sync = await this.ctx.trading.sync();
    for (const p of sync.positions) this.ctx.db.run("INSERT INTO position_snapshots (id, binding_id, market_slug, net_quantity, cost, realized, source, at) VALUES (?, ?, ?, ?, ?, ?, 'rest', ?)", crypto.randomUUID(), binding.id, p.marketSlug, p.netQuantity, p.cost?.value ?? null, p.realized?.value ?? null, sync.at);
    for (const oo of sync.openOrders) {
      const known = this.ctx.db.get<{ id: string }>("SELECT id FROM venue_orders WHERE id = ?", oo.id);
      const ours = this.ctx.db.get<{ id: string }>("SELECT id FROM trade_intents WHERE venue_order_id = ?", oo.id);
      if (!known) this.upsertOrder(binding.id, { id: oo.id, marketSlug: oo.marketSlug, intentRaw: oo.intent, side: oo.intent.endsWith("LONG") ? "yes" : oo.intent.endsWith("SHORT") ? "no" : undefined, stateRaw: oo.state, state: "open", quantity: oo.quantity, filledQuantity: oo.filledQuantity ?? "0", yesPrice: oo.price?.value, createTime: oo.createTime }, "rest", { external: !ours });
    }
    // 2. Every order of ours that is not terminal: read it back.
    let ordersChecked = 0;
    const ourOpen = this.ctx.db.all<IntentRow>("SELECT * FROM trade_intents WHERE binding_id = ? AND venue_order_id IS NOT NULL AND state IN ('acknowledged','submitting','submission_unknown','partially_filled')", binding.id);
    for (const r of ourOpen) {
      const order = await this.ctx.trading.withCredentials((creds, adapter) => adapter.getOrder(creds, r.venue_order_id!));
      ordersChecked++;
      if (order) this.applyOrderSnapshot(binding.id, order, "rest");
    }
    // 3. Activities: paginate fully (retry a failed page once), then trades → executions, resolutions → settlements.
    // RV-05: the venue lists activities newest-first; apply them oldest-first so an original and its correction keep their order.
    const activities = (await this.readAllActivities()).sort((x, y) => (Date.parse(x.at ?? "") || 0) - (Date.parse(y.at ?? "") || 0));
    let executionsAdded = 0;
    let settlements = 0;
    for (const a of activities) {
      if (a.kind === "trade" && a.tradeId) {
        const owner = this.attributeTrade(a);
        if (owner) {
          const r = this.applyExecution(binding.id, { id: `trade:${a.tradeId}`, orderId: owner.id, marketSlug: a.marketSlug, type: "partial_fill", quantity: a.quantity, yesPrice: a.yesPrice, tradeId: a.tradeId, at: a.at, raw: a.raw }, "activity");
          if (r.applied) executionsAdded++;
        } else if (a.marketSlug && !this.ctx.db.get<{ id: string }>("SELECT id FROM executions WHERE trade_id = ?", a.tradeId)) {
          // An external trade on a market we care about: keep it as an external execution, no rationale invented.
          const ext = `external:${a.marketSlug}`;
          if (!this.ctx.db.get<{ id: string }>("SELECT id FROM venue_orders WHERE id = ?", ext)) this.upsertOrder(binding.id, { id: ext, marketSlug: a.marketSlug, state: "unknown", filledQuantity: "0" }, "rest", { external: true });
          this.ctx.db.run("INSERT OR IGNORE INTO executions (id, order_id, intent_id, trade_id, type, quantity, yes_price, at, source, note, received_at, raw_json) VALUES (?, ?, NULL, ?, 'unknown', ?, ?, ?, 'activity', 'external activity (not placed by this app)', ?, ?)", `trade:${a.tradeId}`, ext, a.tradeId, a.quantity ?? null, a.yesPrice ?? null, a.at ?? null, now, JSON.stringify(a.raw ?? null));
        }
      } else if (a.kind === "position_resolution" && a.marketSlug) {
        settlements += this.applyResolution(binding.id, a, now);
      }
    }
    // 4. Unknown submissions: list candidates for the owner; never link automatically.
    const unknownIntents: ReconcileReport["unknownIntents"] = [];
    for (const r of this.ctx.db.all<IntentRow>("SELECT * FROM trade_intents WHERE binding_id = ? AND state = 'submission_unknown'", binding.id)) {
      const candidates = this.ctx.db.all<OrderRow>("SELECT * FROM venue_orders WHERE binding_id = ? AND market_slug = ? AND intent_id IS NULL AND id NOT LIKE 'external:%'", binding.id, r.market_slug ?? "")
        .filter((oo) => (!oo.side || oo.side === r.side) && (!oo.quantity || D(oo.quantity).eq(r.quantity)) && (!oo.yes_price || D(oo.yes_price).eq(r.wire_price)) && (!oo.venue_created_at || !r.dispatch_marker_at || Date.parse(oo.venue_created_at) >= Date.parse(r.dispatch_marker_at) - CANDIDATE_WINDOW_MS))
        .map((oo) => oo.id);
      const hold = this.openHoldFor(binding.id, "submission_unknown", r.id);
      if (hold) this.ctx.db.run("UPDATE reconciliation_holds SET detail_json = ? WHERE id = ?", JSON.stringify({ ...hold.detail, candidates, checkedAt: now, note: candidates.length ? "A same-looking order is not proof of identity: choose it only if you are sure it is this submission." : "No matching order seen yet; absence from one query is not permission to resend." }), hold.id);
      unknownIntents.push({ intentId: r.id, candidates });
    }
    // 5. Discrepancies: venue position vs what our acknowledged orders (and known external activity) account for.
    const discrepancies: ReconcileReport["discrepancies"] = [];
    for (const pos of this.positions(binding.id, sync)) {
      if (pos.discrepancy) {
        discrepancies.push({ marketSlug: pos.marketSlug, venueNet: pos.venueNet ?? "?", localNet: pos.localNet });
        if (!this.openHoldFor(binding.id, "discrepancy", pos.marketSlug)) this.openHold(binding.id, "discrepancy", pos.marketSlug, { venueNet: pos.venueNet, localNet: pos.localNet, intents: pos.intentIds }, now);
      }
    }
    // 5b. (2.0.0-rc.2) Discrepancy holds on markets where the app has no order of its own were opened by the 1.13 rule
    //     "any mismatch pauses"; they describe hand-placed holdings, not bookkeeping errors. Reclassify them once.
    let reclassified = 0;
    for (const h of this.holds(binding.id, true)) {
      if (h.kind !== "discrepancy" || !h.subject || h.subject.startsWith("settlement:")) continue;
      if (this.ctx.db.get("SELECT 1 FROM venue_orders WHERE binding_id = ? AND intent_id IS NOT NULL AND market_slug = ?", binding.id, h.subject)) continue;
      this.ctx.db.run("UPDATE reconciliation_holds SET resolved_at = ?, resolution = ? WHERE id = ?", now, "reclassified as an external holding (2.0.0-rc.2): this app has no order on this market, so the venue position was placed by hand; it is listed under External holdings, counted toward exposure limits and blocks app entry on this contract, but it is not a bookkeeping discrepancy", h.id);
      this.ctx.tradingAlerts.resolve(`discrepancy:${binding.id}:${h.subject}`);
      this.ctx.trading.audit("hold.reclassified", binding.id, { holdId: h.id, marketSlug: h.subject, as: "external_holding" });
      reclassified++;
    }
    const holdsOpen = this.holds(binding.id, true).length;
    const paused = holdsOpen > 0 || unknownIntents.length > 0;
    this.ctx.trading.setDispatchPause(binding.id, paused ? `${holdsOpen} hold(s) open` : null);
    for (const d of discrepancies) this.ctx.tradingAlerts.raise("discrepancy", `discrepancy:${binding.id}:${d.marketSlug}`, `Position discrepancy on ${d.marketSlug}: venue ${d.venueNet} vs local ${d.localNet}.`, { subject: d.marketSlug, details: d });
    // AUTO-04: a discrepancy or an unresolved unknown submission during automatic trading returns to disarmed.
    if ((discrepancies.length || unknownIntents.length) && this.ctx.trading.policy().mode === "auto_live") this.ctx.trading.disarm(`account reconciliation found ${discrepancies.length} discrepancy(ies), ${unknownIntents.length} unknown submission(s)`);
    this.ctx.tradingAlerts.resolve(`stale_sync:${binding.id}`);
    this.ctx.trading.audit("reconcile.completed", binding.id, { ordersChecked, executionsAdded, activities: activities.length, settlements, unknown: unknownIntents.length, discrepancies: discrepancies.length, holdsOpen, reclassified: reclassified || undefined });
    return { bindingId: binding.id, syncedAt: sync.at, ordersChecked, executionsAdded, activitiesRead: activities.length, settlements, unknownIntents, discrepancies, holdsOpen, paused, externalHoldings: this.positions(binding.id, sync).filter((p) => p.external).length, reclassifiedHolds: reclassified };
  }

  private async readAllActivities(): Promise<ActivityRecord[]> {
    const out: ActivityRecord[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
      let r;
      try {
        r = await this.ctx.trading.withCredentials((creds, adapter) => adapter.activities(creds, { cursor }));
      } catch (err) {
        // One retry of the same page (a reconnect mid-snapshot, E10); the cursor is unchanged so nothing is skipped or doubled.
        if (err instanceof TradingAdapterError && (err.code === "network" || err.code === "timeout" || err.code === "venue_unavailable")) { this.counters.readRetries++; r = await this.ctx.trading.withCredentials((creds, adapter) => adapter.activities(creds, { cursor })); }
        else throw err;
      }
      for (const a of r.activities) if (!seen.has(a.id)) { seen.add(a.id); out.push(a); }
      if (r.eof || !r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return out;
  }

  /**
   * Attribute a trade activity to one of our orders only when it is unambiguous: exactly one acknowledged order of ours
   * on that market, created before the trade, whose venue-reported fill quantity still exceeds what we have recorded.
   */
  private attributeTrade(a: ActivityRecord): OrderRow | undefined {
    if (!a.marketSlug || !a.quantity) return undefined;
    const raw = a.raw as { orderId?: string } | undefined;
    if (raw?.orderId) { const o = this.ctx.db.get<OrderRow>("SELECT * FROM venue_orders WHERE id = ? AND intent_id IS NOT NULL", raw.orderId); if (o) return o; }
    const ours = this.ctx.db.all<OrderRow>("SELECT * FROM venue_orders WHERE market_slug = ? AND intent_id IS NOT NULL", a.marketSlug);
    if (ours.length !== 1) return undefined;
    const o = ours[0];
    if (o.venue_created_at && a.at && Date.parse(a.at) < Date.parse(o.venue_created_at) - 1000) return undefined;
    const recorded = D(this.filledFromExecutions(o.id));
    if (recorded.add(a.quantity).gt(o.filled_quantity)) return undefined;
    return o;
  }

  /** Official settlement (EXE-08): one settlement event per resolution activity; corrections are new events. */
  private applyResolution(bindingId: string, a: ActivityRecord, now: string): number {
    const activityId = a.id;
    if (this.ctx.db.get<{ id: string }>("SELECT id FROM settlement_events WHERE activity_id = ?", activityId)) return 0;
    const m = this.ctx.db.get<{ id: string; venue_id: string }>("SELECT id, venue_id FROM markets WHERE provider = 'polymarket_us' AND (venue_id = ? OR slug = ?)", a.marketSlug, a.marketSlug);
    // A resolution on a market this app never stored can only concern external activity: nothing of ours to settle.
    if (!m) return 0;
    const prior = this.ctx.db.get<{ id: string }>("SELECT id FROM settlement_events WHERE venue_market_id = ? AND binding_id = ? AND kind IN ('resolved','void')", m.venue_id, bindingId);
    const side = a.resolutionSide ?? "";
    const outcome = /LONG$/.test(side) ? "yes" : /SHORT$/.test(side) ? "no" : "void";
    const kind: SettlementEventRecord["kind"] = prior ? "correction" : outcome === "void" ? "void" : "resolved";
    let n = 0;
    this.ctx.db.transaction(() => {
      this.ctx.db.run("INSERT INTO settlement_events (id, market_id, venue_market_id, kind, outcome, source, observed_at, details_json, binding_id, activity_id) VALUES (?, ?, ?, ?, ?, 'account_activity', ?, ?, ?, ?)", crypto.randomUUID(), m.id, m.venue_id, kind, outcome, a.at ?? now, JSON.stringify({ marketSlug: a.marketSlug, positionBefore: a.positionBefore, positionAfter: a.positionAfter, realizedPnl: a.realizedPnl, raw: a.raw }), bindingId, activityId);
      n++;
      // Per-intent P&L from the official outcome: win → quantity − cost − fees; loss → −(cost + fees); void → 0.
      // A correction is recorded as a new event beside the original; it never rewrites the earlier amount.
      for (const o of this.ctx.db.all<OrderRow>("SELECT * FROM venue_orders WHERE binding_id = ? AND market_slug = ? AND intent_id IS NOT NULL AND CAST(filled_quantity AS REAL) > 0", bindingId, a.marketSlug!)) {
        if (this.ctx.db.get<{ id: string }>("SELECT id FROM settlement_events WHERE intent_id = ? AND kind = ? AND observed_at = ?", o.intent_id, kind, a.at ?? now)) continue;
        const filled = D(o.filled_quantity);
        const consumed = this.consumedFor(o);
        const pnl = outcome === "void" ? Dec.ZERO : outcome === o.side ? filled.sub(consumed) : consumed.neg();
        this.ctx.db.run("INSERT INTO settlement_events (id, market_id, venue_market_id, kind, outcome, source, observed_at, details_json, binding_id, intent_id, amount, activity_id) VALUES (?, ?, ?, ?, ?, 'account_activity', ?, ?, ?, ?, ?, NULL)", crypto.randomUUID(), m.id, m.venue_id, kind, outcome, a.at ?? now, JSON.stringify({ marketSlug: a.marketSlug, filled: filled.toString(), consumed: consumed.toString(), side: o.side, activityId }), bindingId, o.intent_id, pnl.toString());
        n++;
      }
    });
    this.ctx.trading.audit("settlement.recorded", bindingId, { marketSlug: a.marketSlug, kind, outcome, activityId });
    this.ctx.tradingAlerts.raise("resolution", `resolution:${activityId}`, `${kind === "correction" ? "Settlement correction" : "Official settlement"} on ${a.marketSlug}: ${outcome}.`, { severity: "info", subject: a.marketSlug, details: { kind, outcome, events: n } });
    // RV-04: the meaning of `positionResolution.side` (winning side vs. the account's side) is not documented by the venue.
    // When the venue also reports a realized amount whose sign contradicts what our reading implies for our own fills,
    // the settlement is contested: a discrepancy hold pauses new orders until the owner checks the venue's statement.
    const ours = dsum(this.ctx.db.all<{ amount: string | null }>("SELECT amount FROM settlement_events WHERE binding_id = ? AND venue_market_id = ? AND intent_id IS NOT NULL AND kind = ? AND observed_at = ?", bindingId, m.venue_id, kind, a.at ?? now).map((r) => D(r.amount ?? "0")));
    if (a.realizedPnl !== undefined && n > 1 && !ours.isZero()) {
      const venue = D(a.realizedPnl);
      if (!venue.isZero() && venue.isNeg() !== ours.isNeg()) {
        this.openHold(bindingId, "discrepancy", `settlement:${activityId}`, { marketSlug: a.marketSlug, activityId, resolutionSide: side, ourReading: outcome, ourAmount: ours.toString(), venueRealized: venue.toString(), note: "The venue's realized amount contradicts the app's reading of the resolution side; verify the settlement on the venue before trusting the ledger's P&L for this market." }, now);
        this.ctx.tradingAlerts.raise("discrepancy", `settlement:${activityId}`, `Settlement on ${a.marketSlug} is contested: the app read ${outcome} (${ours} for our fills) but the venue reports realized ${venue}.`, { subject: a.marketSlug, details: { activityId, resolutionSide: side } });
      }
    }
    return n;
  }

  /** Live positions: venue net (latest snapshot) vs our orders' signed fills, per market; a mismatch is a discrepancy. */
  positions(bindingId: string, sync?: { positions: { marketSlug: string; netQuantity: string; cost?: { value: string } }[]; at: string }): LivePosition[] {
    const snap = sync ?? (() => { const s = this.ctx.trading.latestSync(bindingId, true); return s ? { positions: s.positions, at: s.at } : undefined; })();
    const markets = new Set<string>();
    const orders = this.ctx.db.all<OrderRow>("SELECT * FROM venue_orders WHERE binding_id = ?", bindingId);
    for (const o of orders) if (D(o.filled_quantity).isPos()) markets.add(o.market_slug);
    for (const p of snap?.positions ?? []) if (!D(p.netQuantity).isZero()) markets.add(p.marketSlug);
    const out: LivePosition[] = [];
    for (const slug of markets) {
      const ours = orders.filter((o) => o.market_slug === slug && o.intent_id);
      const external = orders.filter((o) => o.market_slug === slug && !o.intent_id);
      const key = this.venueMarketIdFor(slug) ?? slug;
      const settledIntents = new Set(this.ctx.db.all<{ intent_id: string }>("SELECT intent_id FROM settlement_events WHERE venue_market_id = ? AND intent_id IS NOT NULL", key).map((r) => r.intent_id));
      const localNet = dsum(ours.filter((o) => !settledIntents.has(o.intent_id!)).map((o) => (o.side === "no" ? D(o.filled_quantity).neg() : D(o.filled_quantity))));
      // RV-08: orders placed on the website may be sells; sign by action × side, never by side alone.
      const externalNet = dsum(external.map((o) => signedFilledQuantity(o.intent_raw ?? undefined, o.side ?? undefined, o.filled_quantity)));
      const venue = snap?.positions.find((p) => p.marketSlug === slug);
      const settled = this.ctx.db.get<{ kind: SettlementEventRecord["kind"]; observed_at: string; outcome: string | null }>("SELECT kind, observed_at, outcome FROM settlement_events WHERE venue_market_id = ? AND binding_id = ? ORDER BY observed_at DESC, rowid DESC LIMIT 1", key, bindingId);
      const expected = localNet.add(externalNet);
      // 2.0.0-rc.2: a market where the app has NO order of its own is an external holding — hand-placed on the website or
      // older than the app. It is listed, counted toward exposure and blocks app entry on that contract, but it is not a
      // bookkeeping discrepancy and never pauses the account. Discrepancies exist only where the app has its own orders.
      const handPlaced = ours.length === 0;
      const discrepancy = !handPlaced && venue && !settled && !D(venue.netQuantity).eq(expected) ? `venue ${venue.netQuantity} vs local ${expected} (ours ${localNet}${externalNet.isZero() ? "" : `, external ${externalNet}`})` : undefined;
      out.push({
        bindingId, marketSlug: slug, venueMarketId: ours[0]?.venue_market_id ?? this.venueMarketIdFor(slug) ?? undefined, venueNet: venue?.netQuantity, venueAt: snap?.at, localNet: localNet.toString(), intentIds: ours.map((o) => o.intent_id!), discrepancy,
        settled: settled ? { outcome: settledOutcomeFor(settled.kind, settled.outcome, ours.map((o) => o.side)), at: settled.observed_at } : undefined,
        external: handPlaced || undefined, venueCost: venue?.cost?.value,
      });
    }
    return out;
  }

  // ---- holds -------------------------------------------------------------------------------------------------

  openHold(bindingId: string, kind: ReconciliationHold["kind"], subject: string | undefined, detail: Record<string, unknown>, at: string): ReconciliationHold {
    const existing = this.openHoldFor(bindingId, kind, subject);
    if (existing) return existing;
    const id = crypto.randomUUID();
    this.ctx.db.run("INSERT INTO reconciliation_holds (id, binding_id, kind, subject, detail_json, opened_at) VALUES (?, ?, ?, ?, ?, ?)", id, bindingId, kind, subject ?? null, JSON.stringify(detail), at);
    this.ctx.trading.audit("hold.opened", bindingId, { holdId: id, kind, subject });
    return this.hold(id)!;
  }

  openHoldFor(bindingId: string, kind: ReconciliationHold["kind"], subject: string | undefined): ReconciliationHold | undefined {
    const r = this.ctx.db.get<HoldRow>("SELECT * FROM reconciliation_holds WHERE binding_id = ? AND kind = ? AND subject IS ? AND resolved_at IS NULL", bindingId, kind, subject ?? null);
    return r ? hydrateHold(r) : undefined;
  }

  hold(id: string): ReconciliationHold | undefined {
    const r = this.ctx.db.get<HoldRow>("SELECT * FROM reconciliation_holds WHERE id = ?", id);
    return r ? hydrateHold(r) : undefined;
  }

  holds(bindingId?: string, openOnly = false): ReconciliationHold[] {
    const where = [bindingId ? "binding_id = ?" : "1=1", openOnly ? "resolved_at IS NULL" : "1=1"].join(" AND ");
    return this.ctx.db.all<HoldRow>(`SELECT * FROM reconciliation_holds WHERE ${where} ORDER BY opened_at DESC`, ...(bindingId ? [bindingId] : [])).map(hydrateHold);
  }

  /**
   * Owner resolution of an unknown submission (EXE-05): either name the venue order that is this submission, or state
   * that the venue never created one (reservation released, opportunity given back). Both are explicit and audited.
   */
  resolveUnknown(intentId: string, resolution: { venueOrderId: string } | { outcome: "not_submitted" }, note: string): TradeIntent {
    const intent = this.intent(intentId);
    if (!intent || intent.state !== "submission_unknown") throw new ExecutionError("Intent is not in submission_unknown.", "not_unknown", 409);
    const at = this.now().toISOString();
    this.ctx.db.transaction(() => {
      if ("venueOrderId" in resolution) {
        const o = this.ctx.db.get<OrderRow>("SELECT * FROM venue_orders WHERE id = ?", resolution.venueOrderId);
        if (!o) throw new ExecutionError("Unknown venue order id.", "not_found", 404);
        if (o.intent_id && o.intent_id !== intentId) throw new ExecutionError("That order already belongs to another intent.", "order_taken", 409);
        // RV-10 / RV-14: the order must be on this intent's contract and side, with its side known (read it back first if not).
        if (!o.side) throw new ExecutionError("That order's side is not known yet; reconcile (read it back) before linking it.", "order_side_unknown", 409);
        const slug = this.ctx.db.get<{ market_slug: string | null }>("SELECT market_slug FROM trade_intents WHERE id = ?", intentId)?.market_slug ?? undefined;
        if ((slug && o.market_slug !== slug && o.market_slug !== intent.venueMarketId) || o.side !== intent.side) throw new ExecutionError(`That order is ${o.side} on ${o.market_slug}; this submission was ${intent.side} on ${slug ?? intent.venueMarketId}. Only an order on the same contract and side can be this submission.`, "order_mismatch", 409);
        if (o.quantity && !D(o.quantity).eq(intent.quantity)) throw new ExecutionError(`That order is for ${o.quantity} contracts; this submission was for ${intent.quantity}.`, "order_mismatch", 409);
        this.ctx.db.run("UPDATE venue_orders SET intent_id = ?, external = 0, updated_at = ? WHERE id = ?", intentId, at, o.id);
        this.ctx.db.run("UPDATE trade_intents SET venue_order_id = ?, state = 'acknowledged', acknowledged_at = ?, updated_at = ? WHERE id = ?", o.id, at, at, intentId);
        this.ctx.db.run("UPDATE risk_reservations SET acknowledged = 1, updated_at = ? WHERE id = ?", at, intent.reservationId);
        this.syncIntentFromOrder(o.id, at);
      } else {
        this.finishUnsent(intentId, "rejected_local", `owner resolved as not submitted: ${note}`, at);
      }
      const hold = this.openHoldFor(intent.bindingId!, "submission_unknown", intentId);
      if (hold) this.ctx.db.run("UPDATE reconciliation_holds SET resolved_at = ?, resolution = ? WHERE id = ?", at, `${"venueOrderId" in resolution ? `linked to ${resolution.venueOrderId}` : "not submitted"}: ${note}`, hold.id);
    });
    this.ctx.trading.audit("hold.resolved", intent.bindingId, { intentId, resolution, note });
    this.refreshPause(intent.bindingId!);
    return this.intent(intentId)!;
  }

  resolveHold(holdId: string, resolution: string): ReconciliationHold {
    const h = this.hold(holdId);
    if (!h || h.resolvedAt) throw new ExecutionError("Hold not found or already resolved.", "not_found", 404);
    if (h.kind === "submission_unknown") throw new ExecutionError("Resolve an unknown submission through its intent (link an order or declare it not submitted).", "use_resolve_unknown", 409);
    const at = this.now().toISOString();
    this.ctx.db.run("UPDATE reconciliation_holds SET resolved_at = ?, resolution = ? WHERE id = ?", at, resolution, holdId);
    this.ctx.trading.audit("hold.resolved", h.bindingId, { holdId, kind: h.kind, resolution });
    this.refreshPause(h.bindingId);
    return this.hold(holdId)!;
  }

  private refreshPause(bindingId: string): void {
    const open = this.holds(bindingId, true).length + (this.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trade_intents WHERE binding_id = ? AND state = 'submission_unknown'", bindingId)?.n ?? 0);
    this.ctx.trading.setDispatchPause(bindingId, open > 0 ? `${open} hold(s) open` : null);
  }

  // ---- stream (EXE-07) ----------------------------------------------------------------------------------------

  async startStream(): Promise<boolean> {
    const binding = this.ctx.trading.connected();
    if (!binding || this.stream?.connected) return !!this.stream?.connected;
    this.streamState = "connecting";
    try {
      this.stream = await this.ctx.trading.withCredentials((creds, adapter) => adapter.openPrivateStream(creds, {
        onEvent: (e) => this.onStreamEvent(binding.id, e),
        onClose: (reason) => this.onStreamClose(reason),
      }));
      this.streamBinding = binding.id;
      this.streamState = "open";
      this.reconnectDelayMs = 2_000;
      return true;
    } catch (err) {
      this.streamState = "closed";
      this.ctx.trading.audit("stream.failed", binding.id, { message: (err as Error).message.slice(0, 200) });
      return false;
    }
  }

  stopStream(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stream?.close();
    this.stream = undefined;
    this.streamState = "closed";
  }

  private onStreamEvent(bindingId: string, e: Parameters<Parameters<TradingAdapter["openPrivateStream"]>[1]["onEvent"]>[0]): void {
    this.counters.streamEvents++;
    try {
      if (e.kind === "execution") this.applyExecution(bindingId, e.execution, "stream");
      else if (e.kind === "order_snapshot") for (const o of e.orders) this.applyOrderSnapshot(bindingId, o, "stream");
      else if (e.kind === "position") this.ctx.db.run("INSERT INTO position_snapshots (id, binding_id, market_slug, net_quantity, source, at) VALUES (?, ?, ?, ?, 'stream', ?)", crypto.randomUUID(), bindingId, e.marketSlug, e.netQuantity, e.at ?? this.now().toISOString());
      else if (e.kind === "error") this.ctx.trading.audit("stream.error", bindingId, { message: e.message });
    } catch (err) {
      this.ctx.trading.audit("stream.apply_failed", bindingId, { message: (err as Error).message.slice(0, 200) });
    }
  }

  private onStreamClose(reason?: string): void {
    if (this.streamState === "closed") return;
    this.streamState = "reconnecting";
    this.ctx.trading.audit("stream.closed", this.streamBinding, { reason, reconnectInMs: this.reconnectDelayMs });
    if (this.streamBinding) this.ctx.tradingAlerts.raise("disconnection", `disconnection:${this.streamBinding}`, `Private stream disconnected (${reason ?? "closed"}); reconnecting and reconciling.`, { subject: this.streamBinding });
    this.reconnectTimer = setTimeout(() => {
      void (async () => {
        const ok = await this.startStream();
        if (ok) { try { await this.reconcile(); } catch { /* next tick */ } }
        else { this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 60_000); this.onStreamClose("retry"); }
      })();
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref?.();
  }

  // ---- helpers -----------------------------------------------------------------------------------------------

  private liveGate(decisionId: string) {
    const decision = this.ctx.decisions.get(decisionId);
    if (!decision) throw new ExecutionError("Decision not found.", "not_found", 404);
    const policy = this.ctx.trading.policy();
    if (policy.mode !== "manual_live" && policy.mode !== "auto_live") throw new ExecutionError(`Trading mode is ${policy.mode}; live orders need manual-live mode with the owner's acknowledgement.`, "mode_not_live", 409);
    if (!policy.liveAuthorizedAt) throw new ExecutionError("Live authorization is absent.", "not_authorized", 409);
    const binding = this.ctx.trading.connected();
    if (!binding) throw new ExecutionError("No connected Polymarket US account.", "not_connected", 409);
    const blockers = this.ctx.trading.dispatchBlockers();
    if (blockers.length) throw new ExecutionError(`New orders are blocked: ${blockers.join("; ")}.`, "dispatch_blocked", 409, blockers);
    if (decision.mode !== "manual_live" && decision.mode !== "auto_live") throw new ExecutionError(`The decision was evaluated in ${decision.mode} mode against the paper book, not the account; evaluate a new decision in manual-live mode.`, "decision_not_live", 409);
    if (decision.outcome === "skipped") throw new ExecutionError(`The decision was skipped: ${decision.reasonCodes.join(", ")}.`, "decision_not_eligible", 409);
    if (!decision.sizing) throw new ExecutionError("The decision has no sizing.", "decision_not_eligible", 409);
    const market = this.ctx.markets.get(decision.marketId);
    if (!market || market.provider !== "polymarket_us") throw new ExecutionError("The decision's market is not a Polymarket US contract.", "wrong_venue", 409);
    return { decision, policy, binding, market };
  }

  private requestFor(decision: NonNullable<ReturnType<AppContext["decisions"]["get"]>>, marketSlug: string, manual: boolean): OrderRequest {
    const s = decision.sizing!;
    return { marketSlug, side: s.side, action: "buy", yesPrice: s.wirePrice, quantity: s.quantity, timeInForce: "IOC", manual };
  }

  /** Re-run the pure decision with a fresh book and account state; compare the sizing with the stored decision (E02). */
  private async redecide(decisionId: string, pinnedNow: string | undefined, book?: DecisionBook) {
    const decision = this.ctx.decisions.get(decisionId)!;
    const market = this.ctx.markets.get(decision.marketId)!;
    const marketSlug = market.constraints?.slug ?? market.slug;
    const binding = this.ctx.trading.connected()!;
    const policy = this.ctx.trading.policy();
    const verification = decision.verificationId ? this.ctx.markets.getVerification(decision.verificationId) : undefined;
    const forecast = decision.forecastId ? this.ctx.forecasts.get(decision.forecastId) : undefined;
    let freshBook = book;
    if (!freshBook) { try { freshBook = await this.ctx.decisions.fetchBook(market); } catch { freshBook = undefined; } }
    let sync = this.ctx.trading.latestSync(binding.id, true);
    if (!sync || Date.parse(pinnedNow ?? this.now().toISOString()) - Date.parse(sync.at) > policy.limits.syncMaxAgeMs) { try { sync = await this.ctx.trading.sync(); } catch { /* stale sync fails the gate below */ } }
    // RV-03: the decision instant is taken after the book and account state were gathered (unless pinned by the caller).
    const now = pinnedNow ?? this.now().toISOString();
    const usd = sync?.balances.find((b) => b.currency === "USD");
    const exposure = this.ctx.risk.exposure(binding.id, decision.dailyBucket);
    const c = market.constraints;
    const input: DecisionInput = {
      now, mode: policy.mode, offline: !this.ctx.settings.getPersisted().privacy.allowInternet, limits: policy.limits,
      forecast: forecast ? { id: forecast.id, pYes: forecast.pYes, pNo: forecast.pNo, asOf: forecast.asOf, status: forecast.status, expiresAt: forecast.expiresAt, strategyVersion: forecast.strategyVersion, category: forecast.category } : undefined,
      authorization: policy.mode === "auto_live" ? { strategyVersion: policy.authorizedStrategyVersion, category: policy.authorizedCategory } : undefined,
      verification: verification ? { id: verification.id, version: verification.version, status: verification.status, staleAt: verification.staleAt, cutoffAt: verification.cutoffAt, cutoffUnknown: verification.cutoffUnknown, rulesHash: verification.rulesHash, sideId: verification.sideId } : undefined,
      contract: { venue: market.provider, venueMarketId: market.venueId, eventId: market.event?.id ?? c?.eventId, status: c?.status, active: market.active, closed: market.closed, tickSize: c?.tickSize, minQuantity: c?.minQuantity, rulesHash: verification?.rulesHash ? rulesHash(market.description) : undefined, sides: (c?.sides ?? []).map((x) => ({ id: x.id, label: x.label, long: x.long, tradable: x.tradable })) },
      book: freshBook, fee: this.ctx.decisions.feeFor(market),
      // Positions/orders arrive keyed by slug; the contract is compared by venue id (2.0.0-rc.2: mapped, not assumed equal).
      account: sync ? { syncAt: sync.at, complete: sync.complete, buyingPower: usd?.buyingPower?.value, positions: sync.positions.map((x) => ({ venueMarketId: this.venueMarketIdFor(x.marketSlug) ?? x.marketSlug, netQuantity: x.netQuantity, external: !this.ctx.db.get("SELECT 1 FROM venue_orders WHERE binding_id = ? AND intent_id IS NOT NULL AND market_slug = ?", binding.id, x.marketSlug) })), openOrders: sync.openOrders.filter((x) => !this.ctx.db.get<{ id: string }>("SELECT id FROM trade_intents WHERE venue_order_id = ?", x.id)).map((x) => ({ venueMarketId: this.venueMarketIdFor(x.marketSlug) ?? x.marketSlug, intent: x.intent, state: x.state })) } : { complete: false, positions: [], openOrders: [] },
      exposure: { openRiskTotal: exposure.openRiskTotal, dailyCommitted: exposure.dailyCommitted, dailyRealizedLoss: exposure.dailyRealizedLoss, openMarkets: exposure.openMarkets, perMarket: exposure.perMarket[market.venueId] ?? "0", perEvent: (market.event?.id ?? c?.eventId) ? exposure.perEvent[market.event?.id ?? c!.eventId!] ?? "0" : "0", unreflectedReservations: exposure.unreflectedReservations, marketAlreadyOpen: exposure.marketsOpen.has(market.venueId) },
      opportunityConsumed: !!this.ctx.risk.opportunityConsumed(binding.id, market.provider, market.venueId), candidateQuantity: decision.sizing?.quantity,
    };
    // The decision's own quantity is the ceiling: a fresh evaluation may only confirm it (or shrink it, which counts as a change).
    const evaluate = (inp: DecisionInput) => {
      const result = decide(inp);
      const s = decision.sizing!;
      const f = result.sizing;
      const sameSizing = !!f && f.side === s.side && D(f.quantity).eq(s.quantity) && D(f.wirePrice).eq(s.wirePrice) && D(f.worstCost).lte(s.worstCost);
      const diff = f ? { side: [s.side, f.side], quantity: [s.quantity, f.quantity], wirePrice: [s.wirePrice, f.wirePrice], worstCost: [s.worstCost, f.worstCost] } : undefined;
      return { result, sameSizing, diff };
    };
    const first = evaluate(input);
    /**
     * Re-run the same pure decision with the exposure and opportunity re-read *now* — called inside the reserving
     * transaction so that two confirmations racing on different contracts cannot both fit into the same remaining
     * capacity (the async book/sync reads above happened outside any transaction).
     */
    const recheck = () => {
      const e = this.ctx.risk.exposure(binding.id, decision.dailyBucket);
      const key = market.event?.id ?? c?.eventId;
      return evaluate({
        ...input,
        exposure: { openRiskTotal: e.openRiskTotal, dailyCommitted: e.dailyCommitted, dailyRealizedLoss: e.dailyRealizedLoss, openMarkets: e.openMarkets, perMarket: e.perMarket[market.venueId] ?? "0", perEvent: key ? e.perEvent[key] ?? "0" : "0", unreflectedReservations: e.unreflectedReservations, marketAlreadyOpen: e.marketsOpen.has(market.venueId) },
        opportunityConsumed: !!this.ctx.risk.opportunityConsumed(binding.id, market.provider, market.venueId),
      });
    };
    return { ...first, marketSlug, recheck, now };
  }

  private liveIntentFor(bindingId: string, provider: MarketProviderId, venueMarketId: string): TradeIntent | undefined {
    const r = this.ctx.db.get<IntentRow>(`SELECT * FROM trade_intents WHERE binding_id = ? AND provider = ? AND venue_market_id = ? AND (state IN (${LIVE_INTENT_STATES.map(() => "?").join(",")}) OR (state IN ('filled','partially_filled') )) ORDER BY created_at DESC LIMIT 1`, bindingId, provider, venueMarketId, ...LIVE_INTENT_STATES);
    return r ? this.hydrateIntent(r) : undefined;
  }

  private intentForOpportunity(bindingId: string, provider: MarketProviderId, venueMarketId: string): TradeIntent | undefined {
    const o = this.ctx.risk.opportunityConsumed(bindingId, provider, venueMarketId);
    return o ? this.intent(o.intentId) : undefined;
  }

  private consumePreview(id: string, by: NonNullable<OrderPreviewRecord["consumedBy"]>, at: string): void {
    this.ctx.db.run("UPDATE order_previews SET consumed_at = ?, consumed_by = ? WHERE id = ? AND consumed_at IS NULL", at, by, id);
  }

  private venueMarketIdFor(marketSlug: string): string | null {
    return this.ctx.db.get<{ venue_id: string }>("SELECT venue_id FROM markets WHERE provider = 'polymarket_us' AND (slug = ? OR venue_id = ?)", marketSlug, marketSlug)?.venue_id ?? null;
  }

  // ---- queries -----------------------------------------------------------------------------------------------

  /** D04: live intents attached (through their decisions) to a video, prediction or market — these block deletion. */
  liveLineage(f: { videoId?: string; predictionId?: string; marketId?: string }): string[] {
    if (f.videoId) return this.ctx.db.all<{ id: string }>("SELECT i.id FROM trade_intents i JOIN trade_decisions d ON d.id = i.decision_id JOIN predictions p ON p.id = d.prediction_id WHERE i.mode = 'live' AND p.video_id = ?", f.videoId).map((r) => r.id);
    if (f.predictionId) return this.ctx.db.all<{ id: string }>("SELECT i.id FROM trade_intents i JOIN trade_decisions d ON d.id = i.decision_id WHERE i.mode = 'live' AND d.prediction_id = ?", f.predictionId).map((r) => r.id);
    if (f.marketId) return this.ctx.db.all<{ id: string }>("SELECT i.id FROM trade_intents i JOIN trade_decisions d ON d.id = i.decision_id WHERE i.mode = 'live' AND d.market_id = ?", f.marketId).map((r) => r.id);
    return [];
  }

  intent(id: string): TradeIntent | undefined {
    const r = this.ctx.db.get<IntentRow>("SELECT * FROM trade_intents WHERE id = ?", id);
    return r ? this.hydrateIntent(r) : undefined;
  }

  intents(f: { bindingId?: string; state?: IntentState; mode?: "paper" | "live"; limit?: number } = {}): TradeIntent[] {
    const where: string[] = []; const args: unknown[] = [];
    if (f.bindingId) { where.push("binding_id = ?"); args.push(f.bindingId); }
    if (f.state) { where.push("state = ?"); args.push(f.state); }
    if (f.mode) { where.push("mode = ?"); args.push(f.mode); }
    args.push(f.limit ?? 200);
    return this.ctx.db.all<IntentRow>(`SELECT * FROM trade_intents ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`, ...args).map((r) => this.hydrateIntent(r));
  }

  order(id: string): VenueOrderRecord | undefined {
    const r = this.ctx.db.get<OrderRow>("SELECT * FROM venue_orders WHERE id = ?", id);
    return r ? hydrateOrder(r) : undefined;
  }

  orders(f: { bindingId?: string; external?: boolean; limit?: number } = {}): VenueOrderRecord[] {
    const where: string[] = []; const args: unknown[] = [];
    if (f.bindingId) { where.push("binding_id = ?"); args.push(f.bindingId); }
    if (f.external !== undefined) { where.push("external = ?"); args.push(f.external ? 1 : 0); }
    args.push(f.limit ?? 200);
    return this.ctx.db.all<OrderRow>(`SELECT * FROM venue_orders ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY first_seen_at DESC LIMIT ?`, ...args).map(hydrateOrder);
  }

  /** Executions are append-only; the intent lineage is read through the order (an order linked later carries its executions with it). */
  executions(orderId: string): ExecutionRecord[] {
    return this.ctx.db.all<ExecutionRow>("SELECT e.*, COALESCE(e.intent_id, o.intent_id) AS intent_id FROM executions e LEFT JOIN venue_orders o ON o.id = e.order_id WHERE e.order_id = ? ORDER BY e.at, e.received_at", orderId).map(hydrateExecution);
  }

  allExecutions(limit = 5000): ExecutionRecord[] {
    return this.ctx.db.all<ExecutionRow>("SELECT e.*, COALESCE(e.intent_id, o.intent_id) AS intent_id FROM executions e LEFT JOIN venue_orders o ON o.id = e.order_id ORDER BY e.received_at DESC LIMIT ?", limit).map(hydrateExecution);
  }

  settlements(limit = 1000): SettlementEventRecord[] {
    return this.ctx.db.all<{ id: string; market_id: string | null; venue_market_id: string; kind: SettlementEventRecord["kind"]; outcome: string | null; source: SettlementEventRecord["source"]; observed_at: string; details_json: string; binding_id: string | null; intent_id: string | null; amount: string | null }>("SELECT * FROM settlement_events ORDER BY observed_at DESC LIMIT ?", limit)
      .map((r) => ({ id: r.id, marketId: r.market_id ?? undefined, venueMarketId: r.venue_market_id, kind: r.kind, outcome: r.outcome ?? undefined, source: r.source, observedAt: r.observed_at, bindingId: r.binding_id ?? undefined, intentId: r.intent_id ?? undefined, amount: r.amount ?? undefined, details: JSON.parse(r.details_json) as Record<string, unknown> }));
  }

  private hydrateIntent(r: IntentRow): TradeIntent {
    return {
      id: r.id, decisionId: r.decision_id, reservationId: r.reservation_id, mode: r.mode, accountKey: r.account_key, provider: r.provider, venueMarketId: r.venue_market_id, side: r.side, sideId: r.side_id ?? undefined, quantity: r.quantity, wirePrice: r.wire_price, limitCost: r.limit_cost,
      timeInForce: r.time_in_force, state: r.state, payloadHash: r.payload_hash, filledQuantity: r.filled_quantity, createdAt: r.created_at, updatedAt: r.updated_at,
      bindingId: r.binding_id ?? undefined, venueOrderId: r.venue_order_id ?? undefined, previewId: r.preview_id ?? undefined, decisionHash: r.decision_hash ?? undefined, dispatchMarkerAt: r.dispatch_marker_at ?? undefined, submittedAt: r.submitted_at ?? undefined, acknowledgedAt: r.acknowledged_at ?? undefined,
      unknownReason: r.unknown_reason ?? undefined, lastError: r.last_error ?? undefined,
      order: r.venue_order_id ? this.order(r.venue_order_id) : undefined, executions: r.venue_order_id ? this.executions(r.venue_order_id) : undefined,
    };
  }
}

type TradingAdapter = import("../providers/trading/types.js").TradingAdapter;

/** Settlement label for a position: win/loss from the official outcome versus the sides we hold; void and corrections as reported. */
function settledOutcomeFor(kind: SettlementEventRecord["kind"], outcome: string | null, sides: ("yes" | "no" | null)[]): NonNullable<LivePosition["settled"]>["outcome"] {
  if (kind === "correction") return "correction";
  if (kind === "external_exit") return "external_exit";
  if (kind === "void" || (outcome !== "yes" && outcome !== "no")) return "void";
  return sides.some((s) => s === outcome) ? "win" : "loss";
}

function hydrateOrder(r: OrderRow): VenueOrderRecord {
  return {
    id: r.id, bindingId: r.binding_id, intentId: r.intent_id ?? undefined, external: r.external === 1, marketSlug: r.market_slug, venueMarketId: r.venue_market_id ?? undefined, side: r.side ?? undefined, intentRaw: r.intent_raw ?? undefined, stateRaw: r.state_raw ?? undefined, state: r.state,
    quantity: r.quantity ?? undefined, filledQuantity: r.filled_quantity, leavesQuantity: r.leaves_quantity ?? undefined, yesPrice: r.yes_price ?? undefined, avgPrice: r.avg_price ?? undefined, fees: r.fees ?? undefined, venueCreatedAt: r.venue_created_at ?? undefined, updatedAt: r.updated_at, firstSeenAt: r.first_seen_at,
    cancelRequestedAt: r.cancel_requested_at ?? undefined, rejectReason: r.reject_reason ?? undefined,
  };
}
function hydrateExecution(r: ExecutionRow): ExecutionRecord {
  return { id: r.id, orderId: r.order_id, intentId: r.intent_id ?? undefined, tradeId: r.trade_id ?? undefined, type: r.type, quantity: r.quantity ?? undefined, yesPrice: r.yes_price ?? undefined, chosenCost: r.chosen_cost ?? undefined, fee: r.fee ?? undefined, at: r.at ?? undefined, source: r.source, note: r.note ?? undefined, receivedAt: r.received_at };
}
function hydratePreview(r: PreviewRow): OrderPreviewRecord {
  return { id: r.id, decisionId: r.decision_id, decisionHash: r.decision_hash, request: JSON.parse(r.request_json) as Record<string, unknown>, venue: r.venue_json ? (JSON.parse(r.venue_json) as Record<string, unknown>) : undefined, display: JSON.parse(r.display_json) as OrderPreviewRecord["display"], expiresAt: r.expires_at, createdAt: r.created_at, consumedAt: r.consumed_at ?? undefined, consumedBy: r.consumed_by ?? undefined };
}
function hydrateHold(r: HoldRow): ReconciliationHold {
  return { id: r.id, bindingId: r.binding_id, kind: r.kind, subject: r.subject ?? undefined, detail: JSON.parse(r.detail_json) as Record<string, unknown>, openedAt: r.opened_at, resolvedAt: r.resolved_at ?? undefined, resolution: r.resolution ?? undefined };
}
