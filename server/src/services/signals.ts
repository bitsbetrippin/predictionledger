/**
 * Prediction Ledger — signals (1.7): creator records and market-side signals, computed on read.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Nothing here is stored: a signal is a view over predictions, their latest assessments, accepted
 * market links and the latest snapshots. Every number traces back to rows the user can open.
 * Creator identity is the video's channel when known, else the video itself (per-speaker records
 * wait for diarisation).
 */

import type { CreatorRecord, MarketSignal, SignalContribution } from "@prediction-ledger/shared";
import type { Database } from "../db/index.js";
import { clampProb, combineEdges, confidenceLabel, deadlineCheck, outcomeOf, recordStats, shrink, type Gates, type Outcome } from "../analysis/signals.js";

interface Row {
  prediction_id: string; video_id: string; video_title: string; channel: string | null; quote: string; made_on: string | null; deadline: string | null; user_status: string;
  assessment: string | null; time_status: string | null;
  link_id: string | null; link_side: string | null; price_at_made: number | null; market_id: string | null;
}

interface MarketRow { id: string; question: string; url: string; event_title: string | null; end_date: string | null; closed: number }

export class SignalService {
  constructor(private readonly db: Database) {}

  private rows(): Row[] {
    return this.db.all<Row>(
      `SELECT p.id AS prediction_id, p.video_id, v.title AS video_title, v.channel, p.quote_exact AS quote, p.made_on_date AS made_on, p.deadline_date AS deadline, p.user_status,
              a.evidence_assessment AS assessment, a.time_status,
              l.id AS link_id, l.side AS link_side, l.price_at_made, l.market_id
       FROM predictions p
       JOIN videos v ON v.id = p.video_id
       LEFT JOIN assessments a ON a.id = (SELECT id FROM assessments WHERE prediction_id = p.id ORDER BY version DESC LIMIT 1)
       LEFT JOIN prediction_market_links l ON l.prediction_id = p.id AND l.status = 'accepted'
       WHERE p.user_status IN ('pending','accepted')`,
    );
  }

  static creatorOf(r: { channel: string | null; video_id: string; video_title: string }): { key: string; label: string } {
    return r.channel ? { key: `channel:${r.channel.toLowerCase().trim()}`, label: r.channel } : { key: `video:${r.video_id}`, label: `${r.video_title} (no channel)` };
  }

  creators(gates: Gates): CreatorRecord[] {
    const byKey = new Map<string, CreatorRecord & { linked: { outcome: Outcome; priceAtMade: number }[]; seenPredictions: Set<string> }>();
    for (const r of this.rows()) {
      const c = SignalService.creatorOf(r);
      let rec = byKey.get(c.key);
      if (!rec) {
        rec = { key: c.key, label: c.label, predictions: 0, settled: 0, hits: 0, misses: 0, partial: 0, linkedSettled: 0, open: 0, linked: [], seenPredictions: new Set() };
        byKey.set(c.key, rec);
      }
      const firstTime = !rec.seenPredictions.has(r.prediction_id);
      rec.seenPredictions.add(r.prediction_id);
      const o = outcomeOf(r.assessment ?? undefined);
      if (firstTime) {
        rec.predictions++;
        if (o === undefined) rec.open++;
        else { rec.settled++; if (o === 1) rec.hits++; else if (o === 0) rec.misses++; else rec.partial++; }
      }
      // One row per accepted link (a prediction may have several links; each counts as a settled linked observation).
      if (o !== undefined && r.link_id && r.price_at_made !== null) rec.linked.push({ outcome: o, priceAtMade: r.price_at_made });
    }
    return [...byKey.values()]
      .map((rec) => {
        const stats = recordStats(rec.linked);
        const { linked: _l, seenPredictions: _s, ...pub } = rec;
        return {
          ...pub,
          hitRate: rec.settled > 0 ? Math.round(((rec.hits + 0.5 * rec.partial) / rec.settled) * 1000) / 1000 : undefined,
          linkedSettled: stats.linkedSettled,
          realizedEdge: stats.realizedEdge,
          marketBrier: stats.marketBrier,
          creatorBrier: stats.creatorBrier,
          shrunkEdge: shrink(stats.realizedEdge, stats.linkedSettled, gates.priorWeight),
        };
      })
      .sort((a, b) => b.settled - a.settled || b.predictions - a.predictions);
  }

  /** One signal per (market, side) over OPEN predictions with accepted links. */
  signals(gates: Gates, opts: { includeSettled?: boolean } = {}): MarketSignal[] {
    const creators = new Map(this.creators(gates).map((c) => [c.key, c]));
    const groups = new Map<string, { market: MarketRow; side: string; contributions: SignalContribution[]; deadlines: (string | null)[] }>();
    for (const r of this.rows()) {
      if (!r.link_id || !r.market_id || !r.link_side) continue;
      const o = outcomeOf(r.assessment ?? undefined);
      if (o !== undefined && !opts.includeSettled) continue;
      const market = this.db.get<MarketRow>("SELECT id, question, url, event_title, end_date, closed FROM markets WHERE id = ?", r.market_id);
      if (!market) continue;
      const key = `${market.id}|${r.link_side}`;
      let g = groups.get(key);
      if (!g) { g = { market, side: r.link_side, contributions: [], deadlines: [] }; groups.set(key, g); }
      const c = SignalService.creatorOf(r);
      const rec = creators.get(c.key);
      g.contributions.push({
        predictionId: r.prediction_id, videoId: r.video_id, videoTitle: r.video_title, creatorKey: c.key, creatorLabel: c.label, linkId: r.link_id, quote: r.quote,
        madeOnDate: r.made_on ?? undefined, priceAtMade: r.price_at_made ?? undefined, settled: rec?.linkedSettled ?? 0, realizedEdge: rec?.realizedEdge, shrunkEdge: rec?.shrunkEdge, weight: rec?.linkedSettled ?? 0,
      });
      g.deadlines.push(r.deadline);
    }
    const out: MarketSignal[] = [];
    for (const g of groups.values()) {
      const snap = this.db.get<{ prices_json: string; liquidity: number | null; volume_24h: number | null; retrieved_at: string }>("SELECT prices_json, liquidity, volume_24h, retrieved_at FROM market_snapshots WHERE market_id = ? ORDER BY retrieved_at DESC LIMIT 1", g.market.id);
      const prices = snap ? (JSON.parse(snap.prices_json) as { label: string; price?: number }[]) : [];
      const marketPrice = prices.find((x) => x.label === g.side)?.price;
      const combined = combineEdges(g.contributions.map((c) => ({ sourceKey: c.videoId, settled: c.settled, shrunkEdge: c.shrunkEdge })));
      const checks = g.deadlines.map((d) => deadlineCheck(d ?? undefined, g.market.end_date ?? undefined));
      const dc: MarketSignal["deadlineCheck"] = checks.includes("inconsistent") ? "inconsistent" : checks.every((c) => c === "consistent") ? "consistent" : "unknown";
      const label = confidenceLabel({ edge: combined.edge, settled: combined.weight, liquidity: snap?.liquidity ?? undefined, marketPrice, deadlineCheck: dc }, gates);
      out.push({
        marketId: g.market.id, question: g.market.question, url: g.market.url, eventTitle: g.market.event_title ?? undefined, side: g.side,
        marketPrice, asOf: snap?.retrieved_at, liquidity: snap?.liquidity ?? undefined, volume24h: snap?.volume_24h ?? undefined, endDate: g.market.end_date ?? undefined,
        edge: combined.edge, estimate: combined.edge !== undefined && marketPrice !== undefined ? clampProb(marketPrice + combined.edge) : undefined,
        confidence: label.confidence, reasons: label.reasons, creators: combined.creators, contributions: g.contributions, deadlineCheck: dc,
      });
    }
    const rank: Record<string, number> = { strong: 3, moderate: 2, lean: 1, none: 0 };
    return out.sort((a, b) => rank[b.confidence] - rank[a.confidence] || Math.abs(b.edge ?? 0) - Math.abs(a.edge ?? 0));
  }
}
