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
import { buildSportsPlan } from "../../analysis/sports.js";

export function makePlanHandler(ctx: AppContext) {
  return async (job: JobContext): Promise<Record<string, unknown>> => {
    const predictionId = String(job.payload.predictionId ?? "");
    const p = ctx.predictions.get(predictionId);
    if (!p) throw new Error(`Prediction ${predictionId} no longer exists.`);

    const settings = ctx.settings.getPersisted();
    const researchCutoff = new Date().toISOString().slice(0, 10);

    // Sports picks (1.2): the plan is a settlement rule + score look-ups, written by code — no model call.
    if (p.kind === "sports_pick" && p.sportsPick) {
      job.progress(10, "Building settlement plan");
      // A user-edited deadline counts as the game date for the score look-up queries.
      const pick = { ...p.sportsPick, eventDate: p.sportsPick.eventDate ?? p.deadlineDate };
      const { researchPrompt, ...planBody } = buildSportsPlan(pick, { predictionMade: p.madeOnDate, deadline: p.deadlineDate, researchCutoff }, p.components[0]?.statement ?? p.normalizedStatement);
      const plan = ctx.plans.add({ predictionId, plan: normalizePlan(planBody), researchPrompt, provider: "app", model: "rule", templateVersion: "plan.sports.v1", jobId: job.id });
      if (job.payload.thenResearch === true) {
        ctx.jobs.enqueue({ kind: "research.run", subjectType: "prediction", subjectId: predictionId, payload: { predictionId, planId: plan.id }, dedupeKey: `research.run:${predictionId}`, maxAttempts: 1 });
        job.progress(100, `Settlement plan v${plan.version} saved; looking up the score…`);
      } else {
        job.progress(100, `Settlement plan v${plan.version} saved`);
      }
      return { planId: plan.id, version: plan.version, attempts: 0, deterministic: true };
    }

    const target = resolveStageTarget("validationPlan", ctx.settings, ctx.secrets);
    const template = ctx.templates.effective("plan");

    job.progress(10, "Generating validation plan");
    const result = await completeStructured<PlanOutput>({
      stage: "validationPlan",
      target,
      allowInternet: settings.privacy.allowInternet,
      rateLimiter: ctx.rateLimiter,
          timeoutMs: settings.limits.modelTimeoutSeconds * 1000,
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
    // Auto-continue (VP-04): when research was requested and no plan existed, chain into research.run.
    if (job.payload.thenResearch === true) {
      ctx.jobs.enqueue({ kind: "research.run", subjectType: "prediction", subjectId: predictionId, payload: { predictionId, planId: plan.id }, dedupeKey: `research.run:${predictionId}`, maxAttempts: 1 });
      job.progress(100, `Plan v${plan.version} saved; researching…`);
    } else {
      job.progress(100, `Plan v${plan.version} saved`);
    }
    return { planId: plan.id, version: plan.version, attempts: result.attempts };
  };
}

/** Convert nullable model fields into the shared ValidationPlanBody shape. */
export function normalizePlan(b: Omit<PlanOutput, "researchPrompt">) {
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
