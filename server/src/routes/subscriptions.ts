/**
 * Prediction Ledger — HTTP API routes for source subscriptions (1.11, SRC-01).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";

const budgetSchema = z.object({ maxSearches: z.number().int().min(1).max(50).optional(), maxSources: z.number().int().min(1).max(100).optional() }).strict();
const createSchema = z.object({
  url: z.string().min(10).max(500),
  title: z.string().max(200).optional(),
  enabled: z.boolean().optional(),
  pollIntervalHours: z.number().min(1).max(720).optional(),
  lookbackDays: z.number().int().min(0).max(3650).optional(),
  maxVideosPerRun: z.number().int().min(1).max(50).optional(),
  autoExtract: z.boolean().optional(),
  categoryAllowlist: z.array(z.string().max(60)).max(30).optional(),
  researchBudget: budgetSchema.optional(),
}).strict();
const patchSchema = z.object({
  title: z.string().max(200).optional(),
  enabled: z.boolean().optional(),
  pollIntervalHours: z.number().min(1).max(720).optional(),
  lookbackDays: z.number().int().min(0).max(3650).optional(),
  maxVideosPerRun: z.number().int().min(1).max(50).optional(),
  autoExtract: z.boolean().optional(),
  categoryAllowlist: z.array(z.string().max(60)).max(30).optional(),
  researchBudget: budgetSchema.nullable().optional(),
}).strict();

export function registerSubscriptionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/source-subscriptions", async () => ctx.subscriptions.list());

  app.post("/api/source-subscriptions", async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    try {
      return reply.code(201).send(ctx.subscriptions.create(parsed.data));
    } catch (err) {
      return reply.code(400).send({ error: "invalid_url", message: (err as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>("/api/source-subscriptions/:id", async (req, reply) => {
    const s = ctx.subscriptions.get(req.params.id);
    if (!s) return reply.code(404).send({ error: "not_found" });
    return { ...s, runs: ctx.subscriptions.runs(s.id) };
  });

  app.patch<{ Params: { id: string } }>("/api/source-subscriptions/:id", async (req, reply) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const s = ctx.subscriptions.update(req.params.id, { ...parsed.data, researchBudget: parsed.data.researchBudget === null ? undefined : parsed.data.researchBudget });
    return s ?? reply.code(404).send({ error: "not_found" });
  });

  app.delete<{ Params: { id: string } }>("/api/source-subscriptions/:id", async (req, reply) => {
    if (!ctx.subscriptions.delete(req.params.id)) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });

  /** Run now (even when disabled, as an explicit user action). Queues the poll job; imports follow as ordinary jobs. */
  app.post<{ Params: { id: string } }>("/api/source-subscriptions/:id/run", async (req, reply) => {
    const s = ctx.subscriptions.get(req.params.id);
    if (!s) return reply.code(404).send({ error: "not_found" });
    if (!ctx.settings.getPersisted().privacy.allowInternet) return reply.code(409).send({ error: "offline", message: "Internet access is disabled in Setup → Privacy; the channel cannot be listed." });
    const jobId = ctx.jobs.enqueue({ kind: "subscription.poll", subjectType: "subscription", subjectId: s.id, payload: { subscriptionId: s.id, force: true }, dedupeKey: `subscription.poll:${s.id}`, maxAttempts: 1 });
    return reply.code(202).send({ jobId });
  });
}
