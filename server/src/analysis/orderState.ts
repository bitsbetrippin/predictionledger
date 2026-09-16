/**
 * Prediction Ledger — order / execution / intent state rules (1.13, EXE-03/04/06). Pure.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Three state machines are kept apart: the intent (what the app tried to do), the venue order (what the exchange
 * says about it) and the position (what is held). Order states only move forward — a stale "open" arriving after
 * "filled" cannot regress it — and a cancel never erases fills. The wire mapping is here so that the one and only
 * NO → YES price conversion (done by the decision) is never repeated.
 */

import type { IntentState, OrderState } from "@prediction-ledger/shared";
import { D, Dec } from "./decimal.js";
import type { OrderRequest, VenueExecutionType, VenueOrderState } from "../providers/trading/types.js";

/** Venue `ORDER_STATE_*` → normalized state. Unknown strings stay `unknown` rather than being guessed. */
export function normalizeOrderState(raw: string | undefined): VenueOrderState {
  switch ((raw ?? "").toUpperCase()) {
    case "ORDER_STATE_PENDING_NEW":
    case "ORDER_STATE_PENDING_RISK":
    case "ORDER_STATE_PENDING_REPLACE":
    case "ORDER_STATE_PENDING_CANCEL":
      return "pending";
    case "ORDER_STATE_NEW":
    case "ORDER_STATE_REPLACED":
      return "open";
    case "ORDER_STATE_PARTIALLY_FILLED":
      return "partial";
    case "ORDER_STATE_FILLED":
      return "filled";
    case "ORDER_STATE_CANCELED":
      return "canceled";
    case "ORDER_STATE_EXPIRED":
      return "expired";
    case "ORDER_STATE_REJECTED":
      return "rejected";
    default:
      return "unknown";
  }
}

export function normalizeExecutionType(raw: string | undefined): VenueExecutionType {
  switch ((raw ?? "").toUpperCase()) {
    case "EXECUTION_TYPE_NEW": return "new";
    case "EXECUTION_TYPE_PARTIAL_FILL": return "partial_fill";
    case "EXECUTION_TYPE_FILL": return "fill";
    case "EXECUTION_TYPE_CANCELED": return "canceled";
    case "EXECUTION_TYPE_REJECTED": return "rejected";
    case "EXECUTION_TYPE_EXPIRED": return "expired";
    case "EXECUTION_TYPE_REPLACE": return "replace";
    case "EXECUTION_TYPE_DONE_FOR_DAY": return "done_for_day";
    default: return "unknown";
  }
}

/** Order intents: BUY_LONG / SELL_LONG are the YES instrument; BUY_SHORT / SELL_SHORT the synthetic NO. */
export function sideOfIntent(intentRaw: string | undefined): "yes" | "no" | undefined {
  if (!intentRaw) return undefined;
  if (/LONG$/i.test(intentRaw) || /OUTCOME_SIDE_YES/i.test(intentRaw)) return "yes";
  if (/SHORT$/i.test(intentRaw) || /OUTCOME_SIDE_NO/i.test(intentRaw)) return "no";
  return undefined;
}

/** Terminal states never move; non-terminal states only advance along the rank. `cancel_pending` is local and sits before the terminals. */
const RANK: Record<OrderState, number> = { unknown: 0, pending: 1, open: 2, partial: 3, cancel_pending: 4, filled: 9, canceled: 9, expired: 9, rejected: 9 };
export const TERMINAL_ORDER_STATES: OrderState[] = ["filled", "canceled", "expired", "rejected"];

/** Forward-only merge of a reported state into the stored one (EXE-06: stale events cannot regress). */
export function mergeOrderState(current: OrderState, reported: VenueOrderState | OrderState): OrderState {
  if (TERMINAL_ORDER_STATES.includes(current)) return current;
  if (reported === "unknown") return current;
  // A partial report after a cancel request keeps the cancel pending (fills during cancellation are counted, EXE-06).
  if (current === "cancel_pending" && (reported === "open" || reported === "partial" || reported === "pending")) return current;
  return RANK[reported] >= RANK[current] ? reported : current;
}

/** The larger filled quantity wins (cumulative quantities never shrink). */
export function mergeFilled(current: string, reported: string | undefined): string {
  if (!reported) return current;
  return D(reported).gt(current) ? D(reported).toString() : D(current).toString();
}

/** Intent state implied by an order state (the intent is the app's view; it follows the order once acknowledged). */
export function intentStateFor(order: OrderState, filledQuantity: string, quantity: string): IntentState {
  switch (order) {
    case "filled": return "filled";
    case "canceled":
    case "expired": return D(filledQuantity).isPos() ? "partially_filled" : "canceled";
    case "rejected": return "rejected";
    case "partial": return "partially_filled";
    default: return D(filledQuantity).gte(quantity) && D(quantity).isPos() ? "filled" : "acknowledged";
  }
}

export const TERMINAL_INTENT_STATES: IntentState[] = ["filled", "partially_filled", "canceled", "rejected", "rejected_local", "skipped", "expired"];
/** Intent states that hold risk capacity or an entry opportunity open. */
export const LIVE_INTENT_STATES: IntentState[] = ["reserved", "submitting", "acknowledged", "submission_unknown"];

/** Chosen-side cost of a fill at a YES price. */
export function chosenCostOf(side: "yes" | "no", yesPrice: string): string {
  return side === "yes" ? D(yesPrice).toString() : Dec.ONE.sub(yesPrice).toString();
}

/** All-in amount consumed by fills: Σ quantity × chosen cost + fees. */
export function consumedByFills(side: "yes" | "no", fills: { quantity?: string; yesPrice?: string; fee?: string }[]): { quantity: Dec; cost: Dec; fees: Dec } {
  let quantity = Dec.ZERO, cost = Dec.ZERO, fees = Dec.ZERO;
  for (const f of fills) {
    if (!f.quantity || !f.yesPrice) continue;
    const q = D(f.quantity);
    quantity = quantity.add(q);
    cost = cost.add(D(chosenCostOf(side, f.yesPrice)).mul(q));
    if (f.fee) fees = fees.add(f.fee);
  }
  return { quantity, cost, fees };
}

/**
 * The venue wire shape for a create/preview call (verified against docs.polymarket.us and polymarket-us@0.1.1 on
 * 2026-09-16): `price.value` is ALWAYS the YES price, so `req.yesPrice` is passed through untouched — the NO
 * complement was taken exactly once by the decision. `quantity` is a JSON number on the wire; the conversion is
 * refused when it would lose precision.
 */
export function toVenueCreateBody(req: OrderRequest): Record<string, unknown> {
  const qty = Number(D(req.quantity).toString());
  if (!Number.isFinite(qty) || qty <= 0) throw new Error(`quantity ${req.quantity} is not a positive number`);
  if (numberToPlain(qty) !== D(req.quantity).toString()) throw new Error(`quantity ${req.quantity} is not exactly representable on the wire`);
  const price = D(req.yesPrice);
  if (!(price.gte("0.01") && price.lte("0.99"))) throw new Error(`YES price ${req.yesPrice} outside the venue's 0.01–0.99 bounds`);
  return {
    marketSlug: req.marketSlug,
    intent: req.side === "yes" ? "ORDER_INTENT_BUY_LONG" : "ORDER_INTENT_BUY_SHORT",
    type: "ORDER_TYPE_LIMIT",
    price: { value: price.toString(), currency: "USD" },
    quantity: qty,
    tif: req.timeInForce === "IOC" ? "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL" : "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
    manualOrderIndicator: req.manual ? "MANUAL_ORDER_INDICATOR_MANUAL" : "MANUAL_ORDER_INDICATOR_AUTOMATIC",
  };
}

function numberToPlain(n: number): string {
  const s = n.toFixed(8).replace(/\.?0+$/, "");
  return s === "" ? "0" : s;
}
