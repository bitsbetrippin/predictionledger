/**
 * Prediction Ledger — consensus across channels (1.8), computed on read.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * "The same claim across videos" becomes one proposition with many endorsements. Two ways to group:
 *   - by market: every prediction with an accepted link to the same market (sides may differ → the
 *     room is split, and that is shown, not averaged away);
 *   - by text: unlinked predictions whose normalized statements overlap strongly (Jaccard over content
 *     tokens ≥ 0.5, same kind), with the implied side from negation.
 * Endorsement weight = creator's settled market-linked record (min 1) × recency decay (half-life 90 days),
 * so a channel with a record and a fresh claim counts more than a one-off from years ago — but every
 * claim is listed, weight or not.
 */

import type { EvidenceAssessment, Proposition, PropositionSide, Endorsement } from "@prediction-ledger/shared";
import type { Database } from "../db/index.js";
import { tokenize } from "../analysis/markets.js";
import type { Gates } from "../analysis/signals.js";
import { SignalService } from "./signals.js";

interface Row {
  prediction_id: string; video_id: string; video_title: string; channel: string | null; quote: string; normalized: string; kind: string; made_on: string | null; deadline: string | null;
  assessment: string | null; link_side: string | null; market_id: string | null; question: string | null; url: string | null;
}

const HALF_LIFE_DAYS = 90;

export class ConsensusService {
  constructor(private readonly db: Database, private readonly signals: SignalService) {}

  propositions(gates: Gates, opts: { includeSettled?: boolean } = {}): Proposition[] {
    const rows = this.db.all<Row>(
      `SELECT p.id AS prediction_id, p.video_id, v.title AS video_title, v.channel, p.quote_exact AS quote, p.normalized_statement AS normalized, p.kind, p.made_on_date AS made_on, p.deadline_date AS deadline,
              a.evidence_assessment AS assessment, l.side AS link_side, l.market_id, m.question, m.url
       FROM predictions p JOIN videos v ON v.id = p.video_id
       LEFT JOIN assessments a ON a.id = (SELECT id FROM assessments WHERE prediction_id = p.id ORDER BY version DESC LIMIT 1)
       LEFT JOIN prediction_market_links l ON l.prediction_id = p.id AND l.status = 'accepted'
       LEFT JOIN markets m ON m.id = l.market_id
       WHERE p.user_status IN ('pending','accepted')`,
    );
    const creators = new Map(this.signals.creators(gates).map((c) => [c.key, c]));
    const now = Date.now();
    const endorsementOf = (r: Row): Endorsement => {
      const c = SignalService.creatorOf(r);
      const rec = creators.get(c.key);
      const ageDays = r.made_on ? Math.max(0, (now - Date.parse(r.made_on)) / 86_400_000) : 365;
      const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
      const settled = rec?.linkedSettled ?? 0;
      return {
        predictionId: r.prediction_id, videoId: r.video_id, videoTitle: r.video_title, creatorKey: c.key, creatorLabel: c.label, quote: r.quote, madeOnDate: r.made_on ?? undefined,
        settled, shrunkEdge: rec?.shrunkEdge, weight: +(Math.max(1, settled) * recency).toFixed(3), verdict: (r.assessment ?? undefined) as EvidenceAssessment | undefined,
      };
    };
    const settledOut = (r: Row) => !opts.includeSettled && r.assessment && ["supported", "contradicted", "partially_supported"].includes(r.assessment);

    // ---- by market ----
    const byMarket = new Map<string, { row: Row; sides: Map<string, Endorsement[]> }>();
    const linkedPredictions = new Set<string>();
    for (const r of rows) {
      if (!r.market_id || !r.link_side) continue;
      linkedPredictions.add(r.prediction_id);
      if (settledOut(r)) continue;
      let g = byMarket.get(r.market_id);
      if (!g) { g = { row: r, sides: new Map() }; byMarket.set(r.market_id, g); }
      const list = g.sides.get(r.link_side) ?? [];
      if (!list.some((e) => e.predictionId === r.prediction_id)) list.push(endorsementOf(r));
      g.sides.set(r.link_side, list);
    }

    // ---- by text (unlinked only) ----
    const clusters: { rep: Row; tokens: Set<string>; members: Row[] }[] = [];
    for (const r of rows) {
      if (linkedPredictions.has(r.prediction_id) || settledOut(r)) continue;
      const tokens = new Set(tokenize(r.normalized).filter((t) => !/^(19|20)\d\d$/.test(t)));
      if (tokens.size < 3) continue;
      let best: { c: (typeof clusters)[number]; j: number } | undefined;
      for (const c of clusters) {
        if (c.rep.kind !== r.kind) continue;
        let inter = 0;
        for (const t of tokens) if (c.tokens.has(t)) inter++;
        const j = inter / (tokens.size + c.tokens.size - inter);
        if (j >= 0.5 && (!best || j > best.j)) best = { c, j };
      }
      if (best) { best.c.members.push(r); for (const t of tokens) best.c.tokens.add(t); }
      else clusters.push({ rep: r, tokens, members: [r] });
    }

    const out: Proposition[] = [];
    const finish = (key: string, label: string, groupedBy: Proposition["groupedBy"], sidesMap: Map<string, Endorsement[]>, market?: { id: string; url: string }): void => {
      const total = [...sidesMap.values()].flat().reduce((s, e) => s + e.weight, 0);
      const sides: PropositionSide[] = [...sidesMap.entries()]
        .map(([side, endorsements]) => ({ side, endorsements: endorsements.sort((a, b) => b.weight - a.weight), share: total > 0 ? +(endorsements.reduce((s, e) => s + e.weight, 0) / total).toFixed(3) : 0, creators: new Set(endorsements.map((e) => e.creatorKey)).size }))
        .sort((a, b) => b.share - a.share);
      const all = sides.flatMap((s) => s.endorsements);
      let marketPrice: Record<string, number> | undefined;
      if (market) {
        const snap = this.db.get<{ prices_json: string }>("SELECT prices_json FROM market_snapshots WHERE market_id = ? ORDER BY retrieved_at DESC LIMIT 1", market.id);
        if (snap) marketPrice = Object.fromEntries((JSON.parse(snap.prices_json) as { label: string; price?: number }[]).filter((x) => x.price !== undefined).map((x) => [x.label, x.price!]));
      }
      out.push({ key, label, marketId: market?.id, marketUrl: market?.url, marketPrice, sides, disagreement: sides.filter((s) => s.endorsements.length > 0).length > 1, videos: new Set(all.map((e) => e.videoId)).size, creators: new Set(all.map((e) => e.creatorKey)).size, groupedBy });
    };
    for (const [marketId, g] of byMarket) finish(`market:${marketId}`, g.row.question ?? "(market)", "market", g.sides, { id: marketId, url: g.row.url ?? "" });
    for (const c of clusters) {
      if (c.members.length < 2) continue; // a proposition needs more than one voice
      const sides = new Map<string, Endorsement[]>();
      for (const r of c.members) {
        const side = /\b(won't|will not|never|no longer|fail to|not going to|isn't going to|unlikely)\b/i.test(r.normalized) ? "No" : "Yes";
        sides.set(side, [...(sides.get(side) ?? []), endorsementOf(r)]);
      }
      finish(`text:${c.rep.prediction_id}`, c.rep.normalized, "text", sides);
    }
    return out.sort((a, b) => Number(b.disagreement) - Number(a.disagreement) || b.creators - a.creators || b.videos - a.videos);
  }
}
