/**
 * Prediction Ledger — HTTP API routes for automation controls, the Trades ledger and alerts (1.14, AUTO-01…05, DASH-01…05, OPS-04).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Arming needs the exact acknowledgement AND the policy hash the owner reviewed; a bare mode switch never arms
 * automation. Emergency stop is one server-side statement followed by targeted cancels of app-owned orders only;
 * the account-wide cancel is a separate route with its own acknowledgement. Every body is `.strict()`; the CSRF
 * guard from index.ts applies.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { executionError } from "./execution.js";
import { TradingGateError } from "../services/tradingAccounts.js";

const armSchema = z.object({ acknowledge: z.string().max(200), policyHash: z.string().regex(/^[0-9a-f]{64}$/), category: z.string().min(1).max(64), strategyVersion: z.string().min(1).max(64).optional() }).strict();
const pauseSchema = z.object({ reason: z.string().min(1).max(300) }).strict();
const stopSchema = z.object({ reason: z.string().min(1).max(300).optional() }).strict();
const cancelAllSchema = z.object({ acknowledge: z.string().max(200) }).strict();
const automationSchema = z.object({
  intervalMs: z.number().int().min(5_000).max(3_600_000).optional(),
  maxEvaluationsPerTick: z.number().int().min(0).max(200).optional(),
  maxOrdersPerTick: z.number().int().min(0).max(20).optional(),
  maxPerSourcePerTick: z.number().int().min(0).max(50).optional(),
  maxMatchJobsPerTick: z.number().int().min(0).max(50).optional(),
  maxVerificationsPerTick: z.number().int().min(0).max(50).optional(),
  minReevaluateMs: z.number().int().min(0).max(86_400_000).optional(),
  revalidateAfterMs: z.number().int().min(60_000).max(86_400_000).optional(),
  breakerThreshold: z.number().int().min(1).max(100).optional(),
  breakerCooldownMs: z.number().int().min(1_000).max(86_400_000).optional(),
  paperAutopilot: z.boolean().optional(),
}).strict();

export function registerAutomationRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---- arming / pause / stop (AUTO-01/03) ----
  app.post("/api/trading/arm", async (req, reply) => {
    const parsed = armSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    try {
      const policy = ctx.trading.arm({ acknowledge: parsed.data.acknowledge, policyHash: parsed.data.policyHash, category: parsed.data.category, strategyVersion: parsed.data.strategyVersion ?? ctx.forecasts.strategyVersion });
      return { policy, gates: ctx.trading.gates(), status: ctx.trading.status(), scheduler: ctx.autoTrader.liveEnabled() };
    } catch (err) {
      if (err instanceof TradingGateError) return reply.code(409).send({ error: "gate_unmet", message: err.message, gates: err.gates });
      return executionError(reply, err);
    }
  });
  app.post("/api/trading/pause", async (req, reply) => {
    const parsed = pauseSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    return { policy: ctx.trading.pause(parsed.data.reason), status: ctx.trading.status() };
  });
  app.post("/api/trading/resume", async () => ({ policy: ctx.trading.resume(), status: ctx.trading.status() }));
  app.post("/api/trading/emergency-stop", async (req, reply) => {
    const parsed = stopSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    try {
      const r = await ctx.execution.emergencyStop(parsed.data.reason ?? "owner emergency stop");
      return { ...r, status: ctx.trading.status() };
    } catch (err) {
      return executionError(reply, err);
    }
  });
  app.post("/api/trading/cancel-all", async (req, reply) => {
    const parsed = cancelAllSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    try {
      return await ctx.execution.cancelAllAccountOrders(parsed.data.acknowledge);
    } catch (err) {
      return executionError(reply, err);
    }
  });

  // ---- scheduler (AUTO-02/05) ----
  app.get("/api/trading/automation", async () => ({ settings: ctx.trading.policy().automation, live: ctx.autoTrader.liveEnabled(), runs: ctx.autoTrader.runs(20), strategyVersion: ctx.forecasts.strategyVersion, categories: ctx.forecasts.qualifiedCategories() }));
  app.put("/api/trading/automation", async (req, reply) => {
    const parsed = automationSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    try {
      const policy = ctx.trading.setAutomation(parsed.data);
      return { settings: policy.automation, policyHash: policy.policyHash, mode: policy.mode };
    } catch (err) {
      return reply.code(400).send({ error: "invalid_automation", message: (err as Error).message });
    }
  });
  app.post("/api/trading/automation/tick", async (_req, reply) => {
    try {
      return await ctx.autoTrader.tick();
    } catch (err) {
      return executionError(reply, err);
    }
  });
  app.get<{ Querystring: { limit?: string } }>("/api/trading/automation/runs", async (req) => ctx.autoTrader.runs(Math.min(Number(req.query.limit ?? 50) || 50, 500)));
  app.get<{ Params: { id: string } }>("/api/trading/automation/runs/:id", async (req, reply) => {
    const run = ctx.autoTrader.runs(500).find((r) => r.id === req.params.id);
    return run ? { ...run, candidates: ctx.autoTrader.candidatesFor(run.id) } : reply.code(404).send({ error: "not_found" });
  });

  // ---- ledger, summary, metrics, export (DASH-01…05, OPS-04) ----
  const filterOf = (q: Record<string, string | undefined>) => ({ from: q.from, to: q.to, category: q.category, creator: q.creator, status: q.status, mode: q.mode as never, reason: q.reason, includeExternal: q.external !== "false", limit: q.limit ? Math.min(Number(q.limit) || 500, 10_000) : undefined });
  app.get<{ Querystring: Record<string, string | undefined> }>("/api/trading/ledger", async (req) => ctx.ledger.rows(filterOf(req.query)));
  app.get("/api/trading/summary", async () => ctx.ledger.summary());
  app.get("/api/trading/metrics", async () => ctx.ledger.metrics());
  app.get<{ Querystring: Record<string, string | undefined> }>("/api/trading/ledger.csv", async (req, reply) => {
    const csv = ctx.ledger.csv(ctx.ledger.rows(filterOf(req.query)));
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="prediction-ledger-trades-${new Date().toISOString().slice(0, 10)}.csv"`);
    return reply.send(csv);
  });
  app.get<{ Querystring: Record<string, string | undefined> }>("/api/trading/ledger.json", async (req) => ({ exportedAt: new Date().toISOString(), filter: filterOf(req.query), rows: ctx.ledger.rows(filterOf(req.query)), settlements: ctx.execution.settlements(), holds: ctx.execution.holds() }));

  // ---- alerts (AUTO-05) ----
  app.get<{ Querystring: { open?: string; limit?: string } }>("/api/trading/alerts", async (req) => ctx.tradingAlerts.list({ openOnly: req.query.open === "true", limit: Math.min(Number(req.query.limit ?? 200) || 200, 1000) }));
  app.post<{ Params: { id: string } }>("/api/trading/alerts/:id/ack", async (req, reply) => ctx.tradingAlerts.acknowledge(req.params.id) ?? reply.code(404).send({ error: "not_found" }));
}
