/**
 * Prediction Ledger — HTTP API routes for prediction markets (1.5, read-only).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Thin pass-through to the MarketProvider so the dashboard (and curl) can look at what a market
 * says about a question. Nothing is stored yet — that is 1.6. Honours Setup → Privacy → internet.
 */

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { z } from "zod";
import { MarketApiError, type MarketProvider } from "../providers/markets/types.js";
import { createMarketProvider, isMarketProviderId } from "../providers/markets/registry.js";
import { stakeFor } from "../services/paper.js";

/** Accept an id, a slug, or a venue URL (polymarket.com/event/<slug>, manifold.markets/<user>/<slug>). */
export function marketKeyFromInput(input: string): string {
  const t = input.trim();
  const pm = /^https?:\/\/(www\.)?polymarket\.com\/(event|market)\/([^?#/]+)/i.exec(t);
  if (pm) return pm[3];
  const mf = /^https?:\/\/(www\.)?manifold\.markets\/[^/?#]+\/([^?#/]+)/i.exec(t);
  if (mf) return mf[2];
  // Polymarket US event pages (1.10): the slug is the event's; the provider resolves markets under it.
  const us = /^https?:\/\/(www\.)?polymarket\.us\/event\/([^?#/]+)/i.exec(t);
  if (us) return us[2];
  return t.split(/[?#/]/)[0];
}

export function registerMarketRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, providerId: string): MarketProvider | undefined => {
    const s = ctx.settings.getPersisted();
    if (!s.markets.enabled) {
      reply.code(409).send({ error: "markets_disabled", message: "Prediction markets are turned off in Setup → Markets." });
      return undefined;
    }
    if (!s.privacy.allowInternet) {
      reply.code(409).send({ error: "offline", message: "Internet access is disabled in Setup → Privacy; market data cannot be fetched." });
      return undefined;
    }
    if (!isMarketProviderId(providerId)) {
      reply.code(404).send({ error: "unknown_provider", message: `No market provider "${providerId}".` });
      return undefined;
    }
    return createMarketProvider(providerId);
  };
  const wrap = async <T>(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MarketApiError) return reply.code(502).send({ error: "market_api", message: err.message });
      return reply.code(502).send({ error: "market_api", message: (err as Error).message });
    }
  };

  app.get<{ Querystring: { q?: string; provider?: string; limit?: string; all?: string } }>("/api/markets/search", async (req, reply) => {
    const provider = guard(reply, req.query.provider ?? "polymarket");
    if (!provider) return;
    const q = (req.query.q ?? "").trim();
    if (q.length < 2) return reply.code(400).send({ error: "invalid_request", message: "q must be at least 2 characters." });
    return wrap(reply, () => provider.search(q, { limit: Number(req.query.limit ?? 10), activeOnly: req.query.all !== "1" }));
  });

  app.get<{ Querystring: { provider?: string; tag?: string; limit?: string; offset?: string } }>("/api/markets", async (req, reply) => {
    const provider = guard(reply, req.query.provider ?? "polymarket");
    if (!provider) return;
    return wrap(reply, () => provider.list({ tag: req.query.tag, limit: Number(req.query.limit ?? 20), offset: Number(req.query.offset ?? 0) }));
  });

  app.get<{ Params: { provider: string; id: string } }>("/api/markets/:provider/market/:id", async (req, reply) => {
    const provider = guard(reply, req.params.provider);
    if (!provider) return;
    return wrap(reply, async () => (await provider.get(req.params.id)) ?? reply.code(404).send({ error: "not_found" }));
  });

  app.get<{ Params: { provider: string; tokenId: string } }>("/api/markets/:provider/book/:tokenId", async (req, reply) => {
    const provider = guard(reply, req.params.provider);
    if (!provider) return;
    if (!/^[0-9a-zA-Z_-]{1,120}$/.test(req.params.tokenId)) return reply.code(400).send({ error: "invalid_request", message: "Bad token id." });
    return wrap(reply, () => provider.book(req.params.tokenId));
  });

  // ---- 1.6 — stored markets, snapshots, links ----

  app.get("/api/markets/stored", async () => ctx.markets.list());
  app.get<{ Params: { id: string } }>("/api/markets/stored/:id", async (req, reply) => {
    const m = ctx.markets.get(req.params.id);
    if (!m) return reply.code(404).send({ error: "not_found" });
    return { ...m, snapshots: ctx.markets.snapshots(m.id, 100), links: ctx.markets.linksForMarket(m.id) };
  });

  const watchSchema = z.object({ provider: z.enum(["polymarket", "manifold"]).default("polymarket"), idOrSlug: z.string().min(1).max(300) });
  /** Store a market and keep it refreshed. */
  app.post("/api/markets/watch", async (req, reply) => {
    const parsed = watchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const provider = guard(reply, parsed.data.provider);
    if (!provider) return;
    return wrap(reply, async () => {
      const key = marketKeyFromInput(parsed.data.idOrSlug);
      const s = await provider.get(key);
      if (!s) return reply.code(404).send({ error: "not_found", message: `No market "${parsed.data.idOrSlug}" at ${parsed.data.provider}.` });
      return reply.code(201).send(ctx.markets.upsertFromSummary(s, { watched: true }));
    });
  });
  app.post<{ Params: { id: string } }>("/api/markets/stored/:id/unwatch", async (req, reply) => {
    const m = ctx.markets.setWatched(req.params.id, false);
    return m ?? reply.code(404).send({ error: "not_found" });
  });
  app.delete<{ Params: { id: string } }>("/api/markets/stored/:id", async (req, reply) => (ctx.markets.delete(req.params.id) ? { ok: true } : reply.code(404).send({ error: "not_found" })));

  /** Refresh snapshots now (all refreshable markets, or the given ids). */
  app.post<{ Body: { marketIds?: string[] } }>("/api/markets/snapshot", async (req, reply) => {
    if (!guard(reply, "polymarket")) return;
    const ids = Array.isArray(req.body?.marketIds) ? req.body!.marketIds!.filter((x) => typeof x === "string").slice(0, 200) : undefined;
    const jobId = ctx.jobs.enqueue({ kind: "market.snapshot", subjectType: "market", subjectId: ids ? ids.join(",").slice(0, 200) : "all", payload: ids ? { marketIds: ids } : {}, dedupeKey: ids ? undefined : "market.snapshot:all", maxAttempts: 1 });
    return reply.code(202).send({ jobId });
  });

  // ---- links ----
  app.get<{ Params: { id: string } }>("/api/predictions/:id/market-links", async (req, reply) => {
    if (!ctx.predictions.get(req.params.id)) return reply.code(404).send({ error: "not_found" });
    return ctx.markets.linksForPrediction(req.params.id);
  });
  /** Find candidate markets for a prediction (proposals; exact sports matchups may auto-accept). */
  app.post<{ Params: { id: string }; Body: { limit?: number } }>("/api/predictions/:id/market-links/match", async (req, reply) => {
    const p = ctx.predictions.get(req.params.id);
    if (!p) return reply.code(404).send({ error: "not_found" });
    if (!guard(reply, "polymarket")) return;
    const jobId = ctx.jobs.enqueue({ kind: "market.match", subjectType: "prediction", subjectId: p.id, payload: { predictionId: p.id, limit: Math.min(Math.max(Number(req.body?.limit ?? 5), 1), 10) }, dedupeKey: `market.match:${p.id}`, maxAttempts: 1 });
    return reply.code(202).send({ jobId });
  });
  const manualSchema = z.object({ provider: z.enum(["polymarket", "manifold"]).default("polymarket"), idOrSlug: z.string().min(1).max(300), side: z.string().max(80).optional() });
  /** Link a market by hand (stored, accepted, matched_by user). */
  app.post<{ Params: { id: string } }>("/api/predictions/:id/market-links", async (req, reply) => {
    const p = ctx.predictions.get(req.params.id);
    if (!p) return reply.code(404).send({ error: "not_found" });
    const parsed = manualSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const provider = guard(reply, parsed.data.provider);
    if (!provider) return;
    return wrap(reply, async () => {
      const key = marketKeyFromInput(parsed.data.idOrSlug);
      const s = await provider.get(key);
      if (!s) return reply.code(404).send({ error: "not_found", message: `No market "${parsed.data.idOrSlug}".` });
      const m = ctx.markets.upsertFromSummary(s);
      const link = ctx.markets.propose({ predictionId: p.id, marketId: m.id, side: parsed.data.side, score: 1, relation: "same", rationale: "Linked by the user.", matchedBy: "user", status: "accepted" });
      return reply.code(201).send(ctx.markets.setLinkStatus(link.id, "accepted", parsed.data.side));
    });
  });
  app.post<{ Params: { id: string }; Body: { side?: string } }>("/api/market-links/:id/accept", async (req, reply) => {
    const l = ctx.markets.setLinkStatus(req.params.id, "accepted", typeof req.body?.side === "string" ? req.body.side : undefined);
    if (!l) return reply.code(404).send({ error: "not_found" });
    // 1.7: an accepted link gets its made-on price from venue history (best effort, in the background).
    const s = ctx.settings.getPersisted();
    if (s.markets.enabled && s.privacy.allowInternet && l.priceAtMadeSource !== "history") {
      ctx.jobs.enqueue({ kind: "market.backfill", subjectType: "prediction", subjectId: l.predictionId, payload: { linkId: l.id }, dedupeKey: `market.backfill:${l.id}`, maxAttempts: 1 });
    }
    return l;
  });
  app.post<{ Params: { id: string } }>("/api/market-links/:id/backfill", async (req, reply) => {
    const l = ctx.markets.getLink(req.params.id);
    if (!l) return reply.code(404).send({ error: "not_found" });
    if (!guard(reply, "polymarket")) return;
    const jobId = ctx.jobs.enqueue({ kind: "market.backfill", subjectType: "prediction", subjectId: l.predictionId, payload: { linkId: l.id }, dedupeKey: `market.backfill:${l.id}`, maxAttempts: 1 });
    return reply.code(202).send({ jobId });
  });
  app.post("/api/markets/backfill", async (_req, reply) => {
    if (!guard(reply, "polymarket")) return;
    const jobId = ctx.jobs.enqueue({ kind: "market.backfill", subjectType: "market", subjectId: "all", payload: {}, dedupeKey: "market.backfill:all", maxAttempts: 1 });
    return reply.code(202).send({ jobId });
  });

  // ---- 1.7 — signals (computed on read; nothing stored) ----
  app.get<{ Querystring: { includeSettled?: string } }>("/api/signals", async (req) => {
    const gates = ctx.settings.getPersisted().markets.signals;
    return { gates, creators: ctx.signals.creators(gates), signals: ctx.signals.signals(gates, { includeSettled: req.query.includeSettled === "1" }) };
  });
  app.get("/api/signals/creators", async () => ctx.signals.creators(ctx.settings.getPersisted().markets.signals));

  // ---- 1.8 — consensus, alerts, watch ----
  app.get<{ Querystring: { includeSettled?: string } }>("/api/consensus", async (req) => ctx.consensus.propositions(ctx.settings.getPersisted().markets.signals, { includeSettled: req.query.includeSettled === "1" }));
  app.get<{ Querystring: { includeDismissed?: string } }>("/api/alerts", async (req) => ({ open: ctx.alerts.openCount(), alerts: ctx.alerts.list({ includeDismissed: req.query.includeDismissed === "1" }) }));
  app.post<{ Body: { ids?: string[] } }>("/api/alerts/seen", async (req) => { ctx.alerts.markSeen(Array.isArray(req.body?.ids) ? req.body!.ids!.filter((x) => typeof x === "string").slice(0, 500) : []); return { ok: true }; });
  app.post<{ Params: { id: string } }>("/api/alerts/:id/dismiss", async (req, reply) => ctx.alerts.dismiss(req.params.id) ?? reply.code(404).send({ error: "not_found" }));
  app.post("/api/alerts/dismiss-all", async () => ({ dismissed: ctx.alerts.dismissAll() }));
  // ---- 1.9 — paper trading (hypothetical; never an order) ----
  app.get("/api/paper", async () => {
    const cfg = ctx.settings.getPersisted().markets.paper;
    if (cfg.enabled) ctx.paper.markAll();
    return { book: ctx.paper.book({ enabled: cfg.enabled, bankroll: cfg.bankroll }), positions: ctx.paper.list(), sizing: cfg };
  });
  const openSchema = z.object({ marketId: z.string().min(1), side: z.string().min(1).max(80), stake: z.number().positive().optional(), notes: z.string().max(500).optional(), predictionIds: z.array(z.string()).max(50).optional() });
  app.post("/api/paper/positions", async (req, reply) => {
    const parsed = openSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const cfg = ctx.settings.getPersisted().markets.paper;
    if (!cfg.enabled) return reply.code(409).send({ error: "paper_disabled", message: "Paper trading is turned off in Setup → Prediction markets." });
    const m = ctx.markets.get(parsed.data.marketId);
    if (!m) return reply.code(404).send({ error: "not_found", message: "Market is not in the ledger." });
    const price = m.latest?.prices.find((x) => x.label === parsed.data.side)?.price;
    if (price === undefined) return reply.code(409).send({ error: "no_price", message: `No snapshot price for side "${parsed.data.side}"; refresh the market first.` });
    if (ctx.paper.openOn(m.id, parsed.data.side)) return reply.code(409).send({ error: "already_open", message: "A paper position on this side is already open." });
    const book = ctx.paper.book({ enabled: true, bankroll: cfg.bankroll });
    if (book.openCount >= cfg.maxOpenPositions) return reply.code(409).send({ error: "max_open", message: `Max open paper positions (${cfg.maxOpenPositions}) reached.` });
    const sig = ctx.signals.signals(ctx.settings.getPersisted().markets.signals).find((x) => x.marketId === m.id && x.side === parsed.data.side);
    const sized = parsed.data.stake !== undefined ? { stake: parsed.data.stake, note: "stake set by hand" } : stakeFor(cfg, book.bankroll, price, sig?.estimate);
    if (sized.stake <= 0) return reply.code(409).send({ error: "no_stake", message: sized.note });
    try {
      const pos = ctx.paper.open({ marketId: m.id, side: parsed.data.side, price, stake: sized.stake, source: sig ? "signal" : "manual", edge: sig?.edge, estimate: sig?.estimate, confidence: sig?.confidence, predictionIds: parsed.data.predictionIds ?? sig?.contributions.map((c) => c.predictionId), notes: parsed.data.notes ?? sized.note });
      return reply.code(201).send(pos);
    } catch (err) {
      return reply.code(400).send({ error: "invalid_request", message: (err as Error).message });
    }
  });
  app.post<{ Params: { id: string }; Body: { price?: number } }>("/api/paper/positions/:id/close", async (req, reply) => {
    const p = ctx.paper.get(req.params.id);
    if (!p) return reply.code(404).send({ error: "not_found" });
    if (p.status === "closed") return p;
    const price = typeof req.body?.price === "number" ? req.body.price : p.currentPrice ?? p.openedPrice;
    if (!(price >= 0 && price <= 1)) return reply.code(400).send({ error: "invalid_request", message: "price must be 0–1" });
    return ctx.paper.close(p.id, price, "manual");
  });
  app.delete<{ Params: { id: string } }>("/api/paper/positions/:id", async (req, reply) => (ctx.paper.delete(req.params.id) ? { ok: true } : reply.code(404).send({ error: "not_found" })));
  app.post("/api/paper/mark", async () => ctx.paper.markAll());
  app.post("/api/paper/reset", async () => ({ deleted: ctx.paper.reset() }));

  app.post("/api/markets/watch-run", async (_req, reply) => {
    const jobId = ctx.jobs.enqueue({ kind: "market.watch", subjectType: "market", subjectId: "all", payload: {}, dedupeKey: "market.watch:all", maxAttempts: 1 });
    return reply.code(202).send({ jobId });
  });
  app.post<{ Params: { id: string } }>("/api/market-links/:id/reject", async (req, reply) => ctx.markets.setLinkStatus(req.params.id, "rejected") ?? reply.code(404).send({ error: "not_found" }));
  app.delete<{ Params: { id: string } }>("/api/market-links/:id", async (req, reply) => (ctx.markets.deleteLink(req.params.id) ? { ok: true } : reply.code(404).send({ error: "not_found" })));
}
