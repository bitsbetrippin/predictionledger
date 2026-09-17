/**
 * Prediction Ledger — HTTP API routes (Release 0.1: health, settings, providers, jobs).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Every request body is validated with Zod before it touches the database or a provider.
 * Secrets arrive in dedicated fields, are written to SecretStore, and are never echoed.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { HealthResponse, LlmProviderId, ProviderTestResult } from "@prediction-ledger/shared";
import { APP_VERSION } from "../config.js";
import type { AppContext } from "../context.js";
import { createBackup, listBackups } from "../services/backup.js";
import { getLlmProvider } from "../providers/llm/registry.js";
import { persistedSettingsSchema, SECRET_NAMES } from "../settings.js";

const llmIdSchema = z.enum(["anthropic", "openai", "lmstudio"]);

const saveSettingsSchema = z.object({
  settings: persistedSettingsSchema,
  /** Optional secret updates. A value of "" (empty string) clears the stored secret. */
  secrets: z
    .object({
      anthropic: z.string().max(500).optional(),
      openai: z.string().max(500).optional(),
      lmstudio: z.string().max(500).optional(),
      search: z.string().max(500).optional(),
    })
    .optional(),
});

const testProviderSchema = z.object({
  provider: llmIdSchema,
  apiKey: z.string().max(500).optional(),
  baseUrl: z.string().url().max(500).optional(),
  model: z.string().max(200).optional(),
});

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---- Health -------------------------------------------------------------
  app.get("/api/health", async (): Promise<HealthResponse> => ({
    ok: true,
    name: "prediction-ledger",
    version: APP_VERSION,
    node: process.version,
    dataDir: ctx.paths.root,
    schemaVersion: ctx.schemaVersion,
    uptimeSeconds: Math.round(process.uptime()),
    keyFileProtection: { method: ctx.secrets.keyFileProtection.method, ok: ctx.secrets.keyFileProtection.ok, detail: ctx.secrets.keyFileProtection.detail, fix: ctx.secrets.keyFileProtection.fix },
  }));

  // ---- Settings -----------------------------------------------------------
  app.get("/api/settings", async () => ctx.settings.getPublic());

  app.put("/api/settings", async (req, reply) => {
    const parsed = saveSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_settings", issues: parsed.error.issues });
    }
    const { settings, secrets } = parsed.data;

    // Local model endpoints must be plain http(s) URLs the user typed on purpose.
    const lmUrl = settings.providers.lmstudio.baseUrl;
    if (lmUrl && !/^https?:\/\//i.test(lmUrl)) {
      return reply.code(400).send({ error: "invalid_settings", message: "LM Studio URL must start with http:// or https://" });
    }

    ctx.db.transaction(() => {
      ctx.settings.savePersisted(settings);
      if (secrets) {
        for (const id of ["anthropic", "openai", "lmstudio"] as LlmProviderId[]) {
          const v = secrets[id];
          if (v === undefined) continue;
          if (v === "") ctx.secrets.delete(SECRET_NAMES.llm(id));
          else ctx.secrets.set(SECRET_NAMES.llm(id), v);
        }
        if (secrets.search !== undefined) {
          if (secrets.search === "") ctx.secrets.delete(SECRET_NAMES.search);
          else ctx.secrets.set(SECRET_NAMES.search, secrets.search);
        }
      }
    });
    return ctx.settings.getPublic();
  });

  // ---- Provider connection tests & model discovery --------------------------
  app.post("/api/providers/test", async (req, reply): Promise<ProviderTestResult> => {
    const parsed = testProviderSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, provider: "anthropic", code: "unknown", message: "Invalid request body." };
    }
    const { provider: id, apiKey, baseUrl } = parsed.data;
    const provider = getLlmProvider(id);
    const current = ctx.settings.getPersisted();

    if (!current.privacy.allowInternet && !provider.isLocal) {
      return {
        ok: false,
        provider: id,
        code: "offline_mode",
        message: "Internet access is disabled in Setup → Privacy. Enable it to use cloud providers.",
      };
    }

    // Prefer a key typed in the form (not yet saved); fall back to the stored one.
    const effectiveKey = apiKey?.trim() || ctx.secrets.get(SECRET_NAMES.llm(id));
    const effectiveBase = baseUrl?.trim() || current.providers[id].baseUrl;
    return provider.testConnection({ apiKey: effectiveKey, baseUrl: effectiveBase });
  });

  // ---- Jobs ---------------------------------------------------------------
  // Backups (Release 0.6): consistent copy of the live database + secret key into <data>/backups.
  app.get("/api/backups", async () => listBackups(ctx.paths.backups));
  app.post("/api/backups", async (_req, reply) => reply.code(201).send(createBackup(ctx.db, ctx.paths)));

  app.get("/api/jobs", async () => ctx.jobs.list());

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (req, reply) => {
    const job = ctx.jobs.get(req.params.id);
    if (!job) return reply.code(404).send({ error: "not_found" });
    return job;
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (req, reply) => {
    const newId = ctx.jobs.retry(req.params.id);
    if (!newId) return reply.code(409).send({ error: "not_retryable", message: "Only failed or cancelled jobs can be retried." });
    return reply.code(202).send(ctx.jobs.get(newId));
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (req, reply) => {
    const ok = ctx.jobs.cancel(req.params.id);
    if (!ok) return reply.code(409).send({ error: "not_cancellable", message: "Job is not queued or running." });
    return ctx.jobs.get(req.params.id);
  });
}
