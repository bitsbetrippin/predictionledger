/**
 * Prediction Ledger — application settings service.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Non-secret settings are one JSON document in the `settings` table (key = "app").
 * Secrets are handled by SecretStore and only surface here as `hasSecret` / `secretHint`.
 */

import { z } from "zod";
import type { AppSettings, LlmProviderId } from "@prediction-ledger/shared";
import type { Database } from "./db/index.js";
import type { SecretStore } from "./security/secrets.js";

export const SECRET_NAMES = {
  llm: (p: LlmProviderId) => `llm.${p}.apiKey`,
  search: "search.apiKey",
} as const;

/** Zod schema for the persisted (secret-free) part of AppSettings. */
const providerSchema = z.object({
  enabled: z.boolean(),
  model: z.string().max(200),
  baseUrl: z.string().url().max(500).optional(),
});

export const persistedSettingsSchema = z.object({
  providers: z.object({
    anthropic: providerSchema,
    openai: providerSchema,
    lmstudio: providerSchema,
  }),
  stages: z.object({
    extraction: z.object({ provider: z.enum(["anthropic", "openai", "lmstudio"]), model: z.string().max(200).optional() }),
    validationPlan: z.object({ provider: z.enum(["anthropic", "openai", "lmstudio"]), model: z.string().max(200).optional() }),
    assessment: z.object({ provider: z.enum(["anthropic", "openai", "lmstudio"]), model: z.string().max(200).optional() }),
  }),
  transcription: z.object({
    engine: z.enum(["local-whisper", "openai-transcribe", "youtube-captions", "import"]),
    localModel: z.string().max(200),
    language: z.string().max(10),
  }),
  search: z.object({
    provider: z.enum(["brave", "tavily", "searxng", "anthropic-native", "openai-native", "none"]),
    baseUrl: z.string().url().max(500).optional(),
  }),
  limits: z.object({
    concurrency: z.number().int().min(1).max(8),
    maxSearchesPerRun: z.number().int().min(1).max(50),
    maxSourcesPerRun: z.number().int().min(1).max(100),
    requestsPerMinute: z.number().int().min(1).max(600),
  }),
  privacy: z.object({
    allowInternet: z.boolean(),
  }),
  research: z.object({
    reviewPlanBeforeResearch: z.boolean(),
    recheckAfterDays: z.number().int().min(1).max(365),
    maxSourceChars: z.number().int().min(1000).max(60000),
  }),
});

export type PersistedSettings = z.infer<typeof persistedSettingsSchema>;

export const DEFAULT_SETTINGS: PersistedSettings = {
  providers: {
    // Model ids verified against official docs on 2026-09-11; users can override manually.
    anthropic: { enabled: false, model: "claude-sonnet-5" },
    openai: { enabled: false, model: "gpt-5.6-terra" },
    lmstudio: { enabled: false, model: "", baseUrl: "http://127.0.0.1:1234/v1" },
  },
  stages: {
    extraction: { provider: "anthropic" },
    validationPlan: { provider: "anthropic" },
    assessment: { provider: "anthropic" },
  },
  transcription: {
    engine: "local-whisper",
    localModel: "onnx-community/whisper-base",
    language: "auto",
  },
  search: { provider: "none" },
  limits: { concurrency: 2, maxSearchesPerRun: 8, maxSourcesPerRun: 12, requestsPerMinute: 30 },
  privacy: { allowInternet: true },
  research: { reviewPlanBeforeResearch: false, recheckAfterDays: 90, maxSourceChars: 12000 },
};

export class SettingsService {
  constructor(
    private readonly db: Database,
    private readonly secrets: SecretStore,
    private readonly dataDir: string,
  ) {}

  /** Persisted settings merged over defaults (so new fields added by upgrades get sane values). */
  getPersisted(): PersistedSettings {
    const row = this.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'app'");
    if (!row) return structuredClone(DEFAULT_SETTINGS);
    const parsed = persistedSettingsSchema.safeParse(deepMerge(DEFAULT_SETTINGS, JSON.parse(row.value_json)));
    return parsed.success ? parsed.data : structuredClone(DEFAULT_SETTINGS);
  }

  savePersisted(next: PersistedSettings): void {
    this.db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES ('app', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      JSON.stringify(next),
    );
  }

  /** Full settings view for the browser: persisted settings + secret presence/hints. Never the secret values. */
  getPublic(): AppSettings {
    const p = this.getPersisted();
    const withSecret = (id: LlmProviderId) => ({
      ...p.providers[id],
      hasSecret: this.secrets.has(SECRET_NAMES.llm(id)),
      secretHint: this.secrets.hint(SECRET_NAMES.llm(id)),
    });
    return {
      ...p,
      providers: {
        anthropic: withSecret("anthropic"),
        openai: withSecret("openai"),
        lmstudio: withSecret("lmstudio"),
      },
      search: {
        ...p.search,
        hasSecret: this.secrets.has(SECRET_NAMES.search),
        secretHint: this.secrets.hint(SECRET_NAMES.search),
      },
      dataDir: this.dataDir,
    };
  }
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (typeof base !== "object" || base === null || typeof patch !== "object" || patch === null) {
    return (patch ?? base) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}
