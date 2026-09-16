/**
 * Prediction Ledger — HTTP API routes for research, evidence, assessments, and export (Release 0.3).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ExportBundle } from "@prediction-ledger/shared";
import { APP_VERSION } from "../config.js";
import type { AppContext } from "../context.js";
import { buildCsv } from "../services/export.js";
import { matchupKey } from "../analysis/sports.js";

const researchSchema = z.object({
  /** Research a specific plan version; defaults to the latest. */
  planId: z.string().uuid().optional(),
  /** Generate a plan first when none exists (auto-continue, VP-04). */
  autoPlan: z.boolean().default(true),
});

export function registerResearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * Start (or recheck) research for a prediction. Returns 409 with an actionable message when
   * research cannot run (no search provider, offline, no plan in review mode) — nothing is enqueued
   * in those cases, so the processing status stays "not researched" rather than "failed".
   */
  /**
   * Validate scores (1.3 → 1.4): one click settles a sports pick — and every other pick on the same
   * matchup — against a single game record (winner, score, date) looked up once. Refused only before a
   * known game date; an unknown date is resolved by the look-up itself.
   */
  app.post<{ Params: { id: string }; Body: { recheck?: boolean } }>("/api/predictions/:id/validate-score", async (req, reply) => {
    const p = ctx.predictions.get(req.params.id);
    if (!p) return reply.code(404).send({ error: "not_found" });
    if (p.kind !== "sports_pick" || !p.sportsPick) return reply.code(409).send({ error: "not_sports_pick", message: "Validate scores only applies to sports picks. Use Research for other predictions." });
    const s = ctx.settings.getPersisted();
    if (s.search.provider === "none") return reply.code(409).send({ error: "no_search_provider", message: "Choose a web search provider in Setup → Web search; the final score is looked up online." });
    if (!s.privacy.allowInternet) return reply.code(409).send({ error: "offline", message: "Internet access is disabled in Setup → Privacy; the final score cannot be looked up." });
    const today = new Date().toISOString().slice(0, 10);
    if (p.deadlineDate && p.deadlineDate > today) return reply.code(409).send({ error: "game_pending", message: `The game is on ${p.deadlineDate}; there is no final score to validate yet.` });
    const recheck = req.body?.recheck === true;
    const jobId = ctx.jobs.enqueue({ kind: "sports.resolve_game", subjectType: "prediction", subjectId: p.id, payload: { predictionId: p.id, recheck }, dedupeKey: `sports.resolve_game:${matchupKey(p.sportsPick)}`, maxAttempts: 1 });
    return reply.code(202).send({ jobId, stage: "game" });
  });

  /** 1.4 — Validate every sports pick of a video: one job per distinct matchup. */
  app.post<{ Params: { id: string }; Body: { recheck?: boolean } }>("/api/videos/:id/validate-scores", async (req, reply) => {
    const video = ctx.videos.get(req.params.id);
    if (!video) return reply.code(404).send({ error: "not_found" });
    const s = ctx.settings.getPersisted();
    if (s.search.provider === "none") return reply.code(409).send({ error: "no_search_provider", message: "Choose a web search provider in Setup → Web search; final scores are looked up online." });
    if (!s.privacy.allowInternet) return reply.code(409).send({ error: "offline", message: "Internet access is disabled in Setup → Privacy; final scores cannot be looked up." });
    const today = new Date().toISOString().slice(0, 10);
    const picks = ctx.predictions.list({ videoId: video.id, kind: "sports_pick" }).filter((p) => p.sportsPick && !(p.deadlineDate && p.deadlineDate > today));
    const seen = new Map<string, string>();
    for (const p of picks) {
      const key = matchupKey(p.sportsPick!);
      if (seen.has(key)) continue;
      const jobId = ctx.jobs.enqueue({ kind: "sports.resolve_game", subjectType: "prediction", subjectId: p.id, payload: { predictionId: p.id, recheck: req.body?.recheck === true }, dedupeKey: `sports.resolve_game:${key}`, maxAttempts: 1 });
      seen.set(key, jobId);
    }
    return reply.code(202).send({ jobs: [...seen.entries()].map(([matchup, jobId]) => ({ matchup, jobId })), picks: picks.length, skipped: ctx.predictions.list({ videoId: video.id, kind: "sports_pick" }).length - picks.length });
  });

  app.get("/api/games", async () => ctx.games.list());
  app.get<{ Params: { id: string } }>("/api/games/:id", async (req, reply) => {
    const g = ctx.games.get(req.params.id);
    if (!g) return reply.code(404).send({ error: "not_found" });
    return g;
  });

  app.post<{ Params: { id: string } }>("/api/predictions/:id/research", async (req, reply) => {
    const parsed = researchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const p = ctx.predictions.get(req.params.id);
    if (!p) return reply.code(404).send({ error: "not_found" });
    const s = ctx.settings.getPersisted();
    if (s.search.provider === "none") {
      return reply.code(409).send({ error: "no_search_provider", message: "Choose a web search provider in Setup → Web search. Research stays pending until then." });
    }
    if (!s.privacy.allowInternet) {
      return reply.code(409).send({ error: "offline", message: "Internet access is disabled in Setup → Privacy. Online research stays pending." });
    }
    const plan = parsed.data.planId ? ctx.plans.get(parsed.data.planId) : ctx.plans.latest(p.id);
    if (plan && plan.predictionId !== p.id) return reply.code(400).send({ error: "invalid_request", message: "Plan does not belong to this prediction." });

    if (!plan) {
      if (s.research.reviewPlanBeforeResearch || !parsed.data.autoPlan) {
        return reply.code(409).send({ error: "plan_required", message: "Generate and review the validation plan first (Setup → Research has 'review plan before research' on)." });
      }
      // Auto-continue: plan → research → assessment as a chain.
      const planJob = ctx.jobs.enqueue({ kind: "plan.generate", subjectType: "prediction", subjectId: p.id, payload: { predictionId: p.id, thenResearch: true }, dedupeKey: `plan.generate:${p.id}`, maxAttempts: 2 });
      return reply.code(202).send({ jobId: planJob, stage: "plan" });
    }
    const jobId = ctx.jobs.enqueue({
      kind: "research.run",
      subjectType: "prediction",
      subjectId: p.id,
      payload: { predictionId: p.id, planId: plan.id },
      dedupeKey: `research.run:${p.id}`,
      maxAttempts: 1,
    });
    return reply.code(202).send({ jobId, stage: "research", planVersion: plan.version });
  });

  app.get<{ Params: { id: string } }>("/api/predictions/:id/runs", async (req) => ctx.research.runsForPrediction(req.params.id));

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const run = ctx.research.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    return { ...run, evidence: ctx.research.evidenceForRun(run.id) };
  });

  app.get<{ Params: { id: string } }>("/api/predictions/:id/assessments", async (req) => ctx.research.assessmentsForPrediction(req.params.id));

  app.get<{ Params: { id: string } }>("/api/sources/:id", async (req, reply) => {
    const s = ctx.research.getSource(req.params.id);
    if (!s) return reply.code(404).send({ error: "not_found" });
    const text = ctx.research.sourceText(s);
    return { ...s, text: text?.slice(0, 200_000) };
  });

  // ---- Export (never includes settings or secrets) ----
  app.get("/api/export/json", async (_req, reply) => {
    const bundle: ExportBundle = {
      exportedAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      videos: ctx.videos.list(),
      predictions: ctx.predictions.list({ includeDismissed: true }),
      plans: ctx.predictions.list({ includeDismissed: true }).flatMap((p) => ctx.plans.listForPrediction(p.id)),
      runs: ctx.research.allRuns(),
      sources: ctx.research.allSources(),
      evidence: ctx.research.allEvidence(),
      assessments: ctx.research.allAssessments(),
      games: ctx.games.list(),
      markets: ctx.markets.list(),
      marketLinks: ctx.markets.allLinks(),
    };
    reply.header("content-disposition", `attachment; filename="prediction-ledger-export-${bundle.exportedAt.slice(0, 10)}.json"`);
    return bundle;
  });

  app.get("/api/export/csv", async (_req, reply) => {
    const csv = buildCsv(ctx);
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="prediction-ledger-${new Date().toISOString().slice(0, 10)}.csv"`);
    return csv;
  });
}
