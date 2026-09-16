/**
 * Prediction Ledger — HTTP API routes for forecasts, paper decisions and the US paper book (1.12).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * A decision request names a prediction (and optionally a link); it never carries a price, a side or a budget —
 * those come from the stored forecast, the verified contract and the policy (RSK-04: no client budget override).
 * Nothing here can reach the venue's order API: a manual-live decision stops at `needs_review`, and the only order path is
 * routes/execution.ts (preview → confirm, 1.13).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { DecisionError } from "../services/tradeDecisions.js";
import { buildDossier } from "../services/dossier.js";

const decisionSchema = z.object({
  predictionId: z.string().uuid(),
  linkId: z.string().uuid().optional(),
  /** May lower the quantity; never raises it (R03). */
  candidateQuantity: z.string().regex(/^\d+(\.\d{1,8})?$/).optional(),
  /** Evaluate only (no paper dispatch). */
  dryRun: z.boolean().optional(),
}).strict();

const forecastSchema = z.object({ predictionId: z.string().uuid(), linkId: z.string().uuid().optional() }).strict();

function decisionError(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) {
  if (err instanceof DecisionError) return reply.code(err.httpStatus).send({ error: err.code, message: err.message });
  return reply.code(500).send({ error: "decision_failed", message: (err as Error).message });
}

export function registerDecisionRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---- forecasts (FOR-01…06) ----
  app.post("/api/forecasts", async (req, reply) => {
    const parsed = forecastSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const link = parsed.data.linkId ? ctx.markets.getLink(parsed.data.linkId) : ctx.markets.executableLinks(parsed.data.predictionId)[0];
    if (!link || link.predictionId !== parsed.data.predictionId) return reply.code(409).send({ error: "no_link", message: "No verified Polymarket US link for this prediction." });
    const market = ctx.markets.get(link.marketId);
    if (!market) return reply.code(404).send({ error: "not_found" });
    let book;
    try { book = await ctx.decisions.fetchBook(market); } catch { book = undefined; }
    try {
      return reply.code(201).send(ctx.forecasts.build({ predictionId: parsed.data.predictionId, linkId: link.id, book }));
    } catch (err) {
      return reply.code(409).send({ error: "forecast_failed", message: (err as Error).message });
    }
  });
  // Static path registered before the parametric one (find-my-way prefers static anyway; order keeps simpler routers honest).
  app.get<{ Querystring: { strategy?: string; category?: string } }>("/api/forecasts/evaluation", async (req) => ctx.forecasts.evaluate({ strategyVersion: req.query.strategy, category: req.query.category }));
  app.get<{ Params: { id: string } }>("/api/forecasts/:id", async (req, reply) => ctx.forecasts.get(req.params.id) ?? reply.code(404).send({ error: "not_found" }));
  app.get<{ Params: { id: string } }>("/api/predictions/:id/forecasts", async (req) => ctx.forecasts.forPrediction(req.params.id));

  // ---- decisions (RSK-01…07; paper dispatch only) ----
  app.post("/api/trading/decisions", async (req, reply) => {
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    try {
      const d = await ctx.decisions.evaluate({ predictionId: parsed.data.predictionId, linkId: parsed.data.linkId, candidateQuantity: parsed.data.candidateQuantity, dispatch: !parsed.data.dryRun });
      return reply.code(201).send(d);
    } catch (err) {
      return decisionError(reply, err);
    }
  });
  app.get<{ Querystring: { mode?: string; outcome?: string; from?: string; to?: string; predictionId?: string; limit?: string } }>("/api/trading/decisions", async (req) => {
    const q = req.query;
    return ctx.decisions.list({ mode: q.mode as never, outcome: q.outcome as never, from: q.from, to: q.to, predictionId: q.predictionId, limit: Math.min(Number(q.limit ?? 200) || 200, 1000) });
  });
  app.get<{ Params: { id: string } }>("/api/trading/decisions/:id", async (req, reply) => ctx.decisions.get(req.params.id) ?? reply.code(404).send({ error: "not_found" }));
  /** "Why this trade?" — the immutable decision, its forecast, the verification and the evidence dossier (DASH-03 scaffold). */
  app.get<{ Params: { id: string } }>("/api/trading/decisions/:id/evidence", async (req, reply) => {
    const d = ctx.decisions.get(req.params.id);
    if (!d) return reply.code(404).send({ error: "not_found" });
    return {
      decision: d,
      forecast: d.forecastId ? ctx.forecasts.get(d.forecastId) : undefined,
      verification: d.verificationId ? ctx.markets.getVerification(d.verificationId) : undefined,
      dossier: buildDossier(ctx, d.predictionId, { asOf: d.clockAt }),
      reservation: d.reservationId ? ctx.risk.get(d.reservationId) : undefined,
    };
  });
  app.get("/api/trading/exposure", async () => { const p = ctx.trading.policy(); const now = new Date().toISOString(); const { marketsOpen: _m, ...e } = ctx.risk.exposure("paper", now.slice(0, 10)); return { ...e, limits: p.limits }; });

  // ---- US paper book (FOR-08) ----
  app.get("/api/paper/us", async () => ctx.paperUs.book());
  app.put("/api/paper/us/bankroll", async (req, reply) => {
    const parsed = z.object({ bankrollStart: z.string().regex(/^\d+(\.\d{1,2})?$/) }).strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    ctx.paperUs.setBankrollStart(parsed.data.bankrollStart);
    return ctx.paperUs.book();
  });
  app.post("/api/paper/us/reset", async () => ({ deleted: ctx.paperUs.reset(new Date().toISOString()) }));
  app.post<{ Params: { id: string } }>("/api/markets/stored/:id/settle-paper", async (req, reply) => {
    const m = ctx.markets.get(req.params.id);
    if (!m) return reply.code(404).send({ error: "not_found" });
    return { settled: ctx.decisions.settleResolved(m.id) };
  });
}
