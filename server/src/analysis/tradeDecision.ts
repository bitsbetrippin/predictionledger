/**
 * Prediction Ledger — the pure trade / no-trade decision (1.12, RSK-01…04, RSK-06 checks, RSK-07 inputs).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Every gate is evaluated and returned with a stable reason code — nothing short-circuits, so a skipped decision
 * is as inspectable as an eligible one. Money goes through `Dec`; the clock is an input. The function knows nothing
 * about databases, venues or SDKs: the service around it gathers the inputs and persists the result unchanged.
 *
 * Sizing (RSK-04): for N contracts paying $1 each if the chosen side wins,
 *   worst_cost = N · chosen_side_limit_cost + fee_bound(N)
 *   net_edge   = p_chosen − worst_cost / N
 *   EV         = N · p_chosen − worst_cost
 * N is floored to the quantity increment so that worst_cost fits inside every cap; the YES-denominated wire price is
 * the chosen cost floored to the tick for a YES buy and the ceiling of the complement for a NO buy; the cost and the
 * edge are rechecked after rounding. Chosen side = the more probable side, strictly above the threshold — never the
 * cheaper side.
 */

import type { ContractVerificationStatus, DecisionGate, DecisionOutcome, DecisionSizing, ForecastStatus, MarketProviderId, RiskLimits, TradingMode } from "@prediction-ledger/shared";
import { D, Dec } from "./decimal.js";
import { validateProbabilities } from "./forecast.js";

export const POLICY_VERSION = "pilot-v1";

/** Proposed pilot defaults (RSK-02/03). Configurable; never endorsed bankroll sizing. */
export const DEFAULT_LIMITS: RiskLimits = {
  currency: "USD",
  orderBudget: "10",
  dailyCommitmentCap: "50",
  totalOpenRisk: "100",
  perMarket: "10",
  perEvent: "20",
  maxOpenMarkets: 5,
  dailyLossStop: "20",
  probabilityThreshold: "0.50",
  minNetEdge: "0.03",
  bookMaxAgeMs: 10_000,
  syncMaxAgeMs: 30_000,
  forecastMaxAgeMs: 30 * 60_000,
  preEventBufferMs: 5 * 60_000,
};

export interface DecisionBook {
  retrievedAt: string;
  /** YES-denominated levels, best first; sizes in contracts. */
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
}

export interface FeeSchedule {
  /** `per_contract`: a fixed USD fee per filled contract (test schedules). `coefficient`: Θ in Θ·C·p·(1−p). */
  kind: "per_contract" | "coefficient";
  value?: string;
  effectiveAt?: string;
  /** An announced later schedule; the bound uses the larger of the two when it could apply before the cutoff. */
  upcoming?: { value: string; effectiveAt: string };
}

export interface DecisionAccount {
  syncAt?: string;
  complete: boolean;
  buyingPower?: string;
  /** `external`: the app has no order of its own on that market (2.0.0-rc.2) — an entry there would pyramid onto a hand-placed position. */
  positions: { venueMarketId: string; netQuantity: string; external?: boolean }[];
  openOrders: { venueMarketId: string; intent?: string; state?: string }[];
}

export interface DecisionExposure {
  openRiskTotal: string;
  dailyCommitted: string;
  dailyRealizedLoss: string;
  openMarkets: number;
  /** Already committed on this market / event (open positions + live reservations). */
  perMarket: string;
  perEvent: string;
  /** Reserved locally but not yet reflected in the venue's buying power (RSK-06). */
  unreflectedReservations: string;
  /** This market already holds an open position or reservation of ours. */
  marketAlreadyOpen: boolean;
}

export interface DecisionInput {
  now: string;
  mode: TradingMode;
  offline: boolean;
  limits: RiskLimits;
  forecast?: { id: string; pYes: string; pNo: string; asOf: string; status: ForecastStatus; expiresAt?: string; strategyVersion?: string; category?: string };
  /** 2.0 (RV-01): the automation authorization's scope; an auto-live decision must fall inside it (AUTO-01). */
  authorization?: { strategyVersion?: string; category?: string };
  verification?: { id: string; version: number; status: ContractVerificationStatus; staleAt?: string; cutoffAt?: string; cutoffUnknown: boolean; rulesHash?: string; sideId?: string };
  contract: {
    venue: MarketProviderId;
    venueMarketId: string;
    eventId?: string;
    status?: string;
    active: boolean;
    closed: boolean;
    tickSize?: string;
    minQuantity?: string;
    quantityIncrement?: string;
    rulesHash?: string;
    sides: { id: string; label: string; long: boolean; tradable?: boolean }[];
  };
  book?: DecisionBook;
  fee: FeeSchedule;
  /** Undefined in paper mode without a connected account: the paper bankroll stands in. */
  account?: DecisionAccount;
  /** Paper bankroll available (paper mode); ignored when an account is supplied. */
  paperBuyingPower?: string;
  exposure: DecisionExposure;
  opportunityConsumed: boolean;
  /** Client hint: may lower the quantity, never raise it (R03). */
  candidateQuantity?: string;
}

export interface DecisionResult {
  outcome: DecisionOutcome;
  gates: DecisionGate[];
  reasonCodes: string[];
  sizing?: DecisionSizing;
  deadlineAt?: string;
  ages: { bookMs?: number; syncMs?: number; forecastMs?: number };
  feePerContract?: string;
}

const ms = (iso?: string): number | undefined => { if (!iso) return undefined; const t = Date.parse(iso); return Number.isFinite(t) ? t : undefined; };

/** RSK-04 wire price: YES buy → floor the chosen cost to the tick; NO buy → ceiling of the YES-denominated complement. */
export function wirePriceFor(side: "yes" | "no", chosenMaxCost: Dec | string, tick: Dec | string): { wirePrice: Dec; chosenCost: Dec } {
  const cost = D(chosenMaxCost);
  const t = D(tick);
  if (side === "yes") {
    const wire = cost.alignTo(t, "floor");
    return { wirePrice: wire, chosenCost: wire };
  }
  const wire = Dec.ONE.sub(cost).alignTo(t, "ceil");
  return { wirePrice: wire, chosenCost: Dec.ONE.sub(wire) };
}

/** Conservative per-contract fee bound for the schedule at the given YES price (fails closed when unknown). */
export function feePerContractBound(fee: FeeSchedule, yesPrice: Dec, deadlineMs?: number, nowMs?: number): Dec | undefined {
  if (!fee.value) return undefined;
  let value = D(fee.value);
  if (fee.upcoming) {
    const eff = ms(fee.upcoming.effectiveAt);
    const horizon = deadlineMs ?? (nowMs !== undefined ? nowMs + 24 * 3_600_000 : undefined);
    if (eff === undefined || horizon === undefined || eff <= horizon) value = D(fee.upcoming.value).gt(value) ? D(fee.upcoming.value) : value;
  }
  if (fee.kind === "per_contract") return value;
  // Θ · p · (1 − p) is largest at p = 0.5; fills can only happen at prices up to the limit for a YES buy (and
  // down to it for the synthetic NO), so the bound is taken at the worst price the limit permits. One cent per
  // contract is added for per-fill rounding under fragmentation.
  const p = yesPrice.lte("0.5") ? yesPrice : Dec.ONE.sub(yesPrice).gte("0.5") ? D("0.5") : Dec.ONE.sub(yesPrice);
  const pq = p.mul(Dec.ONE.sub(p));
  const worst = pq.gt("0.25") ? D("0.25") : pq;
  return value.mul(worst).round(4, "ceil").add("0.01");
}

/** The calendar day of `now` in the budget timezone (RSK-07). */
export function dailyBucket(now: string, timezone: string): string {
  try {
    return new Date(Date.parse(now)).toLocaleDateString("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return now.slice(0, 10);
  }
}

/**
 * Tolerance for an input stamped slightly *after* `now` (a book fetched in the same call, an NTP step): anything
 * further in the future is not fresh (2.0, RV-03). Inputs older than the limit are stale as before.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 2_000;

export function decide(input: DecisionInput): DecisionResult {
  const gates: DecisionGate[] = [];
  const codes: string[] = [];
  const gate = (id: string, label: string, ok: boolean, detail: string, code?: string) => {
    gates.push({ id, label, satisfied: ok, detail, code: ok ? undefined : code });
    if (!ok && code && !codes.includes(code)) codes.push(code);
    return ok;
  };
  const nowMs = ms(input.now);
  if (nowMs === undefined) throw new Error(`now must be an ISO instant, got ${input.now}`);
  const L = input.limits;
  const ages: DecisionResult["ages"] = {};

  // ---- mode / connectivity ----
  gate("mode", "Trading mode allows decisions", input.mode !== "disabled", input.mode === "disabled" ? "mode is disabled" : `mode ${input.mode}`, "MODE_DISABLED");
  gate("online", "Internet access enabled", !input.offline, input.offline ? "offline: prices and account state cannot be fresh; fail closed" : "online", "OFFLINE");

  // ---- contract ----
  gate("venue", "Polymarket US contract", input.contract.venue === "polymarket_us", input.contract.venue === "polymarket_us" ? "polymarket_us" : `${input.contract.venue} is research-only`, "WRONG_VENUE");
  const v = input.verification;
  const verified = !!v && v.status === "verified_equivalent" && !v.staleAt;
  gate("contract_verified", "Contract verified equivalent and not stale", verified, !v ? "no contract verification" : v.status !== "verified_equivalent" ? `verification status ${v.status}` : v.staleAt ? `verification stale since ${v.staleAt}` : `verification v${v.version}`, !v ? "CONTRACT_NOT_VERIFIED" : v.staleAt ? "CONTRACT_STALE" : "CONTRACT_NOT_VERIFIED");
  const rulesMatch = !v?.rulesHash || !input.contract.rulesHash || v.rulesHash === input.contract.rulesHash;
  gate("rules_current", "Rules text unchanged since verification", rulesMatch, rulesMatch ? "rules hash matches" : "rules hash changed since verification", "RULES_CHANGED");
  const statusOpen = input.contract.status === undefined || /OPEN/i.test(input.contract.status);
  const open = input.contract.active && !input.contract.closed && statusOpen;
  gate("market_open", "Market open for trading", open, open ? "open" : `status ${input.contract.status ?? (input.contract.closed ? "closed" : "inactive")}`, "MARKET_NOT_OPEN");
  const longSide = input.contract.sides.find((s) => s.long);
  const constraintsOk = !!input.contract.tickSize && !!input.contract.minQuantity && !!longSide;
  gate("constraints", "Tick, quantity increment and durable side ids published", constraintsOk, constraintsOk ? `tick ${input.contract.tickSize}, min qty ${input.contract.minQuantity}` : "venue omits tick size, minimum quantity or side ids — category blocked", "CONSTRAINTS_UNSUPPORTED");

  // ---- cutoff ----
  const cutoffMs = v && !v.cutoffUnknown ? ms(v.cutoffAt) : undefined;
  gate("cutoff_known", "Pre-event cutoff known", cutoffMs !== undefined, cutoffMs !== undefined ? `cutoff ${v!.cutoffAt}` : "no safe cutoff (event start, observation cutoff or trading close unknown)", "CUTOFF_UNKNOWN");
  const deadlineMs = cutoffMs !== undefined ? cutoffMs - L.preEventBufferMs : undefined;
  const deadlineAt = deadlineMs !== undefined ? new Date(deadlineMs).toISOString() : undefined;
  gate("pre_cutoff", `Before cutoff minus ${L.preEventBufferMs / 60_000}-minute buffer`, deadlineMs !== undefined && nowMs < deadlineMs, deadlineMs === undefined ? "no deadline" : nowMs < deadlineMs ? `${Math.round((deadlineMs - nowMs) / 1000)} s before ${deadlineAt}` : `at or after ${deadlineAt} (market open or not)`, "AT_OR_PAST_CUTOFF");

  // ---- forecast ----
  const f = input.forecast;
  gate("forecast_present", "Forecast present", !!f, f ? f.id : "no forecast", "FORECAST_MISSING");
  const probs = f ? validateProbabilities(f.pYes, f.pNo) : ["no forecast"];
  gate("forecast_valid", "Forecast probabilities valid (finite, [0,1], sum 1)", probs.length === 0, probs.length ? probs.join("; ") : `pYes ${f!.pYes} pNo ${f!.pNo}`, "FORECAST_INVALID");
  const fAsOf = ms(f?.asOf);
  if (fAsOf !== undefined) ages.forecastMs = nowMs - fAsOf;
  const expiredByStamp = !!f?.expiresAt && nowMs > ms(f.expiresAt)!;
  const fStatus: ForecastStatus | undefined = f ? (f.status === "insufficient_data" ? "insufficient_data" : expiredByStamp ? "expired" : f.status) : undefined;
  gate("forecast_status", "Forecast usable (not insufficient / expired)", fStatus === "experimental" || fStatus === "qualified", fStatus ?? "none", fStatus === "insufficient_data" ? "FORECAST_INSUFFICIENT" : fStatus === "expired" ? "FORECAST_EXPIRED" : "FORECAST_MISSING");
  const fresh = fAsOf !== undefined && ages.forecastMs! <= L.forecastMaxAgeMs && ages.forecastMs! >= -CLOCK_SKEW_TOLERANCE_MS;
  gate("forecast_fresh", `Forecast age ≤ ${L.forecastMaxAgeMs / 60_000} min`, fresh, fAsOf === undefined ? "no forecast instant" : `${ages.forecastMs} ms old`, "FORECAST_STALE");
  if (input.mode === "auto_live") {
    gate("strategy_qualified", "Strategy qualified for automation", fStatus === "qualified", fStatus === "qualified" ? "qualified" : `forecast is ${fStatus ?? "absent"}; auto-live accepts only a qualified strategy`, "STRATEGY_NOT_QUALIFIED");
    // RV-01: the owner armed one (strategy version, category) pair; a qualified forecast outside that pair is not authorized.
    const a = input.authorization;
    const inScope = !!a && !!f && !!a.strategyVersion && !!a.category && f.strategyVersion === a.strategyVersion && f.category === a.category;
    gate("authorized_scope", "Forecast inside the armed strategy/category scope", inScope, !a || !a.strategyVersion || !a.category ? "no automation authorization scope" : !f ? "no forecast" : inScope ? `${a.strategyVersion} / ${a.category}` : `forecast is ${f.strategyVersion ?? "?"} / ${f.category ?? "?"}, armed for ${a.strategyVersion} / ${a.category}`, "AUTHORIZATION_SCOPE");
  }

  // ---- book ----
  const bookAt = ms(input.book?.retrievedAt);
  if (bookAt !== undefined) ages.bookMs = nowMs - bookAt;
  gate("book_fresh", `Order book age ≤ ${L.bookMaxAgeMs / 1000} s`, bookAt !== undefined && ages.bookMs! <= L.bookMaxAgeMs && ages.bookMs! >= -CLOCK_SKEW_TOLERANCE_MS, bookAt === undefined ? "no book" : `${ages.bookMs} ms old`, bookAt === undefined ? "BOOK_MISSING" : "BOOK_STALE");

  // ---- account ----
  const acct = input.account;
  if (acct) {
    const syncAt = ms(acct.syncAt);
    if (syncAt !== undefined) ages.syncMs = nowMs - syncAt;
    gate("sync_fresh", `Account sync age ≤ ${L.syncMaxAgeMs / 1000} s`, syncAt !== undefined && ages.syncMs! <= L.syncMaxAgeMs && ages.syncMs! >= -CLOCK_SKEW_TOLERANCE_MS, syncAt === undefined ? "never synced" : `${ages.syncMs} ms old`, syncAt === undefined ? "SYNC_MISSING" : "SYNC_STALE");
    gate("sync_complete", "Account snapshot complete", acct.complete, acct.complete ? "every page read" : "positions/orders not fully paged; absence cannot be inferred", "SYNC_INCOMPLETE");
  } else {
    const paperOk = input.mode === "paper" && !!input.paperBuyingPower;
    gate("sync_fresh", "Account state", paperOk, paperOk ? "paper: the paper bankroll stands in for the account" : "no account state", "SYNC_MISSING");
  }

  // ---- fee ----
  gate("fee_known", "Fee schedule known", !!input.fee.value, input.fee.value ? `${input.fee.kind} ${input.fee.value}${input.fee.upcoming ? ` (→ ${input.fee.upcoming.value} from ${input.fee.upcoming.effectiveAt})` : ""}` : "fee unknown; fail closed", "FEE_UNKNOWN");

  // ---- exposure / opportunity ----
  gate("opportunity", "Opportunity not yet consumed", !input.opportunityConsumed, input.opportunityConsumed ? "an app entry on this contract already exists (no pyramiding, re-entry or IOC retry)" : "first entry", "OPPORTUNITY_CONSUMED");
  const lossStop = D(input.exposure.dailyRealizedLoss).lt(L.dailyLossStop);
  gate("daily_loss_stop", `Daily realized loss < ${L.dailyLossStop}`, lossStop, `realized loss ${input.exposure.dailyRealizedLoss} today`, "DAILY_LOSS_STOP");
  const marketsOk = input.exposure.marketAlreadyOpen || input.exposure.openMarkets < L.maxOpenMarkets;
  gate("max_open_markets", `Open/pending markets < ${L.maxOpenMarkets}`, marketsOk, `${input.exposure.openMarkets} open`, "MAX_OPEN_MARKETS");

  // ---- probability and side ----
  let side: "yes" | "no" | undefined;
  let pChosen: Dec | undefined;
  if (f && probs.length === 0) {
    const py = D(f.pYes), pn = D(f.pNo);
    if (py.gt(pn)) { side = "yes"; pChosen = py; } else if (pn.gt(py)) { side = "no"; pChosen = pn; }
  }
  const probOk = !!pChosen && pChosen.gt(L.probabilityThreshold);
  gate("probability", `Chosen side probability > ${L.probabilityThreshold} (exclusive)`, probOk, pChosen ? `${side} at ${pChosen}` : "no side is more probable", "PROB_NOT_ABOVE_HALF");

  // ---- opposing exposure (RSK-06) ----
  if (acct && side) {
    const pos = acct.positions.filter((p) => p.venueMarketId === input.contract.venueMarketId && !D(p.netQuantity).isZero());
    const opposing = pos.some((p) => (side === "yes" ? D(p.netQuantity).isNeg() : D(p.netQuantity).isPos()));
    gate("no_opposing_exposure", "No opposing position on this contract", !opposing, opposing ? `existing ${side === "yes" ? "short" : "long"} exposure ${pos.map((p) => p.netQuantity).join(",")} on ${input.contract.venueMarketId}` : "none", "OPPOSING_EXPOSURE");
    const orders = acct.openOrders.filter((o) => o.venueMarketId === input.contract.venueMarketId);
    gate("no_open_order", "No open order on this contract", orders.length === 0, orders.length ? `${orders.length} open order(s) on the contract (external or unreconciled)` : "none", "OPEN_ORDER_ON_CONTRACT");
    // 2.0.0-rc.2: a position the app did not place blocks app entry on that contract (no pyramiding onto hand-placed holdings).
    const external = pos.filter((p) => p.external);
    gate("no_external_position", "No hand-placed position on this contract", external.length === 0, external.length ? `the account already holds ${external.map((p) => p.netQuantity).join(",")} on ${input.contract.venueMarketId} that this app did not place` : "none", "EXTERNAL_POSITION_ON_CONTRACT");
  }

  // ---- sizing ----
  let sizing: DecisionSizing | undefined;
  let feePerContract: Dec | undefined;
  if (side && pChosen && input.book && constraintsOk) {
    const tick = D(input.contract.tickSize!);
    const increment = D(input.contract.quantityIncrement ?? input.contract.minQuantity!);
    const minQty = D(input.contract.minQuantity!);
    const bestAsk = input.book.asks[0]?.price;
    const bestBid = input.book.bids[0]?.price;
    const rawCost = side === "yes" ? (bestAsk ? D(bestAsk) : undefined) : bestBid ? Dec.ONE.sub(D(bestBid)) : undefined;
    gate("liquidity", "Chosen side has an offer", !!rawCost, rawCost ? `chosen-side offer at ${rawCost}` : `no ${side === "yes" ? "asks" : "bids"} in the book`, "NO_LIQUIDITY");
    if (rawCost) {
      const { wirePrice, chosenCost } = wirePriceFor(side, rawCost, tick);
      feePerContract = feePerContractBound(input.fee, wirePrice, deadlineMs, nowMs);
      const allIn = feePerContract ? chosenCost.add(feePerContract) : undefined;
      // Caps: the smallest positive remaining amount bounds the order; any non-positive remainder blocks.
      const caps: { id: string; label: string; remaining: Dec; code: string }[] = [
        { id: "order_budget", label: `Order budget ${L.orderBudget}`, remaining: D(L.orderBudget), code: "ORDER_BUDGET_ZERO" },
        { id: "market_cap", label: `Per-market cap ${L.perMarket}`, remaining: D(L.perMarket).sub(input.exposure.perMarket), code: "MARKET_CAP_REACHED" },
        { id: "total_risk_cap", label: `Total open risk ${L.totalOpenRisk}`, remaining: D(L.totalOpenRisk).sub(input.exposure.openRiskTotal), code: "TOTAL_RISK_CAP_REACHED" },
        { id: "daily_cap", label: `Daily new-commitment cap ${L.dailyCommitmentCap}`, remaining: D(L.dailyCommitmentCap).sub(input.exposure.dailyCommitted), code: "DAILY_CAP_REACHED" },
      ];
      if (input.contract.eventId) caps.push({ id: "event_cap", label: `Per-event cap ${L.perEvent}`, remaining: D(L.perEvent).sub(input.exposure.perEvent), code: "EVENT_CAP_REACHED" });
      const bp = acct ? (acct.buyingPower ? D(acct.buyingPower).sub(input.exposure.unreflectedReservations) : undefined) : input.paperBuyingPower ? D(input.paperBuyingPower) : undefined;
      caps.push({ id: "buying_power", label: "Buying power (less unreflected reservations)", remaining: bp ?? D("-1"), code: bp ? "BUYING_POWER" : "BUYING_POWER_UNKNOWN" });
      let cap: Dec | undefined;
      let boundBy = "";
      for (const c of caps) {
        gate(c.id, c.label, c.remaining.isPos(), `${c.remaining.toFixed(2)} remaining`, c.code);
        if (c.remaining.isPos() && (!cap || c.remaining.lt(cap))) { cap = c.remaining; boundBy = c.id; }
      }
      const capOk = caps.every((c) => c.remaining.isPos());
      if (allIn && capOk && cap) {
        let qty = cap.div(allIn, "floor").alignTo(increment, "floor");
        if (input.candidateQuantity) { const cand = D(input.candidateQuantity).alignTo(increment, "floor"); if (cand.isPos() && cand.lt(qty)) { qty = cand; boundBy = "candidate"; } }
        const qtyOk = qty.gte(minQty) && qty.isPos();
        gate("quantity", "A valid quantity fits every cap", qtyOk, qtyOk ? `${qty} contracts (bound by ${boundBy})` : `no quantity ≥ ${minQty} fits ${cap.toFixed(2)} at ${allIn} all-in`, "NO_VALID_QUANTITY");
        if (qtyOk) {
          const feeBound = input.fee.kind === "per_contract" ? feePerContract!.mul(qty) : feePerContract!.mul(qty).round(2, "ceil");
          const worstCost = chosenCost.mul(qty).add(feeBound);
          const netEdge = pChosen.sub(worstCost.div(qty, "ceil"));
          const ev = pChosen.mul(qty).sub(worstCost);
          const fits = worstCost.lte(cap);
          gate("worst_cost_within_cap", "Worst cost within the binding cap after rounding", fits, `${worstCost.toFixed(2)} ≤ ${cap.toFixed(2)}`, "WORST_COST_EXCEEDS_CAP");
          const edgeOk = netEdge.gte(L.minNetEdge);
          gate("net_edge", `Net edge ≥ ${L.minNetEdge} after rounding`, edgeOk, `p ${pChosen} − all-in ${worstCost.div(qty, "ceil")} = ${netEdge}`, netEdge.isNeg() ? "EDGE_NEGATIVE" : "EDGE_BELOW_MIN");
          // The durable side id of the CHOSEN side (which may differ from the claim's side): long → YES, the other → NO.
          const sideRow = side === "yes" ? longSide : input.contract.sides.find((s) => !s.long);
          sizing = {
            side, sideId: sideRow?.id ?? (side === "yes" ? v?.sideId : undefined), sideLabel: sideRow?.label, pChosen: pChosen.toString(), quantity: qty.toString(), limitCost: chosenCost.toString(), wirePrice: wirePrice.toString(),
            feeBound: feeBound.toString(), worstCost: worstCost.toString(), netEdge: netEdge.toString(), estimatedEv: ev.toString(), boundBy,
          };
        }
      } else if (!allIn) {
        gate("quantity", "A valid quantity fits every cap", false, "fee unknown; cannot size", "FEE_UNKNOWN");
      }
    }
  } else {
    gate("quantity", "A valid quantity fits every cap", false, !side ? "no chosen side" : !input.book ? "no book" : "constraints unsupported", !side ? "PROB_NOT_ABOVE_HALF" : !input.book ? "BOOK_MISSING" : "CONSTRAINTS_UNSUPPORTED");
  }

  const allOk = gates.every((g) => g.satisfied);
  let outcome: DecisionOutcome = allOk ? "eligible" : "skipped";
  if (allOk && input.mode === "manual_live") outcome = "needs_review";
  if (allOk && input.mode === "paper" && fStatus === "experimental") outcome = "eligible";
  return { outcome, gates, reasonCodes: codes, sizing: allOk ? sizing : sizing, deadlineAt, ages, feePerContract: feePerContract?.toString() };
}

/** Everything a stored decision must carry (RSK-07), hashed for the immutable rationale. */
export function decisionInputsRecord(input: DecisionInput, result: DecisionResult): Record<string, unknown> {
  return {
    now: input.now,
    mode: input.mode,
    offline: input.offline,
    limits: input.limits,
    forecast: input.forecast,
    authorization: input.authorization,
    verification: input.verification,
    contract: input.contract,
    book: input.book ? { retrievedAt: input.book.retrievedAt, bids: input.book.bids.slice(0, 5), asks: input.book.asks.slice(0, 5) } : undefined,
    fee: input.fee,
    feePerContract: result.feePerContract,
    account: input.account ? { syncAt: input.account.syncAt, complete: input.account.complete, buyingPower: input.account.buyingPower, positionsOnContract: input.account.positions.filter((p) => p.venueMarketId === input.contract.venueMarketId), openOrdersOnContract: input.account.openOrders.filter((o) => o.venueMarketId === input.contract.venueMarketId) } : undefined,
    paperBuyingPower: input.paperBuyingPower,
    exposure: input.exposure,
    opportunityConsumed: input.opportunityConsumed,
    candidateQuantity: input.candidateQuantity,
    deadlineAt: result.deadlineAt,
    ages: result.ages,
  };
}
