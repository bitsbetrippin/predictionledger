/**
 * Prediction Ledger — contract verification tests (1.11): M01, M04–M08 and the documented-fact rules. Pure, synthetic fixtures.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Fixture F0 (03-Acceptance-Test-Plan): event start 2026-10-01T13:00Z, verified moneyline contract, YES = the exact
 * fixture proposition. Everything here is synthetic; nothing is a real trade target.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { MarketContractConstraints, MarketRecord, Prediction, SportsPick } from "@prediction-ledger/shared";
import { parseComparator, parsePeriod, parseSemantics, parseThreshold, revalidate, rulesHash, verifyContract, HARD_GATES } from "./contractVerification.js";

const RULES_ML = "In the upcoming american football game, scheduled for October 1 at 9:00AM ET: If Detroit wins, the market will resolve to “Lions”. If Buffalo wins, the market will resolve to “Bills”. If the game is postponed, this market will remain open until the game has been completed. If the game is canceled entirely, with no make-up game, this market will resolve 50-50.";
const RULES_SPREAD = "Resolves to the team that covers the spread, final score including overtime. If the game is postponed, this market will remain open until the game has been completed. If the game is canceled entirely, this market will resolve 50-50.";

const side = (id: string, label: string, long: boolean, team?: { name: string; abbreviation: string; league: string; alias: string }): MarketContractConstraints["sides"][number] => ({ id, label, long, tradable: true, ...(team ? { team } : {}) });
const LIONS = { name: "Detroit Lions", abbreviation: "DET", league: "nfl", alias: "Lions" };
const BILLS = { name: "Buffalo Bills", abbreviation: "BUF", league: "nfl", alias: "Bills" };

type MarketOverride = Omit<Partial<MarketRecord>, "constraints"> & { constraints?: Partial<MarketContractConstraints> };
function usMarket(over: MarketOverride = {}): MarketRecord {
  const { constraints, ...rest } = over;
  return {
    id: "m-a", provider: "polymarket_us", venueId: "1001", slug: "aec-nfl-det-buf-2026-10-01", url: "https://polymarket.us/event/nfl-det-buf-2026-10-01", question: "Detroit vs. Buffalo",
    description: RULES_ML, event: { id: "ev-a", slug: "nfl-det-buf-2026-10-01", title: "DET Lions vs BUF Bills" }, outcomes: [{ label: "Lions", tokenId: "aec-nfl-det-buf-2026-10-01:YES" }, { label: "Bills", tokenId: "aec-nfl-det-buf-2026-10-01:NO" }],
    endDate: "2026-10-01T13:00:00Z", startDate: "2026-09-25T00:00:00Z", active: true, closed: false, restricted: false, resolved: false, tags: ["sports"], watched: false, updatedAt: "2026-09-30T00:00:00Z",
    constraints: {
      venue: "polymarket_us", slug: "aec-nfl-det-buf-2026-10-01", status: "MARKET_STATUS_OPEN", tickSize: "0.01", minQuantity: "1", feeCoefficient: "0.06",
      sides: [side("s1", "Lions", true, LIONS), side("s2", "Bills", false, BILLS)], category: "sports", sportsMarketType: "SPORTS_MARKET_TYPE_MONEYLINE", gameStartTime: "2026-10-01T13:00:00Z", eventStartTime: "2026-10-01T13:00:00Z", retrievedAt: "2026-09-30T00:00:00Z",
      ...constraints,
    },
    ...rest,
  };
}

function pick(over: Omit<Partial<Prediction>, "sportsPick"> & { sportsPick?: Partial<SportsPick> } = {}): Prediction {
  const { sportsPick, ...rest } = over;
  return {
    id: "p1", videoId: "v1", kind: "sports_pick", quoteExact: "Bills win this one outright", normalizedStatement: "Buffalo Bills beat Detroit Lions (moneyline)", entities: ["Buffalo Bills", "Detroit Lions"], conditions: [], thresholds: [],
    madeOnDate: "2026-09-28", madeOnBasis: "publication", deadlineDate: "2026-10-01", userStatus: "accepted", occurrences: [], components: [], createdAt: "", updatedAt: "", ambiguities: [], quoteHash: "q1",
    sportsPick: { sport: "NFL", league: "nfl", teams: ["Detroit Lions", "Buffalo Bills"], eventDate: "2026-10-01", pick: { type: "moneyline", team: "Buffalo Bills" }, ...(sportsPick as object) },
    ...rest,
  } as Prediction;
}

function general(over: Partial<Prediction> = {}): Prediction {
  return {
    id: "p2", videoId: "v1", kind: "general", quoteExact: "Bitcoin is going to touch a hundred K before the end of October", normalizedStatement: "Bitcoin will trade above $100,000 at any point before November 1, 2026", entities: ["Bitcoin"], conditions: [], thresholds: ["$100,000"],
    madeOnDate: "2026-09-01", madeOnBasis: "publication", deadlineDate: "2026-11-01", userStatus: "accepted", occurrences: [], components: [], createdAt: "", updatedAt: "", ambiguities: [], quoteHash: "q2", ...over,
  } as Prediction;
}
const BTC_RULES = "This market will settle to Yes if the price of Bitcoin is above $100,000.00 at any point after the creation of this market and before 12:00 AM ET on November 1, 2026. Outcome sourced from CF Benchmarks' Bitcoin Real-Time Index.";
function btcMarket(over: MarketOverride = {}): MarketRecord {
  const { constraints, ...rest } = over;
  return {
    id: "m-btc", provider: "polymarket_us", venueId: "268833", slug: "cpc-btc-100k-10-31-2026", url: "https://polymarket.us/event/btc-100k", question: "When will Bitcoin cross $100k again? — Before November 2026", description: BTC_RULES,
    outcomes: [{ label: "Yes", tokenId: "x:YES" }, { label: "No", tokenId: "x:NO" }], endDate: "2027-01-14T23:00:00Z", active: true, closed: false, restricted: false, resolved: false, tags: ["crypto"], watched: false, updatedAt: "",
    constraints: { venue: "polymarket_us", slug: "cpc-btc-100k-10-31-2026", status: "MARKET_STATUS_OPEN", tickSize: "0.01", minQuantity: "0.01", feeCoefficient: "0.06", sides: [side("537230", "Yes", true), side("537231", "No", false)], category: "crypto", sportsMarketType: "SPORTS_MARKET_TYPE_FUTURE", retrievedAt: "", ...constraints },
    ...rest,
  };
}
const statusOf = (r: ReturnType<typeof verifyContract>, id: string) => r.fields.find((f) => f.id === id)?.status;

test("M01 — the exact synthetic US contract verifies field by field; the side is the picked team's durable side id; the cutoff is the game start", () => {
  const r = verifyContract({ prediction: pick(), market: usMarket() });
  assert.equal(r.status, "verified_equivalent", r.summary);
  assert.ok(r.fields.every((f) => f.status === "verified" || f.status === "not_applicable"), JSON.stringify(r.fields.filter((f) => f.status !== "verified")));
  assert.deepEqual({ id: r.sideId, label: r.sideLabel }, { id: "s2", label: "Buffalo Bills" });
  assert.match(r.sideBasis ?? "", /short/);
  assert.equal(r.cutoffAt, "2026-10-01T13:00:00Z");
  assert.equal(r.cutoffBasis, "game start");
  assert.equal(r.cutoffUnknown, false);
  assert.equal(r.rulesHash, rulesHash(RULES_ML));
  const ids = r.fields.map((f) => f.id);
  for (const id of ["venue", "market_open", "question", "rules_hash", "settlement_conditions", "league", "teams", "game_date", "game_start", "market_type", "line", "period", "overtime_rule", "tie_void_rule", "side", "trading_close"]) assert.ok(ids.includes(id), id);
});

test("M04 — same teams but next week's game, a missing start time, or a missing league are not executable even with identical text", () => {
  const nextWeek = verifyContract({ prediction: pick(), market: usMarket({ constraints: { gameStartTime: "2026-10-08T13:00:00Z", eventStartTime: "2026-10-08T13:00:00Z" } }) });
  assert.equal(nextWeek.status, "incompatible");
  assert.equal(statusOf(nextWeek, "game_date"), "incompatible");
  assert.equal(statusOf(nextWeek, "teams"), "verified", "text similarity would be 1.0 — the date decides");

  const noStart = verifyContract({ prediction: pick(), market: usMarket({ constraints: { gameStartTime: undefined, eventStartTime: undefined } }) });
  assert.equal(noStart.status, "incomplete");
  assert.equal(statusOf(noStart, "game_start"), "missing");
  assert.equal(statusOf(noStart, "game_date"), "missing");
  assert.equal(noStart.cutoffBasis, "trading close", "the trading close is still known, but the game itself is not placed");

  const noClaimDate = verifyContract({ prediction: pick({ sportsPick: { eventDate: undefined } }), market: usMarket() });
  assert.equal(noClaimDate.status, "incomplete");
  assert.match(noClaimDate.fields.find((f) => f.id === "game_date")!.note ?? "", /unknown never means exact/);

  const noLeague = verifyContract({ prediction: pick({ sportsPick: { sport: "football", league: undefined } }), market: usMarket({ slug: "aec-det-buf-2026-10-01", constraints: { sides: [side("s1", "Lions", true, { ...LIONS, league: "" }), side("s2", "Bills", false, { ...BILLS, league: "" })] } }) });
  assert.equal(noLeague.status, "incomplete");
  assert.equal(statusOf(noLeague, "league"), "missing");
});

test("M05 — line, period and overtime mismatches fail strict equivalence and show the exact difference", () => {
  const spreadMarket = usMarket({ slug: "asc-nfl-det-buf-2026-10-01-neg-7pt5", question: "DET -7.5", description: RULES_SPREAD, constraints: { sportsMarketType: "SPORTS_MARKET_TYPE_SPREAD", line: "7.5" } });
  const eagles35 = verifyContract({ prediction: pick({ quoteExact: "Lions minus three and a half", normalizedStatement: "Detroit Lions -3.5", sportsPick: { pick: { type: "spread", team: "Detroit Lions", line: -3.5 } } }), market: spreadMarket });
  assert.equal(eagles35.status, "incompatible");
  const line = eagles35.fields.find((f) => f.id === "line")!;
  assert.deepEqual({ status: line.status, expected: line.expected, found: line.found }, { status: "incompatible", expected: "-3.5", found: "-7.5" });
  const exact = verifyContract({ prediction: pick({ sportsPick: { pick: { type: "spread", team: "Detroit Lions", line: -7.5 } } }), market: spreadMarket });
  assert.equal(exact.status, "verified_equivalent", exact.summary);
  assert.equal(exact.sideId, "s1");

  const totalMarket = usMarket({ slug: "atc-nfl-det-buf-2026-10-01-48pt5", question: "Over/Under 48.5", description: RULES_SPREAD, constraints: { sportsMarketType: "SPORTS_MARKET_TYPE_TOTAL", line: "48.5", sides: [side("t1", "Over", true), side("t2", "Under", false)] } });
  const over475 = verifyContract({ prediction: pick({ sportsPick: { pick: { type: "total", line: 47.5, side: "over" } } }), market: totalMarket });
  assert.equal(statusOf(over475, "line"), "incompatible");
  assert.equal(over475.fields.find((f) => f.id === "line")!.found, "48.5");
  const over485 = verifyContract({ prediction: pick({ sportsPick: { pick: { type: "total", line: 48.5, side: "over" } } }), market: totalMarket });
  assert.equal(over485.status, "verified_equivalent", over485.summary);
  assert.equal(over485.sideId, "t1");

  const firstHalf = verifyContract({ prediction: pick(), market: usMarket({ slug: "aec-nfl-det-buf-2026-10-01-1h", question: "Detroit vs. Buffalo 1H" }) });
  assert.equal(statusOf(firstHalf, "period"), "incompatible");
  assert.match(firstHalf.fields.find((f) => f.id === "period")!.found ?? "", /1st half/);
  assert.match(firstHalf.fields.find((f) => f.id === "period")!.expected ?? "", /full game/);

  const regulation = verifyContract({ prediction: pick({ quoteExact: "Bills in regulation", sportsPick: { pick: { type: "spread", team: "Buffalo Bills", line: 7.5 } } }), market: spreadMarket });
  assert.equal(statusOf(regulation, "overtime_rule"), "incompatible", "a regulation-only claim against an overtime-inclusive contract");
  const otSilentSpread = verifyContract({ prediction: pick({ sportsPick: { pick: { type: "spread", team: "Detroit Lions", line: -7.5 } } }), market: usMarket({ slug: "asc-nfl-det-buf-2026-10-01-neg-7pt5", question: "DET -7.5", description: "If the game is canceled, this market resolves 50-50.", constraints: { sportsMarketType: "SPORTS_MARKET_TYPE_SPREAD", line: "7.5" } }) });
  assert.equal(statusOf(otSilentSpread, "overtime_rule"), "missing", "a spread contract silent on overtime blocks until the rule is documented");
});

test("M06 — general claims: touch vs close, > vs >=, units and geography are related but not equivalent", () => {
  const exact = verifyContract({ prediction: general(), market: btcMarket() });
  assert.equal(exact.status, "verified_equivalent", exact.summary);
  assert.equal(exact.sideId, "537230");
  assert.equal(exact.fields.find((f) => f.id === "measurement_source")!.found, "CF Benchmarks' Bitcoin Real-Time Index");

  const closes = verifyContract({ prediction: general(), market: btcMarket({ description: "This market will settle to Yes if the price of Bitcoin closes above $100,000.00 on December 31, 2026 at 5:00 PM ET, according to the CF Benchmarks Index." }) });
  assert.equal(closes.status, "incompatible");
  assert.equal(statusOf(closes, "proposition_semantics"), "incompatible");
  assert.equal(statusOf(closes, "observation_window"), "incompatible");

  const atLeast = verifyContract({ prediction: general({ normalizedStatement: "Bitcoin will touch at least $100,000 at any point before November 1, 2026" }), market: btcMarket() });
  assert.equal(statusOf(atLeast, "comparator"), "incompatible", ">= vs >");

  const percent = verifyContract({ prediction: general({ normalizedStatement: "Bitcoin will trade above 100% gains at any point before November 1, 2026", thresholds: ["100%"] }), market: btcMarket() });
  assert.equal(statusOf(percent, "units"), "incompatible");

  const geo = verifyContract({ prediction: general({ geography: "Texas" }), market: btcMarket({ description: `${BTC_RULES} This market considers the United States market only.` }) });
  assert.equal(statusOf(geo, "geography"), "incompatible");

  const noDeadline = verifyContract({ prediction: general({ deadlineDate: undefined }), market: btcMarket() });
  assert.equal(noDeadline.status, "incomplete");
  assert.equal(statusOf(noDeadline, "observation_window"), "missing");
});

test("M07 — side mapping comes from durable ids and team/negation semantics, never from the outcome order, a label or the slug", () => {
  const reversed = usMarket({ outcomes: [{ label: "Bills", tokenId: "x:NO" }, { label: "Lions", tokenId: "x:YES" }], constraints: { sides: [side("s2", "Bills", false, BILLS), side("s1", "Lions", true, LIONS)] } });
  const r = verifyContract({ prediction: pick(), market: reversed });
  assert.equal(r.status, "verified_equivalent", r.summary);
  assert.equal(r.sideId, "s2", "display order reversed; the Bills side id is unchanged");
  const lions = verifyContract({ prediction: pick({ quoteExact: "Lions get it done", normalizedStatement: "Detroit Lions beat Buffalo Bills", sportsPick: { pick: { type: "moneyline", team: "Detroit Lions" } } }), market: reversed });
  assert.equal(lions.sideId, "s1");
  const negated = verifyContract({ prediction: general({ normalizedStatement: "Bitcoin will not trade above $100,000 at any point before November 1, 2026" }), market: btcMarket({ constraints: { sides: [side("537231", "No", false), side("537230", "Yes", true)] } }) });
  assert.equal(negated.status, "verified_equivalent", negated.summary);
  assert.equal(negated.sideId, "537231");
  assert.match(negated.sideBasis ?? "", /negated/);
  const unknownTeam = verifyContract({ prediction: pick({ sportsPick: { pick: { type: "moneyline", team: "Kansas City Chiefs" } } }), market: usMarket() });
  assert.equal(statusOf(unknownTeam, "side"), "incompatible");
  assert.equal(unknownTeam.sideId, undefined);
});

test("M08 — a changed rules hash, a postponed game, a halted or closed market, a vanished side or an edited claim invalidate the verification", () => {
  const base = verifyContract({ prediction: pick(), market: usMarket() });
  const prev = { rulesHash: base.rulesHash, cutoffAt: base.cutoffAt, sideId: base.sideId, quoteHash: "q1", status: base.status };
  assert.deepEqual(revalidate({ previous: prev, market: usMarket(), prediction: pick(), currentQuoteHash: "q1" }), []);
  assert.match(revalidate({ previous: prev, market: usMarket({ description: `${RULES_ML} Overtime does not count.` }), prediction: pick(), currentQuoteHash: "q1" }).join(";"), /rules text changed/);
  assert.match(revalidate({ previous: prev, market: usMarket({ constraints: { gameStartTime: "2026-10-02T13:00:00Z", eventStartTime: "2026-10-02T13:00:00Z" } }), prediction: pick(), currentQuoteHash: "q1" }).join(";"), /schedule changed/);
  assert.match(revalidate({ previous: prev, market: usMarket({ constraints: { status: "MARKET_STATUS_HALTED" } }), prediction: pick(), currentQuoteHash: "q1" }).join(";"), /not open/);
  assert.match(revalidate({ previous: prev, market: usMarket({ closed: true, active: false, constraints: { status: "MARKET_STATUS_RESOLVED" } }), prediction: pick(), currentQuoteHash: "q1" }).join(";"), /not open/);
  assert.match(revalidate({ previous: prev, market: usMarket({ constraints: { sides: [side("z9", "Bills", false, BILLS), side("s1", "Lions", true, LIONS)] } }), prediction: pick(), currentQuoteHash: "q1" }).join(";"), /side id no longer/);
  assert.match(revalidate({ previous: prev, market: usMarket(), prediction: pick(), currentQuoteHash: "q1-edited" }).join(";"), /prediction changed/);
  // A halted market also fails a fresh verification outright.
  assert.equal(verifyContract({ prediction: pick(), market: usMarket({ constraints: { status: "MARKET_STATUS_HALTED" } }) }).status, "incompatible");
});

test("documented facts fill missing fields with provenance, never flip incompatible ones, and never touch hard gates (M09 core)", () => {
  const silent = usMarket({ description: "If Detroit wins, the market resolves to Lions. If Buffalo wins, the market resolves to Bills." });
  const before = verifyContract({ prediction: pick({ sportsPick: { league: undefined, sport: "football" } }), market: silent });
  assert.equal(before.status, "incomplete");
  assert.deepEqual(before.fields.filter((f) => f.status === "missing").map((f) => f.id).sort(), ["league", "tie_void_rule"]);
  const after = verifyContract({ prediction: pick({ sportsPick: { league: undefined, sport: "football" } }), market: silent, facts: { league: { value: "NFL", source: "NFL.com schedule, 2026-09-30" }, tie_void_rule: { value: "cancelled game resolves 50-50 per venue help page", source: "polymarket.us/faq/sports" } } });
  assert.equal(after.status, "verified_equivalent", after.summary);
  assert.deepEqual(after.fields.find((f) => f.id === "league")!.fact, { value: "NFL", source: "NFL.com schedule, 2026-09-30" });
  // A fact cannot repair an incompatible field…
  const wrongLine = verifyContract({ prediction: pick({ sportsPick: { pick: { type: "spread", team: "Detroit Lions", line: -3.5 } } }), market: usMarket({ slug: "asc-nfl-det-buf-2026-10-01-neg-7pt5", question: "DET -7.5", description: RULES_SPREAD, constraints: { sportsMarketType: "SPORTS_MARKET_TYPE_SPREAD", line: "7.5" } }), facts: { line: { value: "-3.5", source: "I say so" } } });
  assert.equal(statusOf(wrongLine, "line"), "incompatible");
  assert.match(wrongLine.fields.find((f) => f.id === "line")!.note ?? "", /ignored/);
  // …nor a hard gate: a closed market stays closed whatever the fact says.
  const closed = verifyContract({ prediction: pick(), market: usMarket({ closed: true, active: false, constraints: { status: "MARKET_STATUS_RESOLVED" } }), facts: { market_open: { value: "open", source: "screenshot" }, side: { value: "s1", source: "me" } } });
  assert.equal(closed.status, "incompatible");
  assert.equal(statusOf(closed, "market_open"), "incompatible");
  assert.match(closed.fields.find((f) => f.id === "market_open")!.note ?? "", /accepts no override/);
  assert.ok(HARD_GATES.has("side") && HARD_GATES.has("rules_hash"));
  // A fact that disagrees with the claim is recorded as incompatible, not accepted.
  const badLeague = verifyContract({ prediction: pick({ sportsPick: { league: undefined, sport: "football" } }), market: silent, facts: { league: { value: "NBA", source: "wrong page" }, tie_void_rule: { value: "50-50", source: "faq" } } });
  assert.equal(statusOf(badLeague, "league"), "incompatible");
});

test("parsers: period tokens, comparators, thresholds and semantics", () => {
  assert.deepEqual(parsePeriod("asc-nfl-det-buf-2026-09-17-1h-pos-17pt5"), { period: "first_half", basis: "stated" });
  assert.deepEqual(parsePeriod("Lions first quarter"), { period: "first_quarter", basis: "stated" });
  assert.deepEqual(parsePeriod("Bills -3.5"), { period: "full_game", basis: "unqualified" });
  assert.equal(parseComparator("Bitcoin above $100k"), ">");
  assert.equal(parseComparator("at least 5%"), ">=");
  assert.equal(parseComparator("falls below 2%"), "<");
  assert.deepEqual(parseThreshold("touch $100k by December 31"), { value: 100000, unit: "USD", raw: "$100k" });
  assert.deepEqual(parseThreshold("above $100,000.00 at any point"), { value: 100000, unit: "USD", raw: "$100,000.00" });
  assert.equal(parseThreshold("in 2026 on December 31"), undefined, "years and day numbers are not thresholds");
  assert.equal(parseSemantics("hits $100k at any point"), "touch");
  assert.equal(parseSemantics("closes above $100k on December 31"), "close");
});
