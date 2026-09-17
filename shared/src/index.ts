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

export interface ResearchSettings {
  /** When true, the Research button requires the user to have looked at (and optionally edited) the plan first (VP-04). */
  reviewPlanBeforeResearch: boolean;
  /** Suggested recheck interval for pending-deadline predictions, in days. */
  recheckAfterDays: number;
  /** Max characters of a source sent to the model for evidence extraction. */
  maxSourceChars: number;
}

export interface AppSettings {
  research: ResearchSettings;
  providers: Record<LlmProviderId, LlmProviderSettings>;
  stages: Record<AnalysisStage, StageAssignment>;
  transcription: {
    engine: TranscriptionProviderId;
    /** Whisper model id for the local engine, e.g. "onnx-community/whisper-base". */
    localModel: string;
    /** OpenAI transcription model; whisper-1 returns segment timestamps, gpt-4o-*-transcribe do not. */
    openaiModel: string;
    language: string; // "auto" or ISO-639-1
    chunkSeconds: number;
    overlapSeconds: number;
  };
  sports: {
    /** Sports Mode: videos are game-pick content; extraction targets team-vs-team picks with the game as the deadline. */
    enabled: boolean;
    /** Track point spreads (cover/no cover). Off = every pick is win/loss on the named team. */
    trackSpreads: boolean;
  };
  /** 1.6 — prediction markets (read-only). */
  markets: {
    enabled: boolean;
    provider: MarketProviderId;
    /** Venues searched by Find markets and refreshed by snapshots (1.8). */
    venues: MarketProviderId[];
    /** Hours between automatic snapshot refreshes of linked/watched markets (0 = manual only). */
    refreshHours: number;
    /** Max markets refreshed per snapshot run. */
    snapshotBudget: number;
    /** Auto-accept a link when the match is an exact sports matchup (teams + game date). */
    autoLinkSports: boolean;
    /** 1.7 — signal gates. */
    signals: {
      /** Prior weight k: a creator's realized edge is shrunk by n/(n+k) toward zero. */
      priorWeight: number;
      /** Settled, market-linked predictions a creator needs before a label is shown. */
      minSettledLean: number;
      minSettledModerate: number;
      minSettledStrong: number;
      /** Venue liquidity (quote currency) below which no label is shown. */
      minLiquidity: number;
    };
    /** 1.9 — paper trading: hypothetical positions marked against snapshots. Never places orders. */
    paper: {
      enabled: boolean;
      /** Starting bankroll in the venue's quote unit (Polymarket: USDC-equivalent dollars). */
      bankroll: number;
      /** "fixed" = every position stakes `fixedStake`; "kelly" = fractional Kelly on the signal's edge, capped at `maxStakeFraction` of bankroll. */
      sizing: "fixed" | "kelly";
      fixedStake: number;
      kellyFraction: number;
      maxStakeFraction: number;
      /** Open a paper position automatically when a signal reaches this label (off = never). */
      autoOpen: "off" | "lean" | "moderate" | "strong";
      maxOpenPositions: number;
    };
    /** 1.8 — watch rules evaluated after every snapshot run. */
    watch: {
      enabled: boolean;
      /** Alert when a linked/watched market's first-side price moved at least this many points since ~24 h ago. */
      movePts: number;
      /** Alert when a labelled signal's estimate differs from the market by at least this many points. */
      divergencePts: number;
      /** Alert when a market with an open linked prediction resolves within this many days. */
      resolveDays: number;
    };
  };
  youtube: {
    /** Which captions to accept before falling back to audio: creator-uploaded only, or auto-generated too, or none. */
    captions: "manual-then-auto" | "manual-only" | "never";
    /** Download the audio track (via yt-dlp) when no acceptable captions exist. */
    allowAudioDownload: boolean;
    /** Preferred caption language ("auto" = transcription language → video language → en). */
    captionLanguage: string;
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
    /** Per-request model timeout in seconds (each try; 429/5xx retries are bounded separately). */
    modelTimeoutSeconds: number;
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
  | "assessment.run"
  | "tool.install"
  | "model.download"
  /** 1.4: find the game record (date, final score, winner) for a matchup and settle every pick on it. */
  | "sports.resolve_game"
  /** 1.6: refresh snapshots of linked/watched markets. */
  | "market.snapshot"
  /** 1.6: propose market links for one prediction. */
  | "market.match"
  /** 1.11: poll a saved channel/playlist subscription and queue new videos. */
  | "subscription.poll"
  /** 1.7: fetch the venue price nearest a prediction's made-on date for a link. */
  | "market.backfill"
  /** 1.8: evaluate watch rules over stored markets and signals. */
  | "market.watch"
  /** 1.8: list a YouTube playlist/channel and queue each video's import. */
  | "playlist.import";

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
  /** Handler return value once completed (1.8: shown for bulk imports and watch runs). */
  result?: Record<string, unknown>;
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
  /** 2.0 (OPS-01): the secret key file's protection as verified at startup — a parsed Windows ACL or a POSIX mode. */
  keyFileProtection?: { method: "icacls" | "posix_mode" | "unavailable"; ok: boolean; detail: string; fix?: string };
}

/** Header the browser must send on every mutating request (CSRF guard). */
export const CSRF_HEADER = "x-prediction-ledger";
export const CSRF_VALUE = "1";
/** 1.13 (EXE-01): the exact text an owner must send to enter manual-live mode; anything else is refused server-side. */
export const LIVE_ACKNOWLEDGEMENT = "I understand this places real orders with real money";
/** 1.14 (AUTO-01): the exact text an owner must send to arm automatic trading, together with the policy hash they reviewed. */
export const AUTO_LIVE_ACKNOWLEDGEMENT = "I authorize automatic real-money orders under the policy hash I reviewed";
/** 1.14 (AUTO-03): account-wide cancellation is a separately labelled owner action, never the default. */
export const CANCEL_ALL_ACKNOWLEDGEMENT = "Cancel every open order on this account, including orders I placed elsewhere";
export const DEFAULT_AUTOMATION: AutomationSettings = { intervalMs: 60_000, maxEvaluationsPerTick: 10, maxOrdersPerTick: 1, maxPerSourcePerTick: 2, maxMatchJobsPerTick: 3, maxVerificationsPerTick: 5, minReevaluateMs: 300_000, revalidateAfterMs: 600_000, breakerThreshold: 5, breakerCooldownMs: 300_000, paperAutopilot: false };

// ---------------------------------------------------------------------------
// Release 0.2 — videos, transcripts, predictions, validation plans
// ---------------------------------------------------------------------------

export type SourceKind = "local" | "youtube" | "transcript";
export type VideoStatus = "importing" | "transcribing" | "ready" | "extracting" | "failed";

export interface VideoSummary {
  id: string;
  title: string;
  sourceKind: SourceKind;
  sourceRef?: string;
  durationS?: number;
  publishedAt?: string;
  language?: string;
  importedAt: string;
  status: VideoStatus;
  segmentCount: number;
  predictionCount: number;
  pendingPredictionCount: number;
  /** Local media only (0.4+). */
  mediaSize?: number;
  transcriptionEngine?: string;
  transcriptionModel?: string;
  error?: string;
  /** Chunk progress for resumable transcription. */
  chunksDone?: number;
  chunksTotal?: number;
  /** YouTube imports (0.5+). */
  youtubeId?: string;
  /** 1.11 provenance: channel id when the venue exposes it; how precise `publishedAt` is; when the app first learned of the video. */
  channelId?: string;
  publishedPrecision?: "datetime" | "date" | "unknown";
  firstSeenAt?: string;
  /** sha256 over the original (uncorrected) transcript text; changes only when the transcript is regenerated. */
  transcriptHash?: string;
  subscriptionId?: string;
  channel?: string;
  /** How the transcript was obtained. */
  transcriptSource?: TranscriptSource;
}

export type TranscriptSource = "captions-manual" | "captions-auto" | "transcribed" | "imported";

/** Body for POST /api/videos/import-youtube */
export interface YouTubeImportRequest {
  url: string;
  /** Overrides the upload date reported by YouTube (YYYY-MM-DD). */
  publishedAt?: string;
  language?: string;
  title?: string;
}

/** GET /api/tools/status */
export interface ToolsStatus {
  ffmpeg: { ok: boolean; message: string; source?: string };
  ytdlp: { ok: boolean; message: string; version?: string; source?: string; installedAt?: string };
  /** False when the privacy switch is off — installs and YouTube imports are refused. */
  internet: boolean;
}

/** Status of media tooling and transcription engines (Setup → Transcription, Library banner). */
export interface MediaStatus {
  ffmpeg: { ok: boolean; message: string; source?: string };
  engine: { id: TranscriptionProviderId; ok: boolean; message: string; needsDownload?: boolean };
}

export interface TranscriptSegment {
  id: string;
  seq: number;
  startS: number;
  endS: number;
  textOriginal: string;
  textCorrected?: string;
  speaker?: string;
  engine: string;
}

export interface VideoDetail extends VideoSummary {
  segments: TranscriptSegment[];
  notes?: string;
}

/** Body for POST /api/videos/import-transcript */
export interface TranscriptImportRequest {
  title: string;
  /** Raw file contents. */
  content: string;
  /** "srt" | "vtt" | "txt" | "json" | "auto" */
  format: "srt" | "vtt" | "txt" | "json" | "auto";
  /** Original filename, kept as source_ref. */
  filename?: string;
  /** ISO date (YYYY-MM-DD) when the recording was published/made, if known. Never inferred. */
  publishedAt?: string;
  language?: string;
}

export type PredictionUserStatus = "pending" | "accepted" | "dismissed" | "merged";
export type ComponentKind = "future_claim" | "premise" | "causal_link";
export type MadeOnBasis = "statement" | "publication" | "user" | "unknown";

export interface PredictionComponent {
  id: string;
  seq: number;
  kind: ComponentKind;
  statement: string;
  deadlineDate?: string;
  notes?: string;
}

export interface PredictionOccurrence {
  startS?: number;
  endS?: number;
  windowId: string;
}

/**
 * Sports picks (1.2): a prediction about a single game reduces to who wins, the spread, or the total.
 * The app validates these deterministically — find the final score — instead of the open-ended
 * research loop used for general predictions.
 */
export type PickType = "moneyline" | "spread" | "total";
export interface SportsPick {
  sport: string; // "NFL", "NBA", "NHL", "MLB", "soccer", "college football", …
  league?: string;
  /** Teams as spoken; `team` inside `pick` must match one of them for moneyline/spread. */
  teams: [string, string];
  /** Game date (YYYY-MM-DD) when stated or inferable from the transcript; never guessed. */
  eventDate?: string;
  /** Kick-off / tip-off time as spoken (e.g. "8:20 PM ET"), informational. */
  eventTime?: string;
  /** Non-date time reference from the transcript ("Week 1", "Thursday night opener") — drives the schedule look-up (1.3.1). */
  eventHint?: string;
  /** Where the game date came from: the transcript, a schedule look-up (1.3.1), or a user edit. */
  eventDateSource?: "transcript" | "lookup" | "user";
  /** Schedule page the date was read from, when it came from a look-up. */
  eventDateSourceUrl?: string;
  pick: {
    type: PickType;
    /** Winner (moneyline) or covering team (spread). */
    team?: string;
    /** Spread line (negative = favourite, e.g. -3.5) or total line (e.g. 45.5). */
    line?: number;
    /** For totals. */
    side?: "over" | "under";
  };
}
export type PredictionKind = "general" | "sports_pick";

/**
 * 1.4 — one record per real game. Every pick on the same matchup settles against the same record:
 * "A and B played on <date>, final score X–Y" is looked up once, then each pick is checked by rule.
 */
export interface Game {
  id: string;
  sport: string;
  league?: string;
  matchupKey: string;
  teams: [string, string];
  eventDate?: string;
  eventTime?: string;
  status: "scheduled" | "final" | "postponed" | "unknown";
  /** Final scores in `teams` order. */
  scores?: [number, number];
  overtime: boolean;
  winner?: string | "tie";
  sourceId?: string;
  sourceUrl?: string;
  /** The verbatim line the score was read from. */
  excerpt?: string;
  lookupVia?: string;
  notes: string[];
  retrievedAt?: string;
  updatedAt: string;
}

export interface Prediction {
  id: string;
  videoId: string;
  /** "sports_pick" predictions use the simplified game-result validation path. */
  kind: PredictionKind;
  sportsPick?: SportsPick;
  /** 1.4: the game record this pick settles against, once looked up. */
  gameId?: string;
  videoTitle?: string;
  quoteExact: string;
  contextBefore?: string;
  contextAfter?: string;
  startS?: number;
  endS?: number;
  speaker?: string;
  normalizedStatement: string;
  entities: string[];
  topic?: string;
  geography?: string;
  scope?: string;
  conditions: string[];
  thresholds: string[];
  modality?: string;
  madeOnDate?: string;
  madeOnBasis: MadeOnBasis;
  timeExpression?: string;
  deadlineDate?: string;
  deadlineBasis?: string;
  ambiguities: string[];
  extractionConfidence?: number;
  userStatus: PredictionUserStatus;
  mergedIntoId?: string;
  duplicateOfId?: string;
  occurrences: PredictionOccurrence[];
  extractionProvider?: string;
  extractionModel?: string;
  extractionTemplate?: string;
  /** 1.11: sha256 of `quoteExact` and of the transcript it was located in; `analysisVersion` counts extraction passes over the video. */
  quoteHash?: string;
  transcriptHash?: string;
  analysisVersion?: number;
  components: PredictionComponent[];
  /** Latest plan version number, if any. */
  latestPlanVersion?: number;
  createdAt: string;
  updatedAt: string;
}

/** Fields a user may edit (everything else is immutable or derived). */
export interface PredictionEdit {
  normalizedStatement?: string;
  topic?: string;
  geography?: string;
  scope?: string;
  speaker?: string;
  madeOnDate?: string;
  deadlineDate?: string;
  conditions?: string[];
  ambiguities?: string[];
  components?: { kind: ComponentKind; statement: string; deadlineDate?: string; notes?: string }[];
}

/** Structured validation plan (template plan.v1). Stored as plan_json. */
export interface ValidationPlanBody {
  proposition: string;
  components: { statement: string; kind: ComponentKind; conditions: string[] }[];
  dates: { predictionMade?: string; deadline?: string; researchCutoff: string; notes?: string };
  definitions: { term: string; workingDefinition: string }[];
  ambiguities: string[];
  supportingEvidence: string[];
  contradictingEvidence: string[];
  partialFulfillmentCriteria: string[];
  queries: { neutral: string[]; supporting: string[]; disconfirming: string[] };
  preferredSourceTypes: string[];
  outputSchemaNotes: string;
}

export interface ValidationPlan {
  id: string;
  predictionId: string;
  version: number;
  plan: ValidationPlanBody;
  researchPrompt: string;
  provider: string;
  model?: string;
  templateVersion: string;
  editedByUser: boolean;
  createdAt: string;
}

export interface PredictionFilters {
  videoId?: string;
  kind?: PredictionKind;
  topic?: string;
  userStatus?: PredictionUserStatus;
  deadlineBefore?: string;
  deadlineAfter?: string;
  includeDismissed?: boolean;
}

export interface PromptTemplateInfo {
  name: "extraction" | "plan" | "evidence" | "assessment" | "sports_assessment";
  builtInVersion: string;
  builtInBody: string;
  override?: { body: string; baseVersion: string; updatedAt: string };
}

// ---------------------------------------------------------------------------
// Release 0.3 — research runs, sources, evidence, assessments, export
// ---------------------------------------------------------------------------

export type EvidenceAssessment = "supported" | "partially_supported" | "contradicted" | "insufficient" | "not_assessable";
export type TimeStatusValue = "pending" | "reached" | "unknown";
export type Stance = "supports" | "contradicts" | "context";
export type ActionStage = "proposed" | "announced" | "enacted" | "approved" | "completed" | "other";
export type RunStatus = "running" | "completed" | "failed" | "cancelled";
export type QueryGroup = "neutral" | "supporting" | "disconfirming";

export const EVIDENCE_ASSESSMENT_LABEL: Record<EvidenceAssessment, string> = {
  supported: "Supported",
  partially_supported: "Partially supported",
  contradicted: "Contradicted",
  insufficient: "Insufficient evidence",
  not_assessable: "Not assessable as stated",
};

export const TIME_STATUS_LABEL: Record<TimeStatusValue, string> = {
  pending: "Deadline pending",
  reached: "Deadline reached",
  unknown: "Deadline unknown",
};

export interface SourceRecord {
  id: string;
  url: string;
  canonicalUrl: string;
  title?: string;
  publisher?: string;
  publishedAt?: string;
  retrievedAt: string;
  fetchStatus: "ok" | "blocked" | "error" | "too_large" | "timeout" | "unsupported";
  httpStatus?: number;
  contentChars?: number;
  syndicatedOf?: string;
  accessNotes?: string;
  /** 1.11 provenance: sha256 of the stored text; when the app first fetched it (vs. when it says it was published). */
  contentHash?: string;
  firstSeenAt?: string;
  /** available | withdrawn (by the user) | missing (URL no longer answers). Excerpts and hashes are never rewritten. */
  status: "available" | "withdrawn" | "missing";
  statusChangedAt?: string;
  statusNote?: string;
  /** Sources with the same group are one voice (same publisher, or the same/near-identical text). */
  independenceGroup?: string;
  lastCheckedAt?: string;
  lastHttpStatus?: number;
}

export interface EvidenceItem {
  id: string;
  runId: string;
  sourceId: string;
  source?: SourceRecord;
  componentId?: string;
  stance: Stance;
  excerpt: string;
  fact?: string;
  eventDate?: string;
  actionStage?: ActionStage;
  /** true = inside the deadline window; false = later development; undefined = undated */
  inWindow?: boolean;
  qualityNotes?: string;
  independent: boolean;
}

export interface ResearchRun {
  id: string;
  predictionId: string;
  validationPlanId: string;
  planVersion?: number;
  status: RunStatus;
  searchProvider: string;
  cutoffDate: string;
  queries: { group: QueryGroup; query: string; resultCount: number; error?: string; cached?: boolean }[];
  coverageNotes: string[];
  searchesUsed: number;
  sourcesFetched: number;
  sourcesFailed: number;
  evidenceProvider?: string;
  evidenceModel?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  evidenceCount?: number;
  /** 1.11: `verdict` runs settle the past (they chain an assessment); `forecast` runs gather evidence about a future event and never produce a settlement. */
  purpose: "verdict" | "forecast";
  /** Instant after which nothing may be treated as known to this run (`cutoffDate` end of day when unset). */
  cutoffAt?: string;
}

export interface ComponentAssessment {
  id: string;
  componentId?: string;
  componentKind: ComponentKind;
  statement: string;
  assessment: EvidenceAssessment;
  explanation: string;
  evidenceIds: string[];
}

export interface Assessment {
  id: string;
  predictionId: string;
  runId: string;
  validationPlanId: string;
  planVersion?: number;
  version: number;
  evidenceAssessment: EvidenceAssessment;
  timeStatus: TimeStatusValue;
  explanation: string;
  uncertainty?: string;
  confidence: "high" | "medium" | "low";
  confidenceRationale?: string;
  supportingIds: string[];
  contradictingIds: string[];
  citations: { claim: string; evidenceIds: string[] }[];
  laterDevelopments?: string;
  guardNotes: string[];
  components: ComponentAssessment[];
  provider: string;
  model?: string;
  templateVersion: string;
  researchedAt: string;
  recheckAfter?: string;
  createdAt: string;
}

/** Summary attached to prediction rows for the table (latest assessment, if any). */
export interface ResultSummary {
  assessmentId: string;
  version: number;
  evidenceAssessment: EvidenceAssessment;
  timeStatus: TimeStatusValue;
  explanation: string;
  confidence: "high" | "medium" | "low";
  sourceCount: number;
  researchedAt: string;
  recheckAfter?: string;
}

/** Processing status for the table (VD-01): separate from evidence assessment and time status. */
export type ProcessingStatus = "not_researched" | "running" | "completed" | "failed";

export interface SearchResult {
  url: string;
  title?: string;
  snippet?: string;
  /** Provider-supplied age/date hint, free text. */
  pageAge?: string;
}

export interface ExportBundle {
  exportedAt: string;
  appVersion: string;
  videos: VideoSummary[];
  predictions: Prediction[];
  plans: ValidationPlan[];
  runs: ResearchRun[];
  sources: SourceRecord[];
  evidence: EvidenceItem[];
  assessments: Assessment[];
  /** 1.4 */
  games?: Game[];
  /** 1.6 */
  markets?: MarketRecord[];
  marketLinks?: PredictionMarketLink[];
  /** 1.10 — secret-free: bindings carry masked hints and fingerprints only. */
  tradingBindings?: TradingAccountBinding[];
  tradingAudit?: TradingAuditEvent[];
  /** 1.12 — lineage of every paper decision (skipped ones included); never credentials. */
  forecasts?: ForecastSnapshot[];
  tradeDecisions?: TradeDecision[];
  paperUsPositions?: PaperUsPosition[];
  /** 1.13 — live lineage: intents, venue orders (external ones labelled, with no invented rationale), executions, settlements, holds. */
  tradeIntents?: TradeIntent[];
  venueOrders?: VenueOrderRecord[];
  executions?: ExecutionRecord[];
  settlementEvents?: SettlementEventRecord[];
  reconciliationHolds?: ReconciliationHold[];
}

// ---------------------------------------------------------------------------
// Release 1.6 — prediction markets in the ledger
// ---------------------------------------------------------------------------

/**
 * Market venues. `polymarket` = Polymarket international (Gamma/CLOB, read-only), `manifold` = Manifold
 * (play money, read-only), `polymarket_us` = Polymarket US retail (1.10: read-only discovery; the only
 * venue that can ever reach the separate execution adapter). Records are namespaced by this id and are
 * never converted between venues.
 */
export type MarketProviderId = "polymarket" | "manifold" | "polymarket_us";

export interface MarketRecord {
  id: string;
  provider: MarketProviderId;
  venueId: string;
  conditionId?: string;
  slug: string;
  url: string;
  question: string;
  /** Resolution rules as published by the venue. */
  description?: string;
  event?: { id: string; slug: string; title: string };
  outcomes: { label: string; tokenId?: string }[];
  endDate?: string;
  startDate?: string;
  active: boolean;
  closed: boolean;
  restricted: boolean;
  resolved: boolean;
  resolvedOutcome?: string;
  /** 1.12 — when the app first observed the venue's resolution (never the venue's own settlement time). */
  resolvedAt?: string;
  tags: string[];
  watched: boolean;
  updatedAt: string;
  /** Latest snapshot, when one exists. */
  latest?: MarketSnapshot;
  /** 1.10 — venue contract constraints (Polymarket US only). Absent for other venues. */
  constraints?: MarketContractConstraints;
}

/**
 * 1.10 — what a venue says about a tradable contract, as published, without interpretation. Values that the
 * venue omits stay undefined: a missing field blocks the dependent execution category (spec §14.4), it is never
 * defaulted. Amounts are decimal strings with the unit declared.
 */
export interface MarketContractConstraints {
  venue: "polymarket_us";
  /** Venue market slug — the symbol every private endpoint keys on. */
  slug: string;
  /** Venue status string as published (e.g. MARKET_STATUS_OPEN); undocumented in the OpenAPI schema, captured verbatim. */
  status?: string;
  /** Smallest valid price increment for `price.value` (decimal string, USD). */
  tickSize?: string;
  /** Smallest valid order quantity in contracts (decimal string; "0.01" = 1 % of a contract). */
  minQuantity?: string;
  /** Fee coefficient Θ published on the market at retrieval time. Effective-dated by the venue; never frozen in code. */
  feeCoefficient?: string;
  /** Durable side identifiers. `long` marks the YES-denominated instrument; NO is synthetic (1 − YES). */
  sides: { id: string; label: string; long: boolean; tradable?: boolean; team?: { id?: string; name: string; abbreviation?: string; league?: string; alias?: string } }[];
  category?: string;
  sportsMarketType?: string;
  line?: string;
  /** Event/game start as published (ISO). The earliest applicable of these is the pre-event cutoff basis (MAT-06, 1.11). */
  gameStartTime?: string;
  eventStartTime?: string;
  eventId?: string;
  /** Best YES bid/ask at retrieval (decimal strings, USD). */
  bestBid?: string;
  bestAsk?: string;
  retrievedAt: string;
}

export interface MarketSnapshot {
  id: string;
  marketId: string;
  retrievedAt: string;
  /** In the market's outcomes order. Prices are probabilities 0–1. */
  prices: { label: string; price?: number; bestBid?: number; bestAsk?: number }[];
  liquidity?: number;
  volume?: number;
  volume24h?: number;
  spread?: number;
  source: "gamma" | "clob" | "history";
}

export type MarketLinkStatus = "proposed" | "accepted" | "rejected";
export type MarketLinkRelation = "exact" | "same" | "narrower" | "broader" | "different";

export interface PredictionMarketLink {
  id: string;
  predictionId: string;
  marketId: string;
  /** Outcome label the prediction implies ("Yes", a team name). */
  side?: string;
  /** 0–1 match score. */
  score: number;
  relation?: MarketLinkRelation;
  rationale?: string;
  status: MarketLinkStatus;
  matchedBy: "rule:sports" | "rule:text" | "model" | "user";
  /** Side price nearest the prediction's made-on date, when a snapshot/history point exists. */
  priceAtMade?: number;
  /** Instant of that price point and where it came from (1.7). */
  priceAtMadeAt?: string;
  priceAtMadeSource?: "history" | "snapshot";
  createdAt: string;
  updatedAt: string;
  market?: MarketRecord;
  /** 1.11 (MAT-03): execution eligibility, independent of `score`/`status`. Only `verified_equivalent` can ever qualify. */
  verificationStatus: ContractVerificationStatus;
  verificationId?: string;
}

// ---------------------------------------------------------------------------
// Release 1.7 — signals: creator record vs market
// ---------------------------------------------------------------------------

/** Who made the claims: the video's channel when known, otherwise the video itself. */
export interface CreatorRecord {
  key: string;
  label: string;
  /** Predictions by this creator (all kinds, any status). */
  predictions: number;
  /** Settled = latest assessment supported / contradicted / partially supported. */
  settled: number;
  hits: number;
  misses: number;
  partial: number;
  hitRate?: number;
  /** Subset of settled predictions with an accepted market link and a price when the claim was made. */
  linkedSettled: number;
  /** Mean of (outcome − market price at made) over linkedSettled: realized edge per $1 at the market's price. */
  realizedEdge?: number;
  /** Mean (marketPrice − outcome)² over linkedSettled — how good the market was on this creator's questions. */
  marketBrier?: number;
  /** Mean (1 − outcome)² — the creator stated the side as certain. */
  creatorBrier?: number;
  /** n/(n+k) shrinkage applied to realizedEdge. */
  shrunkEdge?: number;
  open: number;
}

export type SignalConfidence = "strong" | "moderate" | "lean" | "none";

export interface SignalContribution {
  predictionId: string;
  videoId: string;
  videoTitle?: string;
  creatorKey: string;
  creatorLabel: string;
  linkId: string;
  quote: string;
  madeOnDate?: string;
  priceAtMade?: number;
  /** Creator record numbers used for this contribution. */
  settled: number;
  realizedEdge?: number;
  shrunkEdge?: number;
  weight: number;
}

export interface MarketSignal {
  marketId: string;
  question: string;
  url: string;
  eventTitle?: string;
  side: string;
  /** Latest snapshot price of the side. */
  marketPrice?: number;
  asOf?: string;
  liquidity?: number;
  volume24h?: number;
  endDate?: string;
  /** Weighted mean of contributors' shrunk edges. */
  edge?: number;
  /** marketPrice + edge, clamped to (0.01, 0.99). */
  estimate?: number;
  confidence: SignalConfidence;
  /** Why the label is what it is (gates that passed / failed). */
  reasons: string[];
  /** Independent creators (same video counts once). */
  creators: number;
  contributions: SignalContribution[];
  /** Prediction deadlines vs market end: "consistent" | "inconsistent" | "unknown". */
  deadlineCheck: "consistent" | "inconsistent" | "unknown";
}

// ---------------------------------------------------------------------------
// Release 1.8 — consensus, alerts, bulk import
// ---------------------------------------------------------------------------

export type AlertKind = "market_move" | "divergence" | "resolving_soon";
export interface Alert {
  id: string;
  kind: AlertKind;
  marketId?: string;
  side?: string;
  predictionId?: string;
  message: string;
  value?: number;
  threshold?: number;
  createdAt: string;
  seenAt?: string;
  dismissedAt?: string;
  market?: { question: string; url: string };
}

export interface Endorsement {
  predictionId: string;
  videoId: string;
  videoTitle?: string;
  creatorKey: string;
  creatorLabel: string;
  quote: string;
  madeOnDate?: string;
  /** Settled market-linked record behind the weight. */
  settled: number;
  shrunkEdge?: number;
  /** Record weight × recency (1 for today, decaying with age). */
  weight: number;
  verdict?: EvidenceAssessment;
}

export interface PropositionSide {
  side: string;
  endorsements: Endorsement[];
  /** Share of total weight on this side (0–1). */
  share: number;
  creators: number;
}

export interface Proposition {
  key: string;
  /** Market question, or the representative normalized statement for unlinked clusters. */
  label: string;
  marketId?: string;
  marketUrl?: string;
  marketPrice?: Record<string, number>;
  sides: PropositionSide[];
  /** More than one side has endorsements. */
  disagreement: boolean;
  videos: number;
  creators: number;
  groupedBy: "market" | "text";
}

export interface PlaylistImportRequest {
  url: string;
  /** Max videos to queue (newest first as the listing returns them). */
  limit?: number;
  /** Extract predictions automatically once each transcript lands. */
  autoExtract?: boolean;
}

// ---------------------------------------------------------------------------
// Release 1.9 — paper trading (hypothetical positions; no orders, ever)
// ---------------------------------------------------------------------------

export interface PaperPosition {
  id: string;
  marketId: string;
  side: string;
  openedAt: string;
  openedPrice: number;
  stake: number;
  shares: number;
  source: "manual" | "signal" | "auto";
  edgeAtOpen?: number;
  estimateAtOpen?: number;
  confidenceAtOpen?: SignalConfidence;
  predictionIds: string[];
  notes?: string;
  status: "open" | "closed";
  closedAt?: string;
  closedPrice?: number;
  closeReason?: "manual" | "resolved" | "ledger";
  realizedPnl?: number;
  lastMarkPrice?: number;
  lastMarkedAt?: string;
  /** Derived for the UI: current price and unrealized P&L (open), or the outcome (closed). */
  currentPrice?: number;
  unrealizedPnl?: number;
  market?: { question: string; url: string; endDate?: string; provider: MarketProviderId; resolved: boolean; resolvedOutcome?: string };
}

export interface PaperBook {
  enabled: boolean;
  bankrollStart: number;
  /** bankrollStart + realized P&L. */
  bankroll: number;
  /** bankroll + unrealized P&L of open positions. */
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  openCount: number;
  closedCount: number;
  wins: number;
  losses: number;
  /** Total stake ever committed. */
  staked: number;
  /** realized P&L / stake of closed positions. */
  returnOnStake?: number;
  /** Over closed positions that had an estimate at open: mean (estimate − outcome)² vs mean (market price at open − outcome)². Lower is better; the gap is whether the signals helped. */
  brierEstimate?: number;
  brierMarket?: number;
  /** Equity over time from marks (newest last). */
  curve: { at: string; equity: number }[];
  /** 1.12 (F11): the legacy book's simulation method, and its totals split by the venue's unit so mana is never summed into dollars. */
  method: "legacy-snapshot-v1";
  byCurrency: Record<string, { open: number; closed: number; staked: number; realizedPnl: number; unrealizedPnl: number }>;
}

// ---------------------------------------------------------------------------
// Release 1.10 — Polymarket US account connection (read-only foundation)
// ---------------------------------------------------------------------------

export type TradingVenueId = "polymarket_us";

/** ACC-05: connection never arms trading. 1.10 accepts only `disabled` and `paper`; live modes wait for their release gates. */
export type TradingMode = "disabled" | "paper" | "manual_live" | "auto_live";

/** Decimal amount with its unit declared; never a binary float for ledgers. */
export interface DecimalAmount {
  value: string;
  currency: string;
}

export type TradingAccountState = "connected" | "disconnected" | "needs_rebind" | "superseded";

/** How the binding relates to the one before it (ACC-03). */
export type TradingContinuity = "first" | "same_credential" | "user_asserted" | "unverified";

export interface TradingAccountBinding {
  /** Local binding id — the app's own identifier for this credential/account pairing. Never a venue account id. */
  id: string;
  venue: TradingVenueId;
  state: TradingAccountState;
  /** "local_binding" until a venue exposes a verified account identity (Polymarket US retail does not, as of 2026-09-16). */
  identityKind: "local_binding" | "venue_verified";
  externalIdentity?: string;
  /** SHA-256 (hex, 16 chars) of the Ed25519 public key derived from the secret — identifies the credential, not the person. */
  credentialFingerprint?: string;
  keyIdHint?: string;
  secretHint?: string;
  continuity: TradingContinuity;
  /** Set when a binding change means existing venue state must be re-read before anything could activate. */
  reconcileRequired: boolean;
  supersededBy?: string;
  createdAt: string;
  lastValidatedAt?: string;
  lastValidationError?: string;
  lastSyncAt?: string;
  disconnectedAt?: string;
}

export interface TradingBalanceSummary {
  currency: string;
  currentBalance?: DecimalAmount;
  buyingPower?: DecimalAmount;
  openOrdersNotional?: DecimalAmount;
  assetNotional?: DecimalAmount;
  unsettledFunds?: DecimalAmount;
  /** Venue-reported last balance change. */
  lastUpdated?: string;
  /** "number" = the venue returned JSON numbers (decimal formatting is ours); "string" = decimal strings verbatim. */
  precisionSource: "number" | "string";
}

export interface TradingPositionSummary {
  marketSlug: string;
  title?: string;
  outcome?: string;
  eventSlug?: string;
  /** Contracts (decimal string); positive = long YES, negative = short. */
  netQuantity: string;
  cost?: DecimalAmount;
  realized?: DecimalAmount;
  cashValue?: DecimalAmount;
  expired: boolean;
  updateTime?: string;
}

export interface TradingOpenOrderSummary {
  id: string;
  marketSlug: string;
  intent: string;
  state: string;
  /** Venue (YES-denominated) price. */
  price?: DecimalAmount;
  quantity?: string;
  filledQuantity?: string;
  createTime?: string;
}

export interface TradingAccountSync {
  id: string;
  bindingId: string;
  at: string;
  ok: boolean;
  error?: string;
  balances: TradingBalanceSummary[];
  positions: TradingPositionSummary[];
  openOrders: TradingOpenOrderSummary[];
  /** Positions/open-order pages were fully read (absence can only be inferred from a complete snapshot). */
  complete: boolean;
}

export interface TradingConnectionTest {
  ok: boolean;
  /** Stable code for the UI: ok | malformed_secret | invalid_key_id | unauthorized | forbidden | clock_skew | rate_limited | venue_unavailable | offline_mode | sdk_missing | host_not_allowed | unknown */
  code: string;
  /** Redacted, human-readable. Never contains key material or auth headers. */
  message: string;
  credentialFingerprint?: string;
  balances?: TradingBalanceSummary[];
  /** Count of venue create/cancel calls made by the test — always 0 (ACC-02). */
  orderCalls: 0;
}

export interface TradingPolicy {
  mode: TradingMode;
  /** Present only after an explicit owner authorization (1.13 manual, 1.14 auto). Absent in 1.10. */
  liveAuthorizedAt?: string;
  liveAuthorizationHash?: string;
  updatedAt: string;
  /** 1.12 — versioned pilot limits (RSK-02/03/07). */
  policyVersion: string;
  limits: RiskLimits;
  budgetTimezone: string;
  /** sha256 of {policyVersion, limits, budgetTimezone, automation}; any change disarms and is audited. */
  policyHash: string;
  /** 1.14 (AUTO-01): the policy hash / strategy / category the owner authorized for automatic trading; scheduled runs refuse when the live hash differs. */
  authorizedPolicyHash?: string;
  authorizedStrategyVersion?: string;
  authorizedCategory?: string;
  /** 1.14 (AUTO-03): owner pause of new orders (distinct from a reconciliation pause); set by Pause and by Emergency stop. */
  pauseReason?: string;
  pausedAt?: string;
  /** 1.14 (AUTO-02): scheduler budgets; part of the policy hash. */
  automation: AutomationSettings;
}

/** 1.14 — execution scheduler budgets and the circuit-breaker thresholds (all part of the policy hash). */
export interface AutomationSettings {
  /** Scheduler tick interval. */
  intervalMs: number;
  /** Evaluations (decisions) per tick across every source. */
  maxEvaluationsPerTick: number;
  /** New live orders per tick. */
  maxOrdersPerTick: number;
  /** Evaluations per source (creator) per tick — fair share. */
  maxPerSourcePerTick: number;
  /** Bounded discovery work per tick: market.match jobs, contract verifications, revalidations. */
  maxMatchJobsPerTick: number;
  maxVerificationsPerTick: number;
  /** A prediction is not re-evaluated more often than this unless its contract or verification changed. */
  minReevaluateMs: number;
  /** Verified links older than this are revalidated against the venue before they can be traded again. */
  revalidateAfterMs: number;
  /** Consecutive adapter failures that open the circuit breaker, and how long it stays open before a successful read may close it. */
  breakerThreshold: number;
  breakerCooldownMs: number;
  /** When true and the mode is paper, the scheduler evaluates and paper-dispatches on its own (the paper soak); never touches a live account. */
  paperAutopilot: boolean;
}

export interface CircuitBreakerState {
  state: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  openedAt?: string;
  lastFailureAt?: string;
  lastFailureCode?: string;
  incidentId?: string;
}

/** 1.14 (AUTO-05): a local, deduplicated alert; one row per incident key, counted on repeats. */
export interface TradingAlert {
  id: string;
  kind: "unknown_submission" | "disconnection" | "failed_cancel" | "risk_limit" | "stale_sync" | "resolution" | "discrepancy" | "circuit_breaker" | "disarmed" | "emergency_stop";
  severity: "info" | "warning" | "critical";
  incidentKey: string;
  subject?: string;
  message: string;
  details: Record<string, unknown>;
  firstAt: string;
  lastAt: string;
  count: number;
  acknowledgedAt?: string;
}

/** 1.14 (AUTO-02/05): one scheduler tick, with every candidate's outcome persisted. */
export interface AutomationRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  holder: string;
  mode: TradingMode;
  policyHash: string;
  outcome: "completed" | "skipped" | "failed";
  reason?: string;
  candidates: number;
  evaluated: number;
  ordered: number;
  skipped: Record<string, number>;
  notes: string[];
}

export interface AutomationCandidate {
  id: string;
  runId: string;
  predictionId: string;
  linkId?: string;
  marketId?: string;
  sourceKey: string;
  outcome: "ordered" | "evaluated" | "skipped" | "queued_work";
  reason: string;
  decisionId?: string;
  intentId?: string;
  at: string;
}

/** 1.14 (DASH-01): live/paper summary; live figures come only from the venue's sync and official settlements. */
export interface TradingSummary {
  mode: TradingMode;
  armed: boolean;
  armedKind?: "manual" | "auto";
  paused?: string;
  account?: { bindingId: string; keyIdHint?: string; state: string };
  buyingPower?: string;
  currentBalance?: string;
  syncAt?: string;
  syncAgeSeconds?: number;
  stale: boolean;
  /** Reservations + open live positions (all-in). */
  committed: string;
  realizedPnl: string;
  fees: string;
  /** Marked from the latest stored market snapshot; `markStale` when the snapshot is older than the mark window. */
  unrealizedPnl?: string;
  markAt?: string;
  markStale: boolean;
  openPositions: number;
  openIntents: number;
  unknownIntents: number;
  holdsOpen: number;
  alertsOpen: number;
  breaker: CircuitBreakerState;
  lease: DispatchLease;
  stream: string;
  lastReconcileAt?: string;
  lastAutomationRunAt?: string;
}

/** 1.14 (DASH-02/04): one ledger row per decision, joined with its intent, venue order, position state and settlement. */
export interface TradeLedgerRow {
  decisionId: string;
  clockAt: string;
  mode: TradingMode;
  outcome: DecisionOutcome;
  reasonCodes: string[];
  predictionId: string;
  creatorKey?: string;
  creatorName?: string;
  videoId?: string;
  videoTitle?: string;
  quote?: string;
  timestampUrl?: string;
  marketId: string;
  venueMarketId: string;
  marketSlug?: string;
  marketUrl?: string;
  question?: string;
  category?: string;
  eventId?: string;
  cutoffAt?: string;
  side?: "yes" | "no";
  sideLabel?: string;
  pChosen?: string;
  /** Executable price at decision (chosen-side cost) and the YES wire price. */
  limitCost?: string;
  wirePrice?: string;
  requestedQuantity?: string;
  requestedBudget?: string;
  filledQuantity?: string;
  filledCost?: string;
  avgFillPrice?: string;
  fees?: string;
  intentId?: string;
  intentState?: IntentState;
  venueOrderId?: string;
  orderState?: OrderState;
  rejectReason?: string;
  submittedAt?: string;
  acknowledgedAt?: string;
  positionState: "none" | "open" | "settled" | "unknown";
  settlement?: { kind: SettlementEventRecord["kind"]; outcome?: string; amount?: string; at: string };
  mark?: { price?: string; at?: string; stale: boolean; unrealizedPnl?: string };
  external: false;
}

/** 1.14: an order on the account that this app did not place — labelled, never given a rationale. */
export interface ExternalLedgerRow {
  external: true;
  venueOrderId: string;
  marketSlug: string;
  side?: "yes" | "no";
  quantity?: string;
  filledQuantity: string;
  yesPrice?: string;
  avgPrice?: string;
  fees?: string;
  orderState: OrderState;
  venueCreatedAt?: string;
  firstSeenAt: string;
}

export interface TradeLedgerFilter {
  from?: string;
  to?: string;
  category?: string;
  creator?: string;
  status?: string;
  mode?: TradingMode;
  reason?: string;
  includeExternal?: boolean;
  limit?: number;
}

/** 1.14 (OPS-04): redacted counters for the local dashboard and soak reports. */
export interface TradingMetrics {
  at: string;
  decisions: number;
  noTrades: number;
  intents: number;
  liveIntents: number;
  readRetries: number;
  unknownSubmissions: number;
  fills: number;
  droppedDuplicateEvents: number;
  reconciliationLagSeconds?: number;
  lastReconcileAt?: string;
  automationRuns: number;
  lastAutomationRunAt?: string;
  alertsOpen: number;
  breaker: CircuitBreakerState;
}

export interface EmergencyStopResult {
  stoppedAt: string;
  previousMode: TradingMode;
  cancellations: { intentId: string; venueOrderId: string; outcome: string; message?: string }[];
  positionsRetained: number;
  note: string;
}

export interface TradingGate {
  id: string;
  label: string;
  satisfied: boolean;
  detail: string;
}

export interface TradingAuditEvent {
  id: string;
  at: string;
  bindingId?: string;
  kind: string;
  details: Record<string, unknown>;
}

export interface TradingStatus {
  venue: TradingVenueId;
  policy: TradingPolicy;
  /** Feature flags: what this build can do at all. 1.13: submission (manual live); 1.14: automation (auto-live behind arming). */
  features: { submission: boolean; automation: boolean };
  /** 1.14: circuit breaker state of the connected account's adapter calls. */
  breaker: CircuitBreakerState;
  /** True only when a live mode is set, authorized, the account is connected, and no hold pauses dispatch. */
  armed: boolean;
  submissionAvailable: boolean;
  /** 1.13: why new orders are blocked right now (holds, pause, missing lease), if they are. */
  dispatchBlockers: string[];
  binding?: TradingAccountBinding;
  /** Retained earlier bindings (history is never deleted on disconnect). */
  previousBindings: TradingAccountBinding[];
  latestSync?: TradingAccountSync;
  /** Seconds since the latest successful sync; undefined when none. */
  syncAgeSeconds?: number;
  /** True when no sync is younger than the freshness bound (RSK-03: 30 s). */
  stale: boolean;
  gates: TradingGate[];
  /** Plain-language limitation of the identity binding (ACC-03). */
  identityNote: string;
  hosts: { gateway: string; api: string };
  sdk: { package: string; version: string };
}

// ---------------------------------------------------------------------------
// Release 1.11 — source subscriptions, provenance, evidence dossier, contract verification
// ---------------------------------------------------------------------------

export interface SourceSubscription {
  id: string;
  kind: "channel" | "playlist";
  url: string;
  title?: string;
  enabled: boolean;
  pollIntervalHours: number;
  /** Ignore videos published more than this many days before the poll (0 = no limit). */
  lookbackDays: number;
  maxVideosPerRun: number;
  autoExtract: boolean;
  /** Title keywords; when non-empty a listed video must contain one of them (case-insensitive) to be queued. */
  categoryAllowlist: string[];
  /** Research budget applied to predictions from this subscription (searches / sources per run); undefined = Setup defaults. */
  researchBudget?: { maxSearches?: number; maxSources?: number };
  lastRunAt?: string;
  lastResult?: SubscriptionRunSummary;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionRunSummary {
  runId: string;
  at: string;
  listed: number;
  queued: number;
  alreadyKnown: number;
  skippedLookback: number;
  skippedAllowlist: number;
  skippedBudget: number;
  error?: string;
  queuedVideoIds: string[];
}

export type ContractFieldStatus = "verified" | "incompatible" | "missing" | "not_applicable";

export interface ContractField {
  id: string;
  label: string;
  status: ContractFieldStatus;
  /** What the claim requires. */
  expected?: string;
  /** What the venue contract states. */
  found?: string;
  note?: string;
  /** Present when a documented user fact filled this field. */
  fact?: { value: string; source: string };
  required: boolean;
}

export type ContractVerificationStatus = "unverified" | "incomplete" | "incompatible" | "research_only" | "verified_equivalent" | "stale";

export interface ContractVerification {
  id: string;
  linkId: string;
  predictionId: string;
  marketId: string;
  version: number;
  status: ContractVerificationStatus;
  fields: ContractField[];
  /** Durable venue side id + display label for the claim's side (MAT-05); undefined until the side is verified. */
  sideId?: string;
  sideLabel?: string;
  sideBasis?: string;
  /** sha256 of the venue rules text at verification time. */
  rulesHash?: string;
  /** Earliest applicable pre-event cutoff (event start, observation cutoff, trading close) and which one it was. */
  cutoffAt?: string;
  cutoffBasis?: string;
  cutoffUnknown: boolean;
  /** Hashes of the claim as verified, so a later edit or re-extraction is detectable. */
  quoteHash?: string;
  predictionRevision: number;
  facts: Record<string, { value: string; source: string }>;
  reviewer: "app" | "user";
  notes?: string;
  createdAt: string;
  staleAt?: string;
  staleReasons?: string[];
}

export interface UsCandidateSearch {
  outcome: "none" | "one" | "multiple";
  candidates: { market: MarketRecord; score: number; rationale: string; relation?: MarketLinkRelation; side?: string; linkId?: string }[];
  /** Links on other venues, informational only (never executable). */
  researchOnly: { linkId: string; provider: MarketProviderId; question: string }[];
  queries: string[];
  notes: string[];
}

export interface DossierItem {
  evidenceId: string;
  runId: string;
  runPurpose: ResearchRun["purpose"];
  stance: Stance;
  componentId?: string;
  excerpt: string;
  fact?: string;
  eventDate?: string;
  inWindow?: boolean;
  source: {
    id: string;
    url: string;
    title?: string;
    publisher?: string;
    publishedAt?: string;
    retrievedAt: string;
    firstSeenAt?: string;
    contentHash?: string;
    status: SourceRecord["status"];
    statusChangedAt?: string;
    independenceGroup?: string;
    syndicatedOf?: string;
  };
  /** For `asOf` replays: whether this item was actually known to the app by that instant, and on what basis. */
  knownAtAsOf?: boolean;
  availabilityBasis?: "first_seen" | "published_assumption" | "unknown";
}

export interface EvidenceDossier {
  predictionId: string;
  quote: { text: string; hash?: string; startS?: number; endS?: number; videoId: string; videoUrl?: string; timestampUrl?: string };
  versions: { prediction: number; analysis?: number; plan?: number; latestRun?: string; latestAssessment?: number };
  supporting: DossierItem[];
  contradicting: DossierItem[];
  context: DossierItem[];
  /** Contradicting items and their sources, listed even when the verdict went the other way. */
  dissent: { evidenceId: string; sourceUrl: string; excerpt: string }[];
  independenceGroups: { group: string; sourceIds: string[]; publishers: string[] }[];
  coverageLimitations: string[];
  rationale?: { assessment: EvidenceAssessment; explanation: string; guardNotes: string[]; version: number };
  asOf?: string;
  excludedAsOf: number;
}

// ---------------------------------------------------------------------------
// Release 1.12 — forecasts, decisions, risk reservations, US paper execution (no live path)
// ---------------------------------------------------------------------------

/** Pilot limits (RSK-02/03). Amounts are decimal strings in `currency`; ages in milliseconds; thresholds decimal strings. */
export interface RiskLimits {
  currency: "USD";
  /** All-in maximum per order including the conservative fee bound. */
  orderBudget: string;
  dailyCommitmentCap: string;
  totalOpenRisk: string;
  perMarket: string;
  perEvent: string;
  maxOpenMarkets: number;
  dailyLossStop: string;
  /** Exclusive: the chosen side's probability must be strictly greater. */
  probabilityThreshold: string;
  /** Inclusive minimum net edge per contract after rounding. */
  minNetEdge: string;
  bookMaxAgeMs: number;
  syncMaxAgeMs: number;
  forecastMaxAgeMs: number;
  preEventBufferMs: number;
}

export type ForecastStatus = "experimental" | "qualified" | "expired" | "insufficient_data";

export interface ForecastContribution {
  id: string;
  sourceKey: string;
  clusterKey: string;
  predictionId?: string;
  /** +1 supports YES, −1 supports NO. */
  stance: 1 | -1;
  claimAt?: string;
  n: number;
  meanEdge?: string;
  shrunkEdge?: string;
  weight?: string;
  ageDays?: number;
  selected: boolean;
  /** Why it was excluded, or how it was selected. */
  reason: string;
  /** The observations behind `n` (prediction ids), for inspection (FOR-04). */
  history: { predictionId: string; marketId: string; side: "yes" | "no"; priceAtClaim: string; outcome: 0 | 1 }[];
}

export interface ForecastSnapshot {
  id: string;
  predictionId: string;
  marketId: string;
  linkId?: string;
  verificationId?: string;
  strategyVersion: string;
  category?: string;
  asOf: string;
  pYes: string;
  pNo: string;
  prior: { p0: string; source: string; bookAt?: string; bid?: string; ask?: string };
  status: ForecastStatus;
  qualificationId?: string;
  /** Versions of everything that went in (FOR-01). */
  inputs: { predictionRevision: number; analysisVersion?: number; planVersion?: number; verificationVersion?: number; quoteHash?: string; rulesHash?: string; latestRunId?: string; params: Record<string, unknown> };
  formula: { estimatorVersion: string; text: string; sumWeights: string; adjustment: string };
  exclusions: { kind: string; count: number; detail?: string }[];
  contributions: ForecastContribution[];
  hash: string;
  expiresAt?: string;
  createdAt: string;
}

export interface StrategyQualification {
  id: string;
  strategyVersion: string;
  category: string;
  source: "production" | "fixture";
  events: number;
  brier?: string;
  baselineBrier?: string;
  qualified: boolean;
  reasons: string[];
  createdAt: string;
}

export interface ForecastEvaluation {
  strategyVersion: string;
  category: string;
  events: number;
  groups: number;
  brier?: number;
  baselineBrier?: number;
  calibration: { lo: number; hi: number; count: number; meanForecast?: number; hitRate?: number }[];
  feeAdjustedReturn?: number;
  coverage: { decisions: number; traded: number; skipped: number; abstentionRate?: number };
  drawdown?: number;
  skipped: { reason: string; count: number }[];
  gate: { qualified: boolean; reasons: string[] };
}

export type DecisionOutcome = "eligible" | "skipped" | "needs_review";

export interface DecisionGate {
  id: string;
  label: string;
  satisfied: boolean;
  /** Stable reason code when unsatisfied. */
  code?: string;
  detail: string;
}

export interface DecisionSizing {
  side: "yes" | "no";
  sideId?: string;
  sideLabel?: string;
  pChosen: string;
  quantity: string;
  /** Chosen-side cost per contract at the marketable limit (what the user risks per contract). */
  limitCost: string;
  /** YES-denominated price sent to the venue (RSK-04: YES floor to tick; NO ceil of the complement). */
  wirePrice: string;
  feeBound: string;
  worstCost: string;
  netEdge: string;
  estimatedEv: string;
  /** Which cap bound the quantity. */
  boundBy: string;
}

export interface TradeDecision {
  id: string;
  createdAt: string;
  clockAt: string;
  mode: TradingMode;
  predictionId: string;
  marketId: string;
  venueMarketId: string;
  eventId?: string;
  linkId?: string;
  verificationId?: string;
  forecastId?: string;
  policyVersion: string;
  policyHash?: string;
  currency: string;
  budgetTimezone: string;
  dailyBucket: string;
  outcome: DecisionOutcome;
  sizing?: DecisionSizing;
  gates: DecisionGate[];
  reasonCodes: string[];
  /** Everything the decision saw: book, account ages, exposure, cutoff — immutable (RSK-07). */
  inputs: Record<string, unknown>;
  rationaleHash: string;
  reservationId?: string;
  intentId?: string;
  /** Joined for display. */
  question?: string;
  marketUrl?: string;
  intent?: TradeIntent;
  paperPosition?: PaperUsPosition;
}

export type IntentState = "prepared" | "reserved" | "submitting" | "acknowledged" | "filled" | "partially_filled" | "canceled" | "rejected" | "rejected_local" | "skipped" | "expired" | "submission_unknown";

export interface TradeIntent {
  id: string;
  decisionId: string;
  reservationId: string;
  mode: "paper" | "live";
  accountKey: string;
  provider: MarketProviderId;
  venueMarketId: string;
  side: "yes" | "no";
  sideId?: string;
  quantity: string;
  wirePrice: string;
  limitCost: string;
  timeInForce: "IOC";
  state: IntentState;
  payloadHash: string;
  filledQuantity: string;
  createdAt: string;
  updatedAt: string;
  /** 1.13 — live lineage. */
  bindingId?: string;
  venueOrderId?: string;
  previewId?: string;
  decisionHash?: string;
  dispatchMarkerAt?: string;
  submittedAt?: string;
  acknowledgedAt?: string;
  unknownReason?: string;
  lastError?: string;
  /** Joined for display. */
  order?: VenueOrderRecord;
  executions?: ExecutionRecord[];
}

export interface RiskReservation {
  id: string;
  decisionId: string;
  accountKey: string;
  provider: MarketProviderId;
  venueMarketId: string;
  eventId?: string;
  amount: string;
  filledAmount: string;
  dailyBucket: string;
  state: "reserved" | "consumed" | "released" | "expired";
  acknowledged: boolean;
  createdAt: string;
  releasedAt?: string;
  note?: string;
}

export interface RiskExposure {
  accountKey: string;
  currency: string;
  dailyBucket: string;
  openRiskTotal: string;
  dailyCommitted: string;
  dailyRealizedLoss: string;
  openMarkets: number;
  perMarket: Record<string, string>;
  perEvent: Record<string, string>;
  pendingUnknown: number;
  /** 2.0.0-rc.2 (RSK-06): holdings the app did not place, counted conservatively (venue cost basis, else $1 per contract). */
  externalHoldings: { venueMarketId: string; marketSlug: string; netQuantity: string; amount: string; basis: "cost" | "worst_case" }[];
  externalRiskTotal: string;
}

export interface PaperUsFill {
  id: string;
  seq: number;
  quantity: string;
  chosenCost: string;
  yesPrice: string;
  fee: string;
  at: string;
}

export interface PaperUsPosition {
  id: string;
  intentId: string;
  decisionId: string;
  marketId: string;
  venueMarketId: string;
  side: "yes" | "no";
  sideId?: string;
  quantity: string;
  avgCost: string;
  costTotal: string;
  fees: string;
  status: "open" | "settled" | "void";
  openedAt: string;
  settledAt?: string;
  outcome?: "win" | "loss" | "void";
  pnl?: string;
  method: "us-ioc-v1";
  fills: PaperUsFill[];
  question?: string;
  marketUrl?: string;
}

export interface PaperUsBook {
  method: "us-ioc-v1";
  currency: "USD";
  bankrollStart: string;
  bankroll: string;
  committed: string;
  realizedPnl: string;
  fees: string;
  open: number;
  settled: number;
  wins: number;
  losses: number;
  voids: number;
  positions: PaperUsPosition[];
}

// ---------------------------------------------------------------------------
// Release 1.13 — manual-live execution: orders, executions, previews, holds, lease (paper unchanged)
// ---------------------------------------------------------------------------

/** Normalized venue order state (EXE-06). `cancel_pending` is local: a cancel was requested and not yet confirmed. */
export type OrderState = "pending" | "open" | "partial" | "filled" | "cancel_pending" | "canceled" | "expired" | "rejected" | "unknown";

export interface VenueOrderRecord {
  id: string;
  bindingId: string;
  /** Undefined for orders the app did not place (external). */
  intentId?: string;
  external: boolean;
  marketSlug: string;
  venueMarketId?: string;
  side?: "yes" | "no";
  intentRaw?: string;
  stateRaw?: string;
  state: OrderState;
  quantity?: string;
  filledQuantity: string;
  leavesQuantity?: string;
  yesPrice?: string;
  avgPrice?: string;
  fees?: string;
  venueCreatedAt?: string;
  updatedAt: string;
  firstSeenAt: string;
  cancelRequestedAt?: string;
  rejectReason?: string;
}

export interface ExecutionRecord {
  id: string;
  orderId: string;
  intentId?: string;
  tradeId?: string;
  type: "new" | "partial_fill" | "fill" | "canceled" | "rejected" | "expired" | "replace" | "done_for_day" | "unknown";
  quantity?: string;
  yesPrice?: string;
  chosenCost?: string;
  fee?: string;
  at?: string;
  source: "create_response" | "stream" | "rest" | "activity";
  note?: string;
  receivedAt: string;
}

export interface OrderPreviewRecord {
  id: string;
  decisionId: string;
  decisionHash: string;
  request: Record<string, unknown>;
  venue?: Record<string, unknown>;
  display: {
    /** 2.0: who requested the preview — the owner (manual indicator) or the scheduler (automatic indicator). */
    origin?: "owner" | "scheduler";
    side: "yes" | "no";
    sideLabel?: string;
    pChosen: string;
    netEdge: string;
    quantity: string;
    chosenCost: string;
    yesWirePrice: string;
    worstCost: string;
    feeBound: string;
    estimatedEv: string;
    deadlineAt?: string;
    policyHash?: string;
    question?: string;
    marketUrl?: string;
    evidenceUrl: string;
  };
  expiresAt: string;
  createdAt: string;
  consumedAt?: string;
  consumedBy?: "submit" | "stale" | "expired";
}

export interface ReconciliationHold {
  id: string;
  bindingId: string;
  kind: "submission_unknown" | "discrepancy" | "failed_cancel" | "stale_sync" | "stream_gap";
  subject?: string;
  detail: Record<string, unknown>;
  openedAt: string;
  resolvedAt?: string;
  resolution?: string;
}

export interface LivePosition {
  bindingId: string;
  marketSlug: string;
  venueMarketId?: string;
  /** Venue-reported net contracts (positive long YES, negative short) from the latest authoritative snapshot. */
  venueNet?: string;
  venueAt?: string;
  /** What our own acknowledged orders account for (signed, YES-denominated). */
  localNet: string;
  intentIds: string[];
  discrepancy?: string;
  settled?: { outcome: "win" | "loss" | "void" | "correction" | "external_exit"; at: string; pnl?: string };
  /**
   * 2.0.0-rc.2: a position on a market where this app has NO order of its own (placed by hand on the website, or
   * before the app existed). Listed separately, counted toward exposure, never a discrepancy, never pauses the account.
   */
  external?: boolean;
  /** Venue-reported cost basis of the position when the venue supplies it. */
  venueCost?: string;
}

export interface DispatchLease {
  holder?: string;
  acquiredAt?: string;
  expiresAt?: string;
  heldByThisProcess: boolean;
}

export interface SettlementEventRecord {
  id: string;
  marketId?: string;
  venueMarketId: string;
  kind: "resolved" | "void" | "correction" | "external_exit";
  outcome?: string;
  source: "venue_market_status" | "account_activity";
  observedAt: string;
  bindingId?: string;
  intentId?: string;
  amount?: string;
  details: Record<string, unknown>;
}
