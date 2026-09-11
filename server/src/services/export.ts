/**
 * Prediction Ledger — CSV export (one row per prediction with its latest assessment).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * RFC 4180 quoting; UTF-8 BOM so Excel opens it correctly. Never touches settings or secrets.
 */

import type { AppContext } from "../context.js";
import { timeStatus } from "../analysis/dates.js";

export const CSV_COLUMNS = [
  "prediction_id", "video_title", "video_published", "timestamp", "speaker", "quote", "normalized_statement", "modality",
  "topic", "geography", "made_on", "made_on_basis", "time_expression", "deadline", "deadline_basis", "time_status",
  "review_status", "components", "plan_version", "evidence_assessment", "confidence", "explanation", "source_count",
  "supporting_sources", "contradicting_sources", "researched_at", "recheck_after", "assessment_version",
] as const;

export function csvEscape(v: unknown): string {
  if (v === undefined || v === null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(ctx: Pick<AppContext, "predictions" | "research">): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [CSV_COLUMNS.join(",")];
  for (const p of ctx.predictions.list({ includeDismissed: true })) {
    const a = ctx.research.assessmentsForPrediction(p.id)[0];
    const evidence = a ? ctx.research.evidenceForRun(a.runId) : [];
    const urls = (ids: string[]) => [...new Set(ids.map((i) => evidence.find((e) => e.id === i)?.source?.url).filter(Boolean))].join(" ");
    const row = [
      p.id, p.videoTitle, undefined, p.startS !== undefined ? fmt(p.startS) : undefined, p.speaker, p.quoteExact, p.normalizedStatement, p.modality,
      p.topic, p.geography, p.madeOnDate, p.madeOnBasis, p.timeExpression, p.deadlineDate, p.deadlineBasis, timeStatus(p.deadlineDate, today),
      p.userStatus, p.components.map((c) => `[${c.kind}] ${c.statement}`).join(" | "), p.latestPlanVersion, a?.evidenceAssessment, a?.confidence, a?.explanation,
      a ? new Set(evidence.map((e) => e.sourceId)).size : 0, a ? urls(a.supportingIds) : "", a ? urls(a.contradictingIds) : "", a?.researchedAt, a?.recheckAfter, a?.version,
    ];
    lines.push(row.map(csvEscape).join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

function fmt(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
