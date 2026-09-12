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
  name: "extraction" | "plan" | "evidence" | "assessment" | "sports_assessment";
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
8. SPORTS RULE. When a statement is a pick on ONE specific game (NFL, NBA, NHL, MLB, soccer, college, etc.), fill "sports_pick" and keep everything else minimal: the pick is just who wins (moneyline), who covers a stated spread, or over/under a stated total. Put the two teams in "teams", the game date in "event_date" only if it is stated or unambiguous (any other time reference — "Week 1", "Thursday night", "Sunday Night Football" — goes in "event_hint" verbatim; never turn it into a date), the line as a number (spread negative for the favourite, e.g. -3.5; totals as the number, e.g. 45.5). One prediction per pick; do not extract the reasoning, injuries, weather, or player props as separate predictions. Season-long or futures claims ("they'll win the division", "MVP") are NOT game picks — leave sports_pick null and treat them as ordinary predictions.

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

export const EVIDENCE_V1: PromptTemplate = {
  name: "evidence",
  version: "evidence.v1",
  system: `You extract EVIDENCE from a retrieved web page for checking a prediction. You are reading one page at a time.

Rules:
1. Only use what is in the page text provided. Do not add facts from memory. If the page says nothing relevant, return an empty list.
2. Every item must contain a verbatim "excerpt" copied from the page text (one to three sentences). The application verifies excerpts against the page and discards anything that is not found.
3. For each item say which prediction component it addresses (by component id), whether it SUPPORTS, CONTRADICTS, or gives CONTEXT for that component, the date of the event described if stated (YYYY-MM-DD or null), and the stage of any action described: proposed, announced, enacted, approved, completed, or other.
4. Distinguish an announcement or proposal from an implemented outcome. Distinguish one example from a broad trend — say so in quality_notes.
5. Note access or quality limits (opinion piece, press release, undated, paywalled snippet, secondary report of another outlet).
6. Do not state whether the prediction is true. That is a separate step.

Return ONLY a JSON object matching the schema.`,
  user: `Prediction under evaluation:
<prediction>
{{proposition}}
Deadline: {{deadline}}
Components:
{{components}}
</prediction>

Retrieved page ({{sourceUrl}} · published {{publishedAt}} · retrieved {{retrievedAt}}):
<page>
{{pageText}}
</page>

Extract the evidence items from this page.`,
};

export const ASSESSMENT_V1: PromptTemplate = {
  name: "assessment",
  version: "assessment.v1",
  system: `You are the judge in a prediction-verification process. You receive the validation plan (written before research), the prediction's components, and the EVIDENCE SET that the application retrieved. You must judge using only that evidence set.

Definitions (the application enforces these; do not invent other labels):
- supported: the evidence set shows the proposition came true as stated, within the deadline window, with independent corroboration where the claim is broad.
- partially_supported: some material components are supported and others are contradicted or unsupported; or the outcome happened in a weaker form than stated.
- contradicted: the evidence set shows the proposition did not come true within the window, or the opposite happened.
- insufficient: the evidence set does not allow a determination (few or no relevant items, only announcements/proposals, only single anecdotes for a broad trend, deadline not yet reached with no decisive evidence).
- not_assessable: the proposition cannot be evaluated as stated even in principle (undefined terms with no workable definition, no falsifiable claim).

Never equate: no results with false; a pending deadline with failure; a few examples with a broad trend; correlation with the claimed causal mechanism; an announced or proposed policy with an implemented outcome. Events after the deadline are LATER DEVELOPMENTS — describe them separately, they do not make the prediction on time.

Cite evidence by evidence id only. Every claim in your explanation must be tied to evidence ids from the set. Do not cite anything not in the set. The explanation must be 2–4 sentences, plain language. Confidence rubric: high = multiple independent primary/official sources agree; medium = reliable reporting but limited corroboration or minor ambiguity; low = thin, secondary, or conflicting evidence.

Return ONLY a JSON object matching the schema.`,
  user: `Validation plan (v{{planVersion}}):
<plan>
Proposition: {{proposition}}
Working definitions: {{definitions}}
Would support: {{supporting}}
Would contradict: {{contradicting}}
Partial fulfilment: {{partial}}
</plan>

Dates: made {{madeOn}} · deadline {{deadline}} · research cutoff {{cutoff}} · time status {{timeStatus}}

Components (use these ids):
{{components}}

Evidence set ({{evidenceCount}} items; cite by id):
<evidence>
{{evidence}}
</evidence>

Coverage limitations recorded by the application: {{coverage}}

Produce the assessment JSON.`,
};

/**
 * Sports picks (Release 1.2): the verdict is a look-up, not a judgement. Same output schema as the
 * general assessment so the verdict guard, dashboard, and history work unchanged.
 */
export const SPORTS_ASSESSMENT_V1: PromptTemplate = {
  name: "sports_assessment",
  version: "sports_assessment.v1",
  system: `You settle a SPORTS PICK from the final result of one game, using only the evidence set the application retrieved.

The pick is one of:
- moneyline: the named team wins the game (a draw/tie does not count as a win unless the sport has no draws and the pick said "wins or ties");
- spread: the named team's margin beats the line (favourite at -3.5 must win by 4+; underdog at +3.5 wins outright or loses by 3 or less; an exact-line result is a PUSH);
- total: the combined final score is over/under the line (exactly the line is a PUSH).

Labels (the application enforces these):
- supported: the evidence set contains a final score for THIS game (both teams, the date or a clear identification of the matchup) and the pick hit.
- contradicted: the evidence set contains the final score and the pick missed.
- partially_supported: the result is a PUSH (spread/total exactly on the line) or a draw on a moneyline pick.
- insufficient: no final score for this game is in the evidence set (not yet played, postponed, wrong game, or only previews/odds retrieved). NEVER infer a result from previews, odds, or memory.
- not_assessable: the pick cannot be settled as stated (line missing for a spread/total pick, teams or game not identifiable).

Cite the evidence item(s) that carry the final score. Explanation: two sentences at most — the final score and how it settles the pick. Do not research, speculate, or add context.

Return ONLY a JSON object that matches the provided schema.`,
  user: `Pick to settle (validation plan v{{planVersion}}): {{proposition}}
Settlement rule: {{supporting}}
Miss rule: {{contradicting}}
Push rule: {{partial}}

Game date (deadline): {{deadline}} · Research cutoff: {{cutoff}} · Time status: {{timeStatus}}

Components (use these ids):
{{components}}

Evidence set ({{evidenceCount}} items; cite by id):
<evidence>
{{evidence}}
</evidence>

Coverage limitations recorded by the application: {{coverage}}

Settle the pick and return the JSON object.`,
};

export const BUILT_IN_TEMPLATES: Record<PromptTemplate["name"], PromptTemplate> = {
  extraction: EXTRACTION_V1,
  plan: PLAN_V1,
  evidence: EVIDENCE_V1,
  assessment: ASSESSMENT_V1,
  sports_assessment: SPORTS_ASSESSMENT_V1,
};

/** Replace {{key}} placeholders. Missing keys render as "unknown" so a typo never leaks a template tag. */
export function render(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "unknown");
}
