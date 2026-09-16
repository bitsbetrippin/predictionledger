/**
 * Prediction Ledger — paper-trading ledger (1.9): hypothetical positions marked against snapshots.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * The app never places an order. A paper position is a note: "at this instant I would have bought
 * `shares` of `side` at `openedPrice`". Marks come from the same snapshots the signals use; a
 * position closes at 1 or 0 when the venue resolves the market (or by hand at the current mark).
 * The book therefore answers one question honestly: had you followed the signals, what would the
 * scoreboard say — and were the creators' estimates better calibrated than the market's price?
 */

import crypto from "node:crypto";
import type { MarketProviderId, PaperBook, PaperPosition, SignalConfidence } from "@prediction-ledger/shared";
import type { Database } from "../db/index.js";

interface Row {
  id: string; market_id: string; side: string; opened_at: string; opened_price: number; stake: number; shares: number; source: PaperPosition["source"]; edge_at_open: number | null;
  estimate_at_open: number | null; confidence_at_open: string | null; prediction_ids_json: string; notes: string | null; status: PaperPosition["status"]; closed_at: string | null; closed_price: number | null;
  close_reason: PaperPosition["closeReason"] | null; realized_pnl: number | null; last_mark_price: number | null; last_marked_at: string | null;
  question: string | null; url: string | null; end_date: string | null; provider: string | null; resolved: number | null; resolved_outcome: string | null;
}

const SQL = "SELECT p.*, m.question, m.url, m.end_date, m.provider, m.resolved, m.resolved_outcome FROM paper_positions p LEFT JOIN markets m ON m.id = p.market_id";
const round = (x: number) => Math.round(x * 100) / 100;

export interface PaperSizing { sizing: "fixed" | "kelly"; fixedStake: number; kellyFraction: number; maxStakeFraction: number }

/** Stake for a new position. Kelly for a binary at price p with estimate q: f* = (q − p) / (1 − p) of bankroll, scaled and capped. */
export function stakeFor(cfg: PaperSizing, bankroll: number, price: number, estimate?: number): { stake: number; note: string } {
  const cap = Math.max(0.01, bankroll * cfg.maxStakeFraction);
  if (cfg.sizing === "fixed" || estimate === undefined || price >= 1 || price <= 0) {
    const stake = Math.min(cfg.fixedStake, cap, Math.max(0, bankroll));
    return { stake: round(stake), note: cfg.sizing === "kelly" && estimate === undefined ? "no estimate at open — fixed stake used" : "fixed stake" };
  }
  const full = (estimate - price) / (1 - price);
  if (full <= 0) return { stake: 0, note: "Kelly says no bet (estimate ≤ price)" };
  const stake = Math.min(bankroll * full * cfg.kellyFraction, cap, Math.max(0, bankroll));
  return { stake: round(stake), note: `Kelly ${(full * 100).toFixed(1)}% × ${cfg.kellyFraction} of bankroll, capped at ${(cfg.maxStakeFraction * 100).toFixed(0)}%` };
}

export class PaperService {
  constructor(private readonly db: Database) {}

  open(input: { marketId: string; side: string; price: number; stake: number; source: PaperPosition["source"]; edge?: number; estimate?: number; confidence?: SignalConfidence; predictionIds?: string[]; notes?: string }): PaperPosition {
    if (!(input.price > 0 && input.price < 1)) throw new Error(`Cannot open at price ${input.price}; needs 0 < price < 1.`);
    if (!(input.stake > 0)) throw new Error("Stake must be positive.");
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO paper_positions (id, market_id, side, opened_price, stake, shares, source, edge_at_open, estimate_at_open, confidence_at_open, prediction_ids_json, notes, last_mark_price, last_marked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      id, input.marketId, input.side, input.price, round(input.stake), input.stake / input.price, input.source, input.edge ?? null, input.estimate ?? null, input.confidence ?? null, JSON.stringify(input.predictionIds ?? []), input.notes ?? null, input.price,
    );
    // Opening mark so the equity curve starts where the position did.
    this.db.run("INSERT INTO paper_marks (id, position_id, marked_at, price, unrealized_pnl) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 0)", crypto.randomUUID(), id, input.price);
    return this.get(id)!;
  }

  get(id: string): PaperPosition | undefined {
    const r = this.db.get<Row>(`${SQL} WHERE p.id = ?`, id);
    return r ? hydrate(r) : undefined;
  }

  list(status?: "open" | "closed"): PaperPosition[] {
    const rows = status ? this.db.all<Row>(`${SQL} WHERE p.status = ? ORDER BY p.opened_at DESC`, status) : this.db.all<Row>(`${SQL} ORDER BY p.status ASC, p.opened_at DESC`);
    return rows.map(hydrate);
  }

  openOn(marketId: string, side: string): PaperPosition | undefined {
    const r = this.db.get<Row>(`${SQL} WHERE p.market_id = ? AND p.side = ? AND p.status = 'open'`, marketId, side);
    return r ? hydrate(r) : undefined;
  }

  /** Mark every open position at its market's latest snapshot price; append a mark row when the price changed. */
  markAll(now = new Date().toISOString()): { marked: number; closed: number } {
    let marked = 0;
    let closed = 0;
    for (const p of this.list("open")) {
      const snap = this.db.get<{ prices_json: string; retrieved_at: string }>("SELECT prices_json, retrieved_at FROM market_snapshots WHERE market_id = ? AND source <> 'history' ORDER BY retrieved_at DESC LIMIT 1", p.marketId);
      const market = this.db.get<{ resolved: number; resolved_outcome: string | null }>("SELECT resolved, resolved_outcome FROM markets WHERE id = ?", p.marketId);
      if (market?.resolved === 1 && market.resolved_outcome) {
        this.close(p.id, market.resolved_outcome === p.side ? 1 : 0, "resolved", now);
        closed++;
        continue;
      }
      if (!snap) continue;
      const price = (JSON.parse(snap.prices_json) as { label: string; price?: number }[]).find((x) => x.label === p.side)?.price;
      if (price === undefined) continue;
      const unreal = round(p.shares * (price - p.openedPrice));
      if (price !== p.lastMarkPrice) {
        this.db.run("INSERT INTO paper_marks (id, position_id, marked_at, price, unrealized_pnl) VALUES (?, ?, ?, ?, ?)", crypto.randomUUID(), p.id, now, price, unreal);
      }
      this.db.run("UPDATE paper_positions SET last_mark_price = ?, last_marked_at = ? WHERE id = ?", price, now, p.id);
      marked++;
    }
    return { marked, closed };
  }

  close(id: string, price: number, reason: NonNullable<PaperPosition["closeReason"]>, at = new Date().toISOString()): PaperPosition | undefined {
    const p = this.get(id);
    if (!p || p.status === "closed") return p;
    const pnl = round(p.shares * (price - p.openedPrice));
    this.db.run("UPDATE paper_positions SET status = 'closed', closed_at = ?, closed_price = ?, close_reason = ?, realized_pnl = ?, last_mark_price = ?, last_marked_at = ? WHERE id = ?", at, price, reason, pnl, price, at, id);
    this.db.run("INSERT INTO paper_marks (id, position_id, marked_at, price, unrealized_pnl) VALUES (?, ?, ?, ?, ?)", crypto.randomUUID(), id, at, price, pnl);
    return this.get(id);
  }

  delete(id: string): boolean {
    return Number(this.db.run("DELETE FROM paper_positions WHERE id = ?", id).changes) > 0;
  }

  reset(): number {
    return Number(this.db.run("DELETE FROM paper_positions").changes);
  }

  book(cfg: { enabled: boolean; bankroll: number }): PaperBook {
    const all = this.list();
    const open = all.filter((p) => p.status === "open");
    const closed = all.filter((p) => p.status === "closed");
    const realized = round(closed.reduce((s, p) => s + (p.realizedPnl ?? 0), 0));
    const unrealized = round(open.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0));
    const staked = round(all.reduce((s, p) => s + p.stake, 0));
    const closedStake = closed.reduce((s, p) => s + p.stake, 0);
    const withEstimate = closed.filter((p) => p.estimateAtOpen !== undefined && p.closeReason === "resolved" && p.closedPrice !== undefined);
    const mean = (f: (p: PaperPosition) => number) => (withEstimate.length ? Math.round((withEstimate.reduce((s, p) => s + f(p), 0) / withEstimate.length) * 10_000) / 10_000 : undefined);
    // Equity curve: bankroll + cumulative realized + unrealized at each mark instant (coarse: per mark row).
    const marks = this.db.all<{ marked_at: string; position_id: string; unrealized_pnl: number }>("SELECT marked_at, position_id, unrealized_pnl FROM paper_marks ORDER BY marked_at ASC");
    const latest = new Map<string, number>();
    const curve: { at: string; equity: number }[] = [];
    for (const m of marks) {
      latest.set(m.position_id, m.unrealized_pnl);
      let total = 0;
      for (const v of latest.values()) total += v;
      const last = curve[curve.length - 1];
      const point = { at: m.marked_at, equity: round(cfg.bankroll + total) };
      if (last && last.at === point.at) curve[curve.length - 1] = point;
      else curve.push(point);
    }
    return {
      enabled: cfg.enabled, bankrollStart: cfg.bankroll, bankroll: round(cfg.bankroll + realized), equity: round(cfg.bankroll + realized + unrealized), realizedPnl: realized, unrealizedPnl: unrealized,
      openCount: open.length, closedCount: closed.length, wins: closed.filter((p) => (p.realizedPnl ?? 0) > 0).length, losses: closed.filter((p) => (p.realizedPnl ?? 0) < 0).length, staked,
      returnOnStake: closedStake > 0 ? Math.round((realized / closedStake) * 10_000) / 10_000 : undefined,
      brierEstimate: mean((p) => (p.estimateAtOpen! - p.closedPrice!) ** 2), brierMarket: mean((p) => (p.openedPrice - p.closedPrice!) ** 2),
      curve: curve.slice(-500),
    };
  }
}

function hydrate(r: Row): PaperPosition {
  const current = r.status === "closed" ? (r.closed_price ?? undefined) : (r.last_mark_price ?? undefined);
  return {
    id: r.id, marketId: r.market_id, side: r.side, openedAt: r.opened_at, openedPrice: r.opened_price, stake: r.stake, shares: r.shares, source: r.source, edgeAtOpen: r.edge_at_open ?? undefined,
    estimateAtOpen: r.estimate_at_open ?? undefined, confidenceAtOpen: (r.confidence_at_open ?? undefined) as SignalConfidence | undefined, predictionIds: JSON.parse(r.prediction_ids_json) as string[], notes: r.notes ?? undefined,
    status: r.status, closedAt: r.closed_at ?? undefined, closedPrice: r.closed_price ?? undefined, closeReason: r.close_reason ?? undefined, realizedPnl: r.realized_pnl ?? undefined,
    lastMarkPrice: r.last_mark_price ?? undefined, lastMarkedAt: r.last_marked_at ?? undefined, currentPrice: current,
    unrealizedPnl: r.status === "open" && current !== undefined ? round(r.shares * (current - r.opened_price)) : undefined,
    market: r.question ? { question: r.question, url: r.url ?? "", endDate: r.end_date ?? undefined, provider: (r.provider ?? "polymarket") as MarketProviderId, resolved: r.resolved === 1, resolvedOutcome: r.resolved_outcome ?? undefined } : undefined,
  };
}
