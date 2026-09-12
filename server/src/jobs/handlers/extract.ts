/**
 * Prediction Ledger — job handler: prediction.extract
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Pipeline per video:
 *   segments → overlapping windows → (per window) extraction prompt → validated JSON →
 *   locate quotes back to segments → resolve deadlines by rule → dedupe across windows →
 *   insert predictions + components (one row per distinct prediction, all occurrences kept).
 *
 * Idempotency: re-running extraction for a video first removes predictions from previous
 * automatic runs that the user has NOT touched (status 'pending', no revisions). Accepted,
 * dismissed, edited, or merged predictions are preserved.
 */

import type { JobContext } from "../queue.js";
import type { AppContext } from "../../context.js";
import { buildWindows } from "../../analysis/windowing.js";
import { locateQuote } from "../../analysis/quoteLocator.js";
import { resolveDeadline, isIso } from "../../analysis/dates.js";
import { dedupe, jaccard, type DedupeCandidate } from "../../analysis/dedupe.js";
import { render } from "../../analysis/prompts.js";
import { extractionOutputSchema, EXTRACTION_JSON_SCHEMA, type ExtractedPrediction, type ExtractionOutput } from "../../analysis/schemas.js";
import { completeStructured } from "../../analysis/structured.js";
import { resolveStageTarget } from "../../analysis/stages.js";
import { describePick, normalizeSportsPick } from "../../analysis/sports.js";
import type { NewPrediction } from "../../services/predictions.js";

interface Candidate extends DedupeCandidate<ExtractedPrediction> {
  contextBefore?: string;
  contextAfter?: string;
  matchScore?: number;
  speaker?: string;
}

export function makeExtractHandler(ctx: AppContext) {
  return async (job: JobContext): Promise<Record<string, unknown>> => {
    const videoId = String(job.payload.videoId ?? "");
    const video = ctx.videos.get(videoId);
    if (!video) throw new Error(`Video ${videoId} no longer exists.`);

    const settings = ctx.settings.getPersisted();
    const target = resolveStageTarget("extraction", ctx.settings, ctx.secrets);
    const template = ctx.templates.effective("extraction");

    ctx.videos.setStatus(videoId, "extracting");
    try {
      const segments = ctx.videos.segmentsForAnalysis(videoId);
      const windows = buildWindows(segments);
      if (windows.length === 0) throw new Error("The transcript has no segments to analyse.");

      // Statement date: publication date is the best proxy we have for an imported transcript.
      const madeOnDate = video.publishedAt && isIso(video.publishedAt) ? video.publishedAt : undefined;
      const madeOnBasis: NewPrediction["madeOnBasis"] = madeOnDate ? "publication" : "unknown";
      const madeOnDateLine = madeOnDate
        ? `The recording was published on ${madeOnDate}; treat that as the date statements were made.`
        : "The date of the recording is UNKNOWN. Do not assume a year; leave proposed_deadline null for relative expressions.";

      const candidates: Candidate[] = [];
      const windowNotes: string[] = [];

      for (const w of windows) {
        if (job.signal.aborted) throw new Error("Cancelled");
        job.progress(Math.round((w.index / windows.length) * 90), `Extracting window ${w.index + 1} of ${windows.length}`);

        const result = await completeStructured<ExtractionOutput>({
          stage: "extraction",
          target,
          allowInternet: settings.privacy.allowInternet,
          rateLimiter: ctx.rateLimiter,
          timeoutMs: settings.limits.modelTimeoutSeconds * 1000,
          signal: job.signal,
          schemaName: "extraction_output",
          zodSchema: extractionOutputSchema,
          jsonSchema: EXTRACTION_JSON_SCHEMA,
          messages: [
            { role: "system", content: template.system },
            {
              role: "user",
              content: render(template.user, {
                videoTitle: video.title,
                madeOnDateLine,
                windowId: w.id,
                windowRange: `${fmt(w.startS)}–${fmt(w.endS)}`,
                window: w.rendered,
              }),
            },
          ],
        });
        if (result.data.notes) windowNotes.push(`${w.id}: ${result.data.notes}`);

        for (const p of result.data.predictions) {
          const loc = locateQuote(p.quote, w.segments);
          candidates.push({
            item: p,
            windowId: w.id,
            normalizedStatement: p.normalized_statement,
            quote: p.quote,
            startS: loc?.startS,
            endS: loc?.endS,
            confidence: p.confidence,
            contextBefore: loc?.contextBefore,
            contextAfter: loc?.contextAfter,
            matchScore: loc?.matchScore,
            speaker: p.speaker ?? w.segments.find((s) => s.startS === loc?.startS)?.speaker,
          });
        }
      }

      job.progress(92, "Deduplicating");
      const groups = dedupe(candidates);

      job.progress(95, "Saving predictions");
      let created = 0;
      let matchedExisting = 0;
      ctx.db.transaction(() => {
        // Remove untouched predictions from earlier automatic runs (see header comment).
        ctx.db.run(
          `DELETE FROM predictions WHERE video_id = ? AND user_status = 'pending'
             AND NOT EXISTS (SELECT 1 FROM prediction_revisions r WHERE r.prediction_id = predictions.id)
             AND NOT EXISTS (SELECT 1 FROM validation_plans vp WHERE vp.prediction_id = predictions.id)`,
          videoId,
        );
        // Predictions the user has touched survive; don't re-create their duplicates.
        const kept = ctx.predictions.list({ videoId, includeDismissed: true });
        for (const g of groups) {
          const p = g.primary.item;
          const existing = kept.find((k) => jaccard(k.quoteExact, p.quote) >= 0.8 || jaccard(k.normalizedStatement, p.normalized_statement) >= 0.8);
          if (existing) {
            matchedExisting++;
            continue;
          }
          let deadline = resolveDeadline(p.time_expression ?? undefined, madeOnDate, p.proposed_deadline ?? undefined);
          const ambiguities = [...p.ambiguities];

          // Sports rule (1.2): a pick on one game → kind 'sports_pick', deadline = game date, one settleable component.
          let kind: "general" | "sports_pick" = "general";
          let sportsPick: ReturnType<typeof normalizeSportsPick>["pick"];
          let components = p.components.map((c) => ({
            kind: c.kind,
            statement: c.statement,
            deadlineDate: c.deadline && isIso(c.deadline) ? c.deadline : undefined,
            notes: c.notes ?? undefined,
          }));
          if (p.sports_pick) {
            const norm = normalizeSportsPick(p.sports_pick);
            ambiguities.push(...norm.problems);
            if (norm.pick) {
              kind = "sports_pick";
              sportsPick = norm.pick;
              if (norm.pick.eventDate) deadline = { deadlineDate: norm.pick.eventDate, basis: "rule:event" };
              else if (!deadline.deadlineDate) deadline = { basis: "unresolved", note: "Game date not stated; the pick settles when the matchup is identified." };
              components = [{ kind: "future_claim", statement: describePick(norm.pick), deadlineDate: norm.pick.eventDate, notes: "Sports pick — settled from the final score." }];
            }
          }
          if (g.primary.matchScore !== undefined && g.primary.matchScore < 0.85) ambiguities.push(`Quote matched transcript at ${Math.round(g.primary.matchScore * 100)}% — verify wording.`);
          if (g.primary.startS === undefined) ambiguities.push("Quote could not be located in the transcript; timestamps unknown.");
          if (deadline.note) ambiguities.push(deadline.note);

          ctx.predictions.create({
            videoId,
            kind,
            sportsPick,
            quoteExact: p.quote,
            contextBefore: g.primary.contextBefore,
            contextAfter: g.primary.contextAfter,
            startS: g.primary.startS,
            endS: g.primary.endS,
            speaker: g.primary.speaker ?? undefined,
            normalizedStatement: p.normalized_statement,
            entities: p.entities,
            topic: p.topic ?? undefined,
            geography: p.geography ?? undefined,
            scope: p.scope ?? undefined,
            conditions: p.conditions,
            thresholds: p.thresholds,
            modality: p.modality ?? undefined,
            madeOnDate,
            madeOnBasis,
            timeExpression: p.time_expression ?? undefined,
            deadlineDate: deadline.deadlineDate,
            deadlineBasis: deadline.basis === "unresolved" ? undefined : deadline.basis,
            ambiguities,
            extractionConfidence: p.confidence,
            occurrences: g.occurrences,
            extractionProvider: target.providerId,
            extractionModel: target.model,
            extractionTemplate: template.effectiveVersion,
            extractionJobId: job.id,
            components,
          });
          created++;
        }
      });

      ctx.videos.setStatus(videoId, "ready");
      job.progress(100, created === 0 && matchedExisting === 0 ? "No predictions found" : `${created} new prediction(s) saved${matchedExisting ? `, ${matchedExisting} already present` : ""}`);
      return { windows: windows.length, candidates: candidates.length, created, matchedExisting, notes: windowNotes };
    } catch (err) {
      ctx.videos.setStatus(videoId, "ready");
      throw err;
    }
  };
}

function fmt(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
