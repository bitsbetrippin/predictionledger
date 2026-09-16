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
  type DecimalAmount,
  type TradingAccountBinding,
  type TradingAccountSync,
  type TradingAuditEvent,
  type TradingConnectionTest,
  type TradingGate,
  type TradingMode,
  type TradingPolicy,
  type TradingStatus,
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
    markets: s.markets,
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
  research: (id: string, planId?: string, purpose: "verdict" | "forecast" = "verdict") => request<{ jobId: string; stage: "plan" | "research"; planVersion?: number; purpose?: "verdict" | "forecast" }>("POST", `/api/predictions/${id}/research`, { planId, autoPlan: true, purpose }),
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
  /** 1.8 — playlist / channel bulk import. */
  importList: (body: import("@prediction-ledger/shared").PlaylistImportRequest) => request<{ jobId: string; url: string; kind: "playlist" | "channel" }>("POST", "/api/videos/import-youtube-list", body),
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

// ---------------------------------------------------------------------------
// Release 1.6 — prediction markets (read-only)
// ---------------------------------------------------------------------------

import type { Alert, CreatorRecord, MarketProviderId, MarketRecord, MarketSignal, MarketSnapshot, PaperBook, PaperPosition, PredictionMarketLink, Proposition } from "@prediction-ledger/shared";

export interface MarketSummaryView {
  provider: MarketProviderId; id: string; slug: string; url: string; question: string; description?: string; event?: { id: string; slug: string; title: string };
  outcomes: { label: string; tokenId?: string; price?: number; bestBid?: number; bestAsk?: number }[]; liquidity?: number; volume?: number; volume24h?: number; endDate?: string; active: boolean; closed: boolean; restricted?: boolean; retrievedAt: string;
}
export type MarketStoredDetail = MarketRecord & { snapshots: MarketSnapshot[]; links: PredictionMarketLink[] };

export const marketsApi = {
  search: (q: string, limit = 10, provider: MarketProviderId = "polymarket") => request<MarketSummaryView[]>("GET", `/api/markets/search${qs({ q, limit: String(limit), provider })}`),
  byTag: (tag: string, limit = 20, provider: MarketProviderId = "polymarket") => request<MarketSummaryView[]>("GET", `/api/markets${qs({ tag, limit: String(limit), provider })}`),
  stored: () => request<MarketRecord[]>("GET", "/api/markets/stored"),
  storedDetail: (id: string) => request<MarketStoredDetail>("GET", `/api/markets/stored/${id}`),
  watch: (idOrSlug: string, provider: MarketProviderId = "polymarket") => request<MarketRecord>("POST", "/api/markets/watch", { provider, idOrSlug }),
  unwatch: (id: string) => request<MarketRecord>("POST", `/api/markets/stored/${id}/unwatch`),
  remove: (id: string) => request<{ ok: true }>("DELETE", `/api/markets/stored/${id}`),
  snapshot: (marketIds?: string[]) => request<{ jobId: string }>("POST", "/api/markets/snapshot", marketIds ? { marketIds } : {}),
  links: (predictionId: string) => request<PredictionMarketLink[]>("GET", `/api/predictions/${predictionId}/market-links`),
  match: (predictionId: string, limit = 5) => request<{ jobId: string }>("POST", `/api/predictions/${predictionId}/market-links/match`, { limit }),
  linkManual: (predictionId: string, idOrSlug: string, side?: string, provider: MarketProviderId = "polymarket") => request<PredictionMarketLink>("POST", `/api/predictions/${predictionId}/market-links`, { provider, idOrSlug, side }),
  accept: (linkId: string, side?: string) => request<PredictionMarketLink>("POST", `/api/market-links/${linkId}/accept`, { side }),
  reject: (linkId: string) => request<PredictionMarketLink>("POST", `/api/market-links/${linkId}/reject`),
  unlink: (linkId: string) => request<{ ok: true }>("DELETE", `/api/market-links/${linkId}`),
  backfill: (linkId: string) => request<{ jobId: string }>("POST", `/api/market-links/${linkId}/backfill`),
  backfillAll: () => request<{ jobId: string }>("POST", "/api/markets/backfill"),
};

// 1.7 — signals (computed on read)
export interface SignalsResponse { gates: AppSettings["markets"]["signals"]; creators: CreatorRecord[]; signals: MarketSignal[] }
export const signalsApi = {
  get: (includeSettled = false) => request<SignalsResponse>("GET", `/api/signals${includeSettled ? "?includeSettled=1" : ""}`),
};
export const fmtEdge = (e?: number) => (e === undefined ? "—" : `${e >= 0 ? "+" : ""}${(e * 100).toFixed(1)} pts`);

export const fmtPct = (p?: number) => (p === undefined || Number.isNaN(p) ? "—" : `${(p * 100).toFixed(p < 0.1 || p > 0.9 ? 1 : 0)}%`);
export const fmtMoney = (n?: number) => (n === undefined || Number.isNaN(n) ? "—" : `$${Math.round(n).toLocaleString("en-US")}`);

// 1.8 — consensus, alerts
export const consensusApi = { get: (includeSettled = false) => request<Proposition[]>("GET", `/api/consensus${includeSettled ? "?includeSettled=1" : ""}`) };
export const alertsApi = {
  list: (includeDismissed = false) => request<{ open: number; alerts: Alert[] }>("GET", `/api/alerts${includeDismissed ? "?includeDismissed=1" : ""}`),
  seen: (ids: string[]) => request<{ ok: true }>("POST", "/api/alerts/seen", { ids }),
  dismiss: (id: string) => request<Alert>("POST", `/api/alerts/${id}/dismiss`),
  dismissAll: () => request<{ dismissed: number }>("POST", "/api/alerts/dismiss-all"),
  runNow: () => request<{ jobId: string }>("POST", "/api/markets/watch-run"),
};

// 1.9 — paper trading (hypothetical positions; never orders)
export interface PaperResponse { book: PaperBook; positions: PaperPosition[]; sizing: AppSettings["markets"]["paper"] }
export const paperApi = {
  get: () => request<PaperResponse>("GET", "/api/paper"),
  open: (body: { marketId: string; side: string; stake?: number; notes?: string; predictionIds?: string[] }) => request<PaperPosition>("POST", "/api/paper/positions", body),
  close: (id: string, price?: number) => request<PaperPosition>("POST", `/api/paper/positions/${id}/close`, price !== undefined ? { price } : {}),
  remove: (id: string) => request<{ ok: true }>("DELETE", `/api/paper/positions/${id}`),
  mark: () => request<{ marked: number; closed: number }>("POST", "/api/paper/mark"),
  reset: () => request<{ deleted: number }>("POST", "/api/paper/reset"),
};
export const fmtPnl = (n?: number) => (n === undefined ? "—" : `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`);

// 1.10 — Polymarket US account connection (reads only; no order submission exists in this build)
export const tradingApi = {
  status: () => request<TradingStatus>("GET", "/api/trading/status"),
  audit: (limit = 50) => request<TradingAuditEvent[]>("GET", `/api/trading/audit?limit=${limit}`),
  test: (body: { keyId?: string; secretKey?: string }) => request<TradingConnectionTest>("POST", "/api/trading/connection/test", body),
  connect: (body: { keyId: string; secretKey: string; assertSameAccount?: boolean }) => request<{ binding: TradingAccountBinding; test: TradingConnectionTest; sync?: TradingAccountSync; status: TradingStatus }>("PUT", "/api/trading/connection", body),
  disconnect: () => request<{ disconnected: boolean; cancellations: { orderId: string; outcome: string; message?: string }[]; note: string; status: TradingStatus }>("DELETE", "/api/trading/connection"),
  sync: () => request<TradingAccountSync>("POST", "/api/trading/sync"),
  setMode: (mode: TradingMode, acknowledge?: string) => request<{ policy: TradingPolicy; gates: TradingGate[]; status?: TradingStatus }>("PUT", "/api/trading/policy", acknowledge ? { mode, acknowledge } : { mode }),
  /** 1.13 (EXE-01): one statement; live modes fall back to paper and the authorization is cleared. */
  disarm: (reason?: string) => request<{ policy: TradingPolicy; gates: TradingGate[]; status: TradingStatus }>("POST", "/api/trading/disarm", reason ? { reason } : {}),
};
export const fmtAmount = (a?: DecimalAmount) => (a ? `${a.currency === "USD" ? "$" : `${a.currency} `}${a.value}` : "—");

// ---------------------------------------------------------------------------
// 1.11 — source subscriptions, evidence dossier, contract verification (no execution)
// ---------------------------------------------------------------------------

import type { ContractVerification, EvidenceDossier, SourceRecord, SourceSubscription, SubscriptionRunSummary, UsCandidateSearch } from "@prediction-ledger/shared";

export interface SubscriptionInput {
  url: string; title?: string; enabled?: boolean; pollIntervalHours?: number; lookbackDays?: number; maxVideosPerRun?: number; autoExtract?: boolean; categoryAllowlist?: string[];
  researchBudget?: { maxSearches?: number; maxSources?: number };
}
export const subscriptionsApi = {
  list: () => request<SourceSubscription[]>("GET", "/api/source-subscriptions"),
  get: (id: string) => request<SourceSubscription & { runs: SubscriptionRunSummary[] }>("GET", `/api/source-subscriptions/${id}`),
  create: (body: SubscriptionInput) => request<SourceSubscription>("POST", "/api/source-subscriptions", body),
  update: (id: string, patch: Partial<Omit<SubscriptionInput, "url">> & { researchBudget?: SubscriptionInput["researchBudget"] | null }) => request<SourceSubscription>("PATCH", `/api/source-subscriptions/${id}`, patch),
  remove: (id: string) => request<{ ok: true }>("DELETE", `/api/source-subscriptions/${id}`),
  runNow: (id: string) => request<{ jobId: string }>("POST", `/api/source-subscriptions/${id}/run`),
};

export const dossierApi = {
  get: (predictionId: string, opts: { asOf?: string; assumePublished?: boolean } = {}) => request<EvidenceDossier>("GET", `/api/predictions/${predictionId}/dossier${qs({ asOf: opts.asOf, assumePublished: opts.assumePublished })}`),
  withdrawSource: (sourceId: string, note?: string) => request<SourceRecord & { note: string }>("POST", `/api/sources/${sourceId}/withdraw`, note ? { note } : {}),
  restoreSource: (sourceId: string) => request<SourceRecord & { note: string }>("POST", `/api/sources/${sourceId}/withdraw`, { restore: true }),
  recheckSource: (sourceId: string) => request<SourceRecord & { checked: { status: string; httpStatus?: number; outcome: "ok" | "missing" | "error" } }>("POST", `/api/sources/${sourceId}/recheck`),
};

export interface VerifyFacts { [fieldId: string]: { value: string; source: string } }
export const contractsApi = {
  usCandidates: (predictionId: string, opts: { url?: string; limit?: number } = {}) => request<UsCandidateSearch>("POST", `/api/predictions/${predictionId}/us-candidates`, opts),
  verify: (linkId: string, body: { facts?: VerifyFacts; notes?: string } = {}) => request<ContractVerification>("POST", `/api/market-links/${linkId}/verify-contract`, body),
  verifications: (linkId: string) => request<{ link: PredictionMarketLink; verifications: ContractVerification[] }>("GET", `/api/market-links/${linkId}/verifications`),
  revalidate: (linkId: string) => request<{ verification?: ContractVerification; reasons: string[]; refreshed: boolean }>("POST", `/api/market-links/${linkId}/revalidate`),
};
export const VERIFICATION_LABEL: Record<ContractVerification["status"], string> = {
  unverified: "Unverified",
  incomplete: "Incomplete",
  incompatible: "Incompatible",
  research_only: "Research only",
  verified_equivalent: "Verified equivalent",
  stale: "Stale",
};

// ---------------------------------------------------------------------------
// 1.12 — forecasts, paper decisions, risk limits, US paper book (no order path exists)
// ---------------------------------------------------------------------------

import type { ContractVerification as _CV, DecisionOutcome, EvidenceDossier as _ED, ForecastEvaluation, ForecastSnapshot, PaperUsBook, RiskExposure, RiskLimits, RiskReservation, TradeDecision } from "@prediction-ledger/shared";

export interface LimitsResponse { policyVersion: string; limits: RiskLimits; budgetTimezone: string; policyHash: string; mode?: TradingMode }
export interface DecisionEvidence { decision: TradeDecision; forecast?: ForecastSnapshot; verification?: _CV; dossier?: _ED; reservation?: RiskReservation }
export const decisionsApi = {
  evaluate: (body: { predictionId: string; linkId?: string; candidateQuantity?: string; dryRun?: boolean }) => request<TradeDecision>("POST", "/api/trading/decisions", body),
  list: (f: { mode?: TradingMode; outcome?: DecisionOutcome; from?: string; to?: string; predictionId?: string; limit?: number } = {}) => request<TradeDecision[]>("GET", `/api/trading/decisions${qs({ mode: f.mode, outcome: f.outcome, from: f.from, to: f.to, predictionId: f.predictionId, limit: f.limit ? String(f.limit) : undefined })}`),
  get: (id: string) => request<TradeDecision>("GET", `/api/trading/decisions/${id}`),
  evidence: (id: string) => request<DecisionEvidence>("GET", `/api/trading/decisions/${id}/evidence`),
  exposure: () => request<RiskExposure & { unreflectedReservations: string; limits: RiskLimits }>("GET", "/api/trading/exposure"),
  limits: () => request<LimitsResponse>("GET", "/api/trading/limits"),
  setLimits: (patch: Partial<RiskLimits> & { budgetTimezone?: string }) => request<LimitsResponse>("PUT", "/api/trading/limits", patch),
};
export const forecastsApi = {
  build: (predictionId: string, linkId?: string) => request<ForecastSnapshot>("POST", "/api/forecasts", { predictionId, linkId }),
  get: (id: string) => request<ForecastSnapshot>("GET", `/api/forecasts/${id}`),
  forPrediction: (predictionId: string) => request<ForecastSnapshot[]>("GET", `/api/predictions/${predictionId}/forecasts`),
  evaluation: (category?: string) => request<ForecastEvaluation>("GET", `/api/forecasts/evaluation${qs({ category })}`),
};
export const paperUsApi = {
  get: () => request<PaperUsBook>("GET", "/api/paper/us"),
  setBankroll: (bankrollStart: string) => request<PaperUsBook>("PUT", "/api/paper/us/bankroll", { bankrollStart }),
  reset: () => request<{ deleted: number }>("POST", "/api/paper/us/reset"),
};
export const fmtUsd = (s?: string) => (s === undefined || s === "" ? "—" : `${s.startsWith("-") ? "−" : ""}$${Number(s.replace("-", "")).toFixed(2)}`);
export const OUTCOME_LABEL: Record<DecisionOutcome, string> = { eligible: "Eligible", skipped: "Skipped", needs_review: "Needs review" };

// ---------------------------------------------------------------------------
// 1.13 — manual-live execution: preview → confirm, intents, orders, holds, reconciliation (fake venue in tests)
// ---------------------------------------------------------------------------

import type { DispatchLease, ExecutionRecord, IntentState, LivePosition, OrderPreviewRecord, ReconciliationHold, SettlementEventRecord, TradeIntent, VenueOrderRecord } from "@prediction-ledger/shared";

export interface ReconcileReport { bindingId: string; syncedAt: string; ordersChecked: number; executionsAdded: number; activitiesRead: number; settlements: number; unknownIntents: { intentId: string; candidates: string[] }[]; discrepancies: { marketSlug: string; venueNet: string; localNet: string }[]; holdsOpen: number; paused: boolean }
export const executionApi = {
  preview: (decisionId: string) => request<OrderPreviewRecord>("POST", `/api/trading/decisions/${decisionId}/preview`, {}),
  submit: (decisionId: string, previewId: string, decisionHash: string) => request<TradeIntent>("POST", `/api/trading/decisions/${decisionId}/submit`, { previewId, decisionHash }),
  intents: (f: { state?: IntentState; mode?: "paper" | "live"; limit?: number } = {}) => request<TradeIntent[]>("GET", `/api/trading/intents${qs({ state: f.state, mode: f.mode, limit: f.limit ? String(f.limit) : undefined })}`),
  intent: (id: string) => request<TradeIntent>("GET", `/api/trading/intents/${id}`),
  cancel: (id: string) => request<{ outcome: string; message?: string }>("POST", `/api/trading/intents/${id}/cancel`, {}),
  resolveUnknown: (id: string, body: { venueOrderId: string; note: string } | { outcome: "not_submitted"; note: string }) => request<TradeIntent>("POST", `/api/trading/intents/${id}/resolve-unknown`, body),
  orders: (f: { external?: boolean; limit?: number } = {}) => request<VenueOrderRecord[]>("GET", `/api/trading/orders${qs({ external: f.external === undefined ? undefined : String(f.external), limit: f.limit ? String(f.limit) : undefined })}`),
  order: (id: string) => request<VenueOrderRecord & { executions: ExecutionRecord[] }>("GET", `/api/trading/orders/${id}`),
  reconcile: () => request<ReconcileReport>("POST", "/api/trading/reconcile", {}),
  holds: (open = false) => request<ReconciliationHold[]>("GET", `/api/trading/holds${qs({ open: open ? "true" : undefined })}`),
  resolveHold: (id: string, resolution: string) => request<ReconciliationHold>("POST", `/api/trading/holds/${id}/resolve`, { resolution }),
  positions: () => request<LivePosition[]>("GET", "/api/trading/positions"),
  settlements: () => request<SettlementEventRecord[]>("GET", "/api/trading/settlements"),
  lease: () => request<DispatchLease & { stream: string }>("GET", "/api/trading/lease"),
  exportUrl: "/api/trading/export",
};
export const INTENT_LABEL: Record<IntentState, string> = {
  prepared: "Prepared", reserved: "Reserved (not sent)", submitting: "Sending…", acknowledged: "Accepted by venue (open)", filled: "Filled", partially_filled: "Partially filled", canceled: "Canceled (no fill)",
  rejected: "Rejected by venue", rejected_local: "Not sent", skipped: "Skipped", expired: "Expired (never sent)", submission_unknown: "Unknown — reconciling",
};
