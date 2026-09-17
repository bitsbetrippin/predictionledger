/**
 * Prediction Ledger — risk exposure and atomic reservations (1.12, RSK-05/06/07).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Capacity is reserved in SQLite before anything is dispatched: exposure is recomputed and the reservation row is
 * inserted inside one transaction, so two concurrent decisions cannot both fit into the same remaining capacity.
 * A reservation carries the daily bucket it was made in; filled commitment is consumed for good (a winning
 * settlement or returned cash never replenishes the day's allowance); only a confirmed unfilled remainder is
 * released.
 */

import crypto from "node:crypto";
import type { MarketProviderId, RiskExposure, RiskReservation } from "@prediction-ledger/shared";
import type { Database } from "../db/index.js";
import { D, Dec, dsum } from "../analysis/decimal.js";
import { dailyBucket as bucketOf } from "../analysis/tradeDecision.js";

interface ReservationRow {
  id: string; decision_id: string; account_key: string; provider: MarketProviderId; venue_market_id: string; event_id: string | null; amount: string; filled_amount: string; daily_bucket: string;
  state: RiskReservation["state"]; acknowledged: number; created_at: string; updated_at: string; released_at: string | null; note: string | null;
}

export class RiskService {
  constructor(private readonly db: Database) {}

  /**
   * What the account has at stake right now (open positions + live reservations), what today's bucket has committed
   * (reserved + filled, released remainders excluded), today's realized loss, and per-market / per-event totals.
   */
  exposure(accountKey: string, dailyBucket: string, opts: { currency?: string; timezone?: string } = {}): RiskExposure & { unreflectedReservations: string; marketsOpen: Set<string> } {
    const reserved = this.db.all<ReservationRow>("SELECT * FROM risk_reservations WHERE account_key = ? AND state = 'reserved'", accountKey);
    const positions = accountKey === "paper" ? this.paperPositions() : this.livePositions(accountKey);
    const eventOf = new Map<string, string | undefined>();
    for (const p of positions) {
      const m = p.market_id ? this.db.get<{ event_id: string | null }>("SELECT event_id FROM markets WHERE id = ?", p.market_id) : this.db.get<{ event_id: string | null }>("SELECT event_id FROM markets WHERE provider = 'polymarket_us' AND venue_id = ?", p.venue_market_id);
      eventOf.set(p.venue_market_id, m?.event_id ?? undefined);
    }
    const perMarket = new Map<string, Dec>();
    const perEvent = new Map<string, Dec>();
    const add = (map: Map<string, Dec>, key: string | undefined, amt: Dec) => { if (key) map.set(key, (map.get(key) ?? Dec.ZERO).add(amt)); };
    let open = Dec.ZERO;
    for (const r of reserved) { const a = D(r.amount); open = open.add(a); add(perMarket, r.venue_market_id, a); add(perEvent, r.event_id ?? undefined, a); }
    for (const p of positions) { const a = D(p.cost_total).add(p.fees); open = open.add(a); add(perMarket, p.venue_market_id, a); add(perEvent, eventOf.get(p.venue_market_id), a); }
    const bucketRows = this.db.all<ReservationRow>("SELECT * FROM risk_reservations WHERE account_key = ? AND daily_bucket = ?", accountKey, dailyBucket);
    const dailyCommitted = dsum(bucketRows.map((r) => (r.state === "reserved" ? D(r.amount) : D(r.filled_amount))));
    // RV-06 (2.0): the settlement's day is its observed instant expressed in the BUDGET timezone — the same bucket rule
    // as commitments — never the UTC date of the stored instant. The candidate window is generous; the bucket decides.
    const tz = opts.timezone ?? this.db.get<{ budget_timezone: string }>("SELECT budget_timezone FROM trading_policy LIMIT 1")?.budget_timezone ?? "UTC";
    const dayOf = (instant: string | null) => { try { return instant ? bucketOf(instant, tz) : undefined; } catch { return undefined; } };
    const lossRows = (accountKey === "paper"
      ? this.db.all<{ pnl: string | null; at: string | null }>("SELECT pnl, settled_at AS at FROM paper_us_positions WHERE status = 'settled' AND settled_at >= date(?, '-2 days') AND settled_at < date(?, '+2 days')", dailyBucket, dailyBucket)
      // Live (1.13): only official settlements carry a per-intent amount; the day is the settlement's observed day.
      : this.db.all<{ pnl: string | null; at: string | null }>("SELECT amount AS pnl, observed_at AS at FROM settlement_events WHERE binding_id = ? AND intent_id IS NOT NULL AND amount IS NOT NULL AND observed_at >= date(?, '-2 days') AND observed_at < date(?, '+2 days')", accountKey, dailyBucket, dailyBucket)
    ).filter((r) => dayOf(r.at) === dailyBucket);
    const net = dsum(lossRows.map((r) => D(r.pnl ?? "0")));
    const dailyRealizedLoss = net.isNeg() ? net.neg() : Dec.ZERO;
    // 2.0.0-rc.2 (RSK-06): holdings the app did not place count toward total / per-market / per-event risk, conservatively.
    const externalHoldings = accountKey === "paper" ? [] : this.externalHoldings(accountKey);
    for (const h of externalHoldings) { const a = D(h.amount); open = open.add(a); add(perMarket, h.venueMarketId, a); add(perEvent, eventOf.get(h.venueMarketId) ?? this.eventFor(h.venueMarketId), a); }
    const externalRiskTotal = dsum(externalHoldings.map((h) => D(h.amount)));
    const marketsOpen = new Set<string>([...reserved.map((r) => r.venue_market_id), ...positions.map((p) => p.venue_market_id)]);
    const unreflected = dsum(reserved.filter((r) => r.acknowledged === 0).map((r) => D(r.amount)));
    return {
      accountKey,
      currency: opts.currency ?? "USD",
      dailyBucket,
      openRiskTotal: open.toString(),
      dailyCommitted: dailyCommitted.toString(),
      dailyRealizedLoss: dailyRealizedLoss.toString(),
      openMarkets: marketsOpen.size,
      perMarket: Object.fromEntries([...perMarket].map(([k, v]) => [k, v.toString()])),
      perEvent: Object.fromEntries([...perEvent].map(([k, v]) => [k, v.toString()])),
      pendingUnknown: this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trade_intents WHERE account_key = ? AND state = 'submission_unknown'", accountKey)?.n ?? 0,
      unreflectedReservations: unreflected.toString(),
      externalHoldings, externalRiskTotal: externalRiskTotal.toString(),
      marketsOpen,
    };
  }

  private paperPositions(): { venue_market_id: string; cost_total: string; fees: string; market_id: string | null }[] {
    return this.db.all<{ venue_market_id: string; cost_total: string; fees: string; market_id: string }>("SELECT venue_market_id, cost_total, fees, market_id FROM paper_us_positions WHERE status = 'open'");
  }

  /**
   * Live (1.13): an acknowledged order of ours with fills whose reservation has been consumed and whose market has no
   * official settlement yet is an open position: filled × chosen cost (venue average price) + fees.
   */
  /**
   * Venue positions on markets where the app has no order of its own (2.0.0-rc.2): from the latest successful sync,
   * valued at the venue's cost basis when it reports one, else at $1 per contract (the most a binary contract can lose).
   */
  externalHoldings(bindingId: string): RiskExposure["externalHoldings"] {
    const sync = this.db.get<{ positions_json: string }>("SELECT positions_json FROM trading_account_syncs WHERE binding_id = ? AND ok = 1 ORDER BY at DESC LIMIT 1", bindingId);
    if (!sync) return [];
    const positions = JSON.parse(sync.positions_json) as { marketSlug: string; netQuantity: string; cost?: { value: string } }[];
    const out: RiskExposure["externalHoldings"] = [];
    for (const p of positions) {
      const qty = D(p.netQuantity);
      if (qty.isZero()) continue;
      if (this.db.get("SELECT 1 FROM venue_orders WHERE binding_id = ? AND intent_id IS NOT NULL AND market_slug = ?", bindingId, p.marketSlug)) continue;
      const key = this.db.get<{ venue_id: string }>("SELECT venue_id FROM markets WHERE provider = 'polymarket_us' AND (slug = ? OR venue_id = ?)", p.marketSlug, p.marketSlug)?.venue_id ?? p.marketSlug;
      const cost = p.cost?.value ? D(p.cost.value) : undefined;
      const basis: "cost" | "worst_case" = cost && cost.isPos() ? "cost" : "worst_case";
      const amount = basis === "cost" ? cost! : (qty.isNeg() ? qty.neg() : qty);
      out.push({ venueMarketId: key, marketSlug: p.marketSlug, netQuantity: qty.toString(), amount: amount.round(2).toString(), basis });
    }
    return out;
  }

  private eventFor(venueMarketId: string): string | undefined {
    return this.db.get<{ event_id: string | null }>("SELECT event_id FROM markets WHERE provider = 'polymarket_us' AND venue_id = ?", venueMarketId)?.event_id ?? undefined;
  }

  private livePositions(bindingId: string): { venue_market_id: string; cost_total: string; fees: string; market_id: string | null }[] {
    const rows = this.db.all<{ id: string; market_slug: string; venue_market_id: string | null; side: "yes" | "no" | null; filled_quantity: string; avg_price: string | null; yes_price: string | null; fees: string | null; intent_id: string }>(
      // Orders whose reservation is still 'reserved' are covered by the reservation itself (no double count).
      "SELECT o.id, o.market_slug, o.venue_market_id, o.side, o.filled_quantity, o.avg_price, o.yes_price, o.fees, o.intent_id FROM venue_orders o JOIN trade_intents i ON i.id = o.intent_id JOIN risk_reservations r ON r.id = i.reservation_id WHERE o.binding_id = ? AND r.state = 'consumed' AND CAST(o.filled_quantity AS REAL) > 0", bindingId,
    );
    const out: { venue_market_id: string; cost_total: string; fees: string; market_id: string | null }[] = [];
    for (const o of rows) {
      if (this.db.get<{ id: string }>("SELECT id FROM settlement_events WHERE intent_id = ?", o.intent_id)) continue;
      const price = o.avg_price ?? o.yes_price;
      if (!price || !o.side) continue;
      const chosen = o.side === "yes" ? D(price) : Dec.ONE.sub(price);
      const key = o.venue_market_id ?? this.db.get<{ venue_id: string }>("SELECT venue_id FROM markets WHERE provider = 'polymarket_us' AND (slug = ? OR venue_id = ?)", o.market_slug, o.market_slug)?.venue_id ?? o.market_slug;
      out.push({ venue_market_id: key, cost_total: chosen.mul(o.filled_quantity).toString(), fees: o.fees ?? "0", market_id: null });
    }
    return out;
  }

  /** Insert a reservation. Callers run this inside the same transaction as the exposure check that sized it. */
  insert(input: { decisionId: string; accountKey: string; provider: MarketProviderId; venueMarketId: string; eventId?: string; amount: string; dailyBucket: string; now: string; note?: string }): RiskReservation {
    const id = crypto.randomUUID();
    this.db.run(
      "INSERT INTO risk_reservations (id, decision_id, account_key, provider, venue_market_id, event_id, amount, daily_bucket, state, created_at, updated_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)",
      id, input.decisionId, input.accountKey, input.provider, input.venueMarketId, input.eventId ?? null, D(input.amount).toString(), input.dailyBucket, input.now, input.now, input.note ?? null,
    );
    return this.get(id)!;
  }

  /** Fills consumed `filledAmount`; the remainder (if any) is released. Consumed amounts stay in the day's bucket. */
  settleFill(id: string, filledAmount: string, now: string, note?: string): RiskReservation | undefined {
    const r = this.get(id);
    if (!r || r.state !== "reserved") return r;
    const filled = D(filledAmount);
    const state = filled.isPos() ? "consumed" : "released";
    this.db.run("UPDATE risk_reservations SET state = ?, filled_amount = ?, released_at = ?, updated_at = ?, note = COALESCE(?, note) WHERE id = ?", state, filled.toString(), now, now, note ?? null, id);
    return this.get(id);
  }

  release(id: string, now: string, note: string): RiskReservation | undefined {
    const r = this.get(id);
    if (!r || r.state !== "reserved") return r;
    this.db.run("UPDATE risk_reservations SET state = 'released', released_at = ?, updated_at = ?, note = ? WHERE id = ?", now, now, note, id);
    return this.get(id);
  }

  get(id: string): RiskReservation | undefined {
    const r = this.db.get<ReservationRow>("SELECT * FROM risk_reservations WHERE id = ?", id);
    return r ? hydrate(r) : undefined;
  }

  list(accountKey: string, limit = 200): RiskReservation[] {
    return this.db.all<ReservationRow>("SELECT * FROM risk_reservations WHERE account_key = ? ORDER BY created_at DESC LIMIT ?", accountKey, limit).map(hydrate);
  }

  opportunityConsumed(accountKey: string, provider: MarketProviderId, venueMarketId: string): { intentId: string; consumedAt: string } | undefined {
    const r = this.db.get<{ intent_id: string; consumed_at: string }>("SELECT intent_id, consumed_at FROM trade_opportunities WHERE account_key = ? AND provider = ? AND venue_market_id = ?", accountKey, provider, venueMarketId);
    return r ? { intentId: r.intent_id, consumedAt: r.consumed_at } : undefined;
  }

  /** Consume the single entry opportunity for this account/contract; the PRIMARY KEY makes a second consumption impossible. */
  consumeOpportunity(accountKey: string, provider: MarketProviderId, venueMarketId: string, intentId: string, now: string): void {
    this.db.run("INSERT INTO trade_opportunities (account_key, provider, venue_market_id, intent_id, consumed_at) VALUES (?, ?, ?, ?, ?)", accountKey, provider, venueMarketId, intentId, now);
  }
}

function hydrate(r: ReservationRow): RiskReservation {
  return {
    id: r.id, decisionId: r.decision_id, accountKey: r.account_key, provider: r.provider, venueMarketId: r.venue_market_id, eventId: r.event_id ?? undefined, amount: r.amount, filledAmount: r.filled_amount,
    dailyBucket: r.daily_bucket, state: r.state, acknowledged: r.acknowledged === 1, createdAt: r.created_at, releasedAt: r.released_at ?? undefined, note: r.note ?? undefined,
  };
}
