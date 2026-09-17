/**
 * Prediction Ledger — trade decisions with atomic reservations and paper dispatch (1.12, RSK-01…07, FOR-08).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * `evaluate` gathers the inputs (verified link, contract, fresh book, forecast, account or paper bankroll, exposure,
 * policy), then — inside ONE SQLite transaction — recomputes exposure, runs the pure decision, persists it with
 * every input and a rationale hash, and, when eligible in paper mode, inserts the reservation, the intent and
 * consumes the contract's single entry opportunity. Two concurrent evaluations therefore cannot both fit into the
 * same remaining capacity (R07). Paper dispatch then simulates an IOC fill against the same book, records the
 * position and settles the reservation (filled part consumed, remainder released).
 *
 * No live path exists here: a live mode never dispatches (1.13), and the trading adapter is never called.
 */

import crypto from "node:crypto";
import type { DecisionOutcome, MarketRecord, TradeDecision, TradeIntent, TradingMode } from "@prediction-ledger/shared";
import type { AppContext } from "../context.js";
import { D } from "../analysis/decimal.js";
import { simulateIocFill } from "../analysis/paperFill.js";
import { dailyBucket, decide, decisionInputsRecord, type DecisionAccount, type DecisionBook, type DecisionInput, type FeeSchedule } from "../analysis/tradeDecision.js";
import { rulesHash } from "../analysis/contractVerification.js";
import { createMarketProvider } from "../providers/markets/registry.js";
import { usTokenId } from "../providers/markets/polymarketUs.js";

export class DecisionError extends Error {
  constructor(message: string, public readonly code: string, public readonly httpStatus = 409) { super(message); this.name = "DecisionError"; }
}

export interface EvaluateOptions {
  predictionId: string;
  linkId?: string;
  /** Controllable clock (RSK-03). Defaults to the service clock. */
  now?: string;
  /** Injected book (tests, replays). Fetched from the venue when absent. */
  book?: DecisionBook;
  /** Injected fee schedule; derived from the contract's coefficient when absent. */
  fee?: FeeSchedule;
  candidateQuantity?: string;
  /** Paper dispatch after an eligible decision (default true). */
  dispatch?: boolean;
  /** Reuse a fresh forecast when one exists (default true); false always builds a new snapshot. */
  reuseForecast?: boolean;
  /** Simulated latency for paper fills. */
  latencyMs?: number;
}

interface DecisionRow {
  id: string; created_at: string; clock_at: string; mode: TradingMode; prediction_id: string; market_id: string; venue_market_id: string; event_id: string | null; link_id: string | null; verification_id: string | null; forecast_id: string | null;
  policy_version: string; policy_hash: string | null; currency: string; budget_timezone: string; daily_bucket: string; outcome: DecisionOutcome; side: "yes" | "no" | null; side_id: string | null; side_label: string | null; p_chosen: string | null;
  quantity: string | null; limit_cost: string | null; wire_price: string | null; fee_bound: string | null; worst_cost: string | null; net_edge: string | null; estimated_ev: string | null; bound_by: string | null; gates_json: string; reason_codes_json: string; inputs_json: string; rationale_hash: string;
  reservation_id: string | null; intent_id: string | null;
}
interface IntentRow {
  id: string; decision_id: string; reservation_id: string; mode: "paper" | "live"; account_key: string; provider: TradeIntent["provider"]; venue_market_id: string; side: "yes" | "no"; side_id: string | null; quantity: string; wire_price: string; limit_cost: string;
  time_in_force: "IOC"; state: TradeIntent["state"]; payload_hash: string; filled_quantity: string; dispatch_marker_at: string | null; created_at: string; updated_at: string;
}

export class TradeDecisionService {
  private readonly now: () => Date;
  constructor(private readonly ctx: AppContext, opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  /** Fee schedule from the contract's published coefficient at retrieval time (never frozen in code). */
  feeFor(market: MarketRecord): FeeSchedule {
    const c = market.constraints;
    return c?.feeCoefficient ? { kind: "coefficient", value: c.feeCoefficient, effectiveAt: c.retrievedAt } : { kind: "coefficient" };
  }

  async fetchBook(market: MarketRecord, signal?: AbortSignal): Promise<DecisionBook> {
    const s = this.ctx.settings.getPersisted();
    if (!s.markets.enabled || !s.privacy.allowInternet) throw new DecisionError("Prediction markets or internet access are turned off in Setup; no fresh book.", "offline");
    const slug = market.constraints?.slug ?? market.slug;
    const b = await createMarketProvider("polymarket_us").book(usTokenId(slug, "YES"), signal);
    const lvl = (x: { price: number; size: number }) => ({ price: D(x.price.toFixed(6)).toString(), size: D(x.size.toFixed(6)).toString() });
    return { retrievedAt: b.retrievedAt, bids: b.bids.map(lvl), asks: b.asks.map(lvl) };
  }

  async evaluate(o: EvaluateOptions): Promise<TradeDecision> {
    // RV-03: when the caller did not pin the instant, the decision's `now` is taken AFTER its asynchronous inputs
    // (book, forecast build) have been gathered, so a book fetched in this very call is never "from the future".
    let now = o.now ?? this.now().toISOString();
    const p = this.ctx.predictions.get(o.predictionId);
    if (!p) throw new DecisionError("Prediction not found.", "not_found", 404);
    const link = o.linkId ? this.ctx.markets.getLink(o.linkId) : this.ctx.markets.executableLinks(p.id)[0] ?? this.ctx.markets.linksForPrediction(p.id, false).find((l) => l.status === "accepted" && l.market?.provider === "polymarket_us");
    if (!link || link.predictionId !== p.id) throw new DecisionError("No Polymarket US link for this prediction. Find US contracts and verify one first.", "no_link");
    const market = this.ctx.markets.get(link.marketId);
    if (!market) throw new DecisionError("Market no longer stored.", "not_found", 404);
    const policy = this.ctx.trading.policy();
    const settings = this.ctx.settings.getPersisted();
    const verification = this.ctx.markets.latestVerification(link.id);
    const mode = policy.mode;
    const accountKey = mode === "paper" ? "paper" : this.ctx.trading.connected()?.id ?? "unbound";
    const c = market.constraints;

    // Async inputs first (book, forecast); nothing has been decided or reserved yet.
    let book: DecisionBook | undefined = o.book;
    if (!book && market.provider === "polymarket_us" && settings.markets.enabled && settings.privacy.allowInternet) {
      try { book = await this.fetchBook(market); } catch { book = undefined; }
    }
    if (!o.now) now = this.now().toISOString();
    const fee = o.fee ?? this.feeFor(market);
    let forecast = o.reuseForecast === false ? undefined : this.ctx.forecasts.latestUsable(p.id, link.id, now, verification?.id, policy.limits.forecastMaxAgeMs);
    if (!forecast && market.provider === "polymarket_us" && verification) {
      try { forecast = this.ctx.forecasts.build({ predictionId: p.id, linkId: link.id, asOf: now, book, forecastMaxAgeMs: policy.limits.forecastMaxAgeMs }); } catch { forecast = undefined; }
    }
    const account: DecisionAccount | undefined = mode === "paper" ? undefined : this.accountSnapshot();
    const bucket = dailyBucket(now, policy.budgetTimezone);

    // Decide + persist + reserve atomically.
    const result = this.ctx.db.transaction(() => {
      const exposure = this.ctx.risk.exposure(accountKey, bucket);
      const consumed = this.ctx.risk.opportunityConsumed(accountKey, market.provider, market.venueId);
      const paperBook = mode === "paper" ? this.ctx.paperUs.book() : undefined;
      const input: DecisionInput = {
        now, mode, offline: !settings.privacy.allowInternet, limits: policy.limits,
        forecast: forecast ? { id: forecast.id, pYes: forecast.pYes, pNo: forecast.pNo, asOf: forecast.asOf, status: forecast.status, expiresAt: forecast.expiresAt, strategyVersion: forecast.strategyVersion, category: forecast.category } : undefined,
        authorization: mode === "auto_live" ? { strategyVersion: policy.authorizedStrategyVersion, category: policy.authorizedCategory } : undefined,
        verification: verification ? { id: verification.id, version: verification.version, status: verification.status, staleAt: verification.staleAt, cutoffAt: verification.cutoffAt, cutoffUnknown: verification.cutoffUnknown, rulesHash: verification.rulesHash, sideId: verification.sideId } : undefined,
        contract: { venue: market.provider, venueMarketId: market.venueId, eventId: market.event?.id ?? c?.eventId, status: c?.status, active: market.active, closed: market.closed, tickSize: c?.tickSize, minQuantity: c?.minQuantity, rulesHash: verification?.rulesHash ? rulesHash(market.description) : undefined, sides: (c?.sides ?? []).map((s) => ({ id: s.id, label: s.label, long: s.long, tradable: s.tradable })) },
        book, fee, account, paperBuyingPower: paperBook?.bankroll,
        exposure: { openRiskTotal: exposure.openRiskTotal, dailyCommitted: exposure.dailyCommitted, dailyRealizedLoss: exposure.dailyRealizedLoss, openMarkets: exposure.openMarkets, perMarket: exposure.perMarket[market.venueId] ?? "0", perEvent: (market.event?.id ?? c?.eventId) ? exposure.perEvent[market.event?.id ?? c!.eventId!] ?? "0" : "0", unreflectedReservations: exposure.unreflectedReservations, marketAlreadyOpen: exposure.marketsOpen.has(market.venueId) },
        opportunityConsumed: !!consumed, candidateQuantity: o.candidateQuantity,
      };
      const r = decide(input);
      const inputs = decisionInputsRecord(input, r);
      const id = crypto.randomUUID();
      const rationale = { id, predictionId: p.id, marketId: market.id, forecastId: forecast?.id, forecastHash: forecast?.hash, verificationId: verification?.id, policyHash: policy.policyHash, outcome: r.outcome, sizing: r.sizing, gates: r.gates, inputs };
      const rationaleHash = crypto.createHash("sha256").update(JSON.stringify(rationale)).digest("hex");
      const s = r.sizing;
      this.ctx.db.run(
        `INSERT INTO trade_decisions (id, created_at, clock_at, mode, prediction_id, market_id, venue_market_id, event_id, link_id, verification_id, forecast_id, policy_version, policy_hash, currency, budget_timezone, daily_bucket, outcome,
           side, side_id, side_label, p_chosen, quantity, limit_cost, wire_price, fee_bound, worst_cost, net_edge, estimated_ev, bound_by, gates_json, reason_codes_json, inputs_json, rationale_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, this.now().toISOString(), now, mode, p.id, market.id, market.venueId, market.event?.id ?? c?.eventId ?? null, link.id, verification?.id ?? null, forecast?.id ?? null, policy.policyVersion, policy.policyHash, policy.limits.currency, policy.budgetTimezone, bucket, r.outcome,
        s?.side ?? null, s?.sideId ?? null, s?.sideLabel ?? null, s?.pChosen ?? null, s?.quantity ?? null, s?.limitCost ?? null, s?.wirePrice ?? null, s?.feeBound ?? null, s?.worstCost ?? null, s?.netEdge ?? null, s?.estimatedEv ?? null, s?.boundBy ?? null,
        JSON.stringify(r.gates), JSON.stringify(r.reasonCodes), JSON.stringify(inputs), rationaleHash,
      );
      let intentId: string | undefined;
      let reservationId: string | undefined;
      if (r.outcome === "eligible" && s && mode === "paper" && o.dispatch !== false) {
        const res = this.ctx.risk.insert({ decisionId: id, accountKey, provider: market.provider, venueMarketId: market.venueId, eventId: market.event?.id ?? c?.eventId, amount: s.worstCost, dailyBucket: bucket, now, note: `worst cost of ${s.quantity} × ${s.limitCost} + fees ${s.feeBound}` });
        reservationId = res.id;
        intentId = crypto.randomUUID();
        const payload = { venue: market.provider, marketSlug: c?.slug ?? market.slug, side: s.side, sideId: s.sideId, quantity: s.quantity, price: s.wirePrice, tif: "IOC" };
        this.ctx.db.run(
          "INSERT INTO trade_intents (id, decision_id, reservation_id, mode, account_key, provider, venue_market_id, side, side_id, quantity, wire_price, limit_cost, time_in_force, state, payload_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'IOC', 'reserved', ?, ?, ?)",
          intentId, id, res.id, "paper", accountKey, market.provider, market.venueId, s.side, s.sideId ?? null, s.quantity, s.wirePrice, s.limitCost, crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex"), now, now,
        );
        this.ctx.risk.consumeOpportunity(accountKey, market.provider, market.venueId, intentId, now);
        this.ctx.db.run("UPDATE trade_decisions SET reservation_id = ?, intent_id = ? WHERE id = ?", res.id, intentId, id);
      }
      return { id, intentId, reservationId, sizing: s, book };
    });

    if (result.intentId && result.sizing && result.book) this.dispatchPaper(result.intentId, result.book, fee, now, o.latencyMs ?? 0);
    return this.get(result.id)!;
  }

  /** Paper execution: IOC against the decision's book; filled part consumes the reservation, the remainder is released. */
  private dispatchPaper(intentId: string, book: DecisionBook, fee: FeeSchedule, now: string, latencyMs: number): void {
    const intent = this.getIntent(intentId)!;
    const decision = this.ctx.db.get<DecisionRow>("SELECT * FROM trade_decisions WHERE id = ?", intent.decisionId)!;
    const market = this.ctx.markets.get(decision.market_id)!;
    this.ctx.db.run("UPDATE trade_intents SET state = 'submitting', dispatch_marker_at = ?, updated_at = ? WHERE id = ?", now, now, intentId);
    const sim = simulateIocFill({ side: intent.side, wirePrice: intent.wirePrice, quantity: intent.quantity, quantityIncrement: market.constraints?.minQuantity ?? "1", book, fee, latencyMs });
    this.ctx.db.transaction(() => {
      const position = this.ctx.paperUs.recordFills({ intentId, decisionId: intent.decisionId, marketId: market.id, venueMarketId: market.venueId, side: intent.side, sideId: intent.sideId, sim });
      const state = D(sim.filledQuantity).isZero() ? "canceled" : D(sim.remainderCanceled).isPos() ? "partially_filled" : "filled";
      this.ctx.db.run("UPDATE trade_intents SET state = ?, filled_quantity = ?, updated_at = ? WHERE id = ?", state, sim.filledQuantity, sim.filledAt, intentId);
      this.ctx.risk.settleFill(intent.reservationId, sim.allIn, sim.filledAt, sim.note);
      this.ctx.trading.audit("paper.intent_executed", undefined, { intentId, state, filled: sim.filledQuantity, canceled: sim.remainderCanceled, allIn: sim.allIn, positionId: position?.id, method: "us-ioc-v1" });
    });
  }

  private accountSnapshot(): DecisionAccount | undefined {
    const binding = this.ctx.trading.connected();
    if (!binding) return undefined;
    const sync = this.ctx.trading.latestSync(binding.id, true);
    if (!sync) return { complete: false, positions: [], openOrders: [] };
    const usd = sync.balances.find((b) => b.currency === "USD");
    // The venue keys positions and orders by market SLUG; decisions compare against the stored market's venue id
    // (2.0.0-rc.2: found while adding external holdings — the slug/id mismatch had made the on-contract gates inert).
    const idFor = (slug: string) => this.ctx.db.get<{ venue_id: string }>("SELECT venue_id FROM markets WHERE provider = 'polymarket_us' AND (slug = ? OR venue_id = ?)", slug, slug)?.venue_id ?? slug;
    return {
      syncAt: sync.at, complete: sync.complete, buyingPower: usd?.buyingPower?.value,
      positions: sync.positions.map((x) => ({ venueMarketId: idFor(x.marketSlug), netQuantity: x.netQuantity, external: !this.ctx.db.get("SELECT 1 FROM venue_orders WHERE binding_id = ? AND intent_id IS NOT NULL AND market_slug = ?", binding.id, x.marketSlug) })),
      openOrders: sync.openOrders.map((x) => ({ venueMarketId: idFor(x.marketSlug), intent: x.intent, state: x.state })),
    };
  }

  /** Settle paper positions when a stored market shows an official resolution (called after snapshot refreshes). */
  settleResolved(marketId: string, at = this.now().toISOString()): number {
    const market = this.ctx.markets.get(marketId);
    if (!market || !market.resolved) return 0;
    const outcome = this.ctx.forecasts.outcomeOf(market, at);
    if (outcome === "pending") return 0;
    const existing = this.ctx.db.get<{ id: string }>("SELECT id FROM settlement_events WHERE venue_market_id = ? AND kind IN ('resolved','void')", market.venueId);
    if (!existing) this.ctx.db.run("INSERT INTO settlement_events (id, market_id, venue_market_id, kind, outcome, source, observed_at, details_json) VALUES (?, ?, ?, ?, ?, 'venue_market_status', ?, ?)", crypto.randomUUID(), market.id, market.venueId, outcome === "void" ? "void" : "resolved", outcome === "void" ? null : outcome, market.resolvedAt ?? at, JSON.stringify({ resolvedOutcome: market.resolvedOutcome }));
    return this.ctx.paperUs.settle(market.id, outcome, at).length;
  }

  get(id: string): TradeDecision | undefined {
    const r = this.ctx.db.get<DecisionRow>("SELECT * FROM trade_decisions WHERE id = ?", id);
    return r ? this.hydrate(r) : undefined;
  }

  list(f: { mode?: TradingMode; outcome?: DecisionOutcome; from?: string; to?: string; predictionId?: string; limit?: number } = {}): TradeDecision[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.mode) { where.push("mode = ?"); args.push(f.mode); }
    if (f.outcome) { where.push("outcome = ?"); args.push(f.outcome); }
    if (f.from) { where.push("clock_at >= ?"); args.push(f.from); }
    if (f.to) { where.push("clock_at <= ?"); args.push(f.to); }
    if (f.predictionId) { where.push("prediction_id = ?"); args.push(f.predictionId); }
    args.push(f.limit ?? 200);
    return this.ctx.db.all<DecisionRow>(`SELECT * FROM trade_decisions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY clock_at DESC LIMIT ?`, ...args).map((r) => this.hydrate(r));
  }

  getIntent(id: string): TradeIntent | undefined {
    const r = this.ctx.db.get<IntentRow>("SELECT * FROM trade_intents WHERE id = ?", id);
    return r ? hydrateIntent(r) : undefined;
  }

  private hydrate(r: DecisionRow): TradeDecision {
    const m = this.ctx.db.get<{ question: string; url: string }>("SELECT question, url FROM markets WHERE id = ?", r.market_id);
    const intent = r.intent_id ? this.getIntent(r.intent_id) : undefined;
    return {
      id: r.id, createdAt: r.created_at, clockAt: r.clock_at, mode: r.mode, predictionId: r.prediction_id, marketId: r.market_id, venueMarketId: r.venue_market_id, eventId: r.event_id ?? undefined, linkId: r.link_id ?? undefined,
      verificationId: r.verification_id ?? undefined, forecastId: r.forecast_id ?? undefined, policyVersion: r.policy_version, policyHash: r.policy_hash ?? undefined, currency: r.currency, budgetTimezone: r.budget_timezone, dailyBucket: r.daily_bucket, outcome: r.outcome,
      sizing: r.side && r.quantity ? { side: r.side, sideId: r.side_id ?? undefined, sideLabel: r.side_label ?? undefined, pChosen: r.p_chosen!, quantity: r.quantity, limitCost: r.limit_cost!, wirePrice: r.wire_price!, feeBound: r.fee_bound!, worstCost: r.worst_cost!, netEdge: r.net_edge!, estimatedEv: r.estimated_ev!, boundBy: r.bound_by ?? "" } : undefined,
      gates: JSON.parse(r.gates_json) as TradeDecision["gates"], reasonCodes: JSON.parse(r.reason_codes_json) as string[], inputs: JSON.parse(r.inputs_json) as Record<string, unknown>, rationaleHash: r.rationale_hash,
      reservationId: r.reservation_id ?? undefined, intentId: r.intent_id ?? undefined, question: m?.question, marketUrl: m?.url, intent, paperPosition: r.intent_id ? this.ctx.paperUs.byIntent(r.intent_id) : undefined,
    };
  }
}

function hydrateIntent(r: IntentRow): TradeIntent {
  return {
    id: r.id, decisionId: r.decision_id, reservationId: r.reservation_id, mode: r.mode, accountKey: r.account_key, provider: r.provider, venueMarketId: r.venue_market_id, side: r.side, sideId: r.side_id ?? undefined, quantity: r.quantity, wirePrice: r.wire_price, limitCost: r.limit_cost,
    timeInForce: r.time_in_force, state: r.state, payloadHash: r.payload_hash, filledQuantity: r.filled_quantity, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
