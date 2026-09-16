/**
 * Prediction Ledger — HTTP API routes for the Polymarket US account connection (1.10).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Application routes, distinct from venue routes. Every mutation is Zod-validated with `.strict()` so a
 * client cannot smuggle a base URL, a mode or a budget through a connection body (ACC-04/05). The CSRF
 * guard registered in index.ts applies to all of them. Order submission routes do not exist in this
 * release; arm/submit-style calls answer 501 `feature_disabled` so the gate is visible, not silent.
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

const policySchema = z.object({ mode: z.enum(["disabled", "paper", "manual_live", "auto_live"]) }).strict();

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
      return { policy: ctx.trading.setMode(parsed.data.mode), gates: ctx.trading.gates() };
    } catch (err) {
      return adapterError(reply, err);
    }
  });

  // Live-execution controls are not built in this release. They answer explicitly so nothing can be mistaken for silent success.
  for (const path of ["/api/trading/arm", "/api/trading/disarm", "/api/trading/emergency-stop", "/api/trading/decisions", "/api/trading/orders"]) {
    app.post(path, async (_req, reply) => reply.code(501).send({ error: "feature_disabled", message: "Order submission and automation are not part of this build (1.10). They arrive with their release gates (1.13/1.14).", features: TRADING_FEATURES }));
  }
}
