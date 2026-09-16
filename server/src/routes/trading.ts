/**
 * Prediction Ledger — HTTP API routes for the Polymarket US account connection (1.10).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Application routes, distinct from venue routes. Every mutation is Zod-validated with `.strict()` so a
 * client cannot smuggle a base URL, a mode or a budget through a connection body (ACC-04/05). The CSRF
 * guard registered in index.ts applies to all of them. Order submission lives in routes/execution.ts (1.13,
 * preview → confirm only); the automation controls (arm / emergency-stop) answer 501 `feature_disabled` until 1.14
 * so the gate is visible, not silent.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { TradingAdapterError } from "../providers/trading/types.js";
import { TradingConnectError, TradingGateError, TRADING_FEATURES } from "../services/tradingAccounts.js";

const credentialsSchema = z.object({
  keyId: z.string().min(1).max(200),
  secretKey: z.string().min(1).max(500),
  /** ACC-03: owner asserts the new credential belongs to the currently bound account (continuity "user_asserted"). */
  assertSameAccount: z.boolean().optional(),
}).strict();

const testSchema = z.object({
  keyId: z.string().max(200).optional(),
  secretKey: z.string().max(500).optional(),
}).strict();

/** 1.13: `manual_live` needs the exact owner acknowledgement (EXE-01); other modes must not carry one. */
const policySchema = z.object({ mode: z.enum(["disabled", "paper", "manual_live", "auto_live"]), acknowledge: z.string().max(200).optional() }).strict();

type Reply = { code: (n: number) => { send: (b: unknown) => unknown } };

export function registerTradingRoutes(app: FastifyInstance, ctx: AppContext): void {
  const adapterError = (reply: Reply, err: unknown) => {
    if (err instanceof TradingGateError) return reply.code(409).send({ error: "gate_unmet", message: err.message, gates: err.gates });
    if (err instanceof TradingConnectError) return reply.code(422).send({ error: "connection_failed", message: err.message, test: err.test });
    if (err instanceof TradingAdapterError) {
      const status = err.code === "unauthorized" || err.code === "forbidden" ? 401 : err.code === "rate_limited" ? 429 : err.code === "sdk_missing" || err.code === "host_not_allowed" ? 500 : 502;
      return reply.code(status).send({ error: `trading_${err.code}`, message: err.message });
    }
    return reply.code(500).send({ error: "trading_error", message: err instanceof Error ? err.message.slice(0, 300) : "unknown error" });
  };

  app.get("/api/trading/status", async () => ctx.trading.status());

  app.get<{ Querystring: { limit?: string } }>("/api/trading/audit", async (req) => ctx.trading.auditEvents(Math.min(Number(req.query.limit ?? 100) || 100, 500)));

  app.post("/api/trading/connection/test", async (req, reply) => {
    const parsed = testSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    return ctx.trading.testConnection(parsed.data);
  });

  app.put("/api/trading/connection", async (req, reply) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    try {
      const r = await ctx.trading.connect(parsed.data);
      return reply.code(201).send({ ...r, status: ctx.trading.status() });
    } catch (err) {
      return adapterError(reply, err);
    }
  });

  app.delete("/api/trading/connection", async (_req, reply) => {
    try {
      const r = await ctx.trading.disconnect();
      if (!r.disconnected) return reply.code(404).send({ error: "not_connected", message: r.note });
      return { ...r, status: ctx.trading.status() };
    } catch (err) {
      return adapterError(reply, err);
    }
  });

  app.post("/api/trading/sync", async (_req, reply) => {
    try {
      return await ctx.trading.sync();
    } catch (err) {
      return adapterError(reply, err);
    }
  });

  app.get("/api/trading/policy", async () => ({ policy: ctx.trading.policy(), gates: ctx.trading.gates(), features: TRADING_FEATURES }));

  app.put("/api/trading/policy", async (req, reply) => {
    const parsed = policySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    try {
      return { policy: ctx.trading.setMode(parsed.data.mode, { acknowledge: parsed.data.acknowledge }), gates: ctx.trading.gates(), status: ctx.trading.status() };
    } catch (err) {
      return adapterError(reply, err);
    }
  });

  // ---- 1.12: pilot limits (RSK-02/07). Any change disarms and is audited; consumed allowances are never reset. ----
  app.get("/api/trading/limits", async () => { const p = ctx.trading.policy(); return { policyVersion: p.policyVersion, limits: p.limits, budgetTimezone: p.budgetTimezone, policyHash: p.policyHash }; });
  app.put("/api/trading/limits", async (req, reply) => {
    const parsed = limitsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    try {
      const { budgetTimezone, ...limits } = parsed.data;
      const p = ctx.trading.setLimits(limits, { budgetTimezone });
      return { policyVersion: p.policyVersion, limits: p.limits, budgetTimezone: p.budgetTimezone, policyHash: p.policyHash, mode: p.mode };
    } catch (err) {
      return reply.code(400).send({ error: "invalid_limits", message: (err as Error).message });
    }
  });

  // Automation controls are not built in this release (1.14). They answer explicitly so nothing can be mistaken for silent success.
  for (const path of ["/api/trading/arm", "/api/trading/emergency-stop"]) {
    app.post(path, async (_req, reply) => reply.code(501).send({ error: "feature_disabled", message: "Automated (auto_live) trading is not part of this build (1.13). Manual-live orders go through preview → confirm; automation arrives with its release gates (1.14).", features: TRADING_FEATURES }));
  }
}

const money = z.string().regex(/^\d+(\.\d{1,8})?$/, "decimal string");
const limitsSchema = z.object({
  orderBudget: money.optional(),
  dailyCommitmentCap: money.optional(),
  totalOpenRisk: money.optional(),
  perMarket: money.optional(),
  perEvent: money.optional(),
  maxOpenMarkets: z.number().int().min(1).max(100).optional(),
  dailyLossStop: money.optional(),
  probabilityThreshold: z.string().regex(/^0\.\d{1,4}$/).optional(),
  minNetEdge: z.string().regex(/^0\.\d{1,4}$/).optional(),
  bookMaxAgeMs: z.number().int().min(1000).max(600_000).optional(),
  syncMaxAgeMs: z.number().int().min(1000).max(3_600_000).optional(),
  forecastMaxAgeMs: z.number().int().min(60_000).max(86_400_000).optional(),
  preEventBufferMs: z.number().int().min(0).max(86_400_000).optional(),
  budgetTimezone: z.string().min(1).max(64).optional(),
}).strict();
