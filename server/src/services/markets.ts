/**
 * Prediction Ledger — market records, snapshots and prediction↔market links (1.6).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import crypto from "node:crypto";
import type { ContractField, ContractVerification, ContractVerificationStatus, MarketLinkRelation, MarketLinkStatus, MarketRecord, MarketSnapshot, PredictionMarketLink } from "@prediction-ledger/shared";
import type { Database } from "../db/index.js";
import type { MarketSummary } from "../providers/markets/types.js";

interface MarketRow {
  id: string; provider: MarketRecord["provider"]; venue_id: string; condition_id: string | null; slug: string; url: string; question: string; description: string | null;
  event_id: string | null; event_slug: string | null; event_title: string | null; outcomes_json: string; end_date: string | null; start_date: string | null;
  active: number; closed: number; restricted: number; resolved: number; resolved_outcome: string | null; tags_json: string; watched: number; updated_at: string; constraints_json: string | null;
}
interface SnapshotRow { id: string; market_id: string; retrieved_at: string; prices_json: string; liquidity: number | null; volume: number | null; volume_24h: number | null; spread: number | null; source: MarketSnapshot["source"] }
interface LinkRow {
  id: string; prediction_id: string; market_id: string; side: string | null; score: number; relation: string | null; rationale: string | null; status: MarketLinkStatus;
  matched_by: PredictionMarketLink["matchedBy"]; price_at_made: number | null; price_at_made_at: string | null; price_at_made_source: string | null; created_at: string; updated_at: string;
  verification_status: ContractVerificationStatus | null; verification_id: string | null;
}
interface VerificationRow {
  id: string; link_id: string; prediction_id: string; market_id: string; version: number; status: ContractVerificationStatus; fields_json: string; side_id: string | null; side_label: string | null; side_basis: string | null;
  rules_hash: string | null; cutoff_at: string | null; cutoff_basis: string | null; cutoff_unknown: number; quote_hash: string | null; prediction_revision: number; facts_json: string; reviewer: ContractVerification["reviewer"]; notes: string | null;
  created_at: string; stale_at: string | null; stale_reasons_json: string | null;
}

export class MarketService {
  constructor(private readonly db: Database) {}

  // ---- markets --------------------------------------------------------------

  /** Insert or refresh a market from a provider summary and record a snapshot of its prices. */
  upsertFromSummary(s: MarketSummary, opts: { watched?: boolean; snapshot?: boolean } = {}): MarketRecord {
    const existing = this.db.get<MarketRow>("SELECT * FROM markets WHERE provider = ? AND venue_id = ?", s.provider, s.id);
    const id = existing?.id ?? crypto.randomUUID();
    const outcomes = JSON.stringify(s.outcomes.map((o) => ({ label: o.label, tokenId: o.tokenId })));
    const watched = opts.watched === undefined ? (existing?.watched ?? 0) : opts.watched ? 1 : 0;
    this.db.run(
      `INSERT INTO markets (id, provider, venue_id, condition_id, slug, url, question, description, event_id, event_slug, event_title, outcomes_json, end_date, start_date, active, closed, restricted, resolved, resolved_outcome, tags_json, watched, constraints_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, venue_id) DO UPDATE SET condition_id = excluded.condition_id, slug = excluded.slug, url = excluded.url, question = excluded.question, description = excluded.description,
         event_id = COALESCE(excluded.event_id, markets.event_id), event_slug = COALESCE(excluded.event_slug, markets.event_slug), event_title = COALESCE(excluded.event_title, markets.event_title), outcomes_json = excluded.outcomes_json, end_date = excluded.end_date, start_date = excluded.start_date,
         active = excluded.active, closed = excluded.closed, restricted = excluded.restricted, resolved = excluded.resolved, resolved_outcome = excluded.resolved_outcome, tags_json = excluded.tags_json,
         watched = excluded.watched, constraints_json = COALESCE(excluded.constraints_json, markets.constraints_json), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      id, s.provider, s.id, s.conditionId ?? null, s.slug, s.url, s.question, s.description ?? null, s.event?.id ?? null, s.event?.slug ?? null, s.event?.title ?? null, outcomes,
      s.endDate ?? null, s.startDate ?? null, s.active ? 1 : 0, s.closed ? 1 : 0, s.restricted ? 1 : 0, s.resolved ? 1 : 0, s.resolvedOutcome ?? null, JSON.stringify(s.tags ?? []), watched,
      s.constraints ? JSON.stringify(s.constraints) : null,
    );
    if (opts.snapshot !== false) this.addSnapshot(id, s);
    return this.get(id)!;
  }

  addSnapshot(marketId: string, s: MarketSummary, source: MarketSnapshot["source"] = "gamma"): MarketSnapshot {
    const id = crypto.randomUUID();
    const prices = s.outcomes.map((o) => ({ label: o.label, price: o.price, bestBid: o.bestBid, bestAsk: o.bestAsk }));
    const first = s.outcomes[0];
    const spread = first?.bestAsk !== undefined && first?.bestBid !== undefined ? +(first.bestAsk - first.bestBid).toFixed(4) : null;
    this.db.run(
      "INSERT INTO market_snapshots (id, market_id, retrieved_at, prices_json, liquidity, volume, volume_24h, spread, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, marketId, s.retrievedAt, JSON.stringify(prices), s.liquidity ?? null, s.volume ?? null, s.volume24h ?? null, spread, source,
    );
    return this.getSnapshot(id)!;
  }

  get(id: string): MarketRecord | undefined {
    const r = this.db.get<MarketRow>("SELECT * FROM markets WHERE id = ?", id);
    return r ? this.hydrate(r) : undefined;
  }

  findByVenue(provider: string, venueId: string): MarketRecord | undefined {
    const r = this.db.get<MarketRow>("SELECT * FROM markets WHERE provider = ? AND venue_id = ?", provider, venueId);
    return r ? this.hydrate(r) : undefined;
  }

  list(opts: { watchedOnly?: boolean } = {}): MarketRecord[] {
    const rows = opts.watchedOnly
      ? this.db.all<MarketRow>("SELECT * FROM markets WHERE watched = 1 ORDER BY end_date ASC, updated_at DESC")
      : this.db.all<MarketRow>("SELECT * FROM markets ORDER BY end_date ASC, updated_at DESC");
    return rows.map((r) => this.hydrate(r));
  }

  /** Markets that need refreshing: watched, or linked (accepted/proposed) to a prediction. */
  refreshable(): MarketRecord[] {
    return this.db
      .all<MarketRow>(
        `SELECT DISTINCT m.* FROM markets m LEFT JOIN prediction_market_links l ON l.market_id = m.id AND l.status IN ('accepted','proposed')
         WHERE (m.watched = 1 OR l.id IS NOT NULL) AND m.closed = 0 ORDER BY m.end_date ASC`,
      )
      .map((r) => this.hydrate(r));
  }

  setWatched(id: string, watched: boolean): MarketRecord | undefined {
    this.db.run("UPDATE markets SET watched = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", watched ? 1 : 0, id);
    return this.get(id);
  }

  delete(id: string): boolean {
    return Number(this.db.run("DELETE FROM markets WHERE id = ?", id).changes) > 0;
  }

  snapshots(marketId: string, limit = 200): MarketSnapshot[] {
    return this.db.all<SnapshotRow>("SELECT * FROM market_snapshots WHERE market_id = ? ORDER BY retrieved_at DESC LIMIT ?", marketId, limit).map(hydrateSnapshot);
  }

  latestSnapshot(marketId: string): MarketSnapshot | undefined {
    const r = this.db.get<SnapshotRow>("SELECT * FROM market_snapshots WHERE market_id = ? ORDER BY retrieved_at DESC LIMIT 1", marketId);
    return r ? hydrateSnapshot(r) : undefined;
  }

  /** Snapshot nearest a date (either side), for "what did the market say when the claim was made". */
  snapshotNearest(marketId: string, isoDate: string): MarketSnapshot | undefined {
    const r = this.db.get<SnapshotRow>("SELECT * FROM market_snapshots WHERE market_id = ? ORDER BY ABS(julianday(retrieved_at) - julianday(?)) ASC LIMIT 1", marketId, isoDate);
    return r ? hydrateSnapshot(r) : undefined;
  }

  getSnapshot(id: string): MarketSnapshot | undefined {
    const r = this.db.get<SnapshotRow>("SELECT * FROM market_snapshots WHERE id = ?", id);
    return r ? hydrateSnapshot(r) : undefined;
  }

  // ---- links ----------------------------------------------------------------

  /** Create or refresh a link proposal; an accepted/rejected link is never downgraded by a new proposal. */
  propose(input: { predictionId: string; marketId: string; side?: string; score: number; relation?: MarketLinkRelation; rationale?: string; matchedBy: PredictionMarketLink["matchedBy"]; status?: MarketLinkStatus; priceAtMade?: number }): PredictionMarketLink {
    const existing = this.db.get<LinkRow>("SELECT * FROM prediction_market_links WHERE prediction_id = ? AND market_id = ?", input.predictionId, input.marketId);
    if (existing) {
      const status = existing.status === "proposed" ? (input.status ?? "proposed") : existing.status;
      this.db.run(
        "UPDATE prediction_market_links SET side = ?, score = ?, relation = ?, rationale = ?, matched_by = ?, status = ?, price_at_made = COALESCE(?, price_at_made), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
        input.side ?? existing.side, input.score, input.relation ?? existing.relation, input.rationale ?? existing.rationale, input.matchedBy, status, input.priceAtMade ?? null, existing.id,
      );
      return this.getLink(existing.id)!;
    }
    const id = crypto.randomUUID();
    this.db.run(
      "INSERT INTO prediction_market_links (id, prediction_id, market_id, side, score, relation, rationale, status, matched_by, price_at_made) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, input.predictionId, input.marketId, input.side ?? null, input.score, input.relation ?? null, input.rationale ?? null, input.status ?? "proposed", input.matchedBy, input.priceAtMade ?? null,
    );
    return this.getLink(id)!;
  }

  setLinkStatus(id: string, status: MarketLinkStatus, side?: string): PredictionMarketLink | undefined {
    this.db.run("UPDATE prediction_market_links SET status = ?, side = COALESCE(?, side), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", status, side ?? null, id);
    return this.getLink(id);
  }

  setPriceAtMade(id: string, price: number | undefined, at?: string, source?: "history" | "snapshot"): void {
    this.db.run("UPDATE prediction_market_links SET price_at_made = ?, price_at_made_at = ?, price_at_made_source = ? WHERE id = ?", price ?? null, at ?? null, source ?? null, id);
  }

  /** Accepted links whose made-on price has not been read from venue history yet (1.7 backfill). */
  linksNeedingBackfill(limit = 50): PredictionMarketLink[] {
    return this.db
      .all<LinkRow>("SELECT * FROM prediction_market_links WHERE status = 'accepted' AND (price_at_made IS NULL OR price_at_made_source IS NULL OR price_at_made_source <> 'history') ORDER BY updated_at DESC LIMIT ?", limit)
      .map((r) => this.hydrateLink(r));
  }

  getLink(id: string): PredictionMarketLink | undefined {
    const r = this.db.get<LinkRow>("SELECT * FROM prediction_market_links WHERE id = ?", id);
    return r ? this.hydrateLink(r) : undefined;
  }

  linksForPrediction(predictionId: string, includeRejected = true): PredictionMarketLink[] {
    const rows = includeRejected
      ? this.db.all<LinkRow>("SELECT * FROM prediction_market_links WHERE prediction_id = ? ORDER BY status = 'accepted' DESC, score DESC", predictionId)
      : this.db.all<LinkRow>("SELECT * FROM prediction_market_links WHERE prediction_id = ? AND status <> 'rejected' ORDER BY status = 'accepted' DESC, score DESC", predictionId);
    return rows.map((r) => this.hydrateLink(r));
  }

  linksForMarket(marketId: string): PredictionMarketLink[] {
    return this.db.all<LinkRow>("SELECT * FROM prediction_market_links WHERE market_id = ? AND status <> 'rejected' ORDER BY created_at", marketId).map((r) => this.hydrateLink(r, false));
  }

  allLinks(): PredictionMarketLink[] {
    return this.db.all<LinkRow>("SELECT * FROM prediction_market_links ORDER BY created_at").map((r) => this.hydrateLink(r, false));
  }

  deleteLink(id: string): boolean {
    return Number(this.db.run("DELETE FROM prediction_market_links WHERE id = ?", id).changes) > 0;
  }

  // ---- internals ------------------------------------------------------------

  private hydrate(r: MarketRow): MarketRecord {
    return {
      id: r.id, provider: r.provider, venueId: r.venue_id, conditionId: r.condition_id ?? undefined, slug: r.slug, url: r.url, question: r.question, description: r.description ?? undefined,
      event: r.event_id ? { id: r.event_id, slug: r.event_slug ?? "", title: r.event_title ?? "" } : undefined,
      outcomes: JSON.parse(r.outcomes_json) as MarketRecord["outcomes"], endDate: r.end_date ?? undefined, startDate: r.start_date ?? undefined,
      active: r.active === 1, closed: r.closed === 1, restricted: r.restricted === 1, resolved: r.resolved === 1, resolvedOutcome: r.resolved_outcome ?? undefined,
      tags: JSON.parse(r.tags_json) as string[], watched: r.watched === 1, updatedAt: r.updated_at, latest: this.latestSnapshot(r.id),
      constraints: r.constraints_json ? (JSON.parse(r.constraints_json) as MarketRecord["constraints"]) : undefined,
    };
  }

  private hydrateLink(r: LinkRow, withMarket = true): PredictionMarketLink {
    return {
      id: r.id, predictionId: r.prediction_id, marketId: r.market_id, side: r.side ?? undefined, score: r.score, relation: (r.relation ?? undefined) as MarketLinkRelation | undefined,
      rationale: r.rationale ?? undefined, status: r.status, matchedBy: r.matched_by, priceAtMade: r.price_at_made ?? undefined,
      priceAtMadeAt: r.price_at_made_at ?? undefined, priceAtMadeSource: (r.price_at_made_source ?? undefined) as "history" | "snapshot" | undefined, createdAt: r.created_at, updatedAt: r.updated_at,
      market: withMarket ? this.get(r.market_id) : undefined,
      verificationStatus: r.verification_status ?? "unverified", verificationId: r.verification_id ?? undefined,
    };
  }

  // ---- 1.11 contract verifications (immutable versions) ------------------------------------

  addVerification(input: Omit<ContractVerification, "id" | "version" | "createdAt" | "staleAt" | "staleReasons">): ContractVerification {
    const id = crypto.randomUUID();
    const version = (this.db.get<{ n: number | null }>("SELECT MAX(version) AS n FROM contract_verifications WHERE link_id = ?", input.linkId)?.n ?? 0) + 1;
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO contract_verifications (id, link_id, prediction_id, market_id, version, status, fields_json, side_id, side_label, side_basis, rules_hash, cutoff_at, cutoff_basis, cutoff_unknown, quote_hash, prediction_revision, facts_json, reviewer, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, input.linkId, input.predictionId, input.marketId, version, input.status, JSON.stringify(input.fields), input.sideId ?? null, input.sideLabel ?? null, input.sideBasis ?? null, input.rulesHash ?? null,
        input.cutoffAt ?? null, input.cutoffBasis ?? null, input.cutoffUnknown ? 1 : 0, input.quoteHash ?? null, input.predictionRevision, JSON.stringify(input.facts), input.reviewer, input.notes ?? null,
      );
      this.db.run("UPDATE prediction_market_links SET verification_status = ?, verification_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", input.status, id, input.linkId);
    });
    return this.getVerification(id)!;
  }

  /** MAT-06: the one allowed transition on a stored verification — it stops being valid. Everything else stays as written. */
  markVerificationStale(id: string, reasons: string[]): ContractVerification | undefined {
    const v = this.getVerification(id);
    if (!v || v.status === "stale") return v;
    this.db.transaction(() => {
      this.db.run("UPDATE contract_verifications SET status = 'stale', stale_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), stale_reasons_json = ? WHERE id = ?", JSON.stringify(reasons), id);
      this.db.run("UPDATE prediction_market_links SET verification_status = 'stale', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND verification_id = ?", v.linkId, id);
    });
    return this.getVerification(id);
  }

  getVerification(id: string): ContractVerification | undefined {
    const r = this.db.get<VerificationRow>("SELECT * FROM contract_verifications WHERE id = ?", id);
    return r ? hydrateVerification(r) : undefined;
  }

  verificationsForLink(linkId: string): ContractVerification[] {
    return this.db.all<VerificationRow>("SELECT * FROM contract_verifications WHERE link_id = ? ORDER BY version DESC", linkId).map(hydrateVerification);
  }

  /** Links whose latest verification is currently `verified_equivalent` — the only execution candidates (MAT-03). */
  executableLinks(predictionId: string): PredictionMarketLink[] {
    return this.db.all<LinkRow>("SELECT * FROM prediction_market_links WHERE prediction_id = ? AND status = 'accepted' AND verification_status = 'verified_equivalent'", predictionId).map((r) => this.hydrateLink(r));
  }
}

function hydrateVerification(r: VerificationRow): ContractVerification {
  return {
    id: r.id, linkId: r.link_id, predictionId: r.prediction_id, marketId: r.market_id, version: r.version, status: r.status, fields: JSON.parse(r.fields_json) as ContractField[],
    sideId: r.side_id ?? undefined, sideLabel: r.side_label ?? undefined, sideBasis: r.side_basis ?? undefined, rulesHash: r.rules_hash ?? undefined, cutoffAt: r.cutoff_at ?? undefined, cutoffBasis: r.cutoff_basis ?? undefined,
    cutoffUnknown: r.cutoff_unknown === 1, quoteHash: r.quote_hash ?? undefined, predictionRevision: r.prediction_revision, facts: JSON.parse(r.facts_json) as ContractVerification["facts"], reviewer: r.reviewer, notes: r.notes ?? undefined,
    createdAt: r.created_at, staleAt: r.stale_at ?? undefined, staleReasons: r.stale_reasons_json ? (JSON.parse(r.stale_reasons_json) as string[]) : undefined,
  };
}

function hydrateSnapshot(r: SnapshotRow): MarketSnapshot {
  return { id: r.id, marketId: r.market_id, retrievedAt: r.retrieved_at, prices: JSON.parse(r.prices_json) as MarketSnapshot["prices"], liquidity: r.liquidity ?? undefined, volume: r.volume ?? undefined, volume24h: r.volume_24h ?? undefined, spread: r.spread ?? undefined, source: r.source };
}
