/**
 * Prediction Ledger — contract verification and US candidate discovery (1.11, MAT-01…06). Storage glue around the pure verifier.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * - `verifyLink` runs the pure checklist against the stored prediction + market (+ documented facts) and
 *   stores an immutable version; the link's `verificationStatus` follows the latest version.
 * - `revalidateLink` re-reads the venue contract and marks the latest verification stale when the
 *   rules hash, status, schedule, side ids or the prediction itself changed (MAT-06).
 * - `findUsCandidates` searches Polymarket US only (entities, dates, categories; or a pasted event URL),
 *   stores the markets, proposes links, and answers explicitly: none / one / multiple. Links on other
 *   venues are reported as research-only.
 */

import type { ContractVerification, MarketProviderId, UsCandidateSearch } from "@prediction-ledger/shared";
import type { AppContext } from "../context.js";
import { revalidate, verifyContract, type DocumentedFact } from "../analysis/contractVerification.js";
import { buildMarketQueries, scoreSportsMarket, scoreTextMarket } from "../analysis/markets.js";
import { createMarketProvider } from "../providers/markets/registry.js";
import { PolymarketUsProvider } from "../providers/markets/polymarketUs.js";
import type { MarketSummary } from "../providers/markets/types.js";

export class ContractVerifyError extends Error {
  constructor(message: string, public readonly code: "not_found" | "invalid_facts" | "not_accepted" | "offline" | "markets_disabled" | "venue_error", public readonly httpStatus = 400) {
    super(message);
  }
}

const FACT_FIELD_RE = /^[a-z_]{2,40}$/;

export class ContractService {
  constructor(private readonly ctx: Pick<AppContext, "markets" | "predictions" | "games" | "settings" | "rateLimiter">) {}

  /** Run the checklist and store a new immutable version. Facts are documented user inputs (value + source), never a status override. */
  verifyLink(linkId: string, input: { facts?: Record<string, DocumentedFact>; notes?: string; reviewer?: "app" | "user" } = {}): ContractVerification {
    const link = this.ctx.markets.getLink(linkId);
    if (!link) throw new ContractVerifyError("Market link not found.", "not_found", 404);
    const p = this.ctx.predictions.get(link.predictionId);
    const market = this.ctx.markets.get(link.marketId);
    if (!p || !market) throw new ContractVerifyError("Prediction or market no longer exists.", "not_found", 404);
    const facts: Record<string, DocumentedFact> = {};
    for (const [k, v] of Object.entries(input.facts ?? {})) {
      if (!FACT_FIELD_RE.test(k) || !v || typeof v.value !== "string" || typeof v.source !== "string" || !v.value.trim() || !v.source.trim()) throw new ContractVerifyError(`Fact "${k}" must carry a value and its documented source.`, "invalid_facts");
      facts[k] = { value: v.value.trim().slice(0, 300), source: v.source.trim().slice(0, 500) };
    }
    const game = p.gameId ? this.ctx.games.get(p.gameId) : undefined;
    const r = verifyContract({ prediction: p, market, game, facts });
    return this.ctx.markets.addVerification({
      linkId, predictionId: p.id, marketId: market.id, status: r.status, fields: r.fields, sideId: r.sideId, sideLabel: r.sideLabel, sideBasis: r.sideBasis, rulesHash: r.rulesHash,
      cutoffAt: r.cutoffAt, cutoffBasis: r.cutoffBasis, cutoffUnknown: r.cutoffUnknown, quoteHash: p.quoteHash, predictionRevision: this.ctx.predictions.revisionCount(p.id), facts,
      reviewer: input.reviewer ?? (Object.keys(facts).length ? "user" : "app"), notes: input.notes ? `${r.summary}\n${input.notes}` : r.summary,
    });
  }

  /** Compare the latest verification with the current contract and prediction; mark stale on any material change. */
  async revalidateLink(linkId: string, opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<{ verification?: ContractVerification; reasons: string[]; refreshed: boolean }> {
    const link = this.ctx.markets.getLink(linkId);
    if (!link) throw new ContractVerifyError("Market link not found.", "not_found", 404);
    const latest = this.ctx.markets.verificationsForLink(linkId)[0];
    let market = this.ctx.markets.get(link.marketId)!;
    let refreshed = false;
    if (opts.refresh !== false) {
      const s = this.ctx.settings.getPersisted();
      if (s.markets.enabled && s.privacy.allowInternet) {
        try {
          const fresh = await createMarketProvider(market.provider).get(market.venueId, opts.signal);
          if (fresh) { market = this.ctx.markets.upsertFromSummary(fresh); refreshed = true; }
        } catch {
          /* venue unreachable: judge against what is stored and say so */
        }
      }
    }
    if (!latest || latest.status === "stale") return { verification: latest, reasons: latest?.staleReasons ?? [], refreshed };
    const p = this.ctx.predictions.get(link.predictionId)!;
    const reasons = revalidate({ previous: latest, market, prediction: p, currentQuoteHash: p.quoteHash });
    if (this.ctx.predictions.revisionCount(p.id) !== latest.predictionRevision) reasons.push(`prediction edited since verification (revision ${latest.predictionRevision} → ${this.ctx.predictions.revisionCount(p.id)})`);
    if (reasons.length === 0) return { verification: latest, reasons: [], refreshed };
    return { verification: this.ctx.markets.markVerificationStale(latest.id, reasons), reasons, refreshed };
  }

  /** Stale-check every verified link of a prediction without touching the network (used after edits). */
  invalidateForPrediction(predictionId: string, reason: string): number {
    let n = 0;
    for (const link of this.ctx.markets.linksForPrediction(predictionId)) {
      const latest = this.ctx.markets.verificationsForLink(link.id)[0];
      if (latest && latest.status !== "stale") { this.ctx.markets.markVerificationStale(latest.id, [reason]); n++; }
    }
    return n;
  }

  /** MAT-01: US-only discovery with an explicit outcome. Other venues' links are listed as research-only. */
  async findUsCandidates(predictionId: string, input: { url?: string; limit?: number; signal?: AbortSignal } = {}): Promise<UsCandidateSearch> {
    const p = this.ctx.predictions.get(predictionId);
    if (!p) throw new ContractVerifyError("Prediction not found.", "not_found", 404);
    const s = this.ctx.settings.getPersisted();
    if (!s.markets.enabled) throw new ContractVerifyError("Prediction markets are turned off in Setup → Markets.", "markets_disabled", 409);
    if (!s.privacy.allowInternet) throw new ContractVerifyError("Internet access is disabled in Setup → Privacy; the venue cannot be searched.", "offline", 409);
    const provider = createMarketProvider("polymarket_us");
    const notes: string[] = [];
    const seen = new Map<string, MarketSummary>();
    let queries: string[] = [];
    try {
      if (input.url) {
        const slug = usEventSlug(input.url);
        if (!slug) throw new ContractVerifyError("Paste a polymarket.us/event/<slug> URL.", "invalid_facts");
        queries = [`event:${slug}`];
        const us = provider as PolymarketUsProvider;
        const list = typeof us.eventMarkets === "function" ? await us.eventMarkets(slug, input.signal) : [];
        if (list.length === 0) {
          const one = await provider.get(slug, input.signal);
          if (one) list.push(one);
        }
        for (const m of list) seen.set(m.id, m);
      } else {
        queries = buildMarketQueries(p);
        for (const q of queries) {
          await this.ctx.rateLimiter.acquire();
          for (const m of await provider.search(q, { limit: 25, signal: input.signal })) if (!seen.has(m.id)) seen.set(m.id, m);
        }
      }
    } catch (err) {
      if (err instanceof ContractVerifyError) throw err;
      throw new ContractVerifyError(`Polymarket US search failed: ${(err as Error).message}`, "venue_error", 502);
    }
    const game = p.gameId ? this.ctx.games.get(p.gameId) : undefined;
    const scored = [...seen.values()]
      .map((m) => ({ m, s: p.kind === "sports_pick" && p.sportsPick ? scoreSportsMarket(p.sportsPick, m, game?.eventDate ?? p.deadlineDate) : scoreTextMarket(p, m) }))
      .filter((x) => x.s.score >= 0.2 || !!input.url)
      .sort((x, y) => y.s.score - x.s.score)
      .slice(0, input.limit ?? 5);
    const candidates: UsCandidateSearch["candidates"] = [];
    for (const { m, s: sc } of scored) {
      const record = this.ctx.markets.upsertFromSummary(m);
      const link = this.ctx.markets.propose({ predictionId, marketId: record.id, side: sc.side, score: sc.score, relation: sc.relation, rationale: sc.rationale, matchedBy: input.url ? "user" : sc.matchedBy });
      candidates.push({ market: record, score: sc.score, rationale: sc.rationale, relation: sc.relation, side: sc.side, linkId: link.id });
    }
    const strong = candidates.filter((c) => c.score >= 0.6 || c.relation === "exact");
    const outcome: UsCandidateSearch["outcome"] = candidates.length === 0 ? "none" : strong.length === 1 && candidates.length === 1 ? "one" : strong.length === 1 && candidates[0].score - (candidates[1]?.score ?? 0) >= 0.25 ? "one" : "multiple";
    if (outcome === "none") notes.push("No Polymarket US market matched the claim's entities/date; nothing was linked.");
    if (outcome === "multiple") notes.push(`${candidates.length} plausible US markets; pick one and verify its contract — ambiguity never becomes a trade candidate.`);
    const researchOnly = this.ctx.markets.linksForPrediction(predictionId, false).filter((l) => l.market && l.market.provider !== "polymarket_us").map((l) => ({ linkId: l.id, provider: l.market!.provider as MarketProviderId, question: l.market!.question }));
    if (researchOnly.length) notes.push(`${researchOnly.length} link(s) on other venues are informational only and can never be executable.`);
    return { outcome, candidates, researchOnly, queries, notes };
  }
}

export function usEventSlug(url: string): string | undefined {
  const m = /^https?:\/\/(www\.)?polymarket\.us\/event\/([^?#/]+)/i.exec(url.trim());
  return m ? m[2] : undefined;
}

