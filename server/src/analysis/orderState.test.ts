/**
 * Prediction Ledger — order / execution / intent state rules and the venue wire mapping (1.13, E03/E06/E09). Pure.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { chosenCostOf, consumedByFills, intentStateFor, mergeFilled, mergeOrderState, normalizeExecutionType, normalizeOrderState, sideOfIntent, toVenueCreateBody } from "./orderState.js";
import { wirePriceFor } from "./tradeDecision.js";

test("E03 (pure) — NO at a .40 chosen-side limit is converted exactly once: the decision produces YES .60 and the wire body passes it through untouched; YES round-trips", () => {
  const no = wirePriceFor("no", "0.40", "0.01");
  assert.equal(no.wirePrice.toString(), "0.6");
  assert.equal(no.chosenCost.toString(), "0.4");
  const body = toVenueCreateBody({ marketSlug: "aec-nfl-det-buf-2026-10-01", side: "no", action: "buy", yesPrice: no.wirePrice.toString(), quantity: "23", timeInForce: "IOC", manual: true });
  assert.deepEqual(body, {
    marketSlug: "aec-nfl-det-buf-2026-10-01",
    intent: "ORDER_INTENT_BUY_SHORT",
    type: "ORDER_TYPE_LIMIT",
    price: { value: "0.6", currency: "USD" },
    quantity: 23,
    tif: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
    manualOrderIndicator: "MANUAL_ORDER_INDICATOR_MANUAL",
  });
  // Round trip: the venue reports fills at the YES price; the chosen-side cost is 1 − YES, i.e. the .40 that was sized.
  assert.equal(chosenCostOf("no", "0.6"), "0.4");
  assert.equal(chosenCostOf("no", "0.62"), "0.38", "a better fill on the NO side is a lower cost");
  const yes = wirePriceFor("yes", "0.50", "0.01");
  assert.equal(yes.wirePrice.toString(), "0.5");
  const yesBody = toVenueCreateBody({ marketSlug: "m", side: "yes", action: "buy", yesPrice: yes.wirePrice.toString(), quantity: "19", timeInForce: "IOC", manual: false });
  assert.deepEqual({ intent: yesBody.intent, price: yesBody.price, manual: yesBody.manualOrderIndicator }, { intent: "ORDER_INTENT_BUY_LONG", price: { value: "0.5", currency: "USD" }, manual: "MANUAL_ORDER_INDICATOR_AUTOMATIC" });
  assert.equal(chosenCostOf("yes", "0.5"), "0.5");
  // Money consumed by fills is computed on the chosen side: 10 NO contracts filled at YES .60 with .02 fees each = 10 × .40 + .20.
  const consumed = consumedByFills("no", [{ quantity: "6", yesPrice: "0.6", fee: "0.12" }, { quantity: "4", yesPrice: "0.6", fee: "0.08" }]);
  assert.deepEqual({ q: consumed.quantity.toString(), cost: consumed.cost.toString(), fees: consumed.fees.toString() }, { q: "10", cost: "4", fees: "0.2" });
  // Guard rails: no lossy quantities, no out-of-range prices.
  assert.throws(() => toVenueCreateBody({ marketSlug: "m", side: "yes", action: "buy", yesPrice: "0.5", quantity: "0.000000001", timeInForce: "IOC", manual: true }), /exceeds 8 places/, "the decimal type refuses sub-unit quantities before the wire does");
  assert.throws(() => toVenueCreateBody({ marketSlug: "m", side: "yes", action: "buy", yesPrice: "0.5", quantity: "12345678901234567", timeInForce: "IOC", manual: true }), /not exactly representable/, "a quantity a JSON number cannot carry exactly is refused");
  assert.throws(() => toVenueCreateBody({ marketSlug: "m", side: "yes", action: "buy", yesPrice: "1.00", quantity: "1", timeInForce: "IOC", manual: true }), /0\.01–0\.99/);
  assert.throws(() => toVenueCreateBody({ marketSlug: "m", side: "no", action: "buy", yesPrice: "0", quantity: "1", timeInForce: "IOC", manual: true }), /0\.01–0\.99/);
  assert.throws(() => toVenueCreateBody({ marketSlug: "m", side: "yes", action: "buy", yesPrice: "0.5", quantity: "0", timeInForce: "IOC", manual: true }), /not a positive number/);
});

test("venue enums normalise to the app's states; unknown strings stay unknown rather than being guessed", () => {
  assert.equal(normalizeOrderState("ORDER_STATE_PENDING_NEW"), "pending");
  assert.equal(normalizeOrderState("ORDER_STATE_NEW"), "open");
  assert.equal(normalizeOrderState("ORDER_STATE_PARTIALLY_FILLED"), "partial");
  assert.equal(normalizeOrderState("ORDER_STATE_FILLED"), "filled");
  assert.equal(normalizeOrderState("ORDER_STATE_CANCELED"), "canceled");
  assert.equal(normalizeOrderState("ORDER_STATE_EXPIRED"), "expired");
  assert.equal(normalizeOrderState("ORDER_STATE_REJECTED"), "rejected");
  assert.equal(normalizeOrderState("ORDER_STATE_SOMETHING_NEW"), "unknown");
  assert.equal(normalizeOrderState(undefined), "unknown");
  assert.equal(normalizeExecutionType("EXECUTION_TYPE_PARTIAL_FILL"), "partial_fill");
  assert.equal(normalizeExecutionType("EXECUTION_TYPE_FILL"), "fill");
  assert.equal(normalizeExecutionType("EXECUTION_TYPE_REJECTED"), "rejected");
  assert.equal(normalizeExecutionType("EXECUTION_TYPE_DONE_FOR_DAY"), "done_for_day");
  assert.equal(normalizeExecutionType("weird"), "unknown");
  assert.equal(sideOfIntent("ORDER_INTENT_BUY_LONG"), "yes");
  assert.equal(sideOfIntent("ORDER_INTENT_BUY_SHORT"), "no");
  assert.equal(sideOfIntent("OUTCOME_SIDE_NO/ORDER_ACTION_BUY"), "no");
  assert.equal(sideOfIntent("ORDER_INTENT_UNSPECIFIED"), undefined);
});

test("E09 (pure) — order states only move forward, quantities never shrink, a cancel never erases fills, and the intent follows the order", () => {
  // Stale events after a terminal state are ignored.
  assert.equal(mergeOrderState("filled", "open"), "filled");
  assert.equal(mergeOrderState("canceled", "partial"), "canceled");
  assert.equal(mergeOrderState("rejected", "pending"), "rejected");
  // Non-terminal progress.
  assert.equal(mergeOrderState("unknown", "pending"), "pending");
  assert.equal(mergeOrderState("pending", "open"), "open");
  assert.equal(mergeOrderState("open", "partial"), "partial");
  assert.equal(mergeOrderState("partial", "open"), "partial", "a late 'open' cannot regress a partial");
  assert.equal(mergeOrderState("partial", "unknown"), "partial", "an unrecognised state changes nothing");
  assert.equal(mergeOrderState("partial", "canceled"), "canceled");
  // A cancel request keeps its place while fills keep landing; the venue's final word ends it.
  assert.equal(mergeOrderState("cancel_pending", "partial"), "cancel_pending");
  assert.equal(mergeOrderState("cancel_pending", "open"), "cancel_pending");
  assert.equal(mergeOrderState("cancel_pending", "canceled"), "canceled");
  assert.equal(mergeOrderState("cancel_pending", "filled"), "filled");
  // Cumulative fills.
  assert.equal(mergeFilled("10", "3"), "10");
  assert.equal(mergeFilled("3", "10"), "10");
  assert.equal(mergeFilled("10", undefined), "10");
  // Intent state from the order.
  assert.equal(intentStateFor("filled", "19", "19"), "filled");
  assert.equal(intentStateFor("canceled", "10", "19"), "partially_filled", "partial fills survive the cancel of the remainder");
  assert.equal(intentStateFor("canceled", "0", "19"), "canceled");
  assert.equal(intentStateFor("expired", "0", "19"), "canceled");
  assert.equal(intentStateFor("rejected", "0", "19"), "rejected");
  assert.equal(intentStateFor("partial", "4", "19"), "partially_filled");
  assert.equal(intentStateFor("open", "0", "19"), "acknowledged");
  assert.equal(intentStateFor("pending", "0", "19"), "acknowledged");
});
