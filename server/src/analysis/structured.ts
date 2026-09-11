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
  zodSchema: z.ZodType<T>;
  jsonSchema: Record<string, unknown>;
  schemaName: string;
  maxTokens?: number;
  signal?: AbortSignal;
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
    const result = await target.provider.complete(target.credentials, {
      model: target.model,
      messages,
      jsonSchema: { name: req.schemaName, schema: req.jsonSchema },
      maxTokens: req.maxTokens ?? 8192,
      temperature: 0.1,
      signal: req.signal,
    });
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
