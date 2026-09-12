/**
 * Prediction Ledger — OpenAI-compatible chat provider (used for OpenAI and LM Studio).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * LM Studio exposes an OpenAI-compatible server (default http://localhost:1234/v1 with
 * GET /v1/models and POST /v1/chat/completions), so one adapter serves both. Verified
 * against https://lmstudio.ai/docs/developer/openai-compat on 2026-09-11.
 *
 * Implemented with the built-in fetch API rather than the vendor SDK to keep the
 * dependency surface small for an individual maintainer.
 */

import type { LlmProviderId, ModelInfo, ProviderTestResult } from "@prediction-ledger/shared";
import {
  describeHttpFailure,
  describeNetworkFailure,
  ProviderHttpError,
  parseRetryAfter,
  type CompletionRequest,
  type CompletionResult,
  type LanguageModelProvider,
  type ProviderCredentials,
} from "./types.js";

const TEST_TIMEOUT_MS = 10_000;

export interface OpenAiCompatibleOptions {
  id: LlmProviderId;
  displayName: string;
  isLocal: boolean;
  defaultBaseUrl: string;
  /** Whether a missing API key is an error (OpenAI) or fine (LM Studio unless configured). */
  requiresApiKey: boolean;
}

export class OpenAiCompatibleProvider implements LanguageModelProvider {
  readonly id: LlmProviderId;
  readonly displayName: string;
  readonly isLocal: boolean;

  constructor(private readonly opts: OpenAiCompatibleOptions) {
    this.id = opts.id;
    this.displayName = opts.displayName;
    this.isLocal = opts.isLocal;
  }

  private baseUrl(creds: ProviderCredentials): string {
    return (creds.baseUrl?.trim() || this.opts.defaultBaseUrl).replace(/\/+$/, "");
  }

  private headers(creds: ProviderCredentials): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (creds.apiKey) h.authorization = `Bearer ${creds.apiKey}`;
    return h;
  }

  async testConnection(creds: ProviderCredentials): Promise<ProviderTestResult> {
    if (this.opts.requiresApiKey && !creds.apiKey) {
      return { ok: false, provider: this.id, code: "unauthorized", message: "No API key provided." };
    }
    const url = `${this.baseUrl(creds)}/models`;
    const started = Date.now();
    try {
      const res = await fetch(url, { headers: this.headers(creds), signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
      if (!res.ok) return describeHttpFailure(this.id, res.status, await res.text());
      const models = parseModelList(await res.json());
      const latencyMs = Date.now() - started;
      if (this.isLocal && models.length === 0) {
        return {
          ok: true,
          provider: this.id,
          latencyMs,
          models,
          message: "Server reachable but no models are loaded. Load a model in LM Studio (or run `lms load <model>`), then refresh.",
        };
      }
      return { ok: true, provider: this.id, latencyMs, models, message: `Connected — ${models.length} model(s) available.` };
    } catch (err) {
      return describeNetworkFailure(this.id, err, url);
    }
  }

  async listModels(creds: ProviderCredentials): Promise<ModelInfo[]> {
    const result = await this.testConnection(creds);
    return result.models ?? [];
  }

  async complete(creds: ProviderCredentials, req: CompletionRequest): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature ?? 0.2,
    };
    if (req.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: false },
      };
    }
    const res = await fetch(`${this.baseUrl(creds)}/chat/completions`, {
      method: "POST",
      headers: this.headers(creds),
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) {
      throw new ProviderHttpError(this.displayName, res.status, await res.text(), parseRetryAfter(res.headers.get("retry-after")));
    }
    const json = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: json.choices?.[0]?.message?.content ?? "",
      model: json.model ?? req.model,
      usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens },
      raw: json,
    };
  }
}

function parseModelList(json: unknown): ModelInfo[] {
  const data = (json as { data?: { id?: string }[] })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .filter((m): m is { id: string } => typeof m?.id === "string")
    .map((m) => ({ id: m.id, source: "discovered" as const }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
