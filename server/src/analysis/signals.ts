/**
 * Prediction Ledger — signal math (1.7): creator record vs market, edge with shrinkage, confidence gates.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Pure functions — no database, no network — so the numbers can be checked with fixtures.
 *
 * The honest measure of a creator is not their hit rate but what following them would have earned
 * at the market's price: for a settled, market-linked claim the market priced the creator's side at
 * p when the claim was made and the outcome was o ∈ {0, ½, 1}; buying that side then returned
 * (o − p) per share. The mean of that over a creator's settled linked claims is their *realized
 * edge*. A creator who only calls 95 % favourites earns ≈ 0 by this measure, as they should.
 *
 * For an open claim we assume the creator's realized edge persists, shrunk toward zero by n/(n+k)
 * (k = prior weight from Setup), and add it to the market's current price. Several creators on the
 * same market side combine by settled-count weight, one contribution per video. The label is a gate,
 * not a score: it appears only when the record, the liquidity and the deadlines all clear thresholds.
 */

import type { SignalConfidence } from "@prediction-ledger/shared";

export type Outcome = 0 | 0.5 | 1;

export interface SettledLinked {
  outcome: Outcome;
  priceAtMade: number;
}

export interface RecordStats {
  linkedSettled: number;
  realizedEdge?: number;
  marketBrier?: number;
  creatorBrier?: number;
}

export function recordStats(rows: SettledLinked[]): RecordStats {
  const n = rows.length;
  if (n === 0) return { linkedSettled: 0 };
  const mean = (f: (r: SettledLinked) => number) => rows.reduce((s, r) => s + f(r), 0) / n;
  return {
    linkedSettled: n,
    realizedEdge: round(mean((r) => r.outcome - r.priceAtMade)),
    marketBrier: round(mean((r) => (r.priceAtMade - r.outcome) ** 2)),
    creatorBrier: round(mean((r) => (1 - r.outcome) ** 2)),
  };
}

/** n/(n+k) shrinkage toward zero. k = 0 means no shrinkage; n = 0 means no signal. */
export function shrink(edge: number | undefined, n: number, k: number): number | undefined {
  if (edge === undefined || n <= 0) return undefined;
  return round(edge * (n / (n + Math.max(0, k))));
}

export interface Contributor {
  /** Distinct source (video id) — the same video never counts twice. */
  sourceKey: string;
  settled: number;
  shrunkEdge?: number;
}

/** Weighted mean of contributors' shrunk edges (weight = settled count), one per source. */
export function combineEdges(contributors: Contributor[]): { edge?: number; weight: number; creators: number } {
  const seen = new Map<string, Contributor>();
  for (const c of contributors) if (!seen.has(c.sourceKey)) seen.set(c.sourceKey, c);
  const usable = [...seen.values()].filter((c) => c.shrunkEdge !== undefined && c.settled > 0);
  const weight = usable.reduce((s, c) => s + c.settled, 0);
  if (weight === 0) return { weight: 0, creators: seen.size };
  return { edge: round(usable.reduce((s, c) => s + c.shrunkEdge! * c.settled, 0) / weight), weight, creators: seen.size };
}

export const clampProb = (p: number): number => Math.min(0.99, Math.max(0.01, round(p)));

export interface Gates {
  priorWeight: number;
  minSettledLean: number;
  minSettledModerate: number;
  minSettledStrong: number;
  minLiquidity: number;
}

export interface LabelInput {
  edge?: number;
  /** Total settled count behind the edge (sum over contributors). */
  settled: number;
  liquidity?: number;
  marketPrice?: number;
  deadlineCheck: "consistent" | "inconsistent" | "unknown";
}

/** The label is the weakest gate that passes; every failed gate is reported so the UI can say why. */
export function confidenceLabel(input: LabelInput, g: Gates): { confidence: SignalConfidence; reasons: string[] } {
  const reasons: string[] = [];
  let level: SignalConfidence = "none";
  if (input.marketPrice === undefined) reasons.push("no market price snapshot");
  if (input.edge === undefined) reasons.push("no settled, market-linked record for any contributor");
  else {
    const a = Math.abs(input.edge);
    if (input.settled >= g.minSettledStrong && a >= 0.1) level = "strong";
    else if (input.settled >= g.minSettledModerate && a >= 0.05) level = "moderate";
    else if (input.settled >= g.minSettledLean && a >= 0.03) level = "lean";
    if (input.settled < g.minSettledLean) reasons.push(`record too thin (${input.settled} settled, need ${g.minSettledLean})`);
    else if (a < 0.03) reasons.push(`edge ${fmt(input.edge)} is inside the noise band (±3 pts)`);
    else reasons.push(`record ${input.settled} settled, edge ${fmt(input.edge)}`);
  }
  if (input.liquidity !== undefined && input.liquidity < g.minLiquidity) { reasons.push(`liquidity ${Math.round(input.liquidity).toLocaleString("en-US")} below ${g.minLiquidity.toLocaleString("en-US")}`); level = "none"; }
  if (input.liquidity === undefined) reasons.push("liquidity unknown");
  if (input.deadlineCheck === "inconsistent") { reasons.push("prediction deadline and market end disagree"); level = "none"; }
  if (input.deadlineCheck === "unknown") reasons.push("deadline vs market end unknown");
  if (input.marketPrice === undefined) level = "none";
  return { confidence: level, reasons };
}

export function deadlineCheck(deadline: string | undefined, marketEnd: string | undefined, toleranceDays = 45): "consistent" | "inconsistent" | "unknown" {
  if (!deadline || !marketEnd) return "unknown";
  const a = Date.parse(deadline), b = Date.parse(marketEnd);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "unknown";
  return Math.abs(a - b) / 86_400_000 <= toleranceDays ? "consistent" : "inconsistent";
}

/** Map the ledger's verdict onto a settlement outcome for the linked side; undefined = not settled. */
export function outcomeOf(evidenceAssessment: string | undefined): Outcome | undefined {
  switch (evidenceAssessment) {
    case "supported": return 1;
    case "contradicted": return 0;
    case "partially_supported": return 0.5;
    default: return undefined;
  }
}

/** Nearest price point at or before `at` (fallback: nearest overall) from an ascending series. */
export function priceNearest(points: { t: string; p: number }[], at: string): { t: string; p: number } | undefined {
  if (points.length === 0) return undefined;
  const target = Date.parse(at);
  let best: { t: string; p: number } | undefined;
  for (const pt of points) {
    const ts = Date.parse(pt.t);
    if (ts <= target) best = pt;
    else break;
  }
  if (best) return best;
  return points.reduce((a, b) => (Math.abs(Date.parse(b.t) - target) < Math.abs(Date.parse(a.t) - target) ? b : a));
}

const round = (x: number): number => Math.round(x * 10_000) / 10_000;
const fmt = (e: number): string => `${e >= 0 ? "+" : ""}${(e * 100).toFixed(1)} pts`;
