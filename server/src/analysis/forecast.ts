/**
 * Prediction Ledger — the baseline forecast estimator, validation, evaluation and qualification gate
 * (1.12, FOR-01…07). Pure functions: no I/O, no clock, no SDK types.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Estimator `baseline-edge-v1` implements specification §7 exactly:
 *   1. e_i = mean(y_chosen_side − historical_side_price) over n distinct usable observations of source i.
 *   2. d_i = e_i · n / (n + K), K = 10. No usable history → zero weight, with the reason.
 *   3. One contribution per independent cluster, chosen deterministically: most usable history, then most
 *      recent valid claim, then stable source id. w_i = 2^(−age_days / 90); s_i = +1 (YES) or −1 (NO).
 *   4. pYes = clamp(p0 + Σ w_i s_i d_i / (1 + Σ w_i), 0.01, 0.99); pNo = 1 − pYes.
 *   5. No usable independent contribution → `insufficient_data`, even though a midpoint exists.
 * Research evidence never receives a numerical multiplier here (it qualifies, contradicts or blocks upstream).
 *
 * This is an engineering baseline for paper evaluation — a modelling hypothesis, not evidence of accuracy.
 */

export const ESTIMATOR_VERSION = "baseline-edge-v1";

export interface EstimatorParams {
  shrinkK: number;
  halfLifeDays: number;
  clampMin: number;
  clampMax: number;
  /** Declared output precision (decimal places) for stored probabilities. */
  precision: number;
}

export const DEFAULT_ESTIMATOR_PARAMS: EstimatorParams = { shrinkK: 10, halfLifeDays: 90, clampMin: 0.01, clampMax: 0.99, precision: 6 };

export interface HistoryObservation {
  predictionId: string;
  marketId: string;
  side: "yes" | "no";
  /** Chosen-side price at (or before) the claim's earliest possible instant, 0–1 as a decimal string. */
  priceAtClaim: string;
  /** 1 when the chosen side won, 0 when it lost. Voids never appear here. */
  outcome: 0 | 1;
}

export interface ContributionInput {
  /** Creator key (channel id, else channel name, else video id). */
  sourceKey: string;
  /** Independence cluster: same creator, same underlying report (quote/transcript hash) or same source cluster. */
  clusterKey: string;
  predictionId?: string;
  stance: "yes" | "no";
  /** ISO instant of the claim (publication, or first-seen when publication is unknown). */
  claimAt?: string;
  /** Usable historical observations (FOR-02/05 already applied by the caller). Empty = no usable history. */
  history: HistoryObservation[];
  /** Why the history is empty or short, for the record. */
  historyNote?: string;
  /** False when the claim may not contribute at all (withdrawn, after the cutoff, stale) — with the reason. */
  valid?: boolean;
  invalidReason?: string;
}

export interface ContributionRecord {
  sourceKey: string;
  clusterKey: string;
  predictionId?: string;
  stance: 1 | -1;
  claimAt?: string;
  n: number;
  meanEdge?: number;
  shrunkEdge?: number;
  weight?: number;
  ageDays?: number;
  selected: boolean;
  reason: string;
  history: HistoryObservation[];
}

export interface ForecastInput {
  /** Fresh YES midpoint of the US contract, 0–1. */
  p0: number;
  asOf: string;
  contributions: ContributionInput[];
  params?: Partial<EstimatorParams>;
}

export interface ForecastResult {
  estimatorVersion: string;
  params: EstimatorParams;
  status: "computed" | "insufficient_data";
  pYes: number;
  pNo: number;
  /** Fixed-precision strings, the stored form. */
  pYesText: string;
  pNoText: string;
  sumWeights: number;
  adjustment: number;
  contributions: ContributionRecord[];
  exclusions: { kind: string; count: number; detail?: string }[];
  formulaText: string;
}

const round = (x: number, places: number): number => Number(x.toFixed(places));

function meanEdge(history: HistoryObservation[]): number {
  let s = 0;
  for (const h of history) s += h.outcome - Number(h.priceAtClaim);
  return s / history.length;
}

/** Deterministic pick inside a cluster: most usable history, then most recent valid claim, then stable source id, then prediction id. */
function pickRepresentative(members: ContributionRecord[]): ContributionRecord {
  return [...members].sort((a, b) => {
    if (b.n !== a.n) return b.n - a.n;
    const ta = a.claimAt ? Date.parse(a.claimAt) : -Infinity;
    const tb = b.claimAt ? Date.parse(b.claimAt) : -Infinity;
    if (tb !== ta) return tb - ta;
    if (a.sourceKey !== b.sourceKey) return a.sourceKey < b.sourceKey ? -1 : 1;
    return (a.predictionId ?? "") < (b.predictionId ?? "") ? -1 : 1;
  })[0];
}

export function computeForecast(input: ForecastInput): ForecastResult {
  const params = { ...DEFAULT_ESTIMATOR_PARAMS, ...(input.params ?? {}) };
  if (!Number.isFinite(input.p0) || input.p0 < 0 || input.p0 > 1) throw new Error(`Prior p0 must be a finite probability, got ${input.p0}`);
  const asOfMs = Date.parse(input.asOf);
  if (!Number.isFinite(asOfMs)) throw new Error(`asOf must be an ISO instant, got ${input.asOf}`);
  const exclusions = new Map<string, { count: number; detail?: string }>();
  const bump = (kind: string, detail?: string) => { const e = exclusions.get(kind) ?? { count: 0, detail }; e.count += 1; exclusions.set(kind, e); };

  const records: ContributionRecord[] = [];
  for (const c of input.contributions) {
    const stance: 1 | -1 = c.stance === "yes" ? 1 : -1;
    const base: ContributionRecord = { sourceKey: c.sourceKey, clusterKey: c.clusterKey, predictionId: c.predictionId, stance, claimAt: c.claimAt, n: 0, selected: false, reason: "", history: [] };
    if (c.valid === false) {
      records.push({ ...base, reason: `invalid: ${c.invalidReason ?? "excluded by caller"}` });
      bump("invalid_claim", c.invalidReason);
      continue;
    }
    // Distinct observations only: one per (prediction, market).
    const seen = new Set<string>();
    const history = c.history.filter((h) => { const k = `${h.predictionId}:${h.marketId}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const n = history.length;
    if (n === 0) {
      records.push({ ...base, n: 0, reason: `no usable history (${c.historyNote ?? "no settled, verified, pre-claim-priced observations"}) → weight 0` });
      bump("no_usable_history", c.historyNote);
      continue;
    }
    const e = meanEdge(history);
    const d = e * (n / (n + params.shrinkK));
    const claimMs = c.claimAt ? Date.parse(c.claimAt) : NaN;
    if (!Number.isFinite(claimMs)) {
      records.push({ ...base, n, meanEdge: e, shrunkEdge: d, history, reason: "claim instant unknown → cannot weight by recency; excluded" });
      bump("claim_instant_unknown");
      continue;
    }
    if (claimMs > asOfMs) {
      records.push({ ...base, n, meanEdge: e, shrunkEdge: d, history, reason: "claim made after the forecast instant; excluded (no leakage)" });
      bump("claim_after_as_of");
      continue;
    }
    const ageDays = (asOfMs - claimMs) / 86_400_000;
    const w = Math.pow(2, -ageDays / params.halfLifeDays);
    records.push({ ...base, n, meanEdge: e, shrunkEdge: d, weight: w, ageDays, history, reason: "candidate" });
  }

  // One effective contribution per independent cluster.
  const byCluster = new Map<string, ContributionRecord[]>();
  for (const r of records) if (r.reason === "candidate") byCluster.set(r.clusterKey, [...(byCluster.get(r.clusterKey) ?? []), r]);
  let sumW = 0;
  let sumAdj = 0;
  for (const [cluster, members] of byCluster) {
    const rep = pickRepresentative(members);
    rep.selected = true;
    rep.reason = members.length > 1 ? `selected for cluster ${cluster} (${members.length} members: most history n=${rep.n}, then most recent claim, then stable id)` : `selected (cluster ${cluster})`;
    for (const m of members) if (m !== rep) { m.reason = `same cluster as ${rep.predictionId ?? rep.sourceKey} → one effective contribution`; bump("clustered_duplicate"); }
    sumW += rep.weight!;
    sumAdj += rep.weight! * rep.stance * rep.shrunkEdge!;
  }

  const exclusionList = [...exclusions.entries()].map(([kind, e]) => ({ kind, count: e.count, detail: e.detail }));
  if (sumW === 0) {
    return {
      estimatorVersion: ESTIMATOR_VERSION, params, status: "insufficient_data", pYes: NaN, pNo: NaN, pYesText: "", pNoText: "", sumWeights: 0, adjustment: 0,
      contributions: records, exclusions: exclusionList,
      formulaText: "no usable independent contribution → insufficient_data (a midpoint alone is not a forecast)",
    };
  }
  const adjustment = sumAdj / (1 + sumW);
  const raw = input.p0 + adjustment;
  const pYes = round(Math.min(params.clampMax, Math.max(params.clampMin, raw)), params.precision);
  const pNo = round(1 - pYes, params.precision);
  return {
    estimatorVersion: ESTIMATOR_VERSION, params, status: "computed", pYes, pNo, pYesText: pYes.toFixed(params.precision), pNoText: pNo.toFixed(params.precision),
    sumWeights: sumW, adjustment, contributions: records, exclusions: exclusionList,
    formulaText: `pYes = clamp(p0 ${input.p0} + Σ(w·s·d) ${sumAdj.toFixed(6)} / (1 + Σw ${sumW.toFixed(6)}), ${params.clampMin}, ${params.clampMax}) = ${pYes.toFixed(params.precision)}; d = e·n/(n+${params.shrinkK}); w = 2^(−age/${params.halfLifeDays})`,
  };
}

/** FOR-01: finite, in [0,1], and pYes + pNo = 1 within 1e-9. Returns the reasons a pair is unusable. */
export function validateProbabilities(pYes: unknown, pNo: unknown): string[] {
  const problems: string[] = [];
  const y = typeof pYes === "number" ? pYes : Number(pYes);
  const n = typeof pNo === "number" ? pNo : Number(pNo);
  if (!Number.isFinite(y)) problems.push("pYes is not a finite number");
  if (!Number.isFinite(n)) problems.push("pNo is not a finite number");
  if (problems.length) return problems;
  if (y < 0 || y > 1) problems.push(`pYes ${y} outside [0,1]`);
  if (n < 0 || n > 1) problems.push(`pNo ${n} outside [0,1]`);
  if (Math.abs(y + n - 1) > 1e-9) problems.push(`pYes + pNo = ${y + n} differs from 1 by more than 1e-9`);
  return problems;
}

// ---------------------------------------------------------------------------------------------------------
// Evaluation (FOR-07) and qualification (FOR-06)
// ---------------------------------------------------------------------------------------------------------

export interface EvaluationRecord {
  /** Forecast probability of YES at decision time. */
  pYes: number;
  /** Market YES price at the same instant (baseline). */
  marketPYes?: number;
  /** Official outcome: 1 = YES, 0 = NO, null = void/unsettled. */
  outcome: 0 | 1 | null;
  /** Correlated-event group (same event id); one group counts once toward groups. */
  groupKey?: string;
  /** Fee-adjusted realised return of the paper/live position in currency units (0 when not traded). */
  feeAdjustedReturn?: number;
  traded: boolean;
  skipReason?: string;
  /** Distinct creator keys and independent clusters that contributed. */
  creatorObservations?: Record<string, number>;
  independentClusters?: number;
}

export interface QualificationThresholds {
  minEvents: number;
  minObservationsPerCreator: number;
  minIndependentClusters: number;
}
export const DEFAULT_QUALIFICATION: QualificationThresholds = { minEvents: 100, minObservationsPerCreator: 20, minIndependentClusters: 2 };

export interface EvaluationReport {
  events: number;
  groups: number;
  brier?: number;
  baselineBrier?: number;
  calibration: { lo: number; hi: number; count: number; meanForecast?: number; hitRate?: number }[];
  feeAdjustedReturn?: number;
  coverage: { decisions: number; traded: number; skipped: number; abstentionRate?: number };
  drawdown?: number;
  skipped: { reason: string; count: number }[];
  gate: { qualified: boolean; reasons: string[] };
}

export function evaluateForecasts(records: EvaluationRecord[], thresholds: QualificationThresholds = DEFAULT_QUALIFICATION): EvaluationReport {
  const settled = records.filter((r) => r.outcome === 0 || r.outcome === 1);
  const events = settled.length;
  const groups = new Set(settled.map((r, i) => r.groupKey ?? `#${i}`)).size;
  const brier = events ? settled.reduce((s, r) => s + (r.pYes - r.outcome!) ** 2, 0) / events : undefined;
  const withBaseline = settled.filter((r) => typeof r.marketPYes === "number" && Number.isFinite(r.marketPYes));
  const baselineBrier = withBaseline.length === events && events ? withBaseline.reduce((s, r) => s + (r.marketPYes! - r.outcome!) ** 2, 0) / events : undefined;
  const bins = Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, count: 0, sumP: 0, hits: 0 }));
  for (const r of settled) {
    const idx = Math.min(9, Math.max(0, Math.floor(r.pYes * 10)));
    bins[idx].count += 1; bins[idx].sumP += r.pYes; bins[idx].hits += r.outcome!;
  }
  const calibration = bins.map((b) => ({ lo: b.lo, hi: b.hi, count: b.count, meanForecast: b.count ? b.sumP / b.count : undefined, hitRate: b.count ? b.hits / b.count : undefined }));
  const traded = records.filter((r) => r.traded);
  const skippedMap = new Map<string, number>();
  for (const r of records) if (!r.traded) skippedMap.set(r.skipReason ?? "unspecified", (skippedMap.get(r.skipReason ?? "unspecified") ?? 0) + 1);
  const returns = traded.map((r) => r.feeAdjustedReturn ?? 0);
  const feeAdjustedReturn = traded.length ? returns.reduce((a, b) => a + b, 0) : undefined;
  let peak = 0, cum = 0, dd = 0;
  for (const x of returns) { cum += x; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const perCreator = new Map<string, number>();
  let minClusters = Infinity;
  for (const r of settled) {
    for (const [k, n] of Object.entries(r.creatorObservations ?? {})) perCreator.set(k, Math.max(perCreator.get(k) ?? 0, n));
    if (typeof r.independentClusters === "number") minClusters = Math.min(minClusters, r.independentClusters);
  }
  const reasons: string[] = [];
  if (events < thresholds.minEvents) reasons.push(`${events} settled events < ${thresholds.minEvents} required`);
  if (brier === undefined) reasons.push("no Brier score (no settled events)");
  else if (baselineBrier === undefined) reasons.push("market baseline Brier unavailable for every event (a price at decision time is required)");
  else if (brier > baselineBrier) reasons.push(`Brier ${brier.toFixed(4)} worse than the market baseline ${baselineBrier.toFixed(4)}`);
  const thinCreators = [...perCreator.entries()].filter(([, n]) => n < thresholds.minObservationsPerCreator).map(([k, n]) => `${k} (${n})`);
  if (perCreator.size === 0) reasons.push("no weighted creator observations recorded");
  else if (thinCreators.length) reasons.push(`creators below ${thresholds.minObservationsPerCreator} usable observations: ${thinCreators.join(", ")}`);
  if (!Number.isFinite(minClusters) || minClusters < thresholds.minIndependentClusters) reasons.push(`fewer than ${thresholds.minIndependentClusters} independent current source clusters on at least one decision`);
  return {
    events, groups, brier, baselineBrier, calibration, feeAdjustedReturn,
    coverage: { decisions: records.length, traded: traded.length, skipped: records.length - traded.length, abstentionRate: records.length ? (records.length - traded.length) / records.length : undefined },
    drawdown: traded.length ? dd : undefined,
    skipped: [...skippedMap.entries()].map(([reason, count]) => ({ reason, count })),
    gate: { qualified: reasons.length === 0, reasons },
  };
}

/** FOR-06: the status a stored forecast has at `now`. */
export function forecastStatusAt(f: { status: "experimental" | "qualified" | "expired" | "insufficient_data"; expiresAt?: string }, now: string): "experimental" | "qualified" | "expired" | "insufficient_data" {
  if (f.status === "insufficient_data") return f.status;
  if (f.expiresAt && Date.parse(now) > Date.parse(f.expiresAt)) return "expired";
  return f.status;
}
