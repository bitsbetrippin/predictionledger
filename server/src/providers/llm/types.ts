/**
 * Prediction Ledger — LanguageModelProvider interface.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * One of four provider interfaces (docs/ARCHITECTURE.md §4):
 *   LanguageModelProvider  — text in, text/JSON out            (this file)
 *   TranscriptionProvider  — audio in, timestamped segments out (Release 0.2)
 *   SearchProvider         — query in, result list out          (Release 0.6)
 *   SourceFetcher          — URL in, cleaned page text out      (Release 0.6)
 *
 * A text model is never assumed to transcribe audio or reach the internet.
 */

import type { LlmProviderId, ModelInfo, ProviderTestResult } from "@prediction-ledger/shared";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  /** When set, the provider is asked for JSON output; the caller still validates it with Zod. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  maxTokens?: number;
  temperature?: number;
  /** Abort long requests on cancellation / shutdown. */
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Raw provider payload retained for debugging; never logged in full. */
  raw?: unknown;
}

export interface ProviderCredentials {
  apiKey?: string;
  baseUrl?: string;
}

export interface LanguageModelProvider {
  readonly id: LlmProviderId;
  readonly displayName: string;
  /** True when the endpoint is on this machine (LM Studio). Governs the offline switch. */
  readonly isLocal: boolean;

  /** Cheap reachability + credential check. Must return actionable messages, never throw. */
  testConnection(creds: ProviderCredentials): Promise<ProviderTestResult>;

  /** Discover models where the API supports it; return [] otherwise. */
  listModels(creds: ProviderCredentials): Promise<ModelInfo[]>;

  complete(creds: ProviderCredentials, req: CompletionRequest): Promise<CompletionResult>;
}

/** Map an HTTP failure into the shared ProviderTestResult shape with a useful message. */
export function describeHttpFailure(provider: LlmProviderId, status: number, bodyText: string): ProviderTestResult {
  const snippet = bodyText.slice(0, 200).replace(/\s+/g, " ");
  if (status === 401 || status === 403) {
    return { ok: false, provider, code: "unauthorized", message: "Authentication failed — check the API key (and that it has not been revoked)." };
  }
  if (status === 404) {
    return { ok: false, provider, code: "not_found", message: `Endpoint or model not found (HTTP 404). ${snippet}` };
  }
  if (status === 429) {
    return { ok: false, provider, code: "rate_limited", message: "Rate limited by the provider — wait a moment and retry, or lower requests-per-minute in Setup." };
  }
  return { ok: false, provider, code: "unknown", message: `Provider returned HTTP ${status}. ${snippet}` };
}

export function describeNetworkFailure(provider: LlmProviderId, err: unknown, target: string): ProviderTestResult {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { code?: string } })?.cause?.code;
  if (cause === "ECONNREFUSED") {
    return { ok: false, provider, code: "unreachable", message: `Nothing is listening at ${target}. Is the server running?` };
  }
  if (cause === "ENOTFOUND" || cause === "EAI_AGAIN") {
    return { ok: false, provider, code: "unreachable", message: `Could not resolve ${target} — check your internet connection or the URL.` };
  }
  return { ok: false, provider, code: "unreachable", message: `Could not reach ${target}: ${msg}` };
}
