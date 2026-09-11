/**
 * Prediction Ledger — job handler: plan.generate
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Generates the validation plan for ONE prediction: the evaluation criteria and search
 * queries are written before any research happens (VP-01). Dates are fixed by the app and
 * passed in; the model is told to copy them. The result is stored as a new immutable plan
 * version with provider/model/template/time (VP-03).
 */

import type { JobContext } from "../queue.js";
import type { AppContext } from "../../context.js";
import { render } from "../../analysis/prompts.js";
import { planOutputSchema, PLAN_JSON_SCHEMA, type PlanOutput } from "../../analysis/schemas.js";
import { completeStructured } from "../../analysis/structured.js";
import { resolveStageTarget } from "../../analysis/stages.js";

export function makePlanHandler(ctx: AppContext) {
  return async (job: JobContext): Promise<Record<string, unknown>> => {
    const predictionId = String(job.payload.predictionId ?? "");
    const p = ctx.predictions.get(predictionId);
    if (!p) throw new Error(`Prediction ${predictionId} no longer exists.`);

    const settings = ctx.settings.getPersisted();
    const target = resolveStageTarget("validationPlan", ctx.settings, ctx.secrets);
    const template = ctx.templates.effective("plan");
    const researchCutoff = new Date().toISOString().slice(0, 10);

    job.progress(10, "Generating validation plan");
    const result = await completeStructured<PlanOutput>({
      stage: "validationPlan",
      target,
      allowInternet: settings.privacy.allowInternet,
      rateLimiter: ctx.rateLimiter,
      signal: job.signal,
      schemaName: "validation_plan",
      zodSchema: planOutputSchema,
      jsonSchema: PLAN_JSON_SCHEMA,
      messages: [
        { role: "system", content: template.system },
        {
          role: "user",
          content: render(template.user, {
            quote: p.quoteExact,
            contextBefore: p.contextBefore || "(none)",
            contextAfter: p.contextAfter || "(none)",
            normalizedStatement: p.normalizedStatement,
            components: p.components.map((c) => `- [${c.kind}] ${c.statement}${c.deadlineDate ? ` (deadline ${c.deadlineDate})` : ""}`).join("\n") || "- (none)",
            entities: p.entities.join(", ") || "(none)",
            topic: p.topic || "(unstated)",
            geography: p.geography || "(unstated — treat geography as ambiguous)",
            conditions: p.conditions.join("; ") || "(none)",
            ambiguities: p.ambiguities.join("; ") || "(none)",
            madeOnDate: p.madeOnDate || "unknown",
            madeOnBasis: p.madeOnBasis,
            deadlineDate: p.deadlineDate || "unknown",
            deadlineBasis: p.deadlineBasis || "unresolved",
            researchCutoff,
          }),
        },
      ],
    });

    // The app owns the dates: overwrite whatever the model wrote so the plan can't drift.
    const { researchPrompt, ...planBody } = result.data;
    planBody.dates = {
      predictionMade: p.madeOnDate ?? null,
      deadline: p.deadlineDate ?? null,
      researchCutoff,
      notes: planBody.dates?.notes ?? null,
    };

    job.progress(90, "Saving plan version");
    const plan = ctx.plans.add({
      predictionId,
      plan: normalizePlan(planBody),
      researchPrompt,
      provider: target.providerId,
      model: result.model,
      templateVersion: template.effectiveVersion,
      jobId: job.id,
    });
    job.progress(100, `Plan v${plan.version} saved`);
    return { planId: plan.id, version: plan.version, attempts: result.attempts };
  };
}

/** Convert nullable model fields into the shared ValidationPlanBody shape. */
function normalizePlan(b: Omit<PlanOutput, "researchPrompt">) {
  return {
    proposition: b.proposition,
    components: b.components.map((c) => ({ statement: c.statement, kind: c.kind, conditions: c.conditions ?? [] })),
    dates: {
      predictionMade: b.dates.predictionMade ?? undefined,
      deadline: b.dates.deadline ?? undefined,
      researchCutoff: b.dates.researchCutoff,
      notes: b.dates.notes ?? undefined,
    },
    definitions: b.definitions ?? [],
    ambiguities: b.ambiguities ?? [],
    supportingEvidence: b.supportingEvidence,
    contradictingEvidence: b.contradictingEvidence,
    partialFulfillmentCriteria: b.partialFulfillmentCriteria ?? [],
    queries: b.queries,
    preferredSourceTypes: b.preferredSourceTypes ?? [],
    outputSchemaNotes: b.outputSchemaNotes ?? "",
  };
}
