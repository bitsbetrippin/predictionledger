/**
 * Prediction Ledger — pure decision, sizing and paper-fill tests over fixture F0 (1.12: R01–R06, R08 sizing, R09 checks, F10 fill maths).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIMITS, dailyBucket, decide, feePerContractBound, wirePriceFor, type DecisionInput } from "./tradeDecision.js";
import { simulateIocFill } from "./paperFill.js";
import { D } from "./decimal.js";

/** Shared deterministic fixture F0 (03-Acceptance-Test-Plan §Harness). */
const NOW = "2026-10-01T12:00:00Z";
const f0 = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  now: NOW,
  mode: "paper",
  offline: false,
  limits: DEFAULT_LIMITS,
  forecast: { id: "f0", pYes: "0.62", pNo: "0.38", asOf: NOW, status: "experimental", expiresAt: "2026-10-01T12:30:00Z" },
  verification: { id: "v1", version: 1, status: "verified_equivalent", cutoffAt: "2026-10-01T13:00:00Z", cutoffUnknown: false, rulesHash: "R1", sideId: "MA-Y" },
  contract: { venue: "polymarket_us", venueMarketId: "M-A", eventId: "EV-A", status: "MARKET_STATUS_OPEN", active: true, closed: false, tickSize: "0.01", minQuantity: "1", rulesHash: "R1", sides: [{ id: "MA-Y", label: "Yes", long: true }, { id: "MA-N", label: "No", long: false }] },
  book: { retrievedAt: NOW, bids: [{ price: "0.49", size: "500" }], asks: [{ price: "0.50", size: "500" }] },
  fee: { kind: "per_contract", value: "0.02" },
  account: { syncAt: NOW, complete: true, buyingPower: "100", positions: [], openOrders: [] },
  exposure: { openRiskTotal: "0", dailyCommitted: "0", dailyRealizedLoss: "0", openMarkets: 0, perMarket: "0", perEvent: "0", unreflectedReservations: "0", marketAlreadyOpen: false },
  opportunityConsumed: false,
  ...over,
});
const codes = (r: ReturnType<typeof decide>) => r.reasonCodes;

test("F0 — the fixture decision: 19 YES contracts, worst cost $9.88, edge .10 per contract, EV $1.90, eligible", () => {
  const r = decide(f0());
  assert.equal(r.outcome, "eligible", JSON.stringify(r.gates.filter((g) => !g.satisfied)));
  assert.deepEqual({ side: r.sizing!.side, qty: r.sizing!.quantity, limit: r.sizing!.limitCost, wire: r.sizing!.wirePrice, fee: r.sizing!.feeBound, worst: r.sizing!.worstCost, edge: r.sizing!.netEdge, ev: r.sizing!.estimatedEv, sideId: r.sizing!.sideId },
    { side: "yes", qty: "19", limit: "0.5", wire: "0.5", fee: "0.38", worst: "9.88", edge: "0.1", ev: "1.9", sideId: "MA-Y" });
  assert.equal(r.deadlineAt, "2026-10-01T12:55:00.000Z");
  assert.ok(r.gates.every((g) => g.satisfied));
  assert.ok(r.gates.length >= 20, "every gate is reported, satisfied or not");
});

test("R01 — a higher probability of exactly .50 skips; .5001 passes the confidence gate; every other gate is still required", () => {
  const half = decide(f0({ forecast: { id: "f", pYes: "0.50", pNo: "0.50", asOf: NOW, status: "experimental" } }));
  assert.equal(half.outcome, "skipped");
  assert.ok(codes(half).includes("PROB_NOT_ABOVE_HALF"));
  const just = decide(f0({ forecast: { id: "f", pYes: "0.5001", pNo: "0.4999", asOf: NOW, status: "experimental" }, book: { retrievedAt: NOW, bids: [{ price: "0.42", size: "500" }], asks: [{ price: "0.43", size: "500" }] } }));
  assert.equal(just.gates.find((g) => g.id === "probability")!.satisfied, true);
  // all-in .45 = .43 + .02 → edge .0501 ≥ .03 → eligible; but a stale book still blocks it.
  assert.equal(just.outcome, "eligible");
  const stale = decide(f0({ forecast: { id: "f", pYes: "0.5001", pNo: "0.4999", asOf: NOW, status: "experimental" }, book: { retrievedAt: "2026-10-01T11:59:49Z", bids: [{ price: "0.42", size: "500" }], asks: [{ price: "0.43", size: "500" }] } }));
  assert.equal(stale.outcome, "skipped");
  assert.ok(codes(stale).includes("BOOK_STALE"));
  assert.equal(stale.gates.find((g) => g.id === "probability")!.satisfied, true, "the probability gate is reported as passed even when others fail");
});

test("R02 — pChosen .60: all-in .75 → negative edge; .58 → .02 skips; .57 → .03 passes the inclusive boundary", () => {
  const at = (allIn: string) => decide(f0({ forecast: { id: "f", pYes: "0.60", pNo: "0.40", asOf: NOW, status: "experimental" }, fee: { kind: "per_contract", value: "0" }, book: { retrievedAt: NOW, bids: [{ price: "0.40", size: "9" }], asks: [{ price: allIn, size: "500" }] } }));
  const neg = at("0.75");
  assert.equal(neg.outcome, "skipped");
  assert.ok(codes(neg).includes("EDGE_NEGATIVE"));
  const two = at("0.58");
  assert.equal(two.outcome, "skipped");
  assert.ok(codes(two).includes("EDGE_BELOW_MIN"));
  assert.equal(two.sizing?.netEdge, "0.02");
  const three = at("0.57");
  assert.equal(three.outcome, "eligible");
  assert.equal(three.sizing!.netEdge, "0.03");
});

test("R03 — a candidate quantity of 20 under the $10 budget is recomputed to 19 / $9.88; $10.40 is never spent; the hint can only lower the quantity", () => {
  const r = decide(f0({ candidateQuantity: "20" }));
  assert.equal(r.sizing!.quantity, "19");
  assert.equal(r.sizing!.worstCost, "9.88");
  const fewer = decide(f0({ candidateQuantity: "5" }));
  assert.equal(fewer.sizing!.quantity, "5");
  assert.equal(fewer.sizing!.worstCost, "2.6");
  assert.equal(fewer.sizing!.boundBy, "candidate");
});

test("R04 — wire prices: chosen-side max .435 → YES wire .43; NO wire .57 with NO risk .43; half-cent tick keeps .435; fee bounds; unknown fee fails closed", () => {
  const yes = wirePriceFor("yes", "0.435", "0.01");
  assert.deepEqual({ wire: yes.wirePrice.toString(), cost: yes.chosenCost.toString() }, { wire: "0.43", cost: "0.43" });
  const no = wirePriceFor("no", "0.435", "0.01");
  assert.equal(no.wirePrice.toString(), "0.57");
  assert.equal(no.chosenCost.toString(), "0.43");
  assert.equal(wirePriceFor("yes", "0.435", "0.005").wirePrice.toString(), "0.435");
  assert.equal(wirePriceFor("no", "0.435", "0.005").wirePrice.toString(), "0.565");
  // Decision on the NO side: pNo .62; NO offer = 1 − best bid .565 → NO cost .435 → wire .57, chosen cost .43, all-in .45.
  const noSide = decide(f0({ forecast: { id: "f", pYes: "0.38", pNo: "0.62", asOf: NOW, status: "experimental" }, book: { retrievedAt: NOW, bids: [{ price: "0.565", size: "500" }], asks: [{ price: "0.58", size: "500" }] } }));
  assert.equal(noSide.outcome, "eligible");
  assert.deepEqual({ side: noSide.sizing!.side, wire: noSide.sizing!.wirePrice, cost: noSide.sizing!.limitCost, qty: noSide.sizing!.quantity, sideId: noSide.sizing!.sideId }, { side: "no", wire: "0.57", cost: "0.43", qty: "22", sideId: "MA-N" });
  assert.equal(noSide.sizing!.worstCost, D("0.45").mul("22").toString(), "22 × .45 = 9.90 ≤ 10");
  // Fee bounds.
  assert.equal(feePerContractBound({ kind: "per_contract", value: "0.02" }, D("0.5"))!.toString(), "0.02");
  assert.equal(feePerContractBound({ kind: "coefficient", value: "0.06" }, D("0.5"))!.toString(), "0.025", "Θ·p·(1−p) at .5 = .015 + one cent rounding allowance");
  assert.equal(feePerContractBound({ kind: "coefficient", value: "0.06" }, D("0.2"))!.toString(), "0.0196", "at a .20 limit fills cannot happen above .20 → Θ·.16 = .0096 + .01");
  assert.equal(feePerContractBound({ kind: "coefficient", value: "0.06", upcoming: { value: "0.0695", effectiveAt: "2026-10-01T12:30:00Z" } }, D("0.5"), Date.parse("2026-10-01T13:00:00Z"))!.toString(), "0.0274", "an announced increase before the cutoff raises the bound");
  assert.equal(feePerContractBound({ kind: "coefficient", value: "0.06", upcoming: { value: "0.0695", effectiveAt: "2026-10-05T00:00:00Z" } }, D("0.5"), Date.parse("2026-10-01T13:00:00Z"))!.toString(), "0.025", "a change after the cutoff does not apply");
  assert.equal(feePerContractBound({ kind: "coefficient" }, D("0.5")), undefined);
  const unknownFee = decide(f0({ fee: { kind: "coefficient" } }));
  assert.equal(unknownFee.outcome, "skipped");
  assert.ok(codes(unknownFee).includes("FEE_UNKNOWN"));
  // Quantity increments and minimums.
  const frac = decide(f0({ contract: { ...f0().contract, minQuantity: "0.01" } }));
  assert.equal(frac.sizing!.quantity, "19.23", "fractional contracts floor to the increment: 10 / .52 = 19.2307 → 19.23");
  assert.ok(D(frac.sizing!.worstCost).lte("10"));
  const noneFits = decide(f0({ contract: { ...f0().contract, minQuantity: "25" } }));
  assert.equal(noneFits.outcome, "skipped");
  assert.ok(codes(noneFits).includes("NO_VALID_QUANTITY"));
  const halfCent = decide(f0({ contract: { ...f0().contract, tickSize: "0.005" }, book: { retrievedAt: NOW, bids: [{ price: "0.43", size: "500" }], asks: [{ price: "0.435", size: "500" }] } }));
  assert.equal(halfCent.sizing!.wirePrice, "0.435");
  assert.equal(halfCent.sizing!.quantity, "21", "10 / .455 = 21.97 → 21");
});

test("R05 — exact freshness boundaries: book 10 s vs 10.001 s; sync 30 s vs 30.001 s; forecast 30 m vs 30 m + 1 ms", () => {
  const at = (bookAge: number, syncAge: number, forecastAge: number) => decide(f0({
    book: { retrievedAt: new Date(Date.parse(NOW) - bookAge).toISOString(), bids: [{ price: "0.49", size: "500" }], asks: [{ price: "0.50", size: "500" }] },
    account: { syncAt: new Date(Date.parse(NOW) - syncAge).toISOString(), complete: true, buyingPower: "100", positions: [], openOrders: [] },
    forecast: { id: "f", pYes: "0.62", pNo: "0.38", asOf: new Date(Date.parse(NOW) - forecastAge).toISOString(), status: "experimental" },
  }));
  assert.equal(at(10_000, 30_000, 1_800_000).outcome, "eligible");
  assert.ok(codes(at(10_001, 30_000, 1_800_000)).includes("BOOK_STALE"));
  assert.ok(codes(at(10_000, 30_001, 1_800_000)).includes("SYNC_STALE"));
  assert.ok(codes(at(10_000, 30_000, 1_800_001)).includes("FORECAST_STALE"));
  assert.equal(at(10_001, 30_001, 1_800_001).outcome, "skipped");
  assert.ok(codes(at(-5_000, 30_000, 1_800_000)).includes("BOOK_STALE"), "a book from the future is not fresh either");
  // RV-03 (2.0): an input stamped a few hundred milliseconds after `now` (fetched in the same call) is fresh; beyond the tolerance it is not.
  assert.equal(at(-300, -250, -100).outcome, "eligible", "book/sync/forecast up to 2 s ahead of now are inside the clock-skew tolerance");
  assert.equal(at(-2_000, 30_000, 1_800_000).outcome, "eligible");
  assert.ok(codes(at(-2_001, 30_000, 1_800_000)).includes("BOOK_STALE"));
  assert.ok(codes(at(10_000, -2_001, 1_800_000)).includes("SYNC_STALE"));
});

test("R06 — cutoff: 12:54:59.999 is pre-cutoff; 12:55:00 and 12:55:00.001 block even with the market open; DST-equivalent instants agree; unknown cutoff blocks", () => {
  const at = (now: string) => decide(f0({ now, forecast: { id: "f", pYes: "0.62", pNo: "0.38", asOf: now, status: "experimental" }, book: { retrievedAt: now, bids: [{ price: "0.49", size: "500" }], asks: [{ price: "0.50", size: "500" }] }, account: { syncAt: now, complete: true, buyingPower: "100", positions: [], openOrders: [] } }));
  assert.equal(at("2026-10-01T12:54:59.999Z").outcome, "eligible");
  assert.ok(codes(at("2026-10-01T12:55:00.000Z")).includes("AT_OR_PAST_CUTOFF"));
  assert.ok(codes(at("2026-10-01T12:55:00.001Z")).includes("AT_OR_PAST_CUTOFF"));
  assert.equal(at("2026-10-01T08:54:59.999-04:00").outcome, "eligible", "the same instant written in Eastern time");
  assert.ok(codes(at("2026-10-01T08:55:00-04:00")).includes("AT_OR_PAST_CUTOFF"));
  const unknown = decide(f0({ verification: { ...f0().verification!, cutoffAt: undefined, cutoffUnknown: true } }));
  assert.ok(codes(unknown).includes("CUTOFF_UNKNOWN"));
  assert.equal(dailyBucket("2026-10-01T03:30:00Z", "UTC"), "2026-10-01");
  assert.equal(dailyBucket("2026-10-01T03:30:00Z", "America/New_York"), "2026-09-30");
});

test("contract, forecast and mode gates: unverified / stale / changed rules / closed market / disabled mode / offline / insufficient or expired forecast / auto-live needs qualification", () => {
  assert.ok(codes(decide(f0({ verification: undefined }))).includes("CONTRACT_NOT_VERIFIED"));
  assert.ok(codes(decide(f0({ verification: { ...f0().verification!, staleAt: NOW } }))).includes("CONTRACT_STALE"));
  assert.ok(codes(decide(f0({ verification: { ...f0().verification!, status: "incomplete" } }))).includes("CONTRACT_NOT_VERIFIED"));
  assert.ok(codes(decide(f0({ contract: { ...f0().contract, rulesHash: "R2" } }))).includes("RULES_CHANGED"));
  assert.ok(codes(decide(f0({ contract: { ...f0().contract, status: "MARKET_STATUS_HALTED" } }))).includes("MARKET_NOT_OPEN"));
  assert.ok(codes(decide(f0({ contract: { ...f0().contract, closed: true } }))).includes("MARKET_NOT_OPEN"));
  assert.ok(codes(decide(f0({ contract: { ...f0().contract, venue: "polymarket" } }))).includes("WRONG_VENUE"));
  assert.ok(codes(decide(f0({ mode: "disabled" }))).includes("MODE_DISABLED"));
  assert.ok(codes(decide(f0({ offline: true }))).includes("OFFLINE"));
  assert.ok(codes(decide(f0({ forecast: { ...f0().forecast!, status: "insufficient_data" } }))).includes("FORECAST_INSUFFICIENT"));
  assert.ok(codes(decide(f0({ forecast: { ...f0().forecast!, expiresAt: "2026-10-01T11:59:59Z" } }))).includes("FORECAST_EXPIRED"));
  assert.ok(codes(decide(f0({ forecast: { ...f0().forecast!, pYes: "1.2", pNo: "-0.2" } }))).includes("FORECAST_INVALID"));
  assert.ok(codes(decide(f0({ forecast: undefined }))).includes("FORECAST_MISSING"));
  assert.ok(codes(decide(f0({ mode: "auto_live" }))).includes("STRATEGY_NOT_QUALIFIED"), "an experimental forecast never drives automation");
  // RV-01 (2.0): a qualified forecast is not enough — it must fall inside the armed (strategy version, category) scope.
  const qualified = { ...f0().forecast!, status: "qualified" as const, strategyVersion: "baseline-v1", category: "sports" };
  assert.ok(codes(decide(f0({ mode: "auto_live", forecast: qualified }))).includes("AUTHORIZATION_SCOPE"), "no authorization scope → not eligible");
  assert.ok(codes(decide(f0({ mode: "auto_live", forecast: qualified, authorization: { strategyVersion: "baseline-v1", category: "politics" } }))).includes("AUTHORIZATION_SCOPE"), "armed for another category → not eligible");
  assert.ok(codes(decide(f0({ mode: "auto_live", forecast: qualified, authorization: { strategyVersion: "baseline-v2", category: "sports" } }))).includes("AUTHORIZATION_SCOPE"), "armed for another strategy version → not eligible");
  assert.equal(decide(f0({ mode: "auto_live", forecast: qualified, authorization: { strategyVersion: "baseline-v1", category: "sports" } })).outcome, "eligible", "inside the armed scope → eligible");
  assert.equal(decide(f0({ mode: "manual_live" })).outcome, "needs_review", "manual mode: a human confirms");
  assert.ok(codes(decide(f0({ contract: { ...f0().contract, tickSize: undefined } }))).includes("CONSTRAINTS_UNSUPPORTED"));
  assert.ok(codes(decide(f0({ account: { syncAt: NOW, complete: false, buyingPower: "100", positions: [], openOrders: [] } }))).includes("SYNC_INCOMPLETE"));
  assert.ok(codes(decide(f0({ book: undefined }))).includes("BOOK_MISSING"));
  assert.ok(codes(decide(f0({ book: { retrievedAt: NOW, bids: [{ price: "0.49", size: "500" }], asks: [] } }))).includes("NO_LIQUIDITY"));
});

test("R08 (sizing) — a $5 daily remainder sizes down to 9 contracts ($4.68); saturated event / market / total / count / loss-stop gates block", () => {
  const daily = decide(f0({ exposure: { ...f0().exposure, dailyCommitted: "45" } }));
  assert.equal(daily.outcome, "eligible");
  assert.deepEqual({ qty: daily.sizing!.quantity, worst: daily.sizing!.worstCost, by: daily.sizing!.boundBy }, { qty: "9", worst: "4.68", by: "daily_cap" });
  assert.ok(codes(decide(f0({ exposure: { ...f0().exposure, perEvent: "20" } }))).includes("EVENT_CAP_REACHED"));
  assert.ok(codes(decide(f0({ exposure: { ...f0().exposure, perMarket: "10" } }))).includes("MARKET_CAP_REACHED"));
  assert.ok(codes(decide(f0({ exposure: { ...f0().exposure, openRiskTotal: "100" } }))).includes("TOTAL_RISK_CAP_REACHED"));
  assert.ok(codes(decide(f0({ exposure: { ...f0().exposure, dailyCommitted: "50" } }))).includes("DAILY_CAP_REACHED"));
  assert.ok(codes(decide(f0({ exposure: { ...f0().exposure, openMarkets: 5 } }))).includes("MAX_OPEN_MARKETS"));
  assert.ok(codes(decide(f0({ exposure: { ...f0().exposure, dailyRealizedLoss: "20" } }))).includes("DAILY_LOSS_STOP"));
  assert.equal(decide(f0({ exposure: { ...f0().exposure, dailyRealizedLoss: "19.99" } })).outcome, "eligible");
  const bp = decide(f0({ account: { ...f0().account!, buyingPower: "7" } }));
  assert.deepEqual({ qty: bp.sizing!.quantity, by: bp.sizing!.boundBy }, { qty: "13", by: "buying_power" }, "7 / .52 = 13.46 → 13");
  assert.ok(codes(decide(f0({ opportunityConsumed: true }))).includes("OPPORTUNITY_CONSUMED"));
});

test("R09 (checks) — opposing exposure or an open order on the contract blocks; an unreflected reservation is subtracted from buying power once", () => {
  const opposing = decide(f0({ account: { ...f0().account!, positions: [{ venueMarketId: "M-A", netQuantity: "-5" }] } }));
  assert.ok(codes(opposing).includes("OPPOSING_EXPOSURE"));
  const sameSide = decide(f0({ account: { ...f0().account!, positions: [{ venueMarketId: "M-A", netQuantity: "5" }] } }));
  assert.equal(sameSide.gates.find((g) => g.id === "no_opposing_exposure")!.satisfied, true, "same-side external holdings do not block (they count toward limits)");
  const order = decide(f0({ account: { ...f0().account!, openOrders: [{ venueMarketId: "M-A", intent: "ORDER_INTENT_BUY_LONG", state: "open" }] } }));
  assert.ok(codes(order).includes("OPEN_ORDER_ON_CONTRACT"));
  const other = decide(f0({ account: { ...f0().account!, positions: [{ venueMarketId: "M-Z", netQuantity: "-5" }], openOrders: [{ venueMarketId: "M-Z" }] } }));
  assert.equal(other.outcome, "eligible", "exposure on another contract is not opposing exposure here");
  const unreflected = decide(f0({ account: { ...f0().account!, buyingPower: "12" }, exposure: { ...f0().exposure, unreflectedReservations: "9.88" } }));
  assert.deepEqual({ qty: unreflected.sizing!.quantity, by: unreflected.sizing!.boundBy }, { qty: "4", by: "buying_power" }, "12 − 9.88 = 2.12 → 4 contracts");
  const reflected = decide(f0({ account: { ...f0().account!, buyingPower: "2.12" }, exposure: { ...f0().exposure, unreflectedReservations: "0" } }));
  assert.equal(reflected.sizing!.quantity, "4", "once the venue reflects the reservation it is not subtracted again");
});

test("F10 (fill maths) — only 10 contracts at the limit, the rest more expensive: 10 fills for $5.20 including fees, remainder IOC-canceled", () => {
  const sim = simulateIocFill({ side: "yes", wirePrice: "0.5", quantity: "19", quantityIncrement: "1", fee: { kind: "per_contract", value: "0.02" }, book: { retrievedAt: NOW, bids: [{ price: "0.49", size: "500" }], asks: [{ price: "0.50", size: "10" }, { price: "0.51", size: "500" }] }, latencyMs: 250 });
  assert.deepEqual({ filled: sim.filledQuantity, canceled: sim.remainderCanceled, cost: sim.costTotal, fees: sim.fees, allIn: sim.allIn, fills: sim.fills.length, at: sim.filledAt }, { filled: "10", canceled: "9", cost: "5", fees: "0.2", allIn: "5.2", fills: 1, at: "2026-10-01T12:00:00.250Z" });
  assert.match(sim.note, /IOC, no top-up/);
  const none = simulateIocFill({ side: "yes", wirePrice: "0.5", quantity: "19", quantityIncrement: "1", fee: { kind: "per_contract", value: "0.02" }, book: { retrievedAt: NOW, bids: [], asks: [{ price: "0.51", size: "500" }] } });
  assert.equal(none.filledQuantity, "0");
  assert.equal(none.remainderCanceled, "19");
  const noSide = simulateIocFill({ side: "no", wirePrice: "0.57", quantity: "5", quantityIncrement: "1", fee: { kind: "coefficient", value: "0.06" }, book: { retrievedAt: NOW, bids: [{ price: "0.58", size: "3" }, { price: "0.57", size: "10" }, { price: "0.50", size: "10" }], asks: [] } });
  assert.deepEqual(noSide.fills.map((f) => [f.yesPrice, f.chosenCost, f.quantity]), [["0.58", "0.42", "3"], ["0.57", "0.43", "2"]], "a NO buy consumes YES bids at or above the wire price, cost = 1 − bid");
  assert.equal(noSide.filledQuantity, "5");
});
