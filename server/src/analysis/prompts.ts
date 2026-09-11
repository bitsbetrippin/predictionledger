/**
 * Prediction Ledger — built-in prompt templates (extraction.v1, plan.v1).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Templates are versioned strings with {{placeholders}}. Users may override a template in
 * Setup; the override is stored with the built-in version it was derived from so that a
 * later built-in change can be flagged. Untrusted content (transcript windows, prediction
 * text) is always placed inside clearly delimited blocks and never in the system message.
 * The application — not the prompt — controls tools, budgets, and verdict vocabulary.
 */

export interface PromptTemplate {
  name: "extraction" | "plan";
  version: string;
  system: string;
  user: string;
}

export const EXTRACTION_V1: PromptTemplate = {
  name: "extraction",
  version: "extraction.v1",
  system: `You are a careful analyst who identifies PREDICTIONS in a spoken transcript.

A prediction is a statement by the speaker that makes a claim about a FUTURE event, condition, trend, or outcome. It is NOT:
- a historical fact or description of the present,
- a question,
- a wish, hope, or recommendation ("we should", "I'd love to see"),
- a hypothetical or conditional musing with no committed claim ("if X happened, Y might…" with no expectation stated),
- a quotation or paraphrase of someone else's view that the speaker does not adopt.

Rules you must follow:
1. Quote EXACTLY. The "quote" must be verbatim text from the transcript, long enough to be unambiguous (usually one to three sentences). Do not paraphrase inside the quote.
2. Preserve modality. If the speaker says "might", "could", "probably", or "I think", keep that strength in the normalized statement. Never upgrade "might" to "will".
3. Never invent what is not stated. If geography, the actor, or the timeframe is not stated, leave the field null and list it under "ambiguities".
4. Split compound statements into components: "future_claim" (what will happen), "premise" (a present-state claim the speaker relies on), "causal_link" (the claimed mechanism). A prediction must have at least one future_claim component.
5. Record the original time expression verbatim ("within two years", "by 2027"). Propose an ISO deadline ONLY if it follows directly from the words and the statement date given below; otherwise null. The application resolves dates independently.
6. Extract every distinct prediction in the window, including repeated ones (the application deduplicates).
7. Report a confidence 0–1 that the statement is a genuine prediction by the speaker.

Return ONLY a JSON object that matches the provided schema. No prose before or after.`,
  user: `Video: {{videoTitle}}
Statement date basis: {{madeOnDateLine}}
Transcript window {{windowId}} ({{windowRange}}). Lines are "[h:mm:ss] Speaker: text".

<transcript_window>
{{window}}
</transcript_window>

Identify the predictions in this window and return the JSON object.`,
};

export const PLAN_V1: PromptTemplate = {
  name: "plan",
  version: "plan.v1",
  system: `You design evaluation plans for checking whether a prediction came true. Your job is to write the TEST before anyone looks at the ANSWER.

Create a research prompt and evaluation plan for checking this prediction. Do not determine the outcome yet. Do not state or guess whether the prediction was fulfilled. Do not cite any facts about what happened after the prediction date.

The plan must:
- State the exact proposition being evaluated, in one sentence, preserving the speaker's modality.
- List the material components (future claim(s), premise(s), causal link(s)) and any conditions or qualifiers that apply.
- Record the prediction date, the deadline, and the research cutoff date given below. Do not change them.
- Define ambiguous terms with a working definition that a researcher can apply (e.g. what "narrowed down to" would have to mean to count), and list remaining ambiguities.
- Describe evidence that WOULD support the prediction, evidence that WOULD contradict it, and criteria for partial fulfillment.
- Propose search queries in three groups: neutral (what happened), supporting (would find confirming evidence), disconfirming (would find contradicting evidence or alternative explanations). 3–6 queries per group. Queries should be specific and dated where useful.
- Name preferred source types (official records, primary data, filings, reliable reporting) appropriate to this claim.
- Write a complete, executable research prompt that a separate research agent can follow. It must instruct the agent to (a) only use sources it actually retrieves, (b) record dates and whether each item supports/contradicts/contextualises each component, (c) distinguish proposed vs announced vs enacted vs completed actions, (d) separate events inside the deadline window from later developments, (e) never treat missing results as a verdict.

Return ONLY a JSON object that matches the provided schema.`,
  user: `Prediction to plan for:

<prediction>
Quote: "{{quote}}"
Context before: {{contextBefore}}
Context after: {{contextAfter}}
Normalized statement: {{normalizedStatement}}
Components:
{{components}}
Entities: {{entities}}
Topic: {{topic}}
Geography (as stated): {{geography}}
Conditions / qualifiers: {{conditions}}
Ambiguities noted at extraction: {{ambiguities}}
</prediction>

Dates (fixed by the application — copy them, do not alter):
- Prediction made on: {{madeOnDate}} (basis: {{madeOnBasis}})
- Deadline: {{deadlineDate}} (basis: {{deadlineBasis}})
- Research cutoff: {{researchCutoff}}

Produce the evaluation plan JSON now.`,
};

export const BUILT_IN_TEMPLATES: Record<PromptTemplate["name"], PromptTemplate> = {
  extraction: EXTRACTION_V1,
  plan: PLAN_V1,
};

/** Replace {{key}} placeholders. Missing keys render as "unknown" so a typo never leaks a template tag. */
export function render(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "unknown");
}
