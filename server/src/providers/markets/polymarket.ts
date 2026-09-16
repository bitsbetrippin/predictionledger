/**
 * Prediction Ledger — Polymarket adapter (1.5, read-only).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Two public, unauthenticated APIs (verified live 2026-09-15):
 *   Gamma  https://gamma-api.polymarket.com  — market/event metadata, outcomes, prices, liquidity, search
 *   CLOB   https://clob.polymarket.com       — order books, midpoints, price history (reads need no key)
 * Trading endpoints on the CLOB need a Polygon wallet + L2 API key and are deliberately NOT wrapped here.
 * Gamma returns several fields as JSON-encoded strings (`outcomes`, `outcomePrices`, `clobTokenIds`);
 * this adapter normalises them into MarketSummary. Base URLs are overridable for tests and mirrors.
 */

import type { MarketOutcome, MarketProvider, MarketSummary, OrderBookSnapshot, PricePoint } from "./types.js";
import { MarketApiError } from "./types.js";

export interface PolymarketOptions {
  gammaBaseUrl?: string;
  clobBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const POLYMARKET_GAMMA = "https://gamma-api.polymarket.com";
export const POLYMARKET_CLOB = "https://clob.polymarket.com";

/** Raw Gamma market row — only the fields we read. */
interface GammaMarket {
  id: string; question: string; conditionId?: string; slug: string; description?: string;
  outcomes?: string | string[]; outcomePrices?: string | string[]; clobTokenIds?: string | string[];
  liquidity?: string | number; liquidityNum?: number; volume?: string | number; volumeNum?: number; volume24hr?: number;
  bestBid?: number; bestAsk?: number; lastTradePrice?: number; endDate?: string; startDate?: string;
  active?: boolean; closed?: boolean; restricted?: boolean; umaResolutionStatuses?: string | string[];
  events?: { id: string; slug: string; title: string }[];
  tags?: { slug?: string; label?: string }[];
}

function jsonList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  try {
    const parsed = JSON.parse(v) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
const num = (v: string | number | undefined): number | undefined => {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export function normalizeGammaMarket(m: GammaMarket, retrievedAt = new Date().toISOString()): MarketSummary {
  const labels = jsonList(m.outcomes);
  const prices = jsonList(m.outcomePrices).map(Number);
  const tokens = jsonList(m.clobTokenIds);
  const outcomes: MarketOutcome[] = labels.map((label, i) => ({
    label,
    tokenId: tokens[i],
    price: Number.isFinite(prices[i]) ? prices[i] : undefined,
    // Gamma's bestBid/bestAsk describe the first outcome (Yes); the complement is 1 − price.
    bestBid: i === 0 ? m.bestBid : m.bestAsk !== undefined ? +(1 - m.bestAsk).toFixed(4) : undefined,
    bestAsk: i === 0 ? m.bestAsk : m.bestBid !== undefined ? +(1 - m.bestBid).toFixed(4) : undefined,
  }));
  const statuses = jsonList(m.umaResolutionStatuses);
  // Resolution (1.9): UMA says resolved, or the market is closed with one side priced at (almost) 1.
  const winner = outcomes.find((o) => o.price !== undefined && o.price >= 0.98);
  const resolved = statuses.includes("resolved") || (m.closed === true && !!winner);
  const ev = m.events?.[0];
  return {
    provider: "polymarket",
    id: String(m.id),
    conditionId: m.conditionId,
    slug: m.slug,
    url: ev ? `https://polymarket.com/event/${ev.slug}` : `https://polymarket.com/market/${m.slug}`,
    question: m.question,
    description: m.description,
    event: ev ? { id: String(ev.id), slug: ev.slug, title: ev.title } : undefined,
    outcomes,
    liquidity: m.liquidityNum ?? num(m.liquidity),
    volume: m.volumeNum ?? num(m.volume),
    volume24h: m.volume24hr,
    endDate: m.endDate,
    startDate: m.startDate,
    active: m.active === true,
    closed: m.closed === true,
    restricted: m.restricted,
    resolved: resolved || undefined,
    resolvedOutcome: resolved ? winner?.label : undefined,
    tags: m.tags?.map((t) => t.slug ?? t.label ?? "").filter(Boolean),
    retrievedAt,
  };
}

export class PolymarketProvider implements MarketProvider {
  readonly id = "polymarket" as const;
  private readonly gamma: string;
  private readonly clob: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: PolymarketOptions = {}) {
    this.gamma = (opts.gammaBaseUrl ?? POLYMARKET_GAMMA).replace(/\/$/, "");
    this.clob = (opts.clobBaseUrl ?? POLYMARKET_CLOB).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  private async getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await this.fetchImpl(url, { headers: { accept: "application/json", "user-agent": "prediction-ledger (read-only market data)" }, signal: ctl.signal });
      const text = await res.text();
      if (!res.ok) throw new MarketApiError("polymarket", res.status, text);
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async search(query: string, opts: { limit?: number; activeOnly?: boolean; signal?: AbortSignal } = {}): Promise<MarketSummary[]> {
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
    // Gamma's public-search returns events with nested markets; flatten and keep tradable ones.
    const q = new URLSearchParams({ q: query, limit_per_type: String(limit) });
    if (opts.activeOnly !== false) q.set("events_status", "active");
    const data = await this.getJson<{ events?: (Record<string, unknown> & { id: string; slug: string; title: string; markets?: GammaMarket[] })[] }>(`${this.gamma}/public-search?${q}`, opts.signal);
    const out: MarketSummary[] = [];
    const retrievedAt = new Date().toISOString();
    for (const ev of data.events ?? []) {
      for (const m of ev.markets ?? []) {
        const s = normalizeGammaMarket({ ...m, events: m.events ?? [{ id: ev.id, slug: ev.slug, title: ev.title }] }, retrievedAt);
        if (opts.activeOnly !== false && (s.closed || !s.active)) continue;
        out.push(s);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  async get(idOrSlug: string, signal?: AbortSignal): Promise<MarketSummary | undefined> {
    if (/^\d+$/.test(idOrSlug)) {
      try {
        return normalizeGammaMarket(await this.getJson<GammaMarket>(`${this.gamma}/markets/${idOrSlug}`, signal));
      } catch (err) {
        if (err instanceof MarketApiError && err.status === 404) return undefined;
        throw err;
      }
    }
    const rows = await this.getJson<GammaMarket[]>(`${this.gamma}/markets?slug=${encodeURIComponent(idOrSlug)}`, signal);
    return rows[0] ? normalizeGammaMarket(rows[0]) : undefined;
  }

  async list(opts: { tag?: string; limit?: number; offset?: number; activeOnly?: boolean; signal?: AbortSignal }): Promise<MarketSummary[]> {
    const limit = Math.min(opts.limit ?? 20, 100);
    const retrievedAt = new Date().toISOString();
    if (opts.tag) {
      // Tag filtering works on /events (verified live); /markets ignores tag_slug. Flatten each event's markets.
      const q = new URLSearchParams({ tag_slug: opts.tag, limit: String(Math.min(limit, 50)), offset: String(opts.offset ?? 0), order: "volume24hr", ascending: "false" });
      if (opts.activeOnly !== false) { q.set("active", "true"); q.set("closed", "false"); }
      const events = await this.getJson<({ id: string; slug: string; title: string; markets?: GammaMarket[] })[]>(`${this.gamma}/events?${q}`, opts.signal);
      const out: MarketSummary[] = [];
      for (const ev of events) {
        for (const m of ev.markets ?? []) {
          const s = normalizeGammaMarket({ ...m, events: m.events ?? [{ id: ev.id, slug: ev.slug, title: ev.title }] }, retrievedAt);
          if (opts.activeOnly !== false && (s.closed || !s.active)) continue;
          out.push(s);
          if (out.length >= limit) return out;
        }
      }
      return out;
    }
    const q = new URLSearchParams({ limit: String(limit), offset: String(opts.offset ?? 0), order: "volume24hr", ascending: "false" });
    if (opts.activeOnly !== false) { q.set("active", "true"); q.set("closed", "false"); }
    const rows = await this.getJson<GammaMarket[]>(`${this.gamma}/markets?${q}`, opts.signal);
    return rows.map((m) => normalizeGammaMarket(m, retrievedAt));
  }

  async book(tokenId: string, signal?: AbortSignal): Promise<OrderBookSnapshot> {
    const [book, mid] = await Promise.all([
      this.getJson<{ bids?: { price: string; size: string }[]; asks?: { price: string; size: string }[] }>(`${this.clob}/book?token_id=${encodeURIComponent(tokenId)}`, signal),
      this.getJson<{ mid?: string }>(`${this.clob}/midpoint?token_id=${encodeURIComponent(tokenId)}`, signal).catch(() => ({ mid: undefined })),
    ]);
    const lvl = (l: { price: string; size: string }) => ({ price: Number(l.price), size: Number(l.size) });
    return {
      provider: "polymarket",
      tokenId,
      bids: (book.bids ?? []).map(lvl).sort((x, y) => y.price - x.price),
      asks: (book.asks ?? []).map(lvl).sort((x, y) => x.price - y.price),
      midpoint: mid.mid !== undefined ? Number(mid.mid) : undefined,
      retrievedAt: new Date().toISOString(),
    };
  }

  /**
   * CLOB `GET /prices-history?market=<tokenId>&startTs=<unix s>&endTs=<unix s>&fidelity=<minutes>` →
   * `{ history: [{ t: <unix s>, p: <0–1> }] }` (verified live 2026-09-16).
   */
  async priceHistory(tokenId: string, opts: { from: string; to: string; fidelityMinutes?: number; signal?: AbortSignal }): Promise<PricePoint[]> {
    const startTs = Math.floor(Date.parse(opts.from) / 1000);
    const endTs = Math.floor(Date.parse(opts.to) / 1000);
    if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) return [];
    const q = new URLSearchParams({ market: tokenId, startTs: String(startTs), endTs: String(endTs), fidelity: String(opts.fidelityMinutes ?? 60) });
    const data = await this.getJson<{ history?: { t: number; p: number | string }[] }>(`${this.clob}/prices-history?${q}`, opts.signal);
    return (data.history ?? [])
      .map((h) => ({ t: new Date(Number(h.t) * 1000).toISOString(), p: Number(h.p) }))
      .filter((h) => Number.isFinite(h.p))
      .sort((a, b) => a.t.localeCompare(b.t));
  }
}
