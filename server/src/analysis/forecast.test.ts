/**
 * Prediction Ledger — estimator, validation, evaluation and qualification tests (1.12: F01, F02, F03, F07, F08, F09).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { computeForecast, evaluateForecasts, forecastStatusAt, validateProbabilities, type ContributionInput, type EvaluationRecord, type HistoryObservation } from "./forecast.js";
import { D } from "./decimal.js";

const T = "2026-10-01T12:00:00Z";
/** n observations whose mean chosen-side edge is exactly `edge` (each one is outcome 1 at price 1 − edge). */
const history = (n: number, edge: number, prefix = "h"): HistoryObservation[] => Array.from({ length: n }, (_, i) => ({ predictionId: `${prefix}${i}`, marketId: `m${prefix}${i}`, side: "yes", priceAtClaim: (1 - edge).toFixed(4), outcome: 1 }));
const src = (key: string, stance: "yes" | "no", n: number, edge: number, over: Partial<ContributionInput> = {}): ContributionInput => ({ sourceKey: key, clusterKey: key, predictionId: `p-${key}`, stance, claimAt: T, history: history(n, edge, key), ...over });

test("decimal: parse, arithmetic, declared rounding and increment alignment", () => {
  assert.equal(D("0.52").mul("19").toString(), "9.88");
  assert.equal(D("10").div("0.52", "floor").alignTo("1", "floor").toString(), "19");
  assert.equal(D("0.435").alignTo("0.01", "floor").toString(), "0.43");
  assert.equal(D("1").sub("0.435").alignTo("0.01", "ceil").toString(), "0.57");
  assert.equal(D("0.435").alignTo("0.005", "floor").toString(), "0.435");
  assert.equal(D("2").div("3", "half_up").round(2).toString(), "0.67");
  assert.equal(D("-2").div("3", "floor").round(2, "floor").toString(), "-0.67");
  assert.equal(D(0.1).add(0.2).toString(), "0.3", "no binary float drift");
  assert.throws(() => D("abc"));
  assert.throws(() => D("1.123456789"), /exceeds 8 places/);
  assert.equal(D("9.88").toFixed(2), "9.88");
  assert.equal(D("1e-7").toString(), "0.0000001");
});

test("F01 — one source, n=20, mean edge .12, age 0, YES; midpoint .50 → d=.08, adjustment .04, pYes .54 / pNo .46 exactly", () => {
  const r = computeForecast({ p0: 0.5, asOf: T, contributions: [src("A", "yes", 20, 0.12)] });
  assert.equal(r.status, "computed");
  const c = r.contributions[0];
  assert.equal(c.n, 20);
  assert.ok(Math.abs(c.meanEdge! - 0.12) < 1e-12);
  assert.ok(Math.abs(c.shrunkEdge! - 0.08) < 1e-12, `shrunk ${c.shrunkEdge}`);
  assert.equal(c.weight, 1);
  assert.ok(Math.abs(r.adjustment - 0.04) < 1e-12);
  assert.equal(r.pYesText, "0.540000");
  assert.equal(r.pNoText, "0.460000");
  assert.deepEqual(validateProbabilities(r.pYes, r.pNo), []);
  assert.match(r.formulaText, /d = e·n\/\(n\+10\)/);
});

test("F02 — ten videos from the same creator and ten reuploads of the same report count as one contribution; the probability does not inflate", () => {
  const one = computeForecast({ p0: 0.5, asOf: T, contributions: [src("A", "yes", 20, 0.12)] });
  const sameCreator = Array.from({ length: 10 }, (_, i) => src("A", "yes", 20, 0.12, { predictionId: `A-video-${i}`, claimAt: new Date(Date.parse(T) - i * 3_600_000).toISOString() }));
  const reuploads = Array.from({ length: 10 }, (_, i) => src(`reupload-${i}`, "yes", 20, 0.12, { clusterKey: "report-x", predictionId: `re-${i}` }));
  const many = computeForecast({ p0: 0.5, asOf: T, contributions: [...sameCreator, ...reuploads] });
  // Twenty inputs, two independent clusters (creator A; the shared report) → two contributions, not twenty.
  const selected = many.contributions.filter((c) => c.selected);
  assert.equal(selected.length, 2);
  assert.equal(many.contributions.length, 20);
  assert.ok(Math.abs(many.pYes - (0.5 + 0.16 / 3)) < 1e-6, `two equal contributions: ${many.pYes}`);
  assert.ok(many.pYes < 0.6, `pYes ${many.pYes} must not inflate with repetition (one input gives ${one.pYes})`);
  const oneCluster = computeForecast({ p0: 0.5, asOf: T, contributions: sameCreator });
  assert.equal(oneCluster.contributions.filter((c) => c.selected).length, 1, "one contribution per creator");
  assert.equal(oneCluster.pYes, one.pYes, "ten videos from one creator = exactly one video from that creator");
  assert.equal(oneCluster.contributions.filter((c) => c.selected)[0].predictionId, "A-video-0", "the most recent valid claim represents the cluster");
  assert.equal(oneCluster.exclusions.find((e) => e.kind === "clustered_duplicate")?.count, 9);
});

test("F03 — two independent sources, equal weights, d=.08, one YES and one NO: adjustments cancel, pYes = .50, disagreement stays visible", () => {
  const r = computeForecast({ p0: 0.5, asOf: T, contributions: [src("A", "yes", 20, 0.12), src("B", "no", 20, 0.12)] });
  assert.equal(r.pYesText, "0.500000");
  assert.equal(r.pNoText, "0.500000");
  const sel = r.contributions.filter((c) => c.selected);
  assert.deepEqual(sel.map((c) => c.stance).sort(), [-1, 1], "both sides remain on the record");
  assert.ok(Math.abs(r.adjustment) < 1e-12);
});

test("no usable history → weight 0 with the reason; no usable contribution at all → insufficient_data even with a midpoint", () => {
  const r = computeForecast({ p0: 0.5, asOf: T, contributions: [src("A", "yes", 0, 0, { historyNote: "no settled verified claims" })] });
  assert.equal(r.status, "insufficient_data");
  assert.match(r.contributions[0].reason, /no usable history/);
  assert.equal(r.exclusions.find((e) => e.kind === "no_usable_history")?.count, 1);
  const later = computeForecast({ p0: 0.5, asOf: T, contributions: [src("A", "yes", 20, 0.12, { claimAt: "2026-10-02T00:00:00Z" })] });
  assert.equal(later.status, "insufficient_data", "a claim made after the forecast instant never leaks in");
  const invalid = computeForecast({ p0: 0.5, asOf: T, contributions: [src("A", "yes", 20, 0.12, { valid: false, invalidReason: "withdrawn" })] });
  assert.equal(invalid.status, "insufficient_data");
});

test("F07 — NaN, Infinity, 1.2, inconsistent sums and expiry are rejected or made explicit; nothing auto-trades on them", () => {
  assert.ok(validateProbabilities(NaN, 0.5).length);
  assert.ok(validateProbabilities(Infinity, 0).length);
  assert.ok(validateProbabilities(1.2, -0.2).length);
  assert.ok(validateProbabilities(0.6, 0.5).length, "pYes + pNo ≠ 1");
  assert.deepEqual(validateProbabilities("0.62", "0.38"), []);
  assert.ok(validateProbabilities(0.6, 0.4 + 2e-9).length, "1e-9 tolerance is exact");
  assert.throws(() => computeForecast({ p0: NaN, asOf: T, contributions: [] }));
  assert.equal(forecastStatusAt({ status: "experimental", expiresAt: "2026-10-01T12:30:00Z" }, "2026-10-01T12:30:00.001Z"), "expired");
  assert.equal(forecastStatusAt({ status: "experimental", expiresAt: "2026-10-01T12:30:00Z" }, "2026-10-01T12:30:00Z"), "experimental");
  assert.equal(forecastStatusAt({ status: "insufficient_data" }, T), "insufficient_data");
});

const rec = (pYes: number, outcome: 0 | 1 | null, over: Partial<EvaluationRecord> = {}): EvaluationRecord => ({ pYes, marketPYes: 0.5, outcome, traded: true, creatorObservations: { A: 25, B: 30 }, independentClusters: 2, ...over });

test("F09 — Brier over [.8,.3] with outcomes [1,0] = .065; baseline on the same events; skipped cases and counts retained", () => {
  const r = evaluateForecasts([rec(0.8, 1), rec(0.3, 0), rec(0.6, null, { traded: false, skipReason: "EDGE_BELOW_MIN" })]);
  assert.equal(r.events, 2);
  assert.ok(Math.abs(r.brier! - 0.065) < 1e-12);
  assert.ok(Math.abs(r.baselineBrier! - 0.25) < 1e-12, "market baseline at .5 on the same two events");
  assert.equal(r.coverage.decisions, 3);
  assert.equal(r.coverage.skipped, 1);
  assert.deepEqual(r.skipped, [{ reason: "EDGE_BELOW_MIN", count: 1 }]);
  assert.equal(r.calibration.reduce((s, b) => s + b.count, 0), 2);
  assert.equal(r.calibration[8].meanForecast, 0.8);
});

test("F08 — qualification gates apply exactly: 99 vs 100 events, Brier vs baseline, 20 observations per creator, two independent clusters", () => {
  const good = (n: number) => Array.from({ length: n }, (_, i) => rec(0.7, i % 10 === 0 ? 0 : 1, { marketPYes: 0.6 }));
  assert.equal(evaluateForecasts(good(99)).gate.qualified, false);
  assert.match(evaluateForecasts(good(99)).gate.reasons.join(";"), /99 settled events < 100/);
  assert.equal(evaluateForecasts(good(100)).gate.qualified, true);
  const worse = good(100).map((r) => ({ ...r, pYes: 0.99, marketPYes: 0.9 }));
  assert.match(evaluateForecasts(worse).gate.reasons.join(";"), /worse than the market baseline/);
  const thin = good(100).map((r) => ({ ...r, creatorObservations: { A: 19 } }));
  assert.match(evaluateForecasts(thin).gate.reasons.join(";"), /below 20 usable observations: A \(19\)/);
  const single = good(100).map((r) => ({ ...r, independentClusters: 1 }));
  assert.match(evaluateForecasts(single).gate.reasons.join(";"), /fewer than 2 independent/);
});
