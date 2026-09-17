/**
 * Prediction Ledger — immutable forecasts over the trading cohort (1.12, FOR-01…07).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * The service gathers what the pure estimator needs and never decides anything itself:
 *  - the **trading cohort** of a creator (FOR-02): one observation per creator/contract, each with a link that was
 *    verified equivalent, a chosen-side price at or before the claim's earliest possible instant (FOR-05), and an
 *    official venue resolution the app had observed by the forecast instant. Assessments are never outcomes;
 *    voids, pending and partial results are counted and excluded.
 *  - the **current contributions** on the target contract (FOR-03): every verified claim on that contract, one per
 *    creator/event, clustered with reuploads (same quote hash) so a repeated opinion counts once.
 *  - the **prior**: one fresh YES midpoint of the US contract.
 * Everything is filtered by `asOf`, so a replay at T ignores whatever the app learned after T (F06).
 */

import crypto from "node:crypto";
import type { ForecastContribution, ForecastEvaluation, ForecastSnapshot, ForecastStatus, MarketRecord, Prediction, PredictionMarketLink, StrategyQualification, VideoSummary } from "@prediction-ledger/shared";
import type { AppContext } from "../context.js";
import { D } from "../analysis/decimal.js";
import { ESTIMATOR_VERSION, computeForecast, evaluateForecasts, type ContributionInput, type EvaluationRecord, type HistoryObservation } from "../analysis/forecast.js";
import type { DecisionBook } from "../analysis/tradeDecision.js";

interface ForecastRow {
  id: string; prediction_id: string; market_id: string; link_id: string | null; verification_id: string | null; strategy_version: string; category: string | null; as_of: string; p_yes: string; p_no: string;
  prior_json: string; status: ForecastStatus; qualification_id: string | null; inputs_json: string; formula_json: string; exclusions_json: string; hash: string; expires_at: string | null; created_at: string;
}
interface ContributionRow {
  id: string; forecast_id: string; source_key: string; cluster_key: string; prediction_id: string | null; stance: 1 | -1; claim_at: string | null; n: number; mean_edge: string | null; shrunk_edge: string | null;
  weight: string | null; age_days: number | null; selected: number; reason: string; history_json: string;
}

export interface CohortResult {
  observations: HistoryObservation[];
  excluded: { reason: string; count: number }[];
}

export class ForecastService {
  constructor(private readonly ctx: AppContext) {}

  /** The versioned estimator this build trades on (FOR-06: automation accepts only a qualified strategy/category version). */
  readonly strategyVersion = ESTIMATOR_VERSION;

  /** Categories with a production (never fixture) qualification for the current estimator version. */
  qualifiedCategories(): string[] {
    return this.ctx.db.all<{ category: string }>("SELECT DISTINCT category FROM strategy_qualifications WHERE source = 'production' AND qualified = 1 AND strategy_version = ? ORDER BY category", ESTIMATOR_VERSION).map((r) => r.category);
  }

  /** Creator identity for cohorts and clusters: venue channel id, else channel name, else the video itself. */
  creatorKey(video: VideoSummary | undefined): string {
    if (!video) return "unknown";
    return video.channelId ? `channel:${video.channelId}` : video.channel ? `name:${video.channel.toLowerCase()}` : `video:${video.id}`;
  }

  /** The earliest instant a claim could have been public (FOR-05): the publication instant, or midnight UTC of a date-only publication / made-on date. */
  earliestClaimInstant(p: Prediction, video: VideoSummary | undefined): string | undefined {
    if (video?.publishedAt) return video.publishedPrecision === "datetime" && video.publishedAt.length > 10 ? new Date(Date.parse(video.publishedAt)).toISOString() : `${video.publishedAt.slice(0, 10)}T00:00:00.000Z`;
    if (p.madeOnDate) return `${p.madeOnDate}T00:00:00.000Z`;
    return undefined;
  }

  /** The instant used for recency weighting: the same as the earliest instant, else when the app first saw the video. */
  claimAt(p: Prediction, video: VideoSummary | undefined): string | undefined {
    return this.earliestClaimInstant(p, video) ?? video?.firstSeenAt ?? undefined;
  }

  /** YES / NO for a link, from its verification's durable side id, else from the link's side label against the contract's sides. */
  sideOf(link: PredictionMarketLink, market: MarketRecord, sideId?: string): "yes" | "no" | undefined {
    const sides = market.constraints?.sides ?? [];
    if (sideId) {
      const s = sides.find((x) => x.id === sideId);
      if (s) return s.long ? "yes" : "no";
    }
    if (!link.side) return undefined;
    const label = link.side.trim().toLowerCase();
    const long = sides.find((s) => s.long);
    const short = sides.find((s) => !s.long);
    if (long && long.label.toLowerCase() === label) return "yes";
    if (short && short.label.toLowerCase() === label) return "no";
    if (label === "yes") return "yes";
    if (label === "no") return "no";
    return undefined;
  }

  /** Official venue outcome as observed by `asOf`: yes / no / void / pending. */
  outcomeOf(market: MarketRecord, asOf: string): "yes" | "no" | "void" | "pending" {
    if (!market.resolved || !market.resolvedAt || market.resolvedAt > asOf) return "pending";
    const label = (market.resolvedOutcome ?? "").trim().toLowerCase();
    const long = market.constraints?.sides.find((s) => s.long);
    const short = market.constraints?.sides.find((s) => !s.long);
    if (label && long && long.label.toLowerCase() === label) return "yes";
    if (label && short && short.label.toLowerCase() === label) return "no";
    if (label === "yes") return "yes";
    if (label === "no") return "no";
    return "void";
  }

  /** Chosen-side price at or before the earliest claim instant, from stored snapshots (history or otherwise). */
  priceAtOrBefore(marketId: string, instant: string, side: "yes" | "no"): { price: string; at: string } | undefined {
    const snap = this.ctx.db.get<{ retrieved_at: string; prices_json: string }>("SELECT retrieved_at, prices_json FROM market_snapshots WHERE market_id = ? AND retrieved_at <= ? ORDER BY retrieved_at DESC LIMIT 1", marketId, instant);
    if (!snap) return undefined;
    const prices = JSON.parse(snap.prices_json) as { label: string; price?: number }[];
    const yes = prices.find((p) => p.price !== undefined);
    if (!yes || yes.price === undefined) return undefined;
    // Snapshot prices are stored in outcomes order with the YES-denominated price first for US markets (1.10).
    const yesPrice = D(yes.price.toFixed(6));
    const p = side === "yes" ? yesPrice : D("1").sub(yesPrice);
    return { price: p.toString(), at: snap.retrieved_at };
  }

  /** FOR-02/05: the trading cohort of one creator as known at `asOf`, excluding `excludeMarketId` (the contract being forecast). */
  cohort(creatorKey: string, asOf: string, opts: { excludeMarketId?: string; category?: string } = {}): CohortResult {
    const excluded = new Map<string, number>();
    const bump = (r: string) => excluded.set(r, (excluded.get(r) ?? 0) + 1);
    const videos = this.ctx.videos.list().filter((v) => this.creatorKey(v) === creatorKey);
    const byMarket = new Map<string, { obs: HistoryObservation; claimAt: string }>();
    for (const v of videos) {
      for (const p of this.ctx.predictions.list({ videoId: v.id, includeDismissed: true })) {
        if (p.createdAt > asOf) { bump("prediction_after_as_of"); continue; }
        if (p.userStatus === "dismissed" || p.userStatus === "merged") { bump("dismissed_or_merged"); continue; }
        const links = this.ctx.markets.linksForPrediction(p.id, false).filter((l) => l.status === "accepted" && l.updatedAt <= asOf);
        if (links.length === 0) { bump("no_accepted_link"); continue; }
        for (const l of links) {
          const market = this.ctx.markets.get(l.marketId);
          if (!market) { bump("market_missing"); continue; }
          if (market.provider !== "polymarket_us") { bump("not_us_venue"); continue; }
          if (opts.excludeMarketId && market.id === opts.excludeMarketId) { bump("same_contract_as_forecast"); continue; }
          if (opts.category && (market.constraints?.category ?? "general") !== opts.category) { bump("other_category"); continue; }
          const ver = this.ctx.markets.wasVerifiedEquivalentBy(l.id, asOf);
          if (!ver) { bump("link_not_verified_equivalent"); continue; }
          const side = this.sideOf(l, market, ver.sideId);
          if (!side) { bump("side_unknown"); continue; }
          const instant = this.earliestClaimInstant(p, v);
          if (!instant) { bump("claim_instant_unknown"); continue; }
          const price = this.priceAtOrBefore(market.id, instant, side);
          if (!price) { bump("no_price_at_or_before_claim"); continue; }
          const outcome = this.outcomeOf(market, asOf);
          if (outcome === "pending") { bump("outcome_pending"); continue; }
          if (outcome === "void") { bump("void"); continue; }
          const y: 0 | 1 = outcome === side ? 1 : 0;
          const obs: HistoryObservation = { predictionId: p.id, marketId: market.id, side, priceAtClaim: price.price, outcome: y };
          const prev = byMarket.get(market.id);
          // One observation per creator/contract: the latest valid pre-as-of revision wins; the earlier one is recorded as a duplicate.
          if (!prev || instant > prev.claimAt) { if (prev) bump("duplicate_creator_contract"); byMarket.set(market.id, { obs, claimAt: instant }); } else bump("duplicate_creator_contract");
        }
      }
    }
    return { observations: [...byMarket.values()].map((x) => x.obs), excluded: [...excluded].map(([reason, count]) => ({ reason, count })) };
  }

  /** FOR-03: every verified claim on the contract, one per creator, clustered with reuploads (same quote hash). */
  contributionsFor(market: MarketRecord, asOf: string, opts: { category?: string } = {}): { contributions: ContributionInput[]; excluded: { reason: string; count: number }[] } {
    const excluded = new Map<string, number>();
    const bump = (r: string) => excluded.set(r, (excluded.get(r) ?? 0) + 1);
    const links = this.ctx.markets.linksForMarket(market.id).filter((l) => l.status === "accepted" && l.updatedAt <= asOf);
    const perCreator = new Map<string, { c: ContributionInput; quoteHash?: string }>();
    for (const l of links) {
      const p = this.ctx.predictions.get(l.predictionId);
      if (!p || p.createdAt > asOf) { bump("prediction_missing_or_after_as_of"); continue; }
      const video = this.ctx.videos.get(p.videoId);
      const ver = this.ctx.markets.wasVerifiedEquivalentBy(l.id, asOf);
      if (!ver) { bump("link_not_verified_equivalent"); continue; }
      const side = this.sideOf(l, market, ver.sideId);
      if (!side) { bump("side_unknown"); continue; }
      const creator = this.creatorKey(video);
      const claimAt = this.claimAt(p, video);
      const history = this.cohort(creator, asOf, { excludeMarketId: market.id, category: opts.category });
      const c: ContributionInput = {
        sourceKey: creator, clusterKey: creator, predictionId: p.id, stance: side, claimAt, history: history.observations,
        historyNote: history.observations.length ? undefined : history.excluded.map((e) => `${e.reason}×${e.count}`).join(", ") || "no earlier claims by this creator",
        valid: p.userStatus !== "dismissed" && p.userStatus !== "merged",
        invalidReason: p.userStatus === "dismissed" ? "claim dismissed by the user" : p.userStatus === "merged" ? "claim merged into another" : undefined,
      };
      const prev = perCreator.get(creator);
      // One current contribution per creator/event: the latest valid pre-as-of claim; the earlier one stays in history.
      if (!prev || (claimAt ?? "") > (prev.c.claimAt ?? "")) { if (prev) bump("earlier_claim_same_creator"); perCreator.set(creator, { c, quoteHash: p.quoteHash }); } else bump("earlier_claim_same_creator");
    }
    // Reuploads: identical quotes across creators share one cluster (union by quote hash).
    const byQuote = new Map<string, string>();
    for (const { c, quoteHash } of perCreator.values()) {
      if (!quoteHash) continue;
      const owner = byQuote.get(quoteHash);
      if (owner) c.clusterKey = owner; else byQuote.set(quoteHash, c.clusterKey);
    }
    return { contributions: [...perCreator.values()].map((x) => x.c), excluded: [...excluded].map(([reason, count]) => ({ reason, count })) };
  }

  /** Build and store an immutable forecast for a prediction's verified link on a US contract. */
  build(input: { predictionId: string; linkId: string; asOf?: string; book?: DecisionBook; forecastMaxAgeMs?: number }): ForecastSnapshot {
    const asOf = input.asOf ?? new Date().toISOString();
    const link = this.ctx.markets.getLink(input.linkId);
    if (!link || link.predictionId !== input.predictionId) throw new Error("Link not found for this prediction.");
    const market = this.ctx.markets.get(link.marketId);
    const p = this.ctx.predictions.get(input.predictionId);
    if (!market || !p) throw new Error("Prediction or market no longer exists.");
    if (market.provider !== "polymarket_us") throw new Error("Forecasts are built only for Polymarket US contracts (other venues are research-only).");
    const category = market.constraints?.category ?? market.tags[0] ?? "general";
    // Prior: one fresh YES midpoint (book), else the stored constraints' bid/ask at retrieval, else the latest snapshot price.
    let prior: ForecastSnapshot["prior"] | undefined;
    if (input.book && input.book.bids[0] && input.book.asks[0]) {
      const bid = D(input.book.bids[0].price), ask = D(input.book.asks[0].price);
      prior = { p0: bid.add(ask).div("2", "half_up").round(6).toString(), source: "book_midpoint", bookAt: input.book.retrievedAt, bid: bid.toString(), ask: ask.toString() };
    } else if (market.constraints?.bestBid && market.constraints.bestAsk) {
      const bid = D(market.constraints.bestBid), ask = D(market.constraints.bestAsk);
      prior = { p0: bid.add(ask).div("2", "half_up").round(6).toString(), source: "constraints_bbo", bookAt: market.constraints.retrievedAt, bid: bid.toString(), ask: ask.toString() };
    } else {
      const snap = market.latest?.prices.find((x) => x.price !== undefined);
      if (snap?.price !== undefined) prior = { p0: D(snap.price.toFixed(6)).toString(), source: "latest_snapshot", bookAt: market.latest?.retrievedAt };
    }
    const verification = this.ctx.markets.latestVerification(link.id);
    const { contributions, excluded } = this.contributionsFor(market, asOf, { category });
    const params = {};
    const result = prior
      ? computeForecast({ p0: Number(prior.p0), asOf, contributions, params })
      : { estimatorVersion: ESTIMATOR_VERSION, params: { shrinkK: 10, halfLifeDays: 90, clampMin: 0.01, clampMax: 0.99, precision: 6 }, status: "insufficient_data" as const, pYes: NaN, pNo: NaN, pYesText: "", pNoText: "", sumWeights: 0, adjustment: 0, contributions: [], exclusions: [{ kind: "no_prior_price", count: 1 }], formulaText: "no fresh YES midpoint available → insufficient_data" };
    const qualification = result.status === "computed" ? this.productionQualification(ESTIMATOR_VERSION, category) : undefined;
    const status: ForecastStatus = result.status === "insufficient_data" ? "insufficient_data" : qualification ? "qualified" : "experimental";
    const inputs: ForecastSnapshot["inputs"] = {
      // Versions as they stood at `asOf` (F06): a later edit, plan or run must not change a replay's hash.
      predictionRevision: this.ctx.predictions.revisionCount(p.id, asOf), analysisVersion: p.analysisVersion, planVersion: this.ctx.plans.listForPrediction(p.id).filter((x) => x.createdAt <= asOf).sort((a, b) => b.version - a.version)[0]?.version,
      verificationVersion: verification && verification.createdAt <= asOf ? verification.version : undefined,
      quoteHash: p.quoteHash, rulesHash: verification?.rulesHash, latestRunId: this.ctx.research.runsForPrediction(p.id).filter((r) => r.startedAt <= asOf)[0]?.id, params: result.params as unknown as Record<string, unknown>,
    };
    const contribs: ForecastContribution[] = result.contributions.map((c) => ({
      id: crypto.randomUUID(), sourceKey: c.sourceKey, clusterKey: c.clusterKey, predictionId: c.predictionId, stance: c.stance, claimAt: c.claimAt, n: c.n,
      meanEdge: c.meanEdge !== undefined ? c.meanEdge.toFixed(6) : undefined, shrunkEdge: c.shrunkEdge !== undefined ? c.shrunkEdge.toFixed(6) : undefined, weight: c.weight !== undefined ? c.weight.toFixed(6) : undefined,
      ageDays: c.ageDays !== undefined ? Number(c.ageDays.toFixed(4)) : undefined, selected: c.selected, reason: c.reason, history: c.history,
    }));
    const exclusions = [...result.exclusions, ...excluded.map((e) => ({ kind: `contributions:${e.reason}`, count: e.count }))];
    const pYes = result.status === "computed" ? result.pYesText : "";
    const pNo = result.status === "computed" ? result.pNoText : "";
    const canon = JSON.stringify({
      estimator: ESTIMATOR_VERSION, asOf, predictionId: p.id, marketId: market.id, prior: prior ?? null, params: result.params, pYes, pNo,
      contributions: contribs.map((c) => ({ s: c.sourceKey, k: c.clusterKey, p: c.predictionId, st: c.stance, at: c.claimAt, n: c.n, sel: c.selected, h: c.history })).sort((a, b) => (a.p ?? a.s) < (b.p ?? b.s) ? -1 : 1),
      inputs,
    });
    const hash = crypto.createHash("sha256").update(canon).digest("hex");
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.parse(asOf) + (input.forecastMaxAgeMs ?? this.ctx.trading.policy().limits.forecastMaxAgeMs)).toISOString();
    this.ctx.db.transaction(() => {
      this.ctx.db.run(
        `INSERT INTO forecast_snapshots (id, prediction_id, market_id, link_id, verification_id, strategy_version, category, as_of, p_yes, p_no, prior_json, status, qualification_id, inputs_json, formula_json, exclusions_json, hash, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, p.id, market.id, link.id, verification?.id ?? null, ESTIMATOR_VERSION, category, asOf, pYes, pNo, JSON.stringify(prior ?? { p0: "", source: "none" }), status, qualification?.id ?? null,
        JSON.stringify(inputs), JSON.stringify({ estimatorVersion: ESTIMATOR_VERSION, text: result.formulaText, sumWeights: result.sumWeights.toFixed(6), adjustment: result.adjustment.toFixed(6) }), JSON.stringify(exclusions), hash, status === "insufficient_data" ? null : expiresAt,
      );
      for (const c of contribs) {
        this.ctx.db.run(
          "INSERT INTO forecast_contributions (id, forecast_id, source_key, cluster_key, prediction_id, stance, claim_at, n, mean_edge, shrunk_edge, weight, age_days, selected, reason, history_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          c.id, id, c.sourceKey, c.clusterKey, c.predictionId ?? null, c.stance, c.claimAt ?? null, c.n, c.meanEdge ?? null, c.shrunkEdge ?? null, c.weight ?? null, c.ageDays ?? null, c.selected ? 1 : 0, c.reason, JSON.stringify(c.history),
        );
      }
    });
    return this.get(id)!;
  }

  get(id: string): ForecastSnapshot | undefined {
    const r = this.ctx.db.get<ForecastRow>("SELECT * FROM forecast_snapshots WHERE id = ?", id);
    return r ? this.hydrate(r) : undefined;
  }

  forPrediction(predictionId: string, limit = 50): ForecastSnapshot[] {
    return this.ctx.db.all<ForecastRow>("SELECT * FROM forecast_snapshots WHERE prediction_id = ? ORDER BY created_at DESC LIMIT ?", predictionId, limit).map((r) => this.hydrate(r));
  }

  /** The latest forecast for this link that is still within its age limit at `now` and matches the verification. */
  latestUsable(predictionId: string, linkId: string, now: string, verificationId: string | undefined, maxAgeMs: number): ForecastSnapshot | undefined {
    const f = this.forPrediction(predictionId, 20).find((x) => x.linkId === linkId && x.verificationId === verificationId && x.status !== "insufficient_data");
    if (!f) return undefined;
    const age = Date.parse(now) - Date.parse(f.asOf);
    return age >= 0 && age <= maxAgeMs ? f : undefined;
  }

  productionQualification(strategyVersion: string, category: string): StrategyQualification | undefined {
    const r = this.ctx.db.get<{ id: string; strategy_version: string; category: string; source: "production" | "fixture"; events: number; brier: string | null; baseline_brier: string | null; qualified: number; report_json: string; created_at: string }>(
      "SELECT * FROM strategy_qualifications WHERE strategy_version = ? AND category = ? AND source = 'production' AND qualified = 1 ORDER BY created_at DESC LIMIT 1", strategyVersion, category,
    );
    return r ? { id: r.id, strategyVersion: r.strategy_version, category: r.category, source: r.source, events: r.events, brier: r.brier ?? undefined, baselineBrier: r.baseline_brier ?? undefined, qualified: r.qualified === 1, reasons: (JSON.parse(r.report_json) as { gate?: { reasons?: string[] } }).gate?.reasons ?? [], createdAt: r.created_at } : undefined;
  }

  /**
   * FOR-07: evaluate frozen forecasts against official outcomes. Every decision counts, skipped ones included.
   * `source: "fixture"` records can never qualify a strategy — only an evaluation over production data may write a
   * production record, and only when the gate passes.
   */
  evaluate(opts: { strategyVersion?: string; category?: string; asOf?: string; record?: boolean; source?: "production" | "fixture"; records?: EvaluationRecord[] }): ForecastEvaluation & { qualification?: StrategyQualification } {
    const strategyVersion = opts.strategyVersion ?? ESTIMATOR_VERSION;
    const category = opts.category ?? "general";
    const asOf = opts.asOf ?? new Date().toISOString();
    const records: EvaluationRecord[] = opts.records ?? this.evaluationRecords(strategyVersion, category, asOf);
    const report = evaluateForecasts(records);
    const out: ForecastEvaluation & { qualification?: StrategyQualification } = { strategyVersion, category, ...report };
    if (opts.record) {
      const source = opts.source ?? "production";
      const id = crypto.randomUUID();
      this.ctx.db.run(
        "INSERT INTO strategy_qualifications (id, strategy_version, category, source, events, brier, baseline_brier, qualified, report_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id, strategyVersion, category, source, report.events, report.brier?.toFixed(6) ?? null, report.baselineBrier?.toFixed(6) ?? null, report.gate.qualified && source === "production" ? 1 : 0, JSON.stringify(report),
      );
      out.qualification = { id, strategyVersion, category, source, events: report.events, brier: report.brier?.toFixed(6), baselineBrier: report.baselineBrier?.toFixed(6), qualified: report.gate.qualified && source === "production", reasons: report.gate.reasons, createdAt: asOf };
    }
    return out;
  }

  /** Decisions of this strategy/category joined with the official outcomes observed by `asOf`. */
  evaluationRecords(strategyVersion: string, category: string, asOf: string): EvaluationRecord[] {
    const rows = this.ctx.db.all<{ id: string; forecast_id: string | null; market_id: string; outcome: string; side: string | null; reason_codes_json: string; intent_id: string | null; event_id: string | null }>(
      "SELECT id, forecast_id, market_id, outcome, side, reason_codes_json, intent_id, event_id FROM trade_decisions WHERE created_at <= ? ORDER BY created_at ASC", asOf,
    );
    const out: EvaluationRecord[] = [];
    for (const d of rows) {
      const f = d.forecast_id ? this.get(d.forecast_id) : undefined;
      if (!f || f.strategyVersion !== strategyVersion || (f.category ?? "general") !== category) continue;
      const market = this.ctx.markets.get(d.market_id);
      const o = market ? this.outcomeOf(market, asOf) : "pending";
      const pos = d.intent_id ? this.ctx.db.get<{ pnl: string | null; status: string }>("SELECT pnl, status FROM paper_us_positions WHERE intent_id = ?", d.intent_id) : undefined;
      const perCreator: Record<string, number> = {};
      for (const c of f.contributions) if (c.selected) perCreator[c.sourceKey] = c.n;
      out.push({
        pYes: Number(f.pYes), marketPYes: f.prior.p0 ? Number(f.prior.p0) : undefined, outcome: o === "yes" ? 1 : o === "no" ? 0 : null, groupKey: d.event_id ?? d.market_id,
        traded: !!d.intent_id, skipReason: d.intent_id ? undefined : (JSON.parse(d.reason_codes_json) as string[])[0] ?? d.outcome, feeAdjustedReturn: pos?.pnl ? Number(pos.pnl) : 0,
        creatorObservations: perCreator, independentClusters: new Set(f.contributions.filter((c) => c.selected).map((c) => c.clusterKey)).size,
      });
    }
    return out;
  }

  private hydrate(r: ForecastRow): ForecastSnapshot {
    const contributions = this.ctx.db.all<ContributionRow>("SELECT * FROM forecast_contributions WHERE forecast_id = ? ORDER BY selected DESC, source_key ASC", r.id).map((c) => ({
      id: c.id, sourceKey: c.source_key, clusterKey: c.cluster_key, predictionId: c.prediction_id ?? undefined, stance: c.stance, claimAt: c.claim_at ?? undefined, n: c.n, meanEdge: c.mean_edge ?? undefined, shrunkEdge: c.shrunk_edge ?? undefined,
      weight: c.weight ?? undefined, ageDays: c.age_days ?? undefined, selected: c.selected === 1, reason: c.reason, history: JSON.parse(c.history_json) as ForecastContribution["history"],
    }));
    return {
      id: r.id, predictionId: r.prediction_id, marketId: r.market_id, linkId: r.link_id ?? undefined, verificationId: r.verification_id ?? undefined, strategyVersion: r.strategy_version, category: r.category ?? undefined, asOf: r.as_of,
      pYes: r.p_yes, pNo: r.p_no, prior: JSON.parse(r.prior_json) as ForecastSnapshot["prior"], status: r.status, qualificationId: r.qualification_id ?? undefined, inputs: JSON.parse(r.inputs_json) as ForecastSnapshot["inputs"],
      formula: JSON.parse(r.formula_json) as ForecastSnapshot["formula"], exclusions: JSON.parse(r.exclusions_json) as ForecastSnapshot["exclusions"], contributions, hash: r.hash, expiresAt: r.expires_at ?? undefined, createdAt: r.created_at,
    };
  }
}
