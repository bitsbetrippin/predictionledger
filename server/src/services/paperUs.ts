/**
 * Prediction Ledger — execution-aware US paper book (1.12, FOR-08).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * A separate USD bankroll simulated with the same contract verification, forecast, decision and reservation
 * functions the live path will use. Fills come from timestamped side-specific depth (never a midpoint), pay the
 * fee schedule per fill, and settle only from the venue's published resolution. The legacy paper book (1.9) is
 * untouched and keeps its own method label; nothing here reads or writes it.
 */

import crypto from "node:crypto";
import type { PaperUsBook, PaperUsFill, PaperUsPosition } from "@prediction-ledger/shared";
import type { Database } from "../db/index.js";
import { D, Dec, dsum } from "../analysis/decimal.js";
import type { FillSimulation } from "../analysis/paperFill.js";

interface PositionRow {
  id: string; intent_id: string; decision_id: string; market_id: string; venue_market_id: string; side: "yes" | "no"; side_id: string | null; quantity: string; avg_cost: string; cost_total: string; fees: string;
  status: PaperUsPosition["status"]; opened_at: string; settled_at: string | null; outcome: PaperUsPosition["outcome"] | null; pnl: string | null; method: "us-ioc-v1";
}
interface FillRow { id: string; intent_id: string; position_id: string | null; seq: number; quantity: string; chosen_cost: string; yes_price: string; fee: string; at: string }

export class PaperUsService {
  constructor(private readonly db: Database) {}

  bankrollStart(): string {
    return this.db.get<{ bankroll_start: string }>("SELECT bankroll_start FROM paper_us_book WHERE id = 'default'")?.bankroll_start ?? "100";
  }

  setBankrollStart(value: string): void {
    this.db.run("UPDATE paper_us_book SET bankroll_start = ? WHERE id = 'default'", D(value).toString());
  }

  /** Record the fills of a paper intent as one position (or nothing when nothing filled). */
  recordFills(input: { intentId: string; decisionId: string; marketId: string; venueMarketId: string; side: "yes" | "no"; sideId?: string; sim: FillSimulation }): PaperUsPosition | undefined {
    const { sim } = input;
    let positionId: string | undefined;
    this.db.transaction(() => {
      if (D(sim.filledQuantity).isPos()) {
        positionId = crypto.randomUUID();
        this.db.run(
          "INSERT INTO paper_us_positions (id, intent_id, decision_id, market_id, venue_market_id, side, side_id, quantity, avg_cost, cost_total, fees, status, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
          positionId, input.intentId, input.decisionId, input.marketId, input.venueMarketId, input.side, input.sideId ?? null, sim.filledQuantity, sim.avgCost ?? "0", sim.costTotal, sim.fees, sim.filledAt,
        );
      }
      for (const f of sim.fills) {
        this.db.run("INSERT INTO paper_us_fills (id, intent_id, position_id, seq, quantity, chosen_cost, yes_price, fee, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", crypto.randomUUID(), input.intentId, positionId ?? null, f.seq, f.quantity, f.chosenCost, f.yesPrice, f.fee, sim.filledAt);
      }
    });
    return positionId ? this.get(positionId) : undefined;
  }

  /** Settle open positions on a market from the venue's published resolution (win / loss / void). Fees are sunk on win/loss; a void refunds cost and fees. */
  settle(marketId: string, outcome: "yes" | "no" | "void", at: string): PaperUsPosition[] {
    const open = this.db.all<PositionRow>("SELECT * FROM paper_us_positions WHERE market_id = ? AND status = 'open'", marketId);
    const out: PaperUsPosition[] = [];
    for (const p of open) {
      let pnl: Dec;
      let result: NonNullable<PaperUsPosition["outcome"]>;
      let status: PaperUsPosition["status"];
      if (outcome === "void") { pnl = Dec.ZERO; result = "void"; status = "void"; }
      else if (outcome === p.side) { pnl = D(p.quantity).sub(p.cost_total).sub(p.fees); result = "win"; status = "settled"; }
      else { pnl = D(p.cost_total).add(p.fees).neg(); result = "loss"; status = "settled"; }
      this.db.run("UPDATE paper_us_positions SET status = ?, settled_at = ?, outcome = ?, pnl = ? WHERE id = ?", status, at, result, pnl.toString(), p.id);
      out.push(this.get(p.id)!);
    }
    return out;
  }

  get(id: string): PaperUsPosition | undefined {
    const r = this.db.get<PositionRow>("SELECT * FROM paper_us_positions WHERE id = ?", id);
    return r ? this.hydrate(r) : undefined;
  }

  byIntent(intentId: string): PaperUsPosition | undefined {
    const r = this.db.get<PositionRow>("SELECT * FROM paper_us_positions WHERE intent_id = ?", intentId);
    return r ? this.hydrate(r) : undefined;
  }

  fillsForIntent(intentId: string): PaperUsFill[] {
    return this.db.all<FillRow>("SELECT * FROM paper_us_fills WHERE intent_id = ? ORDER BY seq", intentId).map((f) => ({ id: f.id, seq: f.seq, quantity: f.quantity, chosenCost: f.chosen_cost, yesPrice: f.yes_price, fee: f.fee, at: f.at }));
  }

  list(status?: PaperUsPosition["status"]): PaperUsPosition[] {
    const rows = status ? this.db.all<PositionRow>("SELECT * FROM paper_us_positions WHERE status = ? ORDER BY opened_at DESC", status) : this.db.all<PositionRow>("SELECT * FROM paper_us_positions ORDER BY opened_at DESC");
    return rows.map((r) => this.hydrate(r));
  }

  /** Cash not committed to open positions: bankroll start + realized P&L − open cost. */
  book(): PaperUsBook {
    const positions = this.list();
    const open = positions.filter((p) => p.status === "open");
    const settled = positions.filter((p) => p.status !== "open");
    const realized = dsum(settled.map((p) => D(p.pnl ?? "0")));
    const committed = dsum(open.map((p) => D(p.costTotal).add(p.fees)));
    const fees = dsum(positions.map((p) => D(p.fees)));
    const start = D(this.bankrollStart());
    return {
      method: "us-ioc-v1", currency: "USD", bankrollStart: start.toString(), bankroll: start.add(realized).sub(committed).toString(), committed: committed.toString(), realizedPnl: realized.toString(), fees: fees.toString(),
      open: open.length, settled: settled.filter((p) => p.status === "settled").length, wins: settled.filter((p) => p.outcome === "win").length, losses: settled.filter((p) => p.outcome === "loss").length, voids: settled.filter((p) => p.outcome === "void").length,
      positions,
    };
  }

  /** Paper only: wipes positions and fills (decisions and reservations stay as history). */
  reset(at: string): number {
    const n = this.db.run("DELETE FROM paper_us_positions").changes;
    this.db.run("DELETE FROM paper_us_fills");
    this.db.run("UPDATE paper_us_book SET reset_at = ? WHERE id = 'default'", at);
    return Number(n);
  }

  private hydrate(r: PositionRow): PaperUsPosition {
    const m = this.db.get<{ question: string; url: string }>("SELECT question, url FROM markets WHERE id = ?", r.market_id);
    return {
      id: r.id, intentId: r.intent_id, decisionId: r.decision_id, marketId: r.market_id, venueMarketId: r.venue_market_id, side: r.side, sideId: r.side_id ?? undefined, quantity: r.quantity, avgCost: r.avg_cost, costTotal: r.cost_total, fees: r.fees,
      status: r.status, openedAt: r.opened_at, settledAt: r.settled_at ?? undefined, outcome: r.outcome ?? undefined, pnl: r.pnl ?? undefined, method: r.method, fills: this.fillsForIntent(r.intent_id), question: m?.question, marketUrl: m?.url,
    };
  }
}
