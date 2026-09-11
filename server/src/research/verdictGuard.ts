/**
 * Prediction Ledger — app-side verdict rules (VD-01, VD-02, ADR-007).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * The model proposes a verdict; these deterministic rules constrain it. They can only make a
 * verdict MORE cautious, never less. Every adjustment is recorded in `guardNotes` so the user
 * can see what the app changed and why. Pure functions — unit-tested without any provider.
 *
 * Rules:
 *  G1  Citations must reference evidence ids that exist in this run's evidence set; unknown ids are dropped.
 *  G2  An overall "supported" requires at least one in-window SUPPORTS item on every future_claim component;
 *      otherwise downgrade to partially_supported (if any future_claim is supported) or insufficient.
 *  G3  An overall "contradicted" requires at least one in-window CONTRADICTS item on a future_claim component;
 *      otherwise downgrade to insufficient. (No results never means false.)
 *  G4  If the only supporting items for a future_claim are 'proposed' or 'announced' actions, that component
 *      cannot be "supported" — at most partially_supported. (Announced ≠ implemented.)
 *  G5  If every supporting item for the overall verdict comes from syndicated copies of one source, cap
 *      confidence at "medium" and note it. (Corroboration must be independent.)
 *  G6  With zero evidence items, the verdict is insufficient with confidence low, no model call needed.
 *  G7  Time status is computed by the app from the deadline; the model never sets it.
 */

import type { ComponentKind, EvidenceAssessment, TimeStatusValue } from "@prediction-ledger/shared";

export interface GuardEvidence {
  id: string;
  componentId?: string;
  stance: "supports" | "contradicts" | "context";
  inWindow?: boolean; // undefined = undated → treated as in-window for G2/G3 but noted
  actionStage?: string;
  independent: boolean;
  sourceId: string;
}

export interface GuardComponent {
  id: string;
  kind: ComponentKind;
}

export interface GuardInput {
  components: GuardComponent[];
  evidence: GuardEvidence[];
  timeStatus: TimeStatusValue;
  model: {
    overall: EvidenceAssessment;
    confidence: "high" | "medium" | "low";
    supportingIds: string[];
    contradictingIds: string[];
    citations: { claim: string; evidenceIds: string[] }[];
    components: { componentId: string; assessment: EvidenceAssessment; evidenceIds: string[] }[];
  };
}

export interface GuardOutput {
  overall: EvidenceAssessment;
  confidence: "high" | "medium" | "low";
  supportingIds: string[];
  contradictingIds: string[];
  citations: { claim: string; evidenceIds: string[] }[];
  components: { componentId: string; assessment: EvidenceAssessment; evidenceIds: string[] }[];
  notes: string[];
}

const ORDER: EvidenceAssessment[] = ["supported", "partially_supported", "insufficient", "contradicted", "not_assessable"];
const weaker = (a: EvidenceAssessment, b: EvidenceAssessment): EvidenceAssessment => {
  // "weaker" = more cautious. supported > partially_supported > insufficient. contradicted/not_assessable are kept as-is when chosen.
  if (a === "not_assessable" || b === "not_assessable") return "not_assessable";
  if (a === "contradicted" || b === "contradicted") return a === b ? a : "insufficient";
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
};

export function applyVerdictGuard(input: GuardInput): GuardOutput {
  const notes: string[] = [];
  const known = new Set(input.evidence.map((e) => e.id));
  const byId = new Map(input.evidence.map((e) => [e.id, e]));

  // G6 — nothing to judge.
  if (input.evidence.length === 0) {
    return {
      overall: "insufficient",
      confidence: "low",
      supportingIds: [],
      contradictingIds: [],
      citations: [],
      components: input.components.map((c) => ({ componentId: c.id, assessment: "insufficient", evidenceIds: [] })),
      notes: ["G6: no evidence items were retrieved for this run, so the assessment is 'insufficient evidence' by rule (a search that finds nothing is not a verdict)."],
    };
  }

  // G1 — drop unknown ids everywhere.
  const filterIds = (ids: string[], where: string) => {
    const bad = ids.filter((i) => !known.has(i));
    if (bad.length) notes.push(`G1: dropped ${bad.length} citation id(s) in ${where} that are not in this run's evidence set.`);
    return ids.filter((i) => known.has(i));
  };
  const supportingIds = filterIds(input.model.supportingIds, "supporting_ids");
  const contradictingIds = filterIds(input.model.contradictingIds, "contradicting_ids");
  const citations = input.model.citations
    .map((c) => ({ claim: c.claim, evidenceIds: filterIds(c.evidenceIds, `citation "${c.claim.slice(0, 40)}"`) }))
    .filter((c) => c.evidenceIds.length > 0);

  // Per-component facts from the evidence set itself (not the model's view).
  const inWin = (e: GuardEvidence) => e.inWindow !== false;
  const supportsFor = (cid: string) => input.evidence.filter((e) => e.componentId === cid && e.stance === "supports" && inWin(e));
  const contradictsFor = (cid: string) => input.evidence.filter((e) => e.componentId === cid && e.stance === "contradicts" && inWin(e));
  const onlyAnnounced = (items: GuardEvidence[]) => items.length > 0 && items.every((e) => e.actionStage === "proposed" || e.actionStage === "announced");

  // Component assessments: start from the model's, then apply G2/G4 per component.
  const components = input.components.map((c) => {
    const m = input.model.components.find((x) => x.componentId === c.id);
    let assessment: EvidenceAssessment = m?.assessment ?? "insufficient";
    const evidenceIds = filterIds(m?.evidenceIds ?? [], `component ${c.id}`);
    const sup = supportsFor(c.id);
    const con = contradictsFor(c.id);
    if (assessment === "supported" && sup.length === 0) {
      assessment = "insufficient";
      notes.push(`G2: component "${c.id}" was marked supported by the model but has no in-window supporting evidence item; set to insufficient.`);
    }
    if (assessment === "contradicted" && con.length === 0) {
      assessment = "insufficient";
      notes.push(`G3: component "${c.id}" was marked contradicted but has no in-window contradicting evidence item; set to insufficient.`);
    }
    if (assessment === "supported" && onlyAnnounced(sup)) {
      assessment = "partially_supported";
      notes.push(`G4: component "${c.id}" is supported only by proposed/announced actions, not implemented outcomes; capped at partially supported.`);
    }
    return { componentId: c.id, assessment, evidenceIds };
  });

  // Overall verdict: G2/G3 against future_claim components.
  let overall = input.model.overall;
  const futureClaims = input.components.filter((c) => c.kind === "future_claim");
  const fcAssess = (cid: string) => components.find((x) => x.componentId === cid)?.assessment ?? "insufficient";
  if (futureClaims.length > 0) {
    const allSupported = futureClaims.every((c) => fcAssess(c.id) === "supported");
    const anySupported = futureClaims.some((c) => fcAssess(c.id) === "supported" || fcAssess(c.id) === "partially_supported");
    const anyContradicted = futureClaims.some((c) => contradictsFor(c.id).length > 0);
    if (overall === "supported" && !allSupported) {
      overall = anySupported ? "partially_supported" : "insufficient";
      notes.push(`G2: overall 'supported' requires every future-claim component to be supported by in-window evidence; downgraded to ${overall}.`);
    }
    if (overall === "contradicted" && !anyContradicted) {
      overall = "insufficient";
      notes.push("G3: overall 'contradicted' requires in-window contradicting evidence on a future-claim component; downgraded to insufficient.");
    }
  }
  overall = weaker(overall, overall); // no-op, keeps type

  // G5 — independence of corroboration.
  let confidence = input.model.confidence;
  const supItems = supportingIds.map((i) => byId.get(i)!).filter(Boolean);
  if (supItems.length > 0 && supItems.every((e) => !e.independent) && confidence === "high") {
    confidence = "medium";
    notes.push("G5: all supporting items are syndicated copies of the same underlying source; confidence capped at medium.");
  }
  const distinctSources = new Set(supItems.filter((e) => e.independent).map((e) => e.sourceId));
  if ((overall === "supported" || overall === "contradicted") && distinctSources.size < 2 && confidence === "high") {
    confidence = "medium";
    notes.push("G5: a definitive verdict rests on a single source; confidence capped at medium.");
  }

  // Undated evidence note.
  if (input.evidence.some((e) => e.inWindow === undefined && (supportingIds.includes(e.id) || contradictingIds.includes(e.id)))) {
    notes.push("Some cited evidence is undated; it was treated as in-window. Verify dates before relying on this verdict.");
  }

  return { overall, confidence, supportingIds, contradictingIds, citations, components, notes };
}

/** Suggested recheck date: only meaningful while the deadline is pending or the verdict is undecided. */
export function suggestRecheck(today: string, timeStatus: TimeStatusValue, overall: EvidenceAssessment, deadline: string | undefined, recheckAfterDays: number): string | undefined {
  if (timeStatus === "reached" && (overall === "supported" || overall === "contradicted")) return undefined;
  const t = new Date(today + "T00:00:00Z").getTime() + recheckAfterDays * 86_400_000;
  const candidate = new Date(t).toISOString().slice(0, 10);
  if (deadline && timeStatus === "pending" && deadline < candidate) return deadline; // recheck at the deadline if sooner
  return candidate;
}
