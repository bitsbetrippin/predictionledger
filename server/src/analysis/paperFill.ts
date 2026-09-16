/**
 * Prediction Ledger — execution-aware paper fill simulation (1.12, FOR-08).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * A marketable limit IOC against timestamped, side-specific depth: the order walks the levels the limit permits,
 * takes what is there (partial fills are the normal case), pays the fee per fill, and cancels the remainder. No
 * midpoint fill, no top-up, no invented depth. The book is YES-denominated; a NO buy consumes YES bids at
 * cost = 1 − bid.
 */

import { D, Dec } from "./decimal.js";
import type { DecisionBook, FeeSchedule } from "./tradeDecision.js";

export interface SimulatedFill {
  seq: number;
  quantity: string;
  /** Chosen-side cost per contract. */
  chosenCost: string;
  /** YES-denominated price of the level consumed. */
  yesPrice: string;
  fee: string;
}

export interface FillSimulation {
  fills: SimulatedFill[];
  filledQuantity: string;
  remainderCanceled: string;
  costTotal: string;
  fees: string;
  /** Cost + fees actually consumed. */
  allIn: string;
  avgCost?: string;
  filledAt: string;
  note: string;
}

export interface FillRequest {
  side: "yes" | "no";
  /** YES-denominated limit as sent to the venue. */
  wirePrice: string;
  quantity: string;
  quantityIncrement: string;
  book: DecisionBook;
  fee: FeeSchedule;
  /** Simulated latency between decision and execution; the fill timestamp is book time + latency. */
  latencyMs?: number;
}

/** Fee for one fill under the schedule (per contract, or Θ·C·p·(1−p) rounded up to the cent). */
export function feeForFill(fee: FeeSchedule, quantity: Dec, yesPrice: Dec): Dec {
  if (!fee.value) throw new Error("fee schedule unknown");
  const value = D(fee.value);
  if (fee.kind === "per_contract") return value.mul(quantity);
  return value.mul(quantity).mul(yesPrice).mul(Dec.ONE.sub(yesPrice)).round(2, "ceil");
}

export function simulateIocFill(req: FillRequest): FillSimulation {
  const limit = D(req.wirePrice);
  const want = D(req.quantity);
  const inc = D(req.quantityIncrement);
  let remaining = want;
  let cost = Dec.ZERO;
  let fees = Dec.ZERO;
  const fills: SimulatedFill[] = [];
  // YES buy: walk asks with price ≤ limit. NO buy: walk YES bids with price ≥ limit (NO cost = 1 − bid ≤ 1 − limit).
  const levels = req.side === "yes"
    ? [...req.book.asks].sort((a, b) => D(a.price).cmp(b.price)).filter((l) => D(l.price).lte(limit))
    : [...req.book.bids].sort((a, b) => D(b.price).cmp(a.price)).filter((l) => D(l.price).gte(limit));
  for (const level of levels) {
    if (!remaining.isPos()) break;
    const available = D(level.size).alignTo(inc, "floor");
    if (!available.isPos()) continue;
    const take = available.lt(remaining) ? available : remaining;
    const yesPrice = D(level.price);
    const chosenCost = req.side === "yes" ? yesPrice : Dec.ONE.sub(yesPrice);
    const fee = feeForFill(req.fee, take, yesPrice);
    fills.push({ seq: fills.length + 1, quantity: take.toString(), chosenCost: chosenCost.toString(), yesPrice: yesPrice.toString(), fee: fee.toString() });
    cost = cost.add(chosenCost.mul(take));
    fees = fees.add(fee);
    remaining = remaining.sub(take);
  }
  const filled = want.sub(remaining);
  const filledAt = new Date(Date.parse(req.book.retrievedAt) + (req.latencyMs ?? 0)).toISOString();
  return {
    fills,
    filledQuantity: filled.toString(),
    remainderCanceled: remaining.toString(),
    costTotal: cost.toString(),
    fees: fees.toString(),
    allIn: cost.add(fees).toString(),
    avgCost: filled.isPos() ? cost.div(filled, "half_up").round(4).toString() : undefined,
    filledAt,
    note: remaining.isPos()
      ? filled.isPos() ? `partial: ${filled} of ${want} filled at or better than the limit; ${remaining} canceled (IOC, no top-up)` : `nothing at or better than the limit; ${want} canceled (IOC)`
      : `filled ${filled} across ${fills.length} level(s)`,
  };
}
