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
    sports: s.sports,
    youtube: s.youtube,
    search: { provider: s.search.provider, baseUrl: s.search.baseUrl },
    limits: s.limits,
    privacy: s.privacy,
    research: s.research,
  };
}

// ---------------------------------------------------------------------------
// Release 0.2 — videos, predictions, plans, templates
// ---------------------------------------------------------------------------

import type {
  Assessment,
  EvidenceItem,
  Prediction,
  PredictionEdit,
  ProcessingStatus,
  ResearchRun,
  ResultSummary,
  PredictionFilters,
  PromptTemplateInfo,
  TranscriptImportRequest,
  TranscriptSegment,
  ValidationPlan,
  ValidationPlanBody,
  VideoDetail,
  VideoSummary,
} from "@prediction-ledger/shared";

export type TimeStatus = "pending" | "reached" | "unknown";
export type PredictionRow = Prediction & { timeStatus: TimeStatus; result?: ResultSummary; processingStatus: ProcessingStatus };
export type PredictionFull = PredictionRow & {
  plans: ValidationPlan[];
  revisions: { version: number; reason: string | null; createdAt: string; snapshot: unknown }[];
  runs: ResearchRun[];
  assessments: Assessment[];
};
export type RunDetail = ResearchRun & { evidence: EvidenceItem[] };

function qs(obj: Record<string, string | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== "" && v !== false) p.set(k, v === true ? "1" : v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const content = {
  listVideos: () => request<VideoSummary[]>("GET", "/api/videos"),
  importTranscript: (body: TranscriptImportRequest) => request<{ video: VideoDetail; warnings: string[] }>("POST", "/api/videos/import-transcript", body),
  getVideo: (id: string) => request<VideoDetail>("GET", `/api/videos/${id}`),
  updateVideo: (id: string, patch: { title?: string; publishedAt?: string | null; language?: string | null }) => request<VideoDetail>("PATCH", `/api/videos/${id}`, patch),
  correctSegment: (videoId: string, segmentId: string, textCorrected: string | null) =>
    request<TranscriptSegment>("PATCH", `/api/videos/${videoId}/segments/${segmentId}`, { textCorrected }),
  deleteVideo: (id: string) => request<{ ok: true }>("DELETE", `/api/videos/${id}`),
  extract: (videoId: string) => request<{ jobId: string }>("POST", `/api/videos/${videoId}/extract`),

  listPredictions: (f: PredictionFilters & { result?: string } = {}) =>
    request<PredictionRow[]>("GET", `/api/predictions${qs({ videoId: f.videoId, kind: f.kind, topic: f.topic, userStatus: f.userStatus, deadlineBefore: f.deadlineBefore, deadlineAfter: f.deadlineAfter, includeDismissed: f.includeDismissed, result: f.result })}`),
  /** 1.4: one job looks the game up (winner, score, date) and settles every pick on that matchup. */
  validateScore: (id: string, recheck = false) => request<{ jobId: string; stage: "game" }>("POST", `/api/predictions/${id}/validate-score`, { recheck }),
  validateVideoScores: (videoId: string, recheck = false) => request<{ jobs: { matchup: string; jobId: string }[]; picks: number; skipped: number }>("POST", `/api/videos/${videoId}/validate-scores`, { recheck }),
  game: (id: string) => request<import("@prediction-ledger/shared").Game>("GET", `/api/games/${id}`),
  research: (id: string, planId?: string) => request<{ jobId: string; stage: "plan" | "research"; planVersion?: number }>("POST", `/api/predictions/${id}/research`, { planId, autoPlan: true }),
  run: (id: string) => request<RunDetail>("GET", `/api/runs/${id}`),
  topics: () => request<string[]>("GET", "/api/predictions/topics"),
  getPrediction: (id: string) => request<PredictionFull>("GET", `/api/predictions/${id}`),
  editPrediction: (id: string, patch: PredictionEdit) => request<Prediction>("PATCH", `/api/predictions/${id}`, patch),
  accept: (id: string) => request<Prediction>("POST", `/api/predictions/${id}/accept`),
  dismiss: (id: string) => request<Prediction>("POST", `/api/predictions/${id}/dismiss`),
  restore: (id: string) => request<Prediction>("POST", `/api/predictions/${id}/restore`),
  merge: (targetId: string, sourceIds: string[]) => request<Prediction>("POST", `/api/predictions/${targetId}/merge`, { sourceIds }),
  split: (id: string, componentId: string) => request<{ parent: Prediction; child: Prediction }>("POST", `/api/predictions/${id}/split`, { componentId }),
  generatePlan: (id: string) => request<{ jobId: string }>("POST", `/api/predictions/${id}/plan`),
  savePlanEdit: (id: string, plan: Partial<ValidationPlanBody>, researchPrompt: string) => request<ValidationPlan>("POST", `/api/predictions/${id}/plans`, { plan, researchPrompt }),

  templates: () => request<PromptTemplateInfo[]>("GET", "/api/templates"),
  setTemplate: (name: PromptTemplateInfo["name"], body: string | null) => request<PromptTemplateInfo>("PUT", `/api/templates/${name}`, { body }),
  job: (id: string) => request<import("@prediction-ledger/shared").JobSummary>("GET", `/api/jobs/${id}`),
  cancelJob: (id: string) => request<import("@prediction-ledger/shared").JobSummary>("POST", `/api/jobs/${id}/cancel`),
  retryJob: (id: string) => request<import("@prediction-ledger/shared").JobSummary>("POST", `/api/jobs/${id}/retry`),
};

// ---------------------------------------------------------------------------
// Release 0.6 — backups
// ---------------------------------------------------------------------------

export interface BackupInfo { file: string; bytes: number; createdAt: string; kind: "manual" | "pre-migration"; hasSecretKey: boolean }
export const backups = {
  list: () => request<BackupInfo[]>("GET", "/api/backups"),
  create: () => request<BackupInfo>("POST", "/api/backups"),
};

// ---------------------------------------------------------------------------
// Release 0.4 — local media upload and transcription
// ---------------------------------------------------------------------------

import type { MediaStatus } from "@prediction-ledger/shared";

export const media = {
  status: () => request<MediaStatus>("GET", "/api/media/status"),
  /** Upload a local media file as a raw octet stream (no multipart). Metadata rides in headers. */
  upload: async (file: File, meta: { publishedAt?: string; language?: string; title?: string } = {}): Promise<{ video: VideoDetail; duplicate: boolean; jobId?: string }> => {
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
      [CSRF_HEADER]: CSRF_VALUE,
      "x-file-name": encodeURIComponent(file.name),
      "x-file-size": String(file.size),
    };
    if (meta.publishedAt) headers["x-published-at"] = meta.publishedAt;
    if (meta.language) headers["x-language"] = meta.language;
    if (meta.title) headers["x-title"] = encodeURIComponent(meta.title);
    const res = await fetch("/api/videos/upload", { method: "POST", headers, body: file });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const msg = (json as { message?: string; error?: string })?.message ?? (json as { error?: string })?.error ?? res.statusText;
      throw new ApiError(msg, res.status, json);
    }
    return json as { video: VideoDetail; duplicate: boolean; jobId?: string };
  },
  downloadModel: () => request<{ jobId: string }>("POST", "/api/tools/whisper/download"),
  transcribe: (videoId: string, restart = false) => request<{ jobId: string; stage: "audio.extract" | "transcript.generate" | "video.import" }>("POST", `/api/videos/${videoId}/transcribe`, { restart }),
};

// ---------------------------------------------------------------------------
// Release 0.5 — YouTube import and helper tools
// ---------------------------------------------------------------------------

import type { ToolsStatus, YouTubeImportRequest } from "@prediction-ledger/shared";

export const youtube = {
  import: (body: YouTubeImportRequest) => request<{ video: VideoDetail; duplicate: boolean; jobId?: string }>("POST", "/api/videos/import-youtube", body),
  toolsStatus: () => request<ToolsStatus>("GET", "/api/tools/status"),
  installYtDlp: () => request<{ jobId: string }>("POST", "/api/tools/ytdlp/install"),
};

/** Poll a job until it reaches a terminal state; calls onTick with each snapshot. */
export async function pollJob(id: string, onTick?: (j: import("@prediction-ledger/shared").JobSummary) => void, intervalMs = 800) {
  for (;;) {
    const j = await content.job(id);
    onTick?.(j);
    if (j.status === "completed" || j.status === "failed" || j.status === "cancelled") return j;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const fmtClock = (s?: number) => {
  if (s === undefined || Number.isNaN(s)) return "—";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
};
