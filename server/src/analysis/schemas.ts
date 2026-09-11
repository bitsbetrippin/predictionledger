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
