/**
 * Prediction Ledger — Polymarket US retail market-data adapter (1.10, read-only discovery).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Public, unauthenticated host https://gateway.polymarket.us (verified live 2026-09-16):
 *   /v1/search?query=&limit=&status=active            events with nested markets (loose relevance)
 *   /v1/market/slug/{slug}, /v1/market/id/{id}         one market — rules in `description`, constraints inline
 *   /v1/markets?categories=&active=&limit=&offset=    listing;  /v2/leagues/{slug}/events  sports by league
 *   /v1/markets/{slug}/book                            { marketData: { bids[{px:{value},qty}], offers[], state } }
 *   /v1/price-history?symbol=&timestamp.*&fidelity=1  { history: [{ timestamp s, longPrice, shortPrice }] }
 *
 * This is a distinct venue from the international `polymarket` adapter (Gamma/CLOB): different hosts,
 * different ids, different rules text, USD-denominated. Records are stored under provider `polymarket_us`
 * and are the only ones that can ever reach the US execution adapter (ACC-01).
 *
 * Side orientation: the YES instrument is the market side whose `long` flag is true; NO is synthetic
 * (1 − YES). The deprecated `outcomes` array is NOT used for orientation — its order varies between
 * markets ("No","Yes" vs "Chargers","Titans"). Outcome token ids are synthetic `<slug>:YES` / `<slug>:NO`.
 */

import type { MarketContractConstraints } from "@prediction-ledger/shared";
import type { MarketProvider, MarketSummary, OrderBookSnapshot, PricePoint } from "./types.js";
import { MarketApiError } from "./types.js";

export const POLYMARKET_US_GATEWAY = "https://gateway.polymarket.us";
const MAX_HISTORY_DAYS = 30;

export interface PolymarketUsOptions { baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number }

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Raw) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const dec = (v: unknown): string | undefined => {
  if (typeof v === "string") return /^-?\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v.toFixed(8).replace(/\.?0+$/, "");
  return undefined;
};
const amountValue = (v: unknown): string | undefined => dec(obj(v)?.value);

export const usTokenId = (slug: string, side: "YES" | "NO") => `${slug}:${side}`;
export const usSlugOf = (tokenId: string) => tokenId.replace(/:(YES|NO)$/, "");
export const usSideOf = (tokenId: string): "YES" | "NO" => (tokenId.endsWith(":NO") ? "NO" : "YES");

/** Venue contract constraints as published, without defaults (a missing value stays missing). */
export function extractConstraints(m: Raw, event: Raw | undefined, retrievedAt: string): MarketContractConstraints {
  const sides = arr(m.marketSides).flatMap((s) => {
    const o = obj(s);
    const id = o && (str(o.id) ?? undefined);
    if (!o || !id) return [];
    const t = obj(o.team);
    const team = t && str(t.name) ? { id: t.id !== undefined ? String(t.id) : undefined, name: str(t.name)!, abbreviation: str(t.displayAbbreviation) ?? str(t.abbreviation), league: str(t.league), alias: str(t.alias) } : undefined;
    return [{ id, label: str(o.description) ?? (o.long === true ? "Yes" : "No"), long: o.long === true, tradable: typeof o.tradable === "boolean" ? o.tradable : undefined, ...(team ? { team } : {}) }];
  });
  return {
    venue: "polymarket_us",
    slug: str(m.slug) ?? "",
    status: str(m.status),
    tickSize: dec(m.orderPriceMinTickSize),
    minQuantity: dec(m.minimumTradeQty),
    feeCoefficient: dec(m.feeCoefficient),
    sides,
    category: str(m.category) ?? str(event?.category),
    sportsMarketType: str(m.sportsMarketTypeV2) ?? str(m.sportsMarketType),
    line: dec(m.line),
    gameStartTime: str(m.gameStartTime),
    eventStartTime: str(event?.startTime) ?? str(event?.startDate),
    eventId: event ? str(event.id) : undefined,
    bestBid: amountValue(m.bestBidQuote),
    bestAsk: amountValue(m.bestAskQuote),
    retrievedAt,
  };
}

/** Raw gateway market (+ its event when known) → MarketSummary. Prices are YES-denominated probabilities. */
export function normalizeUsMarket(m: Raw, event: Raw | undefined, retrievedAt = new Date().toISOString()): MarketSummary {
  const slug = str(m.slug) ?? String(m.id ?? "");
  const constraints = extractConstraints(m, event, retrievedAt);
  const yesSide = constraints.sides.find((s) => s.long);
  const noSide = constraints.sides.find((s) => !s.long);
  const bid = num(constraints.bestBid), ask = num(constraints.bestAsk);
  const yesPrice = bid !== undefined && ask !== undefined ? +((bid + ask) / 2).toFixed(4) : (ask ?? bid);
  const status = constraints.status ?? "";
  const closed = m.closed === true || /RESOLVED|CLOSED|SETTLED|EXPIRED/i.test(status);
  const resolved = /RESOLVED|SETTLED/i.test(status) || undefined;
  const eventSlug = event ? str(event.slug) : undefined;
  const question = str(m.question) ?? str(m.title) ?? slug;
  const title = str(m.title);
  return {
    provider: "polymarket_us",
    id: String(m.id ?? slug),
    slug,
    url: eventSlug ? `https://polymarket.us/event/${eventSlug}` : `${POLYMARKET_US_GATEWAY}/v1/market/slug/${encodeURIComponent(slug)}`,
    question: title && title !== question && !/^(yes|no)$/i.test(title) ? `${question} — ${title}` : question,
    description: str(m.description),
    event: event && str(event.id) ? { id: String(event.id), slug: eventSlug ?? "", title: str(event.title) ?? "" } : undefined,
    outcomes: [
      { label: yesSide?.label ?? "Yes", tokenId: usTokenId(slug, "YES"), price: yesPrice, bestBid: bid, bestAsk: ask },
      { label: noSide?.label ?? "No", tokenId: usTokenId(slug, "NO"), price: yesPrice !== undefined ? +(1 - yesPrice).toFixed(4) : undefined, bestBid: ask !== undefined ? +(1 - ask).toFixed(4) : undefined, bestAsk: bid !== undefined ? +(1 - bid).toFixed(4) : undefined },
    ],
    volume: num(m.volume),
    volume24h: num(m.volume24hr),
    endDate: str(m.endDate),
    startDate: str(m.startDate),
    active: m.active === true && !closed,
    closed,
    restricted: false,
    resolved,
    tags: [...new Set([...(constraints.category ? [constraints.category] : []), ...arr(m.tags).map((t) => str(obj(t)?.slug)).filter((x): x is string => !!x), "currency:usd"])],
    retrievedAt,
    constraints,
  };
}

export class PolymarketUsProvider implements MarketProvider {
  readonly id = "polymarket_us" as const;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: PolymarketUsOptions = {}) {
    this.base = (opts.baseUrl ?? POLYMARKET_US_GATEWAY).replace(/\/$/, "");
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
      if (!res.ok) throw new MarketApiError("polymarket_us", res.status, text);
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private flattenEvents(events: unknown[], at: string): MarketSummary[] {
    return events.flatMap((e) => {
      const ev = obj(e);
      return ev ? arr(ev.markets).flatMap((m) => (obj(m) ? [normalizeUsMarket(obj(m)!, ev, at)] : [])) : [];
    });
  }

  async search(query: string, opts: { limit?: number; activeOnly?: boolean; signal?: AbortSignal } = {}): Promise<MarketSummary[]> {
    const q = new URLSearchParams({ query, limit: String(Math.min(Math.max(opts.limit ?? 10, 1), 50)) });
    if (opts.activeOnly !== false) q.set("status", "active");
    const res = await this.getJson<Raw>(`${this.base}/v1/search?${q}`, opts.signal);
    const at = new Date().toISOString();
    const out = this.flattenEvents(arr(res.events), at);
    return opts.activeOnly === false ? out : out.filter((m) => !m.closed);
  }

  async get(idOrSlug: string, signal?: AbortSignal): Promise<MarketSummary | undefined> {
    const path = /^\d+$/.test(idOrSlug) ? `/v1/market/id/${idOrSlug}` : `/v1/market/slug/${encodeURIComponent(usSlugOf(idOrSlug))}`;
    try {
      const res = await this.getJson<Raw>(`${this.base}${path}`, signal);
      const m = obj(res.market);
      return m ? normalizeUsMarket(m, undefined) : undefined;
    } catch (err) {
      if (err instanceof MarketApiError && err.status === 404) return undefined;
      throw err;
    }
  }

  /** 1.11 (MAT-01): every market under one event slug — what a pasted polymarket.us/event/<slug> URL points at. */
  async eventMarkets(eventSlug: string, signal?: AbortSignal): Promise<MarketSummary[]> {
    const q = new URLSearchParams({ slug: eventSlug, limit: "1" });
    const res = await this.getJson<Raw>(`${this.base}/v1/events?${q}`, signal);
    return this.flattenEvents(arr(res.events), new Date().toISOString());
  }

  async list(opts: { tag?: string; limit?: number; offset?: number; activeOnly?: boolean; signal?: AbortSignal }): Promise<MarketSummary[]> {
    const limit = Math.min(opts.limit ?? 20, 100);
    const at = new Date().toISOString();
    if (opts.tag && /^[a-z0-9-]+$/i.test(opts.tag)) {
      // Sports leagues (nfl, nba, …) answer on the v2 league endpoint with nested markets; anything else falls through to categories.
      try {
        const res = await this.getJson<Raw>(`${this.base}/v2/leagues/${encodeURIComponent(opts.tag.toLowerCase())}/events?limit=${limit}`, opts.signal);
        const flat = this.flattenEvents(arr(res.events), at);
        if (flat.length) return (opts.activeOnly === false ? flat : flat.filter((m) => !m.closed)).slice(0, limit);
      } catch (err) {
        if (!(err instanceof MarketApiError && err.status === 404)) throw err;
      }
    }
    const q = new URLSearchParams({ limit: String(limit), offset: String(opts.offset ?? 0) });
    if (opts.activeOnly !== false) { q.set("active", "true"); q.set("closed", "false"); }
    if (opts.tag) q.append("categories", opts.tag.toLowerCase());
    const res = await this.getJson<Raw>(`${this.base}/v1/markets?${q}`, opts.signal);
    return arr(res.markets).flatMap((m) => (obj(m) ? [normalizeUsMarket(obj(m)!, undefined, at)] : []));
  }

  async book(tokenId: string, signal?: AbortSignal): Promise<OrderBookSnapshot> {
    const slug = usSlugOf(tokenId);
    const res = await this.getJson<Raw>(`${this.base}/v1/markets/${encodeURIComponent(slug)}/book`, signal);
    const data = obj(res.marketData) ?? res;
    const level = (v: unknown) => {
      const o = obj(v);
      const price = num(obj(o?.px)?.value), size = num(o?.qty);
      return price !== undefined && size !== undefined ? [{ price, size }] : [];
    };
    const yesBids = arr(data.bids).flatMap(level), yesAsks = arr(data.offers).flatMap(level);
    const no = usSideOf(tokenId) === "NO";
    // NO book is the mirror of the YES book: a YES ask at p is a NO bid at 1 − p.
    const bids = no ? yesAsks.map((l) => ({ price: +(1 - l.price).toFixed(4), size: l.size })) : yesBids;
    const asks = no ? yesBids.map((l) => ({ price: +(1 - l.price).toFixed(4), size: l.size })) : yesAsks;
    const best = (xs: { price: number }[], pick: "max" | "min") => (xs.length ? (pick === "max" ? Math.max(...xs.map((x) => x.price)) : Math.min(...xs.map((x) => x.price))) : undefined);
    const bb = best(bids, "max"), ba = best(asks, "min");
    return { provider: "polymarket_us", tokenId, bids, asks, midpoint: bb !== undefined && ba !== undefined ? +((bb + ba) / 2).toFixed(4) : (ba ?? bb), retrievedAt: new Date().toISOString() };
  }

  /** Timestamp ranges require fidelity=1 (verified live: other values return an empty history). Ranges are capped at 30 days. */
  async priceHistory(tokenId: string, opts: { from: string; to: string; fidelityMinutes?: number; signal?: AbortSignal }): Promise<PricePoint[]> {
    const from = Date.parse(opts.from), to = Date.parse(opts.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
    const start = Math.max(from, to - MAX_HISTORY_DAYS * 86_400_000);
    const q = new URLSearchParams({ symbol: usSlugOf(tokenId), "timestamp.startTimestamp": String(Math.floor(start / 1000)), "timestamp.endTimestamp": String(Math.floor(to / 1000)), fidelity: "1" });
    const res = await this.getJson<Raw>(`${this.base}/v1/price-history?${q}`, opts.signal);
    const no = usSideOf(tokenId) === "NO";
    return arr(res.history)
      .flatMap((h) => {
        const o = obj(h);
        const ts = num(o?.timestamp), p = num(no ? o?.shortPrice : o?.longPrice);
        return o && ts !== undefined && p !== undefined ? [{ t: new Date(ts * 1000).toISOString(), p: +p.toFixed(4) }] : [];
      })
      .sort((a, b) => a.t.localeCompare(b.t));
  }
}
