/**
 * Prediction Ledger — validation plan repository (immutable versions).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * A plan version is never updated in place (VP-03). A user edit inserts version n+1 with
 * provider 'user' and template_version 'user-edit'. Research runs (0.3) reference a plan id,
 * so the exact criteria used are always recoverable.
 */

import crypto from "node:crypto";
import type { ValidationPlan, ValidationPlanBody } from "@prediction-ledger/shared";
import type { Database } from "../db/index.js";

interface PlanRow {
  id: string;
  prediction_id: string;
  version: number;
  plan_json: string;
  research_prompt: string;
  provider: string;
  model: string | null;
  template_version: string;
  edited_by_user: number;
  created_at: string;
}

export class PlanService {
  constructor(private readonly db: Database) {}

  add(input: {
    predictionId: string;
    plan: ValidationPlanBody;
    researchPrompt: string;
    provider: string;
    model?: string;
    templateVersion: string;
    editedByUser?: boolean;
    jobId?: string;
  }): ValidationPlan {
    const id = crypto.randomUUID();
    this.db.transaction(() => {
      const next = (this.db.get<{ v: number | null }>("SELECT MAX(version) AS v FROM validation_plans WHERE prediction_id = ?", input.predictionId)?.v ?? 0) + 1;
      this.db.run(
        `INSERT INTO validation_plans (id, prediction_id, version, plan_json, research_prompt, provider, model, template_version, edited_by_user, job_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.predictionId,
        next,
        JSON.stringify(input.plan),
        input.researchPrompt,
        input.provider,
        input.model ?? null,
        input.templateVersion,
        input.editedByUser ? 1 : 0,
        input.jobId ?? null,
      );
    });
    return this.get(id)!;
  }

  get(id: string): ValidationPlan | undefined {
    const row = this.db.get<PlanRow>("SELECT * FROM validation_plans WHERE id = ?", id);
    return row ? hydrate(row) : undefined;
  }

  listForPrediction(predictionId: string): ValidationPlan[] {
    return this.db.all<PlanRow>("SELECT * FROM validation_plans WHERE prediction_id = ? ORDER BY version DESC", predictionId).map(hydrate);
  }

  latest(predictionId: string): ValidationPlan | undefined {
    const row = this.db.get<PlanRow>("SELECT * FROM validation_plans WHERE prediction_id = ? ORDER BY version DESC LIMIT 1", predictionId);
    return row ? hydrate(row) : undefined;
  }
}

function hydrate(r: PlanRow): ValidationPlan {
  return {
    id: r.id,
    predictionId: r.prediction_id,
    version: r.version,
    plan: JSON.parse(r.plan_json) as ValidationPlanBody,
    researchPrompt: r.research_prompt,
    provider: r.provider,
    model: r.model ?? undefined,
    templateVersion: r.template_version,
    editedByUser: r.edited_by_user === 1,
    createdAt: r.created_at,
  };
}
