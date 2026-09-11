/**
 * Prediction Ledger — provider registry.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import type { LlmProviderId } from "@prediction-ledger/shared";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAiCompatibleProvider } from "./openaiCompatible.js";
import type { LanguageModelProvider } from "./types.js";

const providers: Record<LlmProviderId, LanguageModelProvider> = {
  anthropic: new AnthropicProvider(),
  openai: new OpenAiCompatibleProvider({
    id: "openai",
    displayName: "OpenAI",
    isLocal: false,
    defaultBaseUrl: "https://api.openai.com/v1",
    requiresApiKey: true,
  }),
  lmstudio: new OpenAiCompatibleProvider({
    id: "lmstudio",
    displayName: "LM Studio (local)",
    isLocal: true,
    defaultBaseUrl: "http://127.0.0.1:1234/v1",
    requiresApiKey: false,
  }),
};

export function getLlmProvider(id: LlmProviderId): LanguageModelProvider {
  const p = providers[id];
  if (!p) throw new Error(`Unknown language model provider: ${id}`);
  return p;
}
