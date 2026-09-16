/**
 * Prediction Ledger — HTTP API routes for manual-live execution (1.13, EXE-01…08, OPS-03, DASH audit trail).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Application routes, never venue routes. Preview and confirm are the only way an order reaches the venue, and both
 * are gated server-side (mode, authorization, lease, holds) — the browser cannot bypass a gate by calling a route
 * directly. Bodies are `.strict()`: a submission names a preview id and the decision's immutable hash and nothing
 * else (no price, side, quantity or budget can be sent by a client). The CSRF guard from index.ts applies.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { ExecutionError } from "../services/execution.js";
import { TradingAdapterError } from "../providers/trading/types.js";
import { TradingGateError } from "../services/tradingAccounts.js";

const submitSchema = z.object({ previewId: z.string().uuid(), decisionHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
/** Exactly one of `venueOrderId` (link this venue order) or `outcome: "not_submitted"`; the note is mandatory (audited). */
const resolveUnknownSchema = z.object({ venueOrderId: z.string().min(1).max(200).optional(), outcome: z.enum(["not_submitted"]).optional(), note: z.string().min(1).max(1000) }).strict();
const resolveHoldSchema = z.object({ resolution: z.string().min(1).max(1000) }).strict();
const disarmSchema = z.object({ reason: z.string().min(1).max(300).optional() }).strict();

type Reply = { code: (n: number) => { send: (b: unknown) => unknown } };

export function executionError(reply: Reply, err: unknown) {
  if (err instanceof ExecutionError) return reply.code(err.httpStatus).send({ error: err.code, message: err.message, detail: err.detail });
  if (err instanceof TradingGateError) return reply.code(409).send({ error: "gate_unmet", message: err.message, gates: err.gates });
  if (err instanceof TradingAdapterError) {
    const status = err.code === "unauthorized" || err.code === "forbidden" ? 401 : err.code === "rate_limited" ? 429 : err.code === "sdk_missing" || err.code === "host_not_allowed" ? 500 : 502;
    return reply.code(status).send({ error: `trading_${err.code}`, message: err.message });
  }
  return reply.code(500).send({ error: "execution_failed", message: err instanceof Error ? err.message.slice(0, 300) : "unknown error" });
}

export function registerExecutionRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---- preview → confirm (EXE-01/02/03) ----
  app.post<{ Params: { id: string } }>("/api/trading/decisions/:id/preview", async (req, reply) => {
    try {
      return reply.code(201).send(await ctx.execution.preview(req.params.id));
    } catch (err) {
      return executionError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/trading/decisions/:id/submit", async (req, reply) => {
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const preview = ctx.execution.getPreview(parsed.data.previewId);
    if (!preview || preview.decisionId !== req.params.id) return reply.code(404).send({ error: "not_found", message: "Preview not found for this decision." });
    try {
      const intent = await ctx.execution.submit(parsed.data.previewId, { decisionHash: parsed.data.decisionHash });
      return reply.code(intent.state === "rejected_local" ? 409 : 201).send(intent);
    } catch (err) {
      return executionError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/api/trading/previews/:id", async (req, reply) => ctx.execution.getPreview(req.params.id) ?? reply.code(404).send({ error: "not_found" }));

  // ---- intents, orders, executions (EXE-06, DASH) ----
  app.get<{ Querystring: { state?: string; mode?: string; limit?: string } }>("/api/trading/intents", async (req) =>
    ctx.execution.intents({ state: req.query.state as never, mode: req.query.mode === "paper" || req.query.mode === "live" ? req.query.mode : undefined, limit: Math.min(Number(req.query.limit ?? 200) || 200, 1000) }));
  app.get<{ Params: { id: string } }>("/api/trading/intents/:id", async (req, reply) => ctx.execution.intent(req.params.id) ?? reply.code(404).send({ error: "not_found" }));
  app.post<{ Params: { id: string } }>("/api/trading/intents/:id/cancel", async (req, reply) => {
    try {
      return await ctx.execution.cancelIntent(req.params.id);
    } catch (err) {
      return executionError(reply, err);
    }
  });
  app.post<{ Params: { id: string } }>("/api/trading/intents/:id/resolve-unknown", async (req, reply) => {
    const parsed = resolveUnknownSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const { venueOrderId, outcome, note } = parsed.data;
    if ((venueOrderId ? 1 : 0) + (outcome ? 1 : 0) !== 1) return reply.code(400).send({ error: "invalid_request", message: "Give exactly one of venueOrderId or outcome: \"not_submitted\"." });
    try {
      return ctx.execution.resolveUnknown(req.params.id, venueOrderId ? { venueOrderId } : { outcome: "not_submitted" }, note);
    } catch (err) {
      return executionError(reply, err);
    }
  });

  app.get<{ Querystring: { external?: string; limit?: string } }>("/api/trading/orders", async (req) =>
    ctx.execution.orders({ external: req.query.external === "true" ? true : req.query.external === "false" ? false : undefined, limit: Math.min(Number(req.query.limit ?? 200) || 200, 1000) }));
  app.get<{ Params: { id: string } }>("/api/trading/orders/:id", async (req, reply) => {
    const order = ctx.execution.order(req.params.id);
    if (!order) return reply.code(404).send({ error: "not_found" });
    return { ...order, executions: ctx.execution.executions(order.id) };
  });
  // Direct order placement does not exist: every submission goes through preview → confirm with the decision hash.
  app.post("/api/trading/orders", async (_req, reply) => reply.code(409).send({ error: "preview_required", message: "Orders are placed only through POST /api/trading/decisions/:id/preview followed by /submit with the preview id and decision hash." }));

  // ---- reconciliation, holds, positions (EXE-04/05/07/08) ----
  app.post("/api/trading/reconcile", async (_req, reply) => {
    try {
      return await ctx.execution.reconcile();
    } catch (err) {
      return executionError(reply, err);
    }
  });
  app.get<{ Querystring: { open?: string } }>("/api/trading/holds", async (req) => ctx.execution.holds(undefined, req.query.open === "true"));
  app.post<{ Params: { id: string } }>("/api/trading/holds/:id/resolve", async (req, reply) => {
    const parsed = resolveHoldSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    try {
      return ctx.execution.resolveHold(req.params.id, parsed.data.resolution);
    } catch (err) {
      return executionError(reply, err);
    }
  });
  app.get("/api/trading/positions", async () => {
    const binding = ctx.trading.connected();
    return binding ? ctx.execution.positions(binding.id) : [];
  });
  app.get("/api/trading/settlements", async () => ctx.execution.settlements());
  app.get("/api/trading/lease", async () => ({ ...ctx.lease.status(), stream: ctx.execution.streamState }));

  // ---- disarm (EXE-01): one statement; the dispatch marker re-reads the policy so nothing can start after it ----
  app.post("/api/trading/disarm", async (req, reply) => {
    const parsed = disarmSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const policy = ctx.trading.disarm(parsed.data.reason ?? "owner disarm");
    return { policy, gates: ctx.trading.gates(), status: ctx.trading.status() };
  });

  // ---- secret-free lineage export (DASH audit trail) ----
  app.get("/api/trading/export", async () => ({
    exportedAt: new Date().toISOString(),
    intents: ctx.execution.intents({ limit: 10_000 }),
    orders: ctx.execution.orders({ limit: 10_000 }),
    executions: ctx.execution.allExecutions(),
    settlements: ctx.execution.settlements(),
    holds: ctx.execution.holds(),
    audit: ctx.trading.auditEvents(5000),
  }));
}
