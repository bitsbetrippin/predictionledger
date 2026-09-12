/**
 * Prediction Ledger — Anthropic Claude provider.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Uses the Messages API (POST /v1/messages) and the Models API (GET /v1/models) directly
 * over fetch. Verified against platform.claude.com docs on 2026-09-11. The
 * `anthropic-version` header is pinned; bump deliberately after reading the changelog.
 */

import type { ModelInfo, ProviderTestResult } from "@prediction-ledger/shared";
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

const API_BASE = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const TEST_TIMEOUT_MS = 10_000;

export class AnthropicProvider implements LanguageModelProvider {
  readonly id = "anthropic" as const;
  readonly displayName = "Anthropic Claude";
  readonly isLocal = false;

  private headers(creds: ProviderCredentials): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": creds.apiKey ?? "",
      "anthropic-version": API_VERSION,
    };
  }

  async testConnection(creds: ProviderCredentials): Promise<ProviderTestResult> {
    if (!creds.apiKey) {
      return { ok: false, provider: this.id, code: "unauthorized", message: "No API key provided." };
    }
    const url = `${API_BASE}/v1/models?limit=100`;
    const started = Date.now();
    try {
      const res = await fetch(url, { headers: this.headers(creds), signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
      if (!res.ok) return describeHttpFailure(this.id, res.status, await res.text());
      const json = (await res.json()) as { data?: { id: string; display_name?: string }[] };
      const models: ModelInfo[] = (json.data ?? []).map((m) => ({
        id: m.id,
        displayName: m.display_name,
        source: "discovered" as const,
      }));
      return {
        ok: true,
        provider: this.id,
        latencyMs: Date.now() - started,
        models,
        message: `Connected — ${models.length} model(s) available.`,
      };
    } catch (err) {
      return describeNetworkFailure(this.id, err, "api.anthropic.com");
    }
  }

  async listModels(creds: ProviderCredentials): Promise<ModelInfo[]> {
    return (await this.testConnection(creds)).models ?? [];
  }

  async complete(creds: ProviderCredentials, req: CompletionRequest): Promise<CompletionResult> {
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature ?? 0.2,
      messages,
    };
    if (system) body.system = system;

    // JSON-schema enforcement: the Messages API supports structured output via tools
    // ("forced tool use"). Using a single tool whose input_schema is the target schema
    // is the most portable pattern; the tool input is returned as the parsed object.
    if (req.jsonSchema) {
      body.tools = [{ name: req.jsonSchema.name, description: "Return the structured result.", input_schema: req.jsonSchema.schema }];
      body.tool_choice = { type: "tool", name: req.jsonSchema.name };
    }

    const res = await fetch(`${API_BASE}/v1/messages`, {
      method: "POST",
      headers: this.headers(creds),
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) {
      throw new ProviderHttpError("Anthropic", res.status, await res.text(), parseRetryAfter(res.headers.get("retry-after")));
    }
    const json = (await res.json()) as {
      model?: string;
      content?: ({ type: "text"; text: string } | { type: "tool_use"; input: unknown })[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    let text = "";
    for (const block of json.content ?? []) {
      if (block.type === "tool_use") text = JSON.stringify(block.input);
      else if (block.type === "text" && !text) text = block.text;
    }
    return {
      text,
      model: json.model ?? req.model,
      usage: { inputTokens: json.usage?.input_tokens, outputTokens: json.usage?.output_tokens },
      raw: json,
    };
  }
}
