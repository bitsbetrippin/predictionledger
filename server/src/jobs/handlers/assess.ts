/**
 * Prediction Ledger — job handler: assessment.run
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Produces a versioned assessment for ONE research run using ONLY that run's stored evidence.
 * Time status is computed by the app from the deadline (VD-01). With zero evidence the verdict
 * is 'insufficient' by rule and no model is called (G6). Otherwise the assessment-stage model
 * proposes a verdict, and the app-side verdict guard constrains it (G1–G5) before saving.
 */

import type { EvidenceItem } from "@prediction-ledger/shared";
import type { JobContext } from "../queue.js";
import type { AppContext } from "../../context.js";
import { render } from "../../analysis/prompts.js";
import { assessmentOutputSchema, ASSESSMENT_JSON_SCHEMA, type AssessmentOutput } from "../../analysis/schemas.js";
import { completeStructured } from "../../analysis/structured.js";
import { resolveStageTarget } from "../../analysis/stages.js";
import { timeStatus } from "../../analysis/dates.js";
import { applyVerdictGuard, suggestRecheck } from "../../research/verdictGuard.js";

export function makeAssessHandler(ctx: AppContext) {
  return async (job: JobContext): Promise<Record<string, unknown>> => {
    const predictionId = String(job.payload.predictionId ?? "");
    const runId = String(job.payload.runId ?? "");
    const p = ctx.predictions.get(predictionId);
    const run = ctx.research.getRun(runId);
    if (!p || !run) throw new Error("Prediction or research run no longer exists.");
    if (run.status !== "completed") throw new Error(`Research run is ${run.status}; nothing to assess.`);
    // SRC-04: forecast-time research informs a forecast; it can never be recorded as a settlement.
    if (run.purpose === "forecast") throw new Error("This research run has purpose 'forecast'; forecast evidence is never turned into a verdict.");
    const plan = ctx.plans.get(run.validationPlanId)!;
    const settings = ctx.settings.getPersisted();
    const today = new Date().toISOString().slice(0, 10);
    const ts = timeStatus(p.deadlineDate, today);
    const evidence = ctx.research.evidenceForRun(run.id);

    const guardInput = {
      components: p.components.map((c) => ({ id: c.id, kind: c.kind })),
      evidence: evidence.map((e) => ({ id: e.id, componentId: e.componentId, stance: e.stance, inWindow: e.inWindow, actionStage: e.actionStage, independent: e.independent, sourceId: e.sourceId })),
      timeStatus: ts,
    };

    // G6: nothing to judge → deterministic assessment, no model call.
    if (evidence.length === 0) {
      const guarded = applyVerdictGuard({ ...guardInput, model: { overall: "insufficient", confidence: "low", supportingIds: [], contradictingIds: [], citations: [], components: [] } });
      const a = ctx.research.addAssessment({
        predictionId,
        runId: run.id,
        validationPlanId: plan.id,
        evidenceAssessment: "insufficient",
        timeStatus: ts,
        explanation: `No evidence could be retrieved for this prediction as of ${run.cutoffDate}. ${run.coverageNotes[0] ?? "The searches returned no readable sources."} This is not a finding that the prediction is false.`,
        uncertainty: "The absence of results may reflect search coverage, paywalls, or that nothing has been reported yet.",
        confidence: "low",
        confidenceRationale: "No evidence set.",
        supportingIds: [],
        contradictingIds: [],
        citations: [],
        guardNotes: guarded.notes,
        components: p.components.map((c) => ({ componentId: c.id, componentKind: c.kind, statement: c.statement, assessment: "insufficient" as const, explanation: "No evidence retrieved.", evidenceIds: [] })),
        provider: "app",
        templateVersion: "rule:G6",
        researchedAt: run.cutoffDate,
        recheckAfter: suggestRecheck(today, ts, "insufficient", p.deadlineDate, settings.research.recheckAfterDays),
      });
      job.progress(100, `Assessment v${a.version}: insufficient evidence (no sources)`);
      return { assessmentId: a.id, version: a.version, deterministic: true };
    }

    const target = resolveStageTarget("assessment", ctx.settings, ctx.secrets);
    // Sports picks (1.2) are settled by a look-up template with the same output schema.
    const template = ctx.templates.effective(p.kind === "sports_pick" ? "sports_assessment" : "assessment");
    job.progress(20, "Assessing evidence");

    const result = await completeStructured<AssessmentOutput>({
      stage: "assessment",
      target,
      allowInternet: settings.privacy.allowInternet,
      rateLimiter: ctx.rateLimiter,
          timeoutMs: settings.limits.modelTimeoutSeconds * 1000,
      signal: job.signal,
      schemaName: "assessment_output",
      zodSchema: assessmentOutputSchema,
      jsonSchema: ASSESSMENT_JSON_SCHEMA,
      messages: [
        { role: "system", content: template.system },
        {
          role: "user",
          content: render(template.user, {
            planVersion: String(plan.version),
            proposition: plan.plan.proposition,
            definitions: plan.plan.definitions.map((d) => `${d.term}: ${d.workingDefinition}`).join("; ") || "(none)",
            supporting: plan.plan.supportingEvidence.join("; "),
            contradicting: plan.plan.contradictingEvidence.join("; "),
            partial: plan.plan.partialFulfillmentCriteria.join("; ") || "(none)",
            madeOn: p.madeOnDate ?? "unknown",
            deadline: p.deadlineDate ?? "unknown",
            cutoff: run.cutoffDate,
            timeStatus: ts,
            components: p.components.map((c) => `- ${c.id} [${c.kind}] ${c.statement}`).join("\n"),
            evidenceCount: String(evidence.length),
            evidence: evidence.map(renderEvidence).join("\n\n"),
            coverage: run.coverageNotes.join(" | ") || "(none)",
          }),
        },
      ],
    });

    const m = result.data;
    const guarded = applyVerdictGuard({
      ...guardInput,
      model: {
        overall: m.overall.evidence_assessment,
        confidence: m.overall.confidence,
        supportingIds: m.overall.supporting_ids ?? [],
        contradictingIds: m.overall.contradicting_ids ?? [],
        citations: (m.overall.citations ?? []).map((c) => ({ claim: c.claim, evidenceIds: c.evidence_ids })),
        components: m.component_assessments.map((c) => ({ componentId: c.component_id, assessment: c.assessment, evidenceIds: c.evidence_ids ?? [] })),
      },
    });

    // Later developments the app can see from dates, in case the model omitted them.
    const late = evidence.filter((e) => e.inWindow === false);
    const laterDevelopments = m.overall.later_developments ?? (late.length ? `${late.length} evidence item(s) describe events after the deadline (${late.map((e) => e.eventDate).join(", ")}); they do not count toward on-time fulfilment.` : undefined);

    job.progress(90, "Saving assessment");
    const a = ctx.research.addAssessment({
      predictionId,
      runId: run.id,
      validationPlanId: plan.id,
      evidenceAssessment: guarded.overall,
      timeStatus: ts,
      explanation: m.overall.explanation,
      uncertainty: m.overall.uncertainty ?? undefined,
      confidence: guarded.confidence,
      confidenceRationale: m.overall.confidence_rationale ?? undefined,
      supportingIds: guarded.supportingIds,
      contradictingIds: guarded.contradictingIds,
      citations: guarded.citations,
      laterDevelopments,
      guardNotes: guarded.notes,
      components: p.components.map((c) => {
        const g = guarded.components.find((x) => x.componentId === c.id)!;
        const mm = m.component_assessments.find((x) => x.component_id === c.id);
        return { componentId: c.id, componentKind: c.kind, statement: c.statement, assessment: g.assessment, explanation: mm?.explanation ?? "Not addressed by the model.", evidenceIds: g.evidenceIds };
      }),
      provider: target.providerId,
      model: result.model,
      templateVersion: template.effectiveVersion,
      researchedAt: run.cutoffDate,
      recheckAfter: suggestRecheck(today, ts, guarded.overall, p.deadlineDate, settings.research.recheckAfterDays),
    });
    job.progress(100, `Assessment v${a.version}: ${a.evidenceAssessment}`);
    return { assessmentId: a.id, version: a.version, guardNotes: guarded.notes, attempts: result.attempts };
  };
}

function renderEvidence(e: EvidenceItem): string {
  const s = e.source;
  return [
    `[${e.id}] stance=${e.stance} component=${e.componentId ?? "none"} event_date=${e.eventDate ?? "undated"} in_window=${e.inWindow === undefined ? "unknown" : e.inWindow} stage=${e.actionStage ?? "n/a"} independent=${e.independent}`,
    `source: ${s?.title ?? "(untitled)"} — ${s?.publisher ?? ""} — published ${s?.publishedAt ?? "unknown"} — ${s?.url ?? ""}`,
    `excerpt: "${e.excerpt}"`,
    e.fact ? `fact: ${e.fact}` : "",
    e.qualityNotes ? `quality: ${e.qualityNotes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
