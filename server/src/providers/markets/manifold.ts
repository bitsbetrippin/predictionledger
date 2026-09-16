/**
 * Prediction Ledger — Manifold Markets adapter (1.8, read-only). Second venue behind MarketProvider.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Public, unauthenticated API (verified live 2026-09-16): https://api.manifold.markets/v0
 *   /search-markets?term=&limit=&filter=open&contractType=BINARY   search (also used for listing)
 *   /market/{id}, /slug/{slug}                                     one market (textDescription = rules)
 *   /bets?contractId=&limit=&afterTime=&beforeTime=                 trade tape; probAfter gives history
 * Manifold is play-money (mana; some markets are "CASH"): liquidity and volume are in that unit, not
 * USD — the record carries `token` in its tags so signals can tell. Only BINARY markets are mapped;
 * outcome token ids are synthetic (`<id>:YES` / `<id>:NO`) so `book` and `priceHistory` can find the
 * contract again. There is no order book to read: `book` returns the probability as the midpoint.
 */

import type { MarketProvider, MarketSummary, OrderBookSnapshot, PricePoint } from "./types.js";
import { MarketApiError } from "./types.js";

export const MANIFOLD_API = "https://api.manifold.markets/v0";

export interface ManifoldOptions { baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number }

interface ManifoldMarket {
  id: string; slug: string; question: string; url?: string; probability?: number; totalLiquidity?: number; volume?: number; volume24Hours?: number;
  closeTime?: number; createdTime?: number; isResolved?: boolean; resolution?: string | null; outcomeType?: string; textDescription?: string; description?: unknown;
  token?: string; groupSlugs?: string[]; creatorUsername?: string;
}

const tokenIdFor = (id: string, side: "YES" | "NO") => `${id}:${side}`;
const contractOf = (tokenId: string) => tokenId.replace(/:(YES|NO)$/, "");

export function normalizeManifoldMarket(m: ManifoldMarket, retrievedAt = new Date().toISOString()): MarketSummary {
  const p = typeof m.probability === "number" ? +m.probability.toFixed(4) : undefined;
  const closed = m.isResolved === true || (m.closeTime !== undefined && m.closeTime < Date.now());
  return {
    provider: "manifold",
    id: m.id,
    slug: m.slug,
    url: m.url ?? `https://manifold.markets/${m.creatorUsername ?? "m"}/${m.slug}`,
    question: m.question,
    description: m.textDescription || undefined,
    outcomes: [
      { label: "Yes", tokenId: tokenIdFor(m.id, "YES"), price: p },
      { label: "No", tokenId: tokenIdFor(m.id, "NO"), price: p !== undefined ? +(1 - p).toFixed(4) : undefined },
    ],
    liquidity: m.totalLiquidity,
    volume: m.volume,
    volume24h: m.volume24Hours,
    endDate: m.closeTime ? new Date(m.closeTime).toISOString() : undefined,
    startDate: m.createdTime ? new Date(m.createdTime).toISOString() : undefined,
    active: !closed,
    closed,
    restricted: false,
    resolved: m.isResolved === true || undefined,
    resolvedOutcome: m.resolution ? (m.resolution === "YES" ? "Yes" : m.resolution === "NO" ? "No" : m.resolution) : undefined,
    tags: [...(m.groupSlugs ?? []), ...(m.token ? [`token:${m.token.toLowerCase()}`] : [])],
    retrievedAt,
  };
}

export class ManifoldProvider implements MarketProvider {
  readonly id = "manifold" as const;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: ManifoldOptions = {}) {
    this.base = (opts.baseUrl ?? MANIFOLD_API).replace(/\/$/, "");
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
      if (!res.ok) throw new MarketApiError("manifold", res.status, text);
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async search(query: string, opts: { limit?: number; activeOnly?: boolean; signal?: AbortSignal } = {}): Promise<MarketSummary[]> {
    const q = new URLSearchParams({ term: query, limit: String(Math.min(Math.max(opts.limit ?? 10, 1), 100)), contractType: "BINARY" });
    if (opts.activeOnly !== false) q.set("filter", "open");
    const rows = await this.getJson<ManifoldMarket[]>(`${this.base}/search-markets?${q}`, opts.signal);
    const at = new Date().toISOString();
    return rows.filter((m) => m.outcomeType === "BINARY").map((m) => normalizeManifoldMarket(m, at));
  }

  async get(idOrSlug: string, signal?: AbortSignal): Promise<MarketSummary | undefined> {
    const path = /^[A-Za-z0-9]{8,}$/.test(idOrSlug) && !idOrSlug.includes("-") ? `/market/${idOrSlug}` : `/slug/${encodeURIComponent(idOrSlug)}`;
    try {
      const m = await this.getJson<ManifoldMarket>(`${this.base}${path}`, signal);
      return m.outcomeType === "BINARY" ? normalizeManifoldMarket(m) : undefined;
    } catch (err) {
      if (err instanceof MarketApiError && err.status === 404) return undefined;
      throw err;
    }
  }

  async list(opts: { tag?: string; limit?: number; offset?: number; activeOnly?: boolean; signal?: AbortSignal }): Promise<MarketSummary[]> {
    const q = new URLSearchParams({ term: opts.tag ?? "", limit: String(Math.min(opts.limit ?? 20, 100)), offset: String(opts.offset ?? 0), sort: "liquidity", contractType: "BINARY" });
    if (opts.activeOnly !== false) q.set("filter", "open");
    const rows = await this.getJson<ManifoldMarket[]>(`${this.base}/search-markets?${q}`, opts.signal);
    const at = new Date().toISOString();
    return rows.filter((m) => m.outcomeType === "BINARY").map((m) => normalizeManifoldMarket(m, at));
  }

  async book(tokenId: string, signal?: AbortSignal): Promise<OrderBookSnapshot> {
    const m = await this.getJson<ManifoldMarket>(`${this.base}/market/${encodeURIComponent(contractOf(tokenId))}`, signal);
    const p = typeof m.probability === "number" ? m.probability : undefined;
    const side = tokenId.endsWith(":NO") && p !== undefined ? 1 - p : p;
    return { provider: "manifold", tokenId, bids: [], asks: [], midpoint: side !== undefined ? +side.toFixed(4) : undefined, retrievedAt: new Date().toISOString() };
  }

  /** Bets carry `probAfter`; sample them into an ascending series for the requested side. */
  async priceHistory(tokenId: string, opts: { from: string; to: string; fidelityMinutes?: number; signal?: AbortSignal }): Promise<PricePoint[]> {
    const from = Date.parse(opts.from), to = Date.parse(opts.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
    const q = new URLSearchParams({ contractId: contractOf(tokenId), limit: "1000", afterTime: String(from), beforeTime: String(to) });
    const bets = await this.getJson<{ createdTime: number; probAfter?: number }[]>(`${this.base}/bets?${q}`, opts.signal);
    const no = tokenId.endsWith(":NO");
    return bets
      .filter((b) => typeof b.probAfter === "number")
      .map((b) => ({ t: new Date(b.createdTime).toISOString(), p: +(no ? 1 - b.probAfter! : b.probAfter!).toFixed(4) }))
      .sort((a, b) => a.t.localeCompare(b.t));
  }
}
