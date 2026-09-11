/**
 * Prediction Ledger — shared types used by both the server and the web dashboard.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Everything in this package is plain data shapes (no runtime dependencies) so the
 * browser bundle and the Node server agree on API contracts without duplicating them.
 */

// ---------------------------------------------------------------------------
// Provider identifiers
// ---------------------------------------------------------------------------

/** Language-model providers the app can talk to. */
export type LlmProviderId = "anthropic" | "openai" | "lmstudio";

/** Transcription engines (wired up in Release 0.2). */
export type TranscriptionProviderId = "local-whisper" | "openai-transcribe" | "youtube-captions" | "import";

/** Web search providers (wired up in Release 0.6). */
export type SearchProviderId = "brave" | "tavily" | "searxng" | "anthropic-native" | "openai-native" | "none";

/**
 * The three analysis stages that can each use a different provider/model.
 * Keeping them separate lets a user run extraction on a cheap/local model and
 * assessment on a stronger one.
 */
export type AnalysisStage = "extraction" | "validationPlan" | "assessment";

// ---------------------------------------------------------------------------
// Settings (non-secret). Secrets are stored separately and never returned raw.
// ---------------------------------------------------------------------------

export interface LlmProviderSettings {
  /** Whether the provider is enabled in the Setup tab. */
  enabled: boolean;
  /** Model identifier (discovered or typed manually). */
  model: string;
  /** Base URL; only meaningful for LM Studio (default http://127.0.0.1:1234/v1). */
  baseUrl?: string;
  /** True when a secret is stored for this provider (the value itself is never sent to the browser). */
  hasSecret: boolean;
  /** Masked hint such as "sk-ant-…4f2a" so the user can recognise which key is saved. */
  secretHint?: string;
}

export interface StageAssignment {
  provider: LlmProviderId;
  /** Optional per-stage model override; falls back to the provider's default model. */
  model?: string;
}

export interface AppSettings {
  providers: Record<LlmProviderId, LlmProviderSettings>;
  stages: Record<AnalysisStage, StageAssignment>;
  transcription: {
    engine: TranscriptionProviderId;
    /** Whisper model id for the local engine, e.g. "onnx-community/whisper-base". */
    localModel: string;
    language: string; // "auto" or ISO-639-1
  };
  search: {
    provider: SearchProviderId;
    hasSecret: boolean;
    secretHint?: string;
    /** Optional base URL for self-hosted providers (SearXNG). */
    baseUrl?: string;
  };
  limits: {
    /** Max concurrent background jobs. */
    concurrency: number;
    /** Max searches per prediction research run. */
    maxSearchesPerRun: number;
    /** Max sources fetched per research run. */
    maxSourcesPerRun: number;
    /** Max model requests per minute across all providers. */
    requestsPerMinute: number;
  };
  privacy: {
    /**
     * Master switch. When false the app performs no outbound network calls
     * except to explicitly configured local endpoints (LM Studio, SearXNG).
     */
    allowInternet: boolean;
  };
  /** Absolute path of the data directory (read-only in the UI; set via PL_DATA_DIR). */
  dataDir: string;
}

// ---------------------------------------------------------------------------
// Provider test / discovery contracts
// ---------------------------------------------------------------------------

export interface ProviderTestRequest {
  provider: LlmProviderId;
  /** Optional unsaved values to test before saving. */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface ProviderTestResult {
  ok: boolean;
  provider: LlmProviderId;
  /** Human-readable, actionable message ("Invalid API key — check the Anthropic Console"). */
  message: string;
  /** Milliseconds the round-trip took. */
  latencyMs?: number;
  /** Models discovered, when the provider supports listing. */
  models?: ModelInfo[];
  /** Error code for programmatic handling. */
  code?: "unauthorized" | "unreachable" | "not_found" | "rate_limited" | "offline_mode" | "unknown";
}

export interface ModelInfo {
  id: string;
  displayName?: string;
  /** Where the id came from: provider listing, or typed by the user. */
  source: "discovered" | "manual";
}

// ---------------------------------------------------------------------------
// Jobs (durable background work). Only the shape is defined in Release 0.1;
// job kinds are added as later releases land.
// ---------------------------------------------------------------------------

export type JobKind =
  | "video.import"
  | "audio.extract"
  | "transcript.generate"
  | "prediction.extract"
  | "plan.generate"
  | "research.run"
  | "assessment.run";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface JobSummary {
  id: string;
  kind: JobKind;
  status: JobStatus;
  /** 0–100 */
  progress: number;
  /** Short human stage label, e.g. "Transcribing chunk 3 of 12". */
  stage?: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** Free-form reference to the owning entity (video id, prediction id). */
  subjectType?: string;
  subjectId?: string;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  ok: true;
  name: "prediction-ledger";
  version: string;
  node: string;
  dataDir: string;
  /** Schema version applied by the migration runner. */
  schemaVersion: number;
  uptimeSeconds: number;
}

/** Header the browser must send on every mutating request (CSRF guard). */
export const CSRF_HEADER = "x-prediction-ledger";
export const CSRF_VALUE = "1";
