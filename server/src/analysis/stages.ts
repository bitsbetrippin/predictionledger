/**
 * Prediction Ledger — resolve which provider/model/credentials serve an analysis stage.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import type { AnalysisStage } from "@prediction-ledger/shared";
import { getLlmProvider } from "../providers/llm/registry.js";
import type { SecretStore } from "../security/secrets.js";
import { SECRET_NAMES, type SettingsService } from "../settings.js";
import type { StageTarget } from "./structured.js";

export class StageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageConfigError";
  }
}

export function resolveStageTarget(stage: AnalysisStage, settings: SettingsService, secrets: SecretStore): StageTarget {
  const s = settings.getPersisted();
  const assignment = s.stages[stage];
  const providerSettings = s.providers[assignment.provider];
  const provider = getLlmProvider(assignment.provider);

  if (!providerSettings.enabled) {
    throw new StageConfigError(`Stage "${stage}" is routed to ${provider.displayName}, which is disabled in Setup. Enable it or choose another provider.`);
  }
  const model = (assignment.model?.trim() || providerSettings.model?.trim()) ?? "";
  if (!model) {
    throw new StageConfigError(`No model selected for ${provider.displayName}. Pick one in Setup (Test connection lists the available models).`);
  }
  const apiKey = secrets.get(SECRET_NAMES.llm(assignment.provider));
  if (!provider.isLocal && !apiKey) {
    throw new StageConfigError(`${provider.displayName} has no API key saved. Add one in Setup.`);
  }
  return {
    provider,
    providerId: assignment.provider,
    model,
    credentials: { apiKey, baseUrl: providerSettings.baseUrl },
  };
}
