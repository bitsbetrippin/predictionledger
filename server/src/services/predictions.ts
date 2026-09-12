/**
 * Prediction Ledger — prediction repository/service (create, list, edit, merge, split, accept, dismiss).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Immutability rules: quote_exact, context, timestamps, occurrences and the extraction
 * provenance never change after insert. Everything a user may change goes through `edit`,
 * which snapshots the previous state into prediction_revisions first (PX-07).
 */

import crypto from "node:crypto";
import type { ComponentKind, Prediction, PredictionComponent, PredictionEdit, PredictionFilters, PredictionUserStatus, SportsPick } from "@prediction-ledger/shared";
import type { Database } from "../db/index.js";

export interface NewPrediction {
  videoId: string;
  kind?: Prediction["kind"];
  sportsPick?: SportsPick;
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
  madeOnBasis: Prediction["madeOnBasis"];
  timeExpression?: string;
  deadlineDate?: string;
  deadlineBasis?: string;
  ambiguities: string[];
  extractionConfidence?: number;
  occurrences: Prediction["occurrences"];
  extractionProvider?: string;
  extractionModel?: string;
  extractionTemplate?: string;
  extractionJobId?: string;
  components: { kind: ComponentKind; statement: string; deadlineDate?: string; notes?: string }[];
}

interface PredictionRow {
  id: string;
  video_id: string;
  kind: Prediction["kind"];
  sports_json: string | null;
  video_title: string | null;
  quote_exact: string;
  context_before: string | null;
  context_after: string | null;
  start_s: number | null;
  end_s: number | null;
  speaker: string | null;
  normalized_statement: string;
  entities_json: string;
  topic: string | null;
  geography: string | null;
  scope: string | null;
  conditions_json: string;
  thresholds_json: string;
  modality: string | null;
  made_on_date: string | null;
  made_on_basis: Prediction["madeOnBasis"];
  time_expression: string | null;
  deadline_date: string | null;
  deadline_basis: string | null;
  ambiguities_json: string;
  extraction_confidence: number | null;
  user_status: PredictionUserStatus;
  merged_into_id: string | null;
  duplicate_of_id: string | null;
  occurrences_json: string;
  extraction_provider: string | null;
  extraction_model: string | null;
  extraction_template: string | null;
  latest_plan_version: number | null;
  created_at: string;
  updated_at: string;
}

interface ComponentRow {
  id: string;
  prediction_id: string;
  seq: number;
  kind: ComponentKind;
  statement: string;
  deadline_date: string | null;
  notes: string | null;
}

const SELECT = `
  SELECT p.*, v.title AS video_title,
    (SELECT MAX(version) FROM validation_plans vp WHERE vp.prediction_id = p.id) AS latest_plan_version
  FROM predictions p JOIN videos v ON v.id = p.video_id`;

export class PredictionService {
  constructor(private readonly db: Database) {}

  create(n: NewPrediction): Prediction {
    const id = crypto.randomUUID();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO predictions (id, video_id, kind, sports_json, quote_exact, context_before, context_after, start_s, end_s, speaker,
           normalized_statement, entities_json, topic, geography, scope, conditions_json, thresholds_json, modality,
           made_on_date, made_on_basis, time_expression, deadline_date, deadline_basis, ambiguities_json,
           extraction_confidence, occurrences_json, extraction_provider, extraction_model, extraction_template, extraction_job_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, n.videoId, n.kind ?? "general", n.sportsPick ? JSON.stringify(n.sportsPick) : null, n.quoteExact, n.contextBefore ?? null, n.contextAfter ?? null, n.startS ?? null, n.endS ?? null, n.speaker ?? null,
        n.normalizedStatement, JSON.stringify(n.entities), n.topic ?? null, n.geography ?? null, n.scope ?? null,
        JSON.stringify(n.conditions), JSON.stringify(n.thresholds), n.modality ?? null,
        n.madeOnDate ?? null, n.madeOnBasis, n.timeExpression ?? null, n.deadlineDate ?? null, n.deadlineBasis ?? null,
        JSON.stringify(n.ambiguities), n.extractionConfidence ?? null, JSON.stringify(n.occurrences),
        n.extractionProvider ?? null, n.extractionModel ?? null, n.extractionTemplate ?? null, n.extractionJobId ?? null,
      );
      this.replaceComponents(id, n.components);
    });
    return this.get(id)!;
  }

  get(id: string): Prediction | undefined {
    const row = this.db.get<PredictionRow>(`${SELECT} WHERE p.id = ?`, id);
    return row ? this.hydrate(row) : undefined;
  }

  list(f: PredictionFilters = {}): Prediction[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.videoId) { where.push("p.video_id = ?"); params.push(f.videoId); }
    if (f.kind) { where.push("p.kind = ?"); params.push(f.kind); }
    if (f.topic) { where.push("p.topic = ?"); params.push(f.topic); }
    if (f.userStatus) { where.push("p.user_status = ?"); params.push(f.userStatus); }
    else if (!f.includeDismissed) { where.push("p.user_status IN ('pending','accepted')"); }
    if (f.deadlineBefore) { where.push("p.deadline_date <= ?"); params.push(f.deadlineBefore); }
    if (f.deadlineAfter) { where.push("p.deadline_date >= ?"); params.push(f.deadlineAfter); }
    const sql = `${SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY v.imported_at DESC, p.start_s ASC, p.created_at ASC`;
    return this.db.all<PredictionRow>(sql, ...params).map((r) => this.hydrate(r));
  }

  topics(): string[] {
    return this.db.all<{ topic: string }>("SELECT DISTINCT topic FROM predictions WHERE topic IS NOT NULL ORDER BY topic").map((r) => r.topic);
  }

  /** Snapshot then apply user edits. */
  edit(id: string, patch: PredictionEdit, reason = "edit"): Prediction | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const madeOn = patch.madeOnDate === undefined ? (current.madeOnDate ?? null) : patch.madeOnDate || null;
    const deadline = patch.deadlineDate === undefined ? (current.deadlineDate ?? null) : patch.deadlineDate || null;
    const madeOnBasis = madeOn !== (current.madeOnDate ?? null) ? "user" : current.madeOnBasis;
    const deadlineBasis = deadline !== (current.deadlineDate ?? null) ? "user" : (current.deadlineBasis ?? null);
    this.db.transaction(() => {
      this.snapshot(current, reason);
      this.db.run(
        `UPDATE predictions SET normalized_statement = ?, topic = ?, geography = ?, scope = ?, speaker = ?,
           made_on_date = ?, made_on_basis = ?, deadline_date = ?, deadline_basis = ?,
           conditions_json = ?, ambiguities_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
        patch.normalizedStatement?.trim() || current.normalizedStatement,
        patch.topic === undefined ? (current.topic ?? null) : patch.topic || null,
        patch.geography === undefined ? (current.geography ?? null) : patch.geography || null,
        patch.scope === undefined ? (current.scope ?? null) : patch.scope || null,
        patch.speaker === undefined ? (current.speaker ?? null) : patch.speaker || null,
        madeOn,
        madeOnBasis,
        deadline,
        deadlineBasis,
        JSON.stringify(patch.conditions ?? current.conditions),
        JSON.stringify(patch.ambiguities ?? current.ambiguities),
        id,
      );
      if (patch.components) this.replaceComponents(id, patch.components);
    });
    return this.get(id);
  }

  /**
   * 1.3.1 — record the game date/time of a sports pick found by the schedule look-up (or set by the user).
   * Updates the pick, the deadline (basis "lookup" / "user"), the sole component's deadline and
   * statement, and adds a revision so the change is inspectable.
   */
  setSportsEvent(id: string, ev: { eventDate: string; eventTime?: string; source: "lookup" | "user"; sourceUrl?: string; describe: (p: SportsPick) => string }): Prediction | undefined {
    const current = this.get(id);
    if (!current || current.kind !== "sports_pick" || !current.sportsPick) return undefined;
    const pick: SportsPick = { ...current.sportsPick, eventDate: ev.eventDate, eventTime: ev.eventTime ?? current.sportsPick.eventTime, eventDateSource: ev.source, eventDateSourceUrl: ev.sourceUrl };
    const statement = ev.describe(pick);
    const ambiguities = current.ambiguities.filter((a) => !/^Game date not stated/i.test(a));
    if (ev.source === "lookup") ambiguities.push(`Game date ${ev.eventDate}${ev.eventTime ? ` ${ev.eventTime}` : ""} came from a schedule look-up${ev.sourceUrl ? ` (${ev.sourceUrl})` : ""}, not from the transcript.`);
    this.db.transaction(() => {
      this.snapshot(current, ev.source === "lookup" ? "schedule-lookup" : "edit");
      this.db.run(
        `UPDATE predictions SET sports_json = ?, normalized_statement = ?, deadline_date = ?, deadline_basis = ?, ambiguities_json = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        JSON.stringify(pick),
        statement,
        ev.eventDate,
        ev.source,
        JSON.stringify(ambiguities),
        id,
      );
      this.replaceComponents(
        id,
        current.components.map((c) => (c.kind === "future_claim" ? { kind: c.kind, statement, deadlineDate: ev.eventDate, notes: c.notes } : { kind: c.kind, statement: c.statement, deadlineDate: c.deadlineDate, notes: c.notes })),
      );
    });
    return this.get(id);
  }

  setStatus(id: string, status: Exclude<PredictionUserStatus, "merged">): Prediction | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    this.db.transaction(() => {
      this.snapshot(current, status === "dismissed" ? "dismiss" : "accept");
      this.db.run("UPDATE predictions SET user_status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", status, id);
    });
    return this.get(id);
  }

  /** Merge `sourceIds` into `targetId`: sources become status 'merged', their occurrences are appended to the target. */
  merge(targetId: string, sourceIds: string[]): Prediction | undefined {
    const target = this.get(targetId);
    if (!target) return undefined;
    const sources = sourceIds.filter((s) => s !== targetId).map((s) => this.get(s)).filter((p): p is Prediction => !!p && p.videoId === target.videoId);
    if (sources.length === 0) return target;
    this.db.transaction(() => {
      this.snapshot(target, "merge");
      const occurrences = [...target.occurrences];
      for (const s of sources) {
        this.snapshot(s, "merge");
        for (const o of s.occurrences) if (!occurrences.some((x) => x.windowId === o.windowId && x.startS === o.startS)) occurrences.push(o);
        this.db.run("UPDATE predictions SET user_status = 'merged', merged_into_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", targetId, s.id);
      }
      this.db.run("UPDATE predictions SET occurrences_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", JSON.stringify(occurrences), targetId);
    });
    return this.get(targetId);
  }

  /**
   * Split: turn one component of a prediction into its own prediction (same quote/context/time,
   * normalized statement = the component's statement). The parent keeps the remaining components.
   */
  split(id: string, componentId: string): { parent: Prediction; child: Prediction } | undefined {
    const parent = this.get(id);
    const comp = parent?.components.find((c) => c.id === componentId);
    if (!parent || !comp) return undefined;
    if (parent.components.length < 2) throw new Error("A prediction with a single component cannot be split.");
    let child: Prediction | undefined;
    this.db.transaction(() => {
      this.snapshot(parent, "split");
      child = this.create({
        videoId: parent.videoId,
        quoteExact: parent.quoteExact,
        contextBefore: parent.contextBefore,
        contextAfter: parent.contextAfter,
        startS: parent.startS,
        endS: parent.endS,
        speaker: parent.speaker,
        normalizedStatement: comp.statement,
        entities: parent.entities,
        topic: parent.topic,
        geography: parent.geography,
        scope: parent.scope,
        conditions: parent.conditions,
        thresholds: parent.thresholds,
        modality: parent.modality,
        madeOnDate: parent.madeOnDate,
        madeOnBasis: parent.madeOnBasis,
        timeExpression: parent.timeExpression,
        deadlineDate: comp.deadlineDate ?? parent.deadlineDate,
        deadlineBasis: comp.deadlineDate ? "user" : parent.deadlineBasis,
        ambiguities: parent.ambiguities,
        extractionConfidence: parent.extractionConfidence,
        occurrences: parent.occurrences,
        extractionProvider: parent.extractionProvider,
        extractionModel: parent.extractionModel,
        extractionTemplate: parent.extractionTemplate,
        components: [{ kind: comp.kind === "future_claim" ? "future_claim" : comp.kind, statement: comp.statement, deadlineDate: comp.deadlineDate, notes: `Split from prediction ${parent.id}` }],
      });
      this.db.run("UPDATE predictions SET duplicate_of_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", child.id);
      this.replaceComponents(parent.id, parent.components.filter((c) => c.id !== componentId).map((c) => ({ kind: c.kind, statement: c.statement, deadlineDate: c.deadlineDate, notes: c.notes })));
    });
    return { parent: this.get(id)!, child: child! };
  }

  revisions(id: string): { version: number; reason: string | null; createdAt: string; snapshot: unknown }[] {
    return this.db
      .all<{ version: number; reason: string | null; created_at: string; snapshot_json: string }>(
        "SELECT version, reason, created_at, snapshot_json FROM prediction_revisions WHERE prediction_id = ? ORDER BY version DESC",
        id,
      )
      .map((r) => ({ version: r.version, reason: r.reason, createdAt: r.created_at, snapshot: JSON.parse(r.snapshot_json) }));
  }

  delete(id: string): boolean {
    return Number(this.db.run("DELETE FROM predictions WHERE id = ?", id).changes) > 0;
  }

  // ---- internals ------------------------------------------------------------

  private snapshot(p: Prediction, reason: string): void {
    const next = (this.db.get<{ v: number | null }>("SELECT MAX(version) AS v FROM prediction_revisions WHERE prediction_id = ?", p.id)?.v ?? 0) + 1;
    this.db.run(
      "INSERT INTO prediction_revisions (id, prediction_id, version, snapshot_json, reason) VALUES (?, ?, ?, ?, ?)",
      crypto.randomUUID(),
      p.id,
      next,
      JSON.stringify(p),
      reason,
    );
  }

  private replaceComponents(predictionId: string, comps: { kind: ComponentKind; statement: string; deadlineDate?: string; notes?: string }[]): void {
    this.db.run("DELETE FROM prediction_components WHERE prediction_id = ?", predictionId);
    comps.forEach((c, i) => {
      this.db.run(
        "INSERT INTO prediction_components (id, prediction_id, seq, kind, statement, deadline_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
        crypto.randomUUID(),
        predictionId,
        i,
        c.kind,
        c.statement,
        c.deadlineDate ?? null,
        c.notes ?? null,
      );
    });
  }

  private hydrate(r: PredictionRow): Prediction {
    const components: PredictionComponent[] = this.db
      .all<ComponentRow>("SELECT * FROM prediction_components WHERE prediction_id = ? ORDER BY seq", r.id)
      .map((c) => ({ id: c.id, seq: c.seq, kind: c.kind, statement: c.statement, deadlineDate: c.deadline_date ?? undefined, notes: c.notes ?? undefined }));
    return {
      id: r.id,
      videoId: r.video_id,
      kind: r.kind ?? "general",
      sportsPick: r.sports_json ? (JSON.parse(r.sports_json) as SportsPick) : undefined,
      videoTitle: r.video_title ?? undefined,
      quoteExact: r.quote_exact,
      contextBefore: r.context_before ?? undefined,
      contextAfter: r.context_after ?? undefined,
      startS: r.start_s ?? undefined,
      endS: r.end_s ?? undefined,
      speaker: r.speaker ?? undefined,
      normalizedStatement: r.normalized_statement,
      entities: JSON.parse(r.entities_json) as string[],
      topic: r.topic ?? undefined,
      geography: r.geography ?? undefined,
      scope: r.scope ?? undefined,
      conditions: JSON.parse(r.conditions_json) as string[],
      thresholds: JSON.parse(r.thresholds_json) as string[],
      modality: r.modality ?? undefined,
      madeOnDate: r.made_on_date ?? undefined,
      madeOnBasis: r.made_on_basis,
      timeExpression: r.time_expression ?? undefined,
      deadlineDate: r.deadline_date ?? undefined,
      deadlineBasis: r.deadline_basis ?? undefined,
      ambiguities: JSON.parse(r.ambiguities_json) as string[],
      extractionConfidence: r.extraction_confidence ?? undefined,
      userStatus: r.user_status,
      mergedIntoId: r.merged_into_id ?? undefined,
      duplicateOfId: r.duplicate_of_id ?? undefined,
      occurrences: JSON.parse(r.occurrences_json) as Prediction["occurrences"],
      extractionProvider: r.extraction_provider ?? undefined,
      extractionModel: r.extraction_model ?? undefined,
      extractionTemplate: r.extraction_template ?? undefined,
      components,
      latestPlanVersion: r.latest_plan_version ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
