/**
 * Prediction Ledger — research repository: runs, sources, run results, evidence, assessments, search cache.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ActionStage,
  Assessment,
  ComponentAssessment,
  EvidenceAssessment,
  EvidenceItem,
  ProcessingStatus,
  QueryGroup,
  ResearchRun,
  ResultSummary,
  SearchResult,
  SourceRecord,
  Stance,
  TimeStatusValue,
} from "@prediction-ledger/shared";
import type { Database } from "../db/index.js";

const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface RunRow {
  id: string; prediction_id: string; validation_plan_id: string; plan_version: number | null; status: ResearchRun["status"];
  search_provider: string; cutoff_date: string; queries_json: string; coverage_notes_json: string; searches_used: number;
  sources_fetched: number; sources_failed: number; evidence_provider: string | null; evidence_model: string | null;
  error: string | null; started_at: string; finished_at: string | null; evidence_count: number;
}
interface SourceRow {
  id: string; url: string; canonical_url: string; title: string | null; publisher: string | null; published_at: string | null;
  retrieved_at: string; fetch_status: SourceRecord["fetchStatus"]; http_status: number | null; content_path: string | null;
  content_hash: string | null; content_chars: number | null; syndicated_of: string | null; access_notes: string | null;
}
interface EvidenceRow {
  id: string; run_id: string; source_id: string; component_id: string | null; stance: Stance; excerpt: string; fact: string | null;
  event_date: string | null; action_stage: ActionStage | null; in_window: number | null; quality_notes: string | null; independent: number;
}
interface AssessmentRow {
  id: string; prediction_id: string; run_id: string; validation_plan_id: string; plan_version: number | null; version: number;
  evidence_assessment: EvidenceAssessment; time_status: TimeStatusValue; explanation: string; uncertainty: string | null;
  confidence: Assessment["confidence"]; confidence_rationale: string | null; supporting_ids_json: string; contradicting_ids_json: string;
  citations_json: string; later_developments: string | null; guard_notes_json: string; provider: string; model: string | null;
  template_version: string; researched_at: string; recheck_after: string | null; created_at: string;
}

export class ResearchService {
  constructor(
    private readonly db: Database,
    private readonly artifactsDir: string,
  ) {}

  // ---- runs -----------------------------------------------------------------

  createRun(input: { predictionId: string; planId: string; searchProvider: string; cutoffDate: string; jobId?: string }): ResearchRun {
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO research_runs (id, prediction_id, validation_plan_id, search_provider, cutoff_date, job_id) VALUES (?, ?, ?, ?, ?, ?)`,
      id, input.predictionId, input.planId, input.searchProvider, input.cutoffDate, input.jobId ?? null,
    );
    return this.getRun(id)!;
  }

  updateRun(id: string, patch: Partial<{ status: ResearchRun["status"]; queries: ResearchRun["queries"]; coverageNotes: string[]; searchesUsed: number; sourcesFetched: number; sourcesFailed: number; evidenceProvider: string; evidenceModel: string; evidenceTemplate: string; error: string; finished: boolean }>): void {
    const cur = this.db.get<RunRow>("SELECT * FROM research_runs WHERE id = ?", id);
    if (!cur) return;
    this.db.run(
      `UPDATE research_runs SET status = ?, queries_json = ?, coverage_notes_json = ?, searches_used = ?, sources_fetched = ?, sources_failed = ?,
         evidence_provider = COALESCE(?, evidence_provider), evidence_model = COALESCE(?, evidence_model), evidence_template = COALESCE(?, evidence_template),
         error = ?, finished_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE finished_at END WHERE id = ?`,
      patch.status ?? cur.status,
      JSON.stringify(patch.queries ?? JSON.parse(cur.queries_json)),
      JSON.stringify(patch.coverageNotes ?? JSON.parse(cur.coverage_notes_json)),
      patch.searchesUsed ?? cur.searches_used,
      patch.sourcesFetched ?? cur.sources_fetched,
      patch.sourcesFailed ?? cur.sources_failed,
      patch.evidenceProvider ?? null,
      patch.evidenceModel ?? null,
      patch.evidenceTemplate ?? null,
      patch.error ?? cur.error,
      patch.finished ? 1 : 0,
      id,
    );
  }

  getRun(id: string): ResearchRun | undefined {
    const r = this.db.get<RunRow>(RUN_SQL + " WHERE r.id = ?", id);
    return r ? toRun(r) : undefined;
  }

  runsForPrediction(predictionId: string): ResearchRun[] {
    return this.db.all<RunRow>(RUN_SQL + " WHERE r.prediction_id = ? ORDER BY r.started_at DESC", predictionId).map(toRun);
  }

  processingStatus(predictionId: string): ProcessingStatus {
    const r = this.db.get<{ status: string }>("SELECT status FROM research_runs WHERE prediction_id = ? ORDER BY started_at DESC LIMIT 1", predictionId);
    if (!r) return "not_researched";
    if (r.status === "running") return "running";
    if (r.status === "failed" || r.status === "cancelled") return "failed";
    return "completed";
  }

  /** Runs left 'running' by a crash are marked failed at startup (the job queue re-runs the job, which creates a fresh run). */
  failOrphanedRuns(): number {
    const r = this.db.run(
      `UPDATE research_runs SET status='failed', error='Interrupted by restart', finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE status='running' AND started_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes')`,
    );
    return Number(r.changes);
  }

  // ---- search cache -------------------------------------------------------------

  cachedSearch(provider: string, query: string): SearchResult[] | undefined {
    const row = this.db.get<{ results_json: string; cached_at: string }>("SELECT results_json, cached_at FROM search_cache WHERE cache_key = ?", cacheKey(provider, query));
    if (!row) return undefined;
    if (Date.now() - Date.parse(row.cached_at) > SEARCH_CACHE_TTL_MS) return undefined;
    return JSON.parse(row.results_json) as SearchResult[];
  }

  cacheSearch(provider: string, query: string, results: SearchResult[]): void {
    this.db.run(
      `INSERT INTO search_cache (cache_key, results_json, cached_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(cache_key) DO UPDATE SET results_json = excluded.results_json, cached_at = excluded.cached_at`,
      cacheKey(provider, query),
      JSON.stringify(results),
    );
  }

  addRunResult(runId: string, group: QueryGroup, query: string, rank: number, r: SearchResult): string {
    const id = crypto.randomUUID();
    this.db.run(
      "INSERT INTO run_results (id, run_id, query_group, query, rank, url, title, snippet, page_age) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, runId, group, query, rank, r.url, r.title ?? null, r.snippet ?? null, r.pageAge ?? null,
    );
    return id;
  }

  linkRunResult(runResultId: string, sourceId: string, fetched: boolean): void {
    this.db.run("UPDATE run_results SET source_id = ?, fetched = ? WHERE id = ?", sourceId, fetched ? 1 : 0, runResultId);
  }

  // ---- sources -------------------------------------------------------------------

  findSourceByCanonical(canonicalUrl: string): SourceRecord | undefined {
    const r = this.db.get<SourceRow>("SELECT * FROM sources WHERE canonical_url = ?", canonicalUrl);
    return r ? toSource(r) : undefined;
  }

  /** Reuse a successful fetch from the last 24 h; otherwise the caller re-fetches. */
  freshSource(canonicalUrl: string): SourceRecord | undefined {
    const s = this.findSourceByCanonical(canonicalUrl);
    if (!s || s.fetchStatus !== "ok") return undefined;
    return Date.now() - Date.parse(s.retrievedAt) < SEARCH_CACHE_TTL_MS ? s : undefined;
  }

  upsertSource(input: {
    url: string; canonicalUrl: string; title?: string; publisher?: string; publishedAt?: string; fetchStatus: SourceRecord["fetchStatus"];
    httpStatus?: number; contentType?: string; text?: string; accessNotes?: string;
  }): SourceRecord {
    const existing = this.findSourceByCanonical(input.canonicalUrl);
    const id = existing?.id ?? crypto.randomUUID();
    let contentPath: string | null = null;
    let contentHash: string | null = null;
    let chars: number | null = null;
    if (input.text !== undefined) {
      contentHash = crypto.createHash("sha256").update(input.text).digest("hex");
      chars = input.text.length;
      const dir = path.join(this.artifactsDir, "sources");
      fs.mkdirSync(dir, { recursive: true });
      contentPath = path.join("sources", `${contentHash.slice(0, 32)}.txt`);
      fs.writeFileSync(path.join(this.artifactsDir, contentPath), input.text, "utf8");
    }
    // Syndication: same extracted text as another source. The earliest-published copy is the
    // original; the other is marked syndicated_of it (published date first, retrieval time as fallback).
    let dup: { id: string } | undefined;
    let repointAfterInsert: string | undefined;
    if (contentHash) {
      const other = this.db.get<{ id: string; published_at: string | null; retrieved_at: string }>(
        "SELECT id, published_at, retrieved_at FROM sources WHERE content_hash = ? AND id <> ? AND syndicated_of IS NULL ORDER BY COALESCE(published_at, retrieved_at) ASC LIMIT 1",
        contentHash, id,
      );
      if (other) {
        const otherDate = other.published_at ?? other.retrieved_at.slice(0, 10);
        const mine = input.publishedAt ?? new Date().toISOString().slice(0, 10);
        if (mine < otherDate) {
          repointAfterInsert = other.id; // the new one is the earlier original; re-point the other after we insert
        } else {
          dup = { id: other.id };
        }
      }
    }
    this.db.run(
      `INSERT INTO sources (id, url, canonical_url, title, publisher, published_at, retrieved_at, fetch_status, http_status, content_type, content_path, content_hash, content_chars, syndicated_of, access_notes)
       VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(canonical_url) DO UPDATE SET url = excluded.url, title = COALESCE(excluded.title, sources.title), publisher = COALESCE(excluded.publisher, sources.publisher),
         published_at = COALESCE(excluded.published_at, sources.published_at), retrieved_at = excluded.retrieved_at, fetch_status = excluded.fetch_status,
         http_status = excluded.http_status, content_type = excluded.content_type, content_path = COALESCE(excluded.content_path, sources.content_path),
         content_hash = COALESCE(excluded.content_hash, sources.content_hash), content_chars = COALESCE(excluded.content_chars, sources.content_chars),
         syndicated_of = excluded.syndicated_of, access_notes = excluded.access_notes`,
      id, input.url, input.canonicalUrl, input.title ?? null, input.publisher ?? null, input.publishedAt ?? null, input.fetchStatus, input.httpStatus ?? null,
      input.contentType ?? null, contentPath, contentHash, chars, dup?.id ?? null, input.accessNotes ?? null,
    );
    if (repointAfterInsert) this.db.run("UPDATE sources SET syndicated_of = ? WHERE id = ?", id, repointAfterInsert);
    return this.findSourceByCanonical(input.canonicalUrl)!;
  }

  sourceText(source: SourceRecord): string | undefined {
    const r = this.db.get<{ content_path: string | null }>("SELECT content_path FROM sources WHERE id = ?", source.id);
    if (!r?.content_path) return undefined;
    try {
      return fs.readFileSync(path.join(this.artifactsDir, r.content_path), "utf8");
    } catch {
      return undefined;
    }
  }

  getSource(id: string): SourceRecord | undefined {
    const r = this.db.get<SourceRow>("SELECT * FROM sources WHERE id = ?", id);
    return r ? toSource(r) : undefined;
  }

  // ---- evidence ----------------------------------------------------------------------

  addEvidence(input: Omit<EvidenceItem, "id" | "source">): EvidenceItem {
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO evidence_items (id, run_id, source_id, component_id, stance, excerpt, fact, event_date, action_stage, in_window, quality_notes, independent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.runId, input.sourceId, input.componentId ?? null, input.stance, input.excerpt, input.fact ?? null, input.eventDate ?? null,
      input.actionStage ?? null, input.inWindow === undefined ? null : input.inWindow ? 1 : 0, input.qualityNotes ?? null, input.independent ? 1 : 0,
    );
    return this.evidenceForRun(input.runId).find((e) => e.id === id)!;
  }

  evidenceForRun(runId: string): EvidenceItem[] {
    const rows = this.db.all<EvidenceRow & SourceRow & { src_id: string }>(
      `SELECT e.*, s.id AS src_id, s.url, s.canonical_url, s.title, s.publisher, s.published_at, s.retrieved_at, s.fetch_status, s.http_status,
              s.content_chars, s.syndicated_of, s.access_notes
       FROM evidence_items e JOIN sources s ON s.id = e.source_id WHERE e.run_id = ? ORDER BY e.created_at`,
      runId,
    );
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      sourceId: r.source_id,
      source: toSource({ ...r, id: r.src_id, content_path: null, content_hash: null }),
      componentId: r.component_id ?? undefined,
      stance: r.stance,
      excerpt: r.excerpt,
      fact: r.fact ?? undefined,
      eventDate: r.event_date ?? undefined,
      actionStage: r.action_stage ?? undefined,
      inWindow: r.in_window === null ? undefined : r.in_window === 1,
      qualityNotes: r.quality_notes ?? undefined,
      independent: r.independent === 1,
    }));
  }

  // ---- assessments ---------------------------------------------------------------------

  addAssessment(input: Omit<Assessment, "id" | "version" | "createdAt" | "components" | "planVersion"> & { components: Omit<ComponentAssessment, "id">[] }): Assessment {
    const id = crypto.randomUUID();
    this.db.transaction(() => {
      const next = (this.db.get<{ v: number | null }>("SELECT MAX(version) AS v FROM assessments WHERE prediction_id = ?", input.predictionId)?.v ?? 0) + 1;
      this.db.run(
        `INSERT INTO assessments (id, prediction_id, run_id, validation_plan_id, version, evidence_assessment, time_status, explanation, uncertainty, confidence,
           confidence_rationale, supporting_ids_json, contradicting_ids_json, citations_json, later_developments, guard_notes_json, provider, model, template_version, researched_at, recheck_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, input.predictionId, input.runId, input.validationPlanId, next, input.evidenceAssessment, input.timeStatus, input.explanation, input.uncertainty ?? null,
        input.confidence, input.confidenceRationale ?? null, JSON.stringify(input.supportingIds), JSON.stringify(input.contradictingIds), JSON.stringify(input.citations),
        input.laterDevelopments ?? null, JSON.stringify(input.guardNotes), input.provider, input.model ?? null, input.templateVersion, input.researchedAt, input.recheckAfter ?? null,
      );
      for (const c of input.components) {
        this.db.run(
          "INSERT INTO component_assessments (id, assessment_id, component_id, component_kind, statement, assessment, explanation, evidence_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          crypto.randomUUID(), id, c.componentId ?? null, c.componentKind, c.statement, c.assessment, c.explanation, JSON.stringify(c.evidenceIds),
        );
      }
    });
    return this.getAssessment(id)!;
  }

  getAssessment(id: string): Assessment | undefined {
    const r = this.db.get<AssessmentRow>(ASSESSMENT_SQL + " WHERE a.id = ?", id);
    return r ? this.hydrateAssessment(r) : undefined;
  }

  assessmentsForPrediction(predictionId: string): Assessment[] {
    return this.db.all<AssessmentRow>(ASSESSMENT_SQL + " WHERE a.prediction_id = ? ORDER BY a.version DESC", predictionId).map((r) => this.hydrateAssessment(r));
  }

  latestSummary(predictionId: string): ResultSummary | undefined {
    const r = this.db.get<AssessmentRow & { source_count: number }>(
      `${ASSESSMENT_SQL.replace("FROM assessments a", ", (SELECT COUNT(DISTINCT e.source_id) FROM evidence_items e WHERE e.run_id = a.run_id) AS source_count FROM assessments a")}
       WHERE a.prediction_id = ? ORDER BY a.version DESC LIMIT 1`,
      predictionId,
    );
    if (!r) return undefined;
    return {
      assessmentId: r.id,
      version: r.version,
      evidenceAssessment: r.evidence_assessment,
      timeStatus: r.time_status,
      explanation: r.explanation,
      confidence: r.confidence,
      sourceCount: Number(r.source_count),
      researchedAt: r.researched_at,
      recheckAfter: r.recheck_after ?? undefined,
    };
  }

  private hydrateAssessment(r: AssessmentRow): Assessment {
    const comps = this.db
      .all<{ id: string; component_id: string | null; component_kind: ComponentAssessment["componentKind"]; statement: string; assessment: EvidenceAssessment; explanation: string; evidence_ids_json: string }>(
        "SELECT * FROM component_assessments WHERE assessment_id = ?",
        r.id,
      )
      .map((c) => ({ id: c.id, componentId: c.component_id ?? undefined, componentKind: c.component_kind, statement: c.statement, assessment: c.assessment, explanation: c.explanation, evidenceIds: JSON.parse(c.evidence_ids_json) as string[] }));
    return {
      id: r.id,
      predictionId: r.prediction_id,
      runId: r.run_id,
      validationPlanId: r.validation_plan_id,
      planVersion: r.plan_version ?? undefined,
      version: r.version,
      evidenceAssessment: r.evidence_assessment,
      timeStatus: r.time_status,
      explanation: r.explanation,
      uncertainty: r.uncertainty ?? undefined,
      confidence: r.confidence,
      confidenceRationale: r.confidence_rationale ?? undefined,
      supportingIds: JSON.parse(r.supporting_ids_json) as string[],
      contradictingIds: JSON.parse(r.contradicting_ids_json) as string[],
      citations: JSON.parse(r.citations_json) as Assessment["citations"],
      laterDevelopments: r.later_developments ?? undefined,
      guardNotes: JSON.parse(r.guard_notes_json) as string[],
      components: comps,
      provider: r.provider,
      model: r.model ?? undefined,
      templateVersion: r.template_version,
      researchedAt: r.researched_at,
      recheckAfter: r.recheck_after ?? undefined,
      createdAt: r.created_at,
    };
  }

  // ---- export -----------------------------------------------------------------------------

  allRuns(): ResearchRun[] {
    return this.db.all<RunRow>(RUN_SQL + " ORDER BY r.started_at").map(toRun);
  }
  allSources(): SourceRecord[] {
    return this.db.all<SourceRow>("SELECT * FROM sources ORDER BY retrieved_at").map(toSource);
  }
  allEvidence(): EvidenceItem[] {
    return this.db.all<EvidenceRow>("SELECT * FROM evidence_items ORDER BY created_at").map((r) => ({
      id: r.id, runId: r.run_id, sourceId: r.source_id, componentId: r.component_id ?? undefined, stance: r.stance, excerpt: r.excerpt, fact: r.fact ?? undefined,
      eventDate: r.event_date ?? undefined, actionStage: r.action_stage ?? undefined, inWindow: r.in_window === null ? undefined : r.in_window === 1,
      qualityNotes: r.quality_notes ?? undefined, independent: r.independent === 1,
    }));
  }
  allAssessments(): Assessment[] {
    return this.db.all<AssessmentRow>(ASSESSMENT_SQL + " ORDER BY a.created_at").map((r) => this.hydrateAssessment(r));
  }
}

const RUN_SQL = `SELECT r.*, vp.version AS plan_version, (SELECT COUNT(*) FROM evidence_items e WHERE e.run_id = r.id) AS evidence_count
  FROM research_runs r JOIN validation_plans vp ON vp.id = r.validation_plan_id`;
const ASSESSMENT_SQL = `SELECT a.*, vp.version AS plan_version FROM assessments a JOIN validation_plans vp ON vp.id = a.validation_plan_id`;

function cacheKey(provider: string, query: string): string {
  return `${provider}|${query.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

function toRun(r: RunRow): ResearchRun {
  return {
    id: r.id,
    predictionId: r.prediction_id,
    validationPlanId: r.validation_plan_id,
    planVersion: r.plan_version ?? undefined,
    status: r.status,
    searchProvider: r.search_provider,
    cutoffDate: r.cutoff_date,
    queries: JSON.parse(r.queries_json) as ResearchRun["queries"],
    coverageNotes: JSON.parse(r.coverage_notes_json) as string[],
    searchesUsed: r.searches_used,
    sourcesFetched: r.sources_fetched,
    sourcesFailed: r.sources_failed,
    evidenceProvider: r.evidence_provider ?? undefined,
    evidenceModel: r.evidence_model ?? undefined,
    error: r.error ?? undefined,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? undefined,
    evidenceCount: Number(r.evidence_count),
  };
}

function toSource(r: SourceRow): SourceRecord {
  return {
    id: r.id,
    url: r.url,
    canonicalUrl: r.canonical_url,
    title: r.title ?? undefined,
    publisher: r.publisher ?? undefined,
    publishedAt: r.published_at ?? undefined,
    retrievedAt: r.retrieved_at,
    fetchStatus: r.fetch_status,
    httpStatus: r.http_status ?? undefined,
    contentChars: r.content_chars ?? undefined,
    syndicatedOf: r.syndicated_of ?? undefined,
    accessNotes: r.access_notes ?? undefined,
  };
}
