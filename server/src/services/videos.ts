/**
 * Prediction Ledger — video + transcript repository/service.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Release 0.2 supports transcript import only (source_kind = 'transcript'). Local media and
 * YouTube imports reuse the same tables in 0.4 / 0.5. Original segment text is immutable;
 * corrections are stored in text_corrected (IN-06).
 */

import crypto from "node:crypto";
import type { TranscriptImportRequest, TranscriptSegment, VideoDetail, VideoSummary } from "@prediction-ledger/shared";
import type { Database } from "../db/index.js";
import { parseTranscript } from "../transcripts/parsers.js";

interface VideoRow {
  id: string;
  title: string;
  source_kind: VideoSummary["sourceKind"];
  source_ref: string | null;
  duration_s: number | null;
  published_at: string | null;
  language: string | null;
  imported_at: string;
  status: VideoSummary["status"];
  notes: string | null;
  segment_count: number;
  prediction_count: number;
  pending_count: number;
}

interface SegmentRow {
  id: string;
  seq: number;
  start_s: number;
  end_s: number;
  text_original: string;
  text_corrected: string | null;
  speaker: string | null;
  engine: string;
}

const SUMMARY_SQL = `
  SELECT v.*,
    (SELECT COUNT(*) FROM transcript_segments s WHERE s.video_id = v.id) AS segment_count,
    (SELECT COUNT(*) FROM predictions p WHERE p.video_id = v.id AND p.user_status IN ('pending','accepted')) AS prediction_count,
    (SELECT COUNT(*) FROM predictions p WHERE p.video_id = v.id AND p.user_status = 'pending') AS pending_count
  FROM videos v`;

export class VideoService {
  constructor(private readonly db: Database) {}

  importTranscript(req: TranscriptImportRequest): { video: VideoDetail; warnings: string[] } {
    const parsed = parseTranscript(req.content, req.format, req.filename);
    if (parsed.segments.length === 0) {
      throw new Error("No transcript segments could be read from the file. Check the format (SRT, VTT, plain text, or JSON).");
    }
    const id = crypto.randomUUID();
    const last = parsed.segments[parsed.segments.length - 1];
    const duration = parsed.hasRealTimestamps ? last.endS : null;

    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO videos (id, title, source_kind, source_ref, duration_s, published_at, language, status, notes)
         VALUES (?, ?, 'transcript', ?, ?, ?, ?, 'ready', ?)`,
        id,
        req.title.trim() || req.filename || "Imported transcript",
        req.filename ?? null,
        duration,
        req.publishedAt ?? null,
        req.language ?? null,
        parsed.warnings.length ? parsed.warnings.join("\n") : null,
      );
      parsed.segments.forEach((s, i) => {
        this.db.run(
          `INSERT INTO transcript_segments (id, video_id, seq, start_s, end_s, text_original, speaker, engine)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          crypto.randomUUID(),
          id,
          i,
          s.startS,
          s.endS,
          s.text,
          s.speaker ?? null,
          `import:${parsed.format}`,
        );
      });
    });
    return { video: this.get(id)!, warnings: parsed.warnings };
  }

  list(): VideoSummary[] {
    return this.db.all<VideoRow>(`${SUMMARY_SQL} ORDER BY v.imported_at DESC`).map(toSummary);
  }

  get(id: string): VideoDetail | undefined {
    const row = this.db.get<VideoRow>(`${SUMMARY_SQL} WHERE v.id = ?`, id);
    if (!row) return undefined;
    const segments = this.db
      .all<SegmentRow>("SELECT * FROM transcript_segments WHERE video_id = ? ORDER BY seq", id)
      .map(toSegment);
    return { ...toSummary(row), segments, notes: row.notes ?? undefined };
  }

  /** Segments in the shape the windowing module wants (corrected text preferred). */
  segmentsForAnalysis(videoId: string): { seq: number; startS: number; endS: number; text: string; speaker?: string }[] {
    return this.db
      .all<SegmentRow>("SELECT * FROM transcript_segments WHERE video_id = ? ORDER BY seq", videoId)
      .map((r) => ({ seq: r.seq, startS: r.start_s, endS: r.end_s, text: r.text_corrected ?? r.text_original, speaker: r.speaker ?? undefined }));
  }

  setStatus(id: string, status: VideoSummary["status"]): void {
    this.db.run("UPDATE videos SET status = ? WHERE id = ?", status, id);
  }

  updateMeta(id: string, patch: { title?: string; publishedAt?: string | null; language?: string | null }): VideoDetail | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    this.db.run(
      "UPDATE videos SET title = ?, published_at = ?, language = ? WHERE id = ?",
      patch.title?.trim() || current.title,
      patch.publishedAt === undefined ? (current.publishedAt ?? null) : patch.publishedAt,
      patch.language === undefined ? (current.language ?? null) : patch.language,
      id,
    );
    return this.get(id);
  }

  correctSegment(videoId: string, segmentId: string, textCorrected: string | null): TranscriptSegment | undefined {
    const changed = this.db.run(
      "UPDATE transcript_segments SET text_corrected = ? WHERE id = ? AND video_id = ?",
      textCorrected?.trim() || null,
      segmentId,
      videoId,
    );
    if (Number(changed.changes) === 0) return undefined;
    const row = this.db.get<SegmentRow>("SELECT * FROM transcript_segments WHERE id = ?", segmentId);
    return row ? toSegment(row) : undefined;
  }

  /** Cascade deletes segments, predictions, components, revisions, plans (FK ON DELETE CASCADE). */
  delete(id: string): boolean {
    return Number(this.db.run("DELETE FROM videos WHERE id = ?", id).changes) > 0;
  }
}

function toSummary(r: VideoRow): VideoSummary {
  return {
    id: r.id,
    title: r.title,
    sourceKind: r.source_kind,
    sourceRef: r.source_ref ?? undefined,
    durationS: r.duration_s ?? undefined,
    publishedAt: r.published_at ?? undefined,
    language: r.language ?? undefined,
    importedAt: r.imported_at,
    status: r.status,
    segmentCount: Number(r.segment_count),
    predictionCount: Number(r.prediction_count),
    pendingPredictionCount: Number(r.pending_count),
  };
}

function toSegment(r: SegmentRow): TranscriptSegment {
  return {
    id: r.id,
    seq: r.seq,
    startS: r.start_s,
    endS: r.end_s,
    textOriginal: r.text_original,
    textCorrected: r.text_corrected ?? undefined,
    speaker: r.speaker ?? undefined,
    engine: r.engine,
  };
}
