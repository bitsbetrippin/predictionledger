/**
 * Prediction Ledger — structured completion with validation and one repair attempt.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Flow (PX-08): pick the provider/model for the stage → request JSON (schema hint to the
 * provider) → extract JSON from the reply (strip code fences, tolerate leading prose) →
 * validate with Zod → on failure, retry ONCE with the validation errors appended → if it
 * still fails, throw MalformedOutputError carrying the raw text so the job records it and
 * the user can see and retry. Also enforces the privacy switch and a simple per-minute
 * rate limit shared by all model calls.
 */

import type { z } from "zod";
import type { AnalysisStage, LlmProviderId } from "@prediction-ledger/shared";
import type { ChatMessage, CompletionResult, LanguageModelProvider, ProviderCredentials } from "../providers/llm/types.js";
import { ProviderHttpError } from "../providers/llm/types.js";

export class MalformedOutputError extends Error {
  constructor(
    message: string,
    public readonly rawText: string,
    public readonly issues: string[],
  ) {
    super(message);
    this.name = "MalformedOutputError";
  }
}

export class OfflineModeError extends Error {
  constructor(provider: LlmProviderId) {
    super(`Internet access is disabled in Setup → Privacy; cloud provider "${provider}" cannot be used. Enable internet or route this stage to LM Studio.`);
    this.name = "OfflineModeError";
  }
}

export interface StageTarget {
  provider: LanguageModelProvider;
  providerId: LlmProviderId;
  model: string;
  credentials: ProviderCredentials;
}

export interface StructuredRequest<T> {
  stage: AnalysisStage;
  target: StageTarget;
  messages: ChatMessage[];
  /** Output type T; input may differ (fields with .default() are optional on the way in). */
  zodSchema: z.ZodType<T, z.ZodTypeDef, unknown>;
  jsonSchema: Record<string, unknown>;
  schemaName: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Per-request timeout (default 120 s); the job's own signal still cancels earlier. */
  timeoutMs?: number;
  /** Bounded retries for 429/5xx/network failures (default 3 tries total). Invalid credentials never retry. */
  maxTries?: number;
  allowInternet: boolean;
  rateLimiter?: RateLimiter;
}

export interface StructuredResult<T> {
  data: T;
  model: string;
  providerId: LlmProviderId;
  attempts: number;
  usage?: CompletionResult["usage"];
}

export async function completeStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
  const { target } = req;
  if (!req.allowInternet && !target.provider.isLocal) throw new OfflineModeError(target.providerId);

  let messages = req.messages;
  let lastRaw = "";
  let lastIssues: string[] = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (req.rateLimiter) await req.rateLimiter.acquire(req.signal);
    const result = await withResilience(
      (signal) =>
        target.provider.complete(target.credentials, {
          model: target.model,
          messages,
          jsonSchema: { name: req.schemaName, schema: req.jsonSchema },
          maxTokens: req.maxTokens ?? 8192,
          temperature: 0.1,
          signal,
        }),
      { signal: req.signal, timeoutMs: req.timeoutMs, maxTries: req.maxTries },
    );
    lastRaw = result.text ?? "";
    const parsed = tryParseJson(lastRaw);
    if (parsed.ok) {
      const validated = req.zodSchema.safeParse(parsed.value);
      if (validated.success) {
        return { data: validated.data, model: result.model, providerId: target.providerId, attempts: attempt, usage: result.usage };
      }
      lastIssues = validated.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    } else {
      lastIssues = [parsed.error];
    }
    // Repair attempt: show the model exactly what was wrong.
    messages = [
      ...req.messages,
      { role: "assistant", content: lastRaw.slice(0, 12_000) },
      {
        role: "user",
        content:
          `Your previous reply was not valid according to the required JSON schema. Problems:\n- ${lastIssues.slice(0, 20).join("\n- ")}\n\n` +
          `Return the corrected JSON object only, with no prose and no code fences.`,
      },
    ];
  }
  throw new MalformedOutputError(`Model returned output that did not match the ${req.schemaName} schema after a repair attempt.`, lastRaw, lastIssues);
}

export class ProviderTimeoutError extends Error {
  constructor(ms: number) {
    super(`The model did not answer within ${Math.round(ms / 1000)} s. Try a smaller model, a shorter window, or raise the timeout.`);
    this.name = "ProviderTimeoutError";
  }
}

/**
 * Timeout + bounded retry around one provider call (PS-03/PS-04 hardening, Release 0.6):
 *  - each try gets its own timeout (default 120 s) combined with the caller's cancel signal;
 *  - 401/403 fail immediately with the provider's message (invalid credentials are never retried);
 *  - 408/429/5xx and network errors retry with exponential backoff (1 s, 4 s, 9 s… capped at 30 s),
 *    honouring Retry-After when the provider sends one; other errors (malformed JSON etc.) are not retried here.
 */
export async function withResilience<T>(call: (signal: AbortSignal) => Promise<T>, opts: { signal?: AbortSignal; timeoutMs?: number; maxTries?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxTries = Math.max(1, opts.maxTries ?? 3);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let t = 1; t <= maxTries; t++) {
    if (opts.signal?.aborted) throw new Error("Cancelled");
    // A ref'd timer (AbortSignal.timeout's is unref'd and would let a bare process exit mid-call).
    const timeoutCtl = new AbortController();
    const timer = setTimeout(() => timeoutCtl.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutCtl.signal]) : timeoutCtl.signal;
    try {
      return await call(signal);
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted) throw err;
      const timedOut = timeoutCtl.signal.aborted || (err as Error)?.name === "TimeoutError";
      if (timedOut) lastErr = new ProviderTimeoutError(timeoutMs);
      const http = err instanceof ProviderHttpError ? err : undefined;
      if (http?.invalidCredentials) throw err;
      const network = !http && !timedOut && /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test((err as Error)?.message ?? "");
      const retryable = timedOut || network || (http?.retryable ?? false);
      if (!retryable || t === maxTries) throw lastErr;
      const backoff = Math.min(30_000, 1000 * t * t);
      await sleep(http?.retryAfterMs ?? backoff);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** Pull a JSON object out of a reply that may contain code fences or leading text. */
export function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) candidates.unshift(fence[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return { ok: true, value: JSON.parse(c) };
    } catch {
      /* try next */
    }
  }
  return { ok: false, error: "Reply did not contain a parseable JSON object." };
}

/** Simple token-bucket limiter: at most `perMinute` acquisitions per rolling 60 s. */
export class RateLimiter {
  private stamps: number[] = [];
  constructor(private readonly perMinute: () => number) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < 60_000);
      if (this.stamps.length < Math.max(1, this.perMinute())) {
        this.stamps.push(now);
        return;
      }
      const wait = 60_000 - (now - this.stamps[0]) + 50;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, wait);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("Cancelled while waiting for rate limit."));
        }, { once: true });
      });
    }
  }
}
