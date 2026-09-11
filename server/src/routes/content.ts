/**
 * Prediction Ledger — HTTP API routes for videos, predictions, plans, templates (Release 0.2).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Every body is Zod-validated. Long operations (extraction, plan generation) are enqueued
 * and return a job id the client polls via /api/jobs/:id.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PredictionFilters } from "@prediction-ledger/shared";
import type { AppContext } from "../context.js";
import { timeStatus } from "../analysis/dates.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const importSchema = z.object({
  title: z.string().max(300).default(""),
  content: z.string().min(1).max(20_000_000),
  format: z.enum(["srt", "vtt", "txt", "json", "auto"]).default("auto"),
  filename: z.string().max(300).optional(),
  publishedAt: isoDate.optional(),
  language: z.string().max(10).optional(),
});

const videoMetaSchema = z.object({
  title: z.string().max(300).optional(),
  publishedAt: isoDate.nullable().optional(),
  language: z.string().max(10).nullable().optional(),
});

const correctionSchema = z.object({ textCorrected: z.string().max(5000).nullable() });

const componentSchema = z.object({
  kind: z.enum(["future_claim", "premise", "causal_link"]),
  statement: z.string().min(1).max(2000),
  deadlineDate: isoDate.optional(),
  notes: z.string().max(2000).optional(),
});

const editSchema = z.object({
  normalizedStatement: z.string().min(1).max(2000).optional(),
  topic: z.string().max(200).optional(),
  geography: z.string().max(200).optional(),
  scope: z.string().max(500).optional(),
  speaker: z.string().max(200).optional(),
  madeOnDate: isoDate.or(z.literal("")).optional(),
  deadlineDate: isoDate.or(z.literal("")).optional(),
  conditions: z.array(z.string().max(500)).optional(),
  ambiguities: z.array(z.string().max(500)).optional(),
  components: z.array(componentSchema).min(1).optional(),
});

const mergeSchema = z.object({ sourceIds: z.array(z.string().uuid()).min(1) });
const splitSchema = z.object({ componentId: z.string().uuid() });

const planEditSchema = z.object({
  plan: z.record(z.unknown()),
  researchPrompt: z.string().min(20).max(50_000),
});

const templateSchema = z.object({ body: z.string().max(50_000).nullable() });

export function registerContentRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---- Videos ---------------------------------------------------------------
  app.get("/api/videos", async () => ctx.videos.list());

  app.post("/api/videos/import-transcript", async (req, reply) => {
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    try {
      const { video, warnings } = ctx.videos.importTranscript(parsed.data);
      return reply.code(201).send({ video, warnings });
    } catch (err) {
      return reply.code(422).send({ error: "import_failed", message: (err as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>("/api/videos/:id", async (req, reply) => {
    const v = ctx.videos.get(req.params.id);
    return v ?? reply.code(404).send({ error: "not_found" });
  });

  app.patch<{ Params: { id: string } }>("/api/videos/:id", async (req, reply) => {
    const parsed = videoMetaSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const v = ctx.videos.updateMeta(req.params.id, parsed.data);
    return v ?? reply.code(404).send({ error: "not_found" });
  });

  app.patch<{ Params: { id: string; segmentId: string } }>("/api/videos/:id/segments/:segmentId", async (req, reply) => {
    const parsed = correctionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const s = ctx.videos.correctSegment(req.params.id, req.params.segmentId, parsed.data.textCorrected);
    return s ?? reply.code(404).send({ error: "not_found" });
  });

  app.delete<{ Params: { id: string } }>("/api/videos/:id", async (req, reply) => {
    return ctx.videos.delete(req.params.id) ? { ok: true } : reply.code(404).send({ error: "not_found" });
  });

  app.post<{ Params: { id: string } }>("/api/videos/:id/extract", async (req, reply) => {
    const v = ctx.videos.get(req.params.id);
    if (!v) return reply.code(404).send({ error: "not_found" });
    if (v.segmentCount === 0) return reply.code(409).send({ error: "no_transcript", message: "This video has no transcript to analyse." });
    const jobId = ctx.jobs.enqueue({
      kind: "prediction.extract",
      subjectType: "video",
      subjectId: v.id,
      payload: { videoId: v.id },
      dedupeKey: `prediction.extract:${v.id}`,
      maxAttempts: 2,
    });
    return reply.code(202).send({ jobId });
  });

  // ---- Predictions ------------------------------------------------------------
  app.get("/api/predictions", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const filters: PredictionFilters = {
      videoId: q.videoId || undefined,
      topic: q.topic || undefined,
      userStatus: (q.userStatus as PredictionFilters["userStatus"]) || undefined,
      deadlineBefore: q.deadlineBefore || undefined,
      deadlineAfter: q.deadlineAfter || undefined,
      includeDismissed: q.includeDismissed === "1",
    };
    const today = new Date().toISOString().slice(0, 10);
    return ctx.predictions.list(filters).map((p) => ({ ...p, timeStatus: timeStatus(p.deadlineDate, today) }));
  });

  app.get("/api/predictions/topics", async () => ctx.predictions.topics());

  app.get<{ Params: { id: string } }>("/api/predictions/:id", async (req, reply) => {
    const p = ctx.predictions.get(req.params.id);
    if (!p) return reply.code(404).send({ error: "not_found" });
    return { ...p, timeStatus: timeStatus(p.deadlineDate), plans: ctx.plans.listForPrediction(p.id), revisions: ctx.predictions.revisions(p.id) };
  });

  app.patch<{ Params: { id: string } }>("/api/predictions/:id", async (req, reply) => {
    const parsed = editSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const p = ctx.predictions.edit(req.params.id, parsed.data);
    return p ?? reply.code(404).send({ error: "not_found" });
  });

  app.post<{ Params: { id: string } }>("/api/predictions/:id/accept", async (req, reply) => {
    const p = ctx.predictions.setStatus(req.params.id, "accepted");
    return p ?? reply.code(404).send({ error: "not_found" });
  });

  app.post<{ Params: { id: string } }>("/api/predictions/:id/dismiss", async (req, reply) => {
    const p = ctx.predictions.setStatus(req.params.id, "dismissed");
    return p ?? reply.code(404).send({ error: "not_found" });
  });

  app.post<{ Params: { id: string } }>("/api/predictions/:id/restore", async (req, reply) => {
    const p = ctx.predictions.setStatus(req.params.id, "pending");
    return p ?? reply.code(404).send({ error: "not_found" });
  });

  app.post<{ Params: { id: string } }>("/api/predictions/:id/merge", async (req, reply) => {
    const parsed = mergeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const p = ctx.predictions.merge(req.params.id, parsed.data.sourceIds);
    return p ?? reply.code(404).send({ error: "not_found" });
  });

  app.post<{ Params: { id: string } }>("/api/predictions/:id/split", async (req, reply) => {
    const parsed = splitSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    try {
      const r = ctx.predictions.split(req.params.id, parsed.data.componentId);
      return r ?? reply.code(404).send({ error: "not_found" });
    } catch (err) {
      return reply.code(409).send({ error: "cannot_split", message: (err as Error).message });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/predictions/:id", async (req, reply) => {
    return ctx.predictions.delete(req.params.id) ? { ok: true } : reply.code(404).send({ error: "not_found" });
  });

  // ---- Validation plans ---------------------------------------------------------
  app.post<{ Params: { id: string } }>("/api/predictions/:id/plan", async (req, reply) => {
    const p = ctx.predictions.get(req.params.id);
    if (!p) return reply.code(404).send({ error: "not_found" });
    const jobId = ctx.jobs.enqueue({
      kind: "plan.generate",
      subjectType: "prediction",
      subjectId: p.id,
      payload: { predictionId: p.id },
      dedupeKey: `plan.generate:${p.id}`,
      maxAttempts: 2,
    });
    return reply.code(202).send({ jobId });
  });

  app.get<{ Params: { id: string } }>("/api/predictions/:id/plans", async (req) => ctx.plans.listForPrediction(req.params.id));

  /** User edit → new immutable version. */
  app.post<{ Params: { id: string } }>("/api/predictions/:id/plans", async (req, reply) => {
    const parsed = planEditSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const p = ctx.predictions.get(req.params.id);
    if (!p) return reply.code(404).send({ error: "not_found" });
    const latest = ctx.plans.latest(p.id);
    const plan = ctx.plans.add({
      predictionId: p.id,
      plan: { ...(latest?.plan ?? {}), ...(parsed.data.plan as object) } as never,
      researchPrompt: parsed.data.researchPrompt,
      provider: "user",
      templateVersion: "user-edit",
      editedByUser: true,
    });
    return reply.code(201).send(plan);
  });

  // ---- Prompt templates -----------------------------------------------------------
  app.get("/api/templates", async () => [ctx.templates.info("extraction"), ctx.templates.info("plan")]);

  app.put<{ Params: { name: string } }>("/api/templates/:name", async (req, reply) => {
    if (req.params.name !== "extraction" && req.params.name !== "plan") return reply.code(404).send({ error: "not_found" });
    const parsed = templateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    return ctx.templates.setOverride(req.params.name, parsed.data.body);
  });
}
