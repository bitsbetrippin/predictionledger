/**
 * Prediction Ledger — evidence dossier (1.11, SRC-03/04/06).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * One view over everything stored about a prediction's evidence: every item by stance with its
 * source's provenance (URL, publisher, published / retrieved / first-seen, content hash, status),
 * independence groups, the versions involved, coverage limitations, and the dissent — contradicting
 * items are listed even when the verdict went the other way. With `asOf`, items are replayed against
 * what the app actually knew by that instant; a publication-date assumption is only used on request
 * and is labelled.
 */

import type { DossierItem, EvidenceDossier, EvidenceItem, SourceRecord } from "@prediction-ledger/shared";
import type { AppContext } from "../context.js";
import { contentSketch, independenceGroups, knownBy } from "../analysis/independence.js";

export function buildDossier(ctx: Pick<AppContext, "predictions" | "research" | "videos" | "plans" | "markets">, predictionId: string, opts: { asOf?: string; assumePublished?: boolean } = {}): EvidenceDossier | undefined {
  const p = ctx.predictions.get(predictionId);
  if (!p) return undefined;
  const video = ctx.videos.get(p.videoId);
  const runs = ctx.research.runsForPrediction(predictionId).filter((r) => r.status === "completed");
  const items: { e: EvidenceItem; runPurpose: "verdict" | "forecast" }[] = [];
  for (const r of runs) for (const e of ctx.research.evidenceForRun(r.id)) items.push({ e, runPurpose: r.purpose });
  const sourceIds = [...new Set(items.map((x) => x.e.sourceId))];
  const sources = new Map<string, SourceRecord>();
  for (const id of sourceIds) { const s = ctx.research.getSource(id); if (s) sources.set(id, s); }

  // Independence groups: stored ones first; anything ungrouped (older data) is clustered now from the stored text.
  const groups = new Map<string, string>();
  const ungrouped = [...sources.values()].filter((s) => !s.independenceGroup);
  for (const s of sources.values()) if (s.independenceGroup) groups.set(s.id, s.independenceGroup);
  if (ungrouped.length) {
    const computed = independenceGroups(ungrouped.map((s) => ({ id: s.id, url: s.url, publisher: s.publisher, contentHash: s.contentHash, sketch: contentSketch(ctx.research.sourceText(s) ?? ""), orderKey: s.publishedAt ?? s.retrievedAt })));
    for (const [id, g] of computed.groups) groups.set(id, g);
  }

  let excluded = 0;
  const toItem = (x: { e: EvidenceItem; runPurpose: "verdict" | "forecast" }): DossierItem | undefined => {
    const s = sources.get(x.e.sourceId);
    if (!s) return undefined;
    let knownAtAsOf: boolean | undefined;
    let availabilityBasis: DossierItem["availabilityBasis"];
    if (opts.asOf) {
      const k = knownBy({ firstSeenAt: s.firstSeenAt, retrievedAt: s.retrievedAt, publishedAt: s.publishedAt }, opts.asOf, { assumePublished: opts.assumePublished });
      knownAtAsOf = k.known;
      availabilityBasis = k.basis;
      if (!k.known) { excluded++; return undefined; }
    }
    return {
      evidenceId: x.e.id, runId: x.e.runId, runPurpose: x.runPurpose, stance: x.e.stance, componentId: x.e.componentId, excerpt: x.e.excerpt, fact: x.e.fact, eventDate: x.e.eventDate, inWindow: x.e.inWindow,
      source: { id: s.id, url: s.url, title: s.title, publisher: s.publisher, publishedAt: s.publishedAt, retrievedAt: s.retrievedAt, firstSeenAt: s.firstSeenAt, contentHash: s.contentHash, status: s.status, statusChangedAt: s.statusChangedAt, independenceGroup: groups.get(s.id), syndicatedOf: s.syndicatedOf },
      knownAtAsOf, availabilityBasis,
    };
  };
  const all = items.map(toItem).filter((x): x is DossierItem => !!x);
  const byStance = (st: DossierItem["stance"]) => all.filter((x) => x.stance === st);
  const latestAssessment = ctx.research.assessmentsForPrediction(predictionId)[0];
  const groupList = new Map<string, { sourceIds: Set<string>; publishers: Set<string> }>();
  for (const s of sources.values()) {
    const g = groups.get(s.id) ?? `grp-${s.id.slice(0, 8)}`;
    const entry = groupList.get(g) ?? { sourceIds: new Set(), publishers: new Set() };
    entry.sourceIds.add(s.id);
    if (s.publisher) entry.publishers.add(s.publisher);
    groupList.set(g, entry);
  }
  const contradicting = byStance("contradicts");
  const timestampUrl = video?.youtubeId ? `https://www.youtube.com/watch?v=${video.youtubeId}${p.startS !== undefined ? `&t=${Math.max(0, Math.floor(p.startS))}s` : ""}` : undefined;
  return {
    predictionId,
    quote: { text: p.quoteExact, hash: p.quoteHash, startS: p.startS, endS: p.endS, videoId: p.videoId, videoUrl: video?.sourceKind === "youtube" ? video.sourceRef : undefined, timestampUrl },
    versions: { prediction: ctx.predictions.revisionCount(predictionId), analysis: p.analysisVersion, plan: p.latestPlanVersion, latestRun: runs[0]?.id, latestAssessment: latestAssessment?.version },
    supporting: byStance("supports"),
    contradicting,
    context: byStance("context"),
    dissent: contradicting.map((x) => ({ evidenceId: x.evidenceId, sourceUrl: x.source.url, excerpt: x.excerpt })),
    independenceGroups: [...groupList.entries()].map(([group, v]) => ({ group, sourceIds: [...v.sourceIds], publishers: [...v.publishers] })),
    coverageLimitations: [...new Set(runs.flatMap((r) => r.coverageNotes))],
    rationale: latestAssessment ? { assessment: latestAssessment.evidenceAssessment, explanation: latestAssessment.explanation, guardNotes: latestAssessment.guardNotes, version: latestAssessment.version } : undefined,
    asOf: opts.asOf,
    excludedAsOf: excluded,
  };
}
