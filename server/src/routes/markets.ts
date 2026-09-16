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
import { MarketApiError, type MarketProvider } from "../providers/markets/types.js";
import { PolymarketProvider } from "../providers/markets/polymarket.js";

export function registerMarketRoutes(app: FastifyInstance, ctx: AppContext, providers: Record<string, MarketProvider> = { polymarket: new PolymarketProvider() }): void {
  const guard = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, providerId: string): MarketProvider | undefined => {
    if (!ctx.settings.getPersisted().privacy.allowInternet) {
      reply.code(409).send({ error: "offline", message: "Internet access is disabled in Setup → Privacy; market data cannot be fetched." });
      return undefined;
    }
    const p = providers[providerId];
    if (!p) reply.code(404).send({ error: "unknown_provider", message: `No market provider "${providerId}".` });
    return p;
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
}
