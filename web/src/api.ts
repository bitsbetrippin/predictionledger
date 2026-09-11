/**
 * Prediction Ledger — typed API client for the dashboard.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Same-origin only. Every mutating call carries the CSRF header the server requires.
 */

import {
  CSRF_HEADER,
  CSRF_VALUE,
  type AppSettings,
  type HealthResponse,
  type JobSummary,
  type ProviderTestRequest,
  type ProviderTestResult,
} from "@prediction-ledger/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers[CSRF_HEADER] = CSRF_VALUE;

  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const msg = (json as { message?: string; error?: string })?.message ?? (json as { error?: string })?.error ?? res.statusText;
    throw new ApiError(msg, res.status, json);
  }
  return json as T;
}

/** Persisted settings shape sent back on save — same as AppSettings minus read-only/secret fields. */
export type SettingsPayload = Omit<AppSettings, "dataDir" | "providers" | "search"> & {
  providers: Record<keyof AppSettings["providers"], { enabled: boolean; model: string; baseUrl?: string }>;
  search: { provider: AppSettings["search"]["provider"]; baseUrl?: string };
};

export interface SecretUpdates {
  anthropic?: string;
  openai?: string;
  lmstudio?: string;
  search?: string;
}

export const api = {
  health: () => request<HealthResponse>("GET", "/api/health"),
  getSettings: () => request<AppSettings>("GET", "/api/settings"),
  saveSettings: (settings: SettingsPayload, secrets?: SecretUpdates) =>
    request<AppSettings>("PUT", "/api/settings", { settings, secrets }),
  testProvider: (body: ProviderTestRequest) => request<ProviderTestResult>("POST", "/api/providers/test", body),
  listJobs: () => request<JobSummary[]>("GET", "/api/jobs"),
};

/** Strip read-only and secret-presence fields before sending settings back. */
export function toPayload(s: AppSettings): SettingsPayload {
  const strip = (p: AppSettings["providers"]["anthropic"]) => ({ enabled: p.enabled, model: p.model, baseUrl: p.baseUrl });
  return {
    providers: {
      anthropic: strip(s.providers.anthropic),
      openai: strip(s.providers.openai),
      lmstudio: strip(s.providers.lmstudio),
    },
    stages: s.stages,
    transcription: s.transcription,
    search: { provider: s.search.provider, baseUrl: s.search.baseUrl },
    limits: s.limits,
    privacy: s.privacy,
  };
}
