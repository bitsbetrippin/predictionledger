/**
 * Prediction Ledger — model output schemas (Zod for validation + JSON Schema for providers).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Two representations are kept in sync by hand (a zod→json-schema dependency would be the
 * alternative; see spike S-2 in docs/ARCHITECTURE.md). Zod is the source of truth: whatever
 * the provider claims to enforce, the app re-validates and refuses malformed output (PX-08).
 */

import { z } from "zod";

// ---- Extraction ---------------------------------------------------------------

const nullableStr = z.string().nullable().optional();

export const extractedComponentSchema = z.object({
  kind: z.enum(["future_claim", "premise", "causal_link"]),
  statement: z.string().min(3),
  deadline: nullableStr,
  notes: nullableStr,
});

export const sportsPickSchema = z.object({
  sport: z.string().min(2),
  league: nullableStr,
  teams: z.array(z.string().min(1)).min(2).max(2),
  event_date: nullableStr,
  pick_type: z.enum(["moneyline", "spread", "total"]),
  team: nullableStr,
  line: z.number().nullable().optional(),
  side: z.enum(["over", "under"]).nullable().optional(),
});

export const extractedPredictionSchema = z.object({
  quote: z.string().min(10),
  speaker: nullableStr,
  normalized_statement: z.string().min(5),
  modality: nullableStr,
  entities: z.array(z.string()).default([]),
  topic: nullableStr,
  geography: nullableStr,
  scope: nullableStr,
  conditions: z.array(z.string()).default([]),
  thresholds: z.array(z.string()).default([]),
  time_expression: nullableStr,
  proposed_deadline: nullableStr,
  ambiguities: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  components: z.array(extractedComponentSchema).min(1),
  /** Present only when the statement is a pick on a single game (Release 1.2 sports rule). */
  sports_pick: sportsPickSchema.nullable().optional(),
});

export const extractionOutputSchema = z.object({
  predictions: z.array(extractedPredictionSchema),
  /** Free-text notes about the window (e.g. "mostly historical recap"). */
  notes: nullableStr,
});

export type ExtractedPrediction = z.infer<typeof extractedPredictionSchema>;
export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;

export const EXTRACTION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["predictions"],
  properties: {
    predictions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["quote", "normalized_statement", "confidence", "components"],
        properties: {
          quote: { type: "string", description: "Verbatim text from the transcript window." },
          speaker: { type: ["string", "null"] },
          normalized_statement: { type: "string", description: "Concise restatement preserving modality." },
          modality: { type: ["string", "null"], description: "will | likely | might | could | expects | …" },
          entities: { type: "array", items: { type: "string" } },
          topic: { type: ["string", "null"] },
          geography: { type: ["string", "null"], description: "Only if stated." },
          scope: { type: ["string", "null"] },
          conditions: { type: "array", items: { type: "string" } },
          thresholds: { type: "array", items: { type: "string" } },
          time_expression: { type: ["string", "null"], description: "Original wording, e.g. 'within two years'." },
          proposed_deadline: { type: ["string", "null"], description: "YYYY-MM-DD only if it follows directly from the words." },
          ambiguities: { type: "array", items: { type: "string" } },
          sports_pick: {
            type: ["object", "null"],
            description: "Only for a pick on ONE specific game (who wins / spread / total). Null otherwise.",
            additionalProperties: false,
            required: ["sport", "teams", "pick_type"],
            properties: {
              sport: { type: "string", description: "NFL, NBA, NHL, MLB, soccer, college football, …" },
              league: { type: ["string", "null"] },
              teams: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
              event_date: { type: ["string", "null"], description: "YYYY-MM-DD only if stated or unambiguous from the transcript." },
              pick_type: { type: "string", enum: ["moneyline", "spread", "total"] },
              team: { type: ["string", "null"], description: "Winner (moneyline) or covering team (spread)." },
              line: { type: ["number", "null"], description: "Spread (negative = favourite) or total line." },
              side: { type: ["string", "null"], enum: ["over", "under", null] },
            },
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          components: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "statement"],
              properties: {
                kind: { type: "string", enum: ["future_claim", "premise", "causal_link"] },
                statement: { type: "string" },
                deadline: { type: ["string", "null"] },
                notes: { type: ["string", "null"] },
              },
            },
          },
        },
      },
    },
    notes: { type: ["string", "null"] },
  },
};

// ---- Validation plan ------------------------------------------------------------

export const planOutputSchema = z.object({
  proposition: z.string().min(5),
  components: z
    .array(
      z.object({
        statement: z.string(),
        kind: z.enum(["future_claim", "premise", "causal_link"]),
        conditions: z.array(z.string()).default([]),
      }),
    )
    .min(1),
  dates: z.object({
    predictionMade: nullableStr,
    deadline: nullableStr,
    researchCutoff: z.string(),
    notes: nullableStr,
  }),
  definitions: z.array(z.object({ term: z.string(), workingDefinition: z.string() })).default([]),
  ambiguities: z.array(z.string()).default([]),
  supportingEvidence: z.array(z.string()).min(1),
  contradictingEvidence: z.array(z.string()).min(1),
  partialFulfillmentCriteria: z.array(z.string()).default([]),
  queries: z.object({
    neutral: z.array(z.string()).min(1),
    supporting: z.array(z.string()).min(1),
    disconfirming: z.array(z.string()).min(1),
  }),
  preferredSourceTypes: z.array(z.string()).default([]),
  outputSchemaNotes: z.string().default(""),
  researchPrompt: z.string().min(50),
});

export type PlanOutput = z.infer<typeof planOutputSchema>;

export const PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["proposition", "components", "dates", "supportingEvidence", "contradictingEvidence", "queries", "researchPrompt"],
  properties: {
    proposition: { type: "string" },
    components: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "kind"],
        properties: {
          statement: { type: "string" },
          kind: { type: "string", enum: ["future_claim", "premise", "causal_link"] },
          conditions: { type: "array", items: { type: "string" } },
        },
      },
    },
    dates: {
      type: "object",
      additionalProperties: false,
      required: ["researchCutoff"],
      properties: {
        predictionMade: { type: ["string", "null"] },
        deadline: { type: ["string", "null"] },
        researchCutoff: { type: "string" },
        notes: { type: ["string", "null"] },
      },
    },
    definitions: { type: "array", items: { type: "object", required: ["term", "workingDefinition"], properties: { term: { type: "string" }, workingDefinition: { type: "string" } } } },
    ambiguities: { type: "array", items: { type: "string" } },
    supportingEvidence: { type: "array", items: { type: "string" } },
    contradictingEvidence: { type: "array", items: { type: "string" } },
    partialFulfillmentCriteria: { type: "array", items: { type: "string" } },
    queries: {
      type: "object",
      additionalProperties: false,
      required: ["neutral", "supporting", "disconfirming"],
      properties: {
        neutral: { type: "array", items: { type: "string" } },
        supporting: { type: "array", items: { type: "string" } },
        disconfirming: { type: "array", items: { type: "string" } },
      },
    },
    preferredSourceTypes: { type: "array", items: { type: "string" } },
    outputSchemaNotes: { type: "string" },
    researchPrompt: { type: "string", description: "Complete executable prompt for the research agent." },
  },
};

// ---- Evidence extraction (per page) ---------------------------------------------

export const evidenceOutputSchema = z.object({
  items: z
    .array(
      z.object({
        component_id: z.string().nullable().optional(),
        stance: z.enum(["supports", "contradicts", "context"]),
        excerpt: z.string().min(15),
        fact: nullableStr,
        event_date: nullableStr,
        action_stage: z.enum(["proposed", "announced", "enacted", "approved", "completed", "other"]).nullable().optional(),
        quality_notes: nullableStr,
      }),
    )
    .default([]),
  page_relevance: z.enum(["high", "medium", "low", "none"]).optional(),
});
export type EvidenceOutput = z.infer<typeof evidenceOutputSchema>;

export const EVIDENCE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["stance", "excerpt"],
        properties: {
          component_id: { type: ["string", "null"], description: "Id of the prediction component this item addresses." },
          stance: { type: "string", enum: ["supports", "contradicts", "context"] },
          excerpt: { type: "string", description: "Verbatim text copied from the page." },
          fact: { type: ["string", "null"], description: "One-sentence fact the excerpt establishes." },
          event_date: { type: ["string", "null"], description: "YYYY-MM-DD if the event date is stated." },
          action_stage: { type: ["string", "null"], enum: ["proposed", "announced", "enacted", "approved", "completed", "other", null] },
          quality_notes: { type: ["string", "null"] },
        },
      },
    },
    page_relevance: { type: "string", enum: ["high", "medium", "low", "none"] },
  },
};

// ---- Assessment -------------------------------------------------------------------

const verdictEnum = z.enum(["supported", "partially_supported", "contradicted", "insufficient", "not_assessable"]);

export const assessmentOutputSchema = z.object({
  component_assessments: z.array(
    z.object({
      component_id: z.string(),
      assessment: verdictEnum,
      explanation: z.string().min(10),
      evidence_ids: z.array(z.string()).default([]),
    }),
  ),
  overall: z.object({
    evidence_assessment: verdictEnum,
    explanation: z.string().min(20),
    citations: z.array(z.object({ claim: z.string(), evidence_ids: z.array(z.string()).min(1) })).default([]),
    supporting_ids: z.array(z.string()).default([]),
    contradicting_ids: z.array(z.string()).default([]),
    later_developments: nullableStr,
    uncertainty: nullableStr,
    confidence: z.enum(["high", "medium", "low"]),
    confidence_rationale: nullableStr,
  }),
});
export type AssessmentOutput = z.infer<typeof assessmentOutputSchema>;

const VERDICT_ENUM = ["supported", "partially_supported", "contradicted", "insufficient", "not_assessable"];
export const ASSESSMENT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["component_assessments", "overall"],
  properties: {
    component_assessments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["component_id", "assessment", "explanation"],
        properties: {
          component_id: { type: "string" },
          assessment: { type: "string", enum: VERDICT_ENUM },
          explanation: { type: "string" },
          evidence_ids: { type: "array", items: { type: "string" } },
        },
      },
    },
    overall: {
      type: "object",
      additionalProperties: false,
      required: ["evidence_assessment", "explanation", "confidence"],
      properties: {
        evidence_assessment: { type: "string", enum: VERDICT_ENUM },
        explanation: { type: "string", description: "2–4 sentences." },
        citations: { type: "array", items: { type: "object", required: ["claim", "evidence_ids"], properties: { claim: { type: "string" }, evidence_ids: { type: "array", items: { type: "string" } } } } },
        supporting_ids: { type: "array", items: { type: "string" } },
        contradicting_ids: { type: "array", items: { type: "string" } },
        later_developments: { type: ["string", "null"] },
        uncertainty: { type: ["string", "null"] },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        confidence_rationale: { type: ["string", "null"] },
      },
    },
  },
};
