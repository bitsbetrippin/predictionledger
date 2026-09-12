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
  | "tool.install";

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

export interface Prediction {
  id: string;
  videoId: string;
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
  topic?: string;
  userStatus?: PredictionUserStatus;
  deadlineBefore?: string;
  deadlineAfter?: string;
  includeDismissed?: boolean;
}

export interface PromptTemplateInfo {
  name: "extraction" | "plan" | "evidence" | "assessment";
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
}
