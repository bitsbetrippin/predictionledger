/**
 * Prediction Ledger — sports-pick tests (Release 1.2): pick normalisation, deterministic settlement plan,
 * and the pipeline: extraction marks picks, plan.generate makes NO model call, research is capped to a
 * few score look-ups, and assessment uses the settlement template.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import type { ModelInfo, ProviderTestResult, SearchResult } from "@prediction-ledger/shared";
import type { CompletionRequest, CompletionResult, LanguageModelProvider, ProviderCredentials } from "../providers/llm/types.js";
import { setLlmProviderForTests } from "../providers/llm/registry.js";
import { setSearchProviderFactoryForTests } from "../research/search.js";
import type { FetchOutcome, SourceFetcher } from "../research/fetcher.js";
import { extractHtml } from "../research/htmlExtract.js";
import { buildSportsPlan, describePick, normalizeSportsPick, pickLabel, SPORTS_RESEARCH_BUDGET } from "./sports.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "..", "..", "..", "fixtures");
const srt = fs.readFileSync(path.join(fixtures, "transcripts", "nfl-picks.srt"), "utf8");
const expected = JSON.parse(fs.readFileSync(path.join(fixtures, "transcripts", "nfl-picks.expected.json"), "utf8")) as {
  publishedAt: string;
  mustExtract: { id: string; quoteContains: string; kind: string; pickType?: string; team?: string; line?: number; side?: string; deadlineDate?: string }[];
  mustNotExtract: { quoteContains: string }[];
};
const extractionReply = fs.readFileSync(path.join(fixtures, "model-outputs", "extraction.nfl-picks.json"), "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("normalizeSportsPick: team matching, missing lines, bad dates", () => {
  const ok = normalizeSportsPick({ sport: "NFL", teams: ["Kansas City Chiefs", "Buffalo Bills"], event_date: "2026-01-11", pick_type: "spread", team: "Chiefs", line: -3.5 });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.pick?.pick.team, "Kansas City Chiefs", "short name resolves to the full team");
  assert.equal(ok.pick?.eventDate, "2026-01-11");
  assert.equal(describePick(ok.pick!), "Kansas City Chiefs cover -3.5 vs Buffalo Bills (NFL on 2026-01-11)");
  assert.equal(pickLabel(ok.pick!), "NFL · Kansas City Chiefs -3.5");

  const noLine = normalizeSportsPick({ sport: "NBA", teams: ["Lakers", "Celtics"], event_date: "January 11", pick_type: "spread", team: "Lakers" });
  assert.ok(noLine.problems.some((p) => /without a stated line/.test(p)));
  assert.ok(noLine.problems.some((p) => /not a full date/.test(p)));
  assert.equal(noLine.pick?.eventDate, undefined, "partial dates are never turned into deadlines");

  const wrongTeam = normalizeSportsPick({ sport: "NHL", teams: ["Bruins", "Rangers"], pick_type: "moneyline", team: "Blackhawks" });
  assert.ok(wrongTeam.problems.some((p) => /not one of the two teams/.test(p)));

  const total = normalizeSportsPick({ sport: "NFL", teams: ["Detroit Lions", "Green Bay Packers"], pick_type: "total", line: 48.5, side: "over" });
  assert.deepEqual(total.problems, []);
  assert.equal(describePick(total.pick!), "Detroit Lions vs Green Bay Packers total over 48.5 (NFL)");
  assert.equal(pickLabel(total.pick!), "NFL · O 48.5");
});

test("buildSportsPlan: settlement rules and score look-up queries, no model involved", () => {
  const { pick } = normalizeSportsPick({ sport: "NFL", teams: ["Philadelphia Eagles", "Dallas Cowboys"], event_date: "2026-01-11", pick_type: "moneyline", team: "Eagles" });
  const plan = buildSportsPlan(pick!, { predictionMade: "2026-01-08", deadline: "2026-01-11", researchCutoff: "2026-02-01" }, describePick(pick!));
  assert.match(plan.supportingEvidence[0], /Philadelphia Eagles scored more than Dallas Cowboys/);
  assert.match(plan.partialFulfillmentCriteria[0], /draw|tie/i);
  assert.ok(plan.queries.neutral.some((q) => /final score 2026-01-11/.test(q)));
  assert.ok(plan.queries.disconfirming.some((q) => /postponed OR cancelled/.test(q)));
  assert.match(plan.researchPrompt, /Do not use previews, odds, or predictions as evidence/);
  assert.equal(plan.dates.deadline, "2026-01-11");
  const spread = buildSportsPlan(normalizeSportsPick({ sport: "NFL", teams: ["A", "B"], pick_type: "spread", team: "A", line: -3.5 }).pick!, { researchCutoff: "2026-02-01" }, "x");
  assert.match(spread.supportingEvidence[0], /plus \(-3\.5\)/);
  assert.match(spread.partialFulfillmentCriteria[0], /push/);
  assert.ok(spread.ambiguities.some((a) => /Game date not stated/.test(a)));
});

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

class FakeModel implements LanguageModelProvider {
  readonly id = "lmstudio" as const;
  readonly displayName = "fake";
  readonly isLocal = true;
  requests: CompletionRequest[] = [];
  async testConnection(): Promise<ProviderTestResult> { return { ok: true, provider: this.id, message: "fake" }; }
  async listModels(): Promise<ModelInfo[]> { return []; }
  async complete(_c: ProviderCredentials, req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    const name = req.jsonSchema?.name;
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";
    let text = "{}";
    if (name === "extraction_output") text = extractionReply;
    else if (name === "evidence_output") {
      text = JSON.stringify({ items: [{ component_id: null, stance: "supports", excerpt: "Final score: Kansas City Chiefs 27, Buffalo Bills 20.", fact: "Chiefs won by 7", event_date: "2026-01-11", action_stage: "completed" }], page_relevance: "high" });
    } else if (name === "assessment_output") {
      const evidenceId = /\[([0-9a-f-]{36})\] stance=/.exec(user)?.[1] ?? "";
      const componentId = /^- (\S+) \[future_claim\]/m.exec(user)?.[1] ?? "";
      text = JSON.stringify({
        component_assessments: [{ component_id: componentId, assessment: "supported", explanation: "Chiefs won 27-20, covering -3.5 by a 7-point margin.", evidence_ids: [evidenceId] }],
        overall: { evidence_assessment: "supported", explanation: "Kansas City beat Buffalo 27-20 on 2026-01-11; the 7-point margin covers -3.5.", citations: [{ claim: "final score 27-20", evidence_ids: [evidenceId] }], supporting_ids: [evidenceId], contradicting_ids: [], later_developments: null, uncertainty: null, confidence: "high", confidence_rationale: "Official box score." },
      });
    }
    return { text, model: req.model };
  }
}

const boxScoreHtml = `<html><head><title>Chiefs 27, Bills 20 — Box score</title><meta property="article:published_time" content="2026-01-11T23:30:00Z"></head><body><article><h1>Chiefs 27, Bills 20</h1><p>Final score: Kansas City Chiefs 27, Buffalo Bills 20. Kansas City, Jan 11, 2026.</p></article></body></html>`;
class FakeFetcher implements SourceFetcher {
  fetched: string[] = [];
  async fetch(url: string): Promise<FetchOutcome> {
    this.fetched.push(url);
    const page = extractHtml(boxScoreHtml);
    return { status: "ok", finalUrl: url, httpStatus: 200, contentType: "text/html", page, rawText: page.text };
  }
}

let fake: FakeModel;
const searches: string[] = [];
before(() => {
  process.env.PL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pl-sports-"));
  fake = new FakeModel();
  setLlmProviderForTests("lmstudio", fake);
  setSearchProviderFactoryForTests(() => ({
    id: "searxng",
    isLocal: true,
    async search(query: string): Promise<SearchResult[]> {
      searches.push(query);
      return [{ url: `https://scores.example/${searches.length}`, title: "Chiefs 27, Bills 20 — Box score", snippet: "Final score 27-20" }];
    },
  }));
});
after(() => { delete process.env.PL_DATA_DIR; });

test("sports pipeline: picks extracted with game-date deadlines; plan is deterministic; research capped; settlement template used", async () => {
  const { createContext } = await import("../context.js");
  const fetcher = new FakeFetcher();
  const ctx = createContext({ fetcher });
  const s = ctx.settings.getPersisted();
  s.providers.lmstudio.enabled = true;
  s.providers.lmstudio.model = "fake";
  s.stages = { extraction: { provider: "lmstudio" }, validationPlan: { provider: "lmstudio" }, assessment: { provider: "lmstudio" } };
  s.search.provider = "searxng";
  s.search.baseUrl = "http://127.0.0.1:8080";
  s.privacy.allowInternet = true;
  s.limits.maxSearchesPerRun = 8;
  s.limits.maxSourcesPerRun = 12;
  ctx.settings.savePersisted(s);
  ctx.jobs.start();
  const waitFor = async (id: string) => {
    const t0 = Date.now();
    for (;;) {
      const j = ctx.jobs.get(id)!;
      if (["completed", "failed", "cancelled"].includes(j.status)) return j;
      if (Date.now() - t0 > 15_000) throw new Error(`job ${id} timed out (${j.status})`);
      await sleep(100);
    }
  };
  try {
    const { video } = ctx.videos.importTranscript({ title: "Week 18 picks", content: srt, format: "srt", publishedAt: expected.publishedAt });
    const ej = await waitFor(ctx.jobs.enqueue({ kind: "prediction.extract", subjectType: "video", subjectId: video.id, payload: { videoId: video.id } }));
    assert.equal(ej.status, "completed", ej.error);
    const preds = ctx.predictions.list({ videoId: video.id });
    assert.equal(preds.length, 4);
    for (const exp of expected.mustExtract) {
      const p = preds.find((x) => x.quoteExact.includes(exp.quoteContains))!;
      assert.ok(p, exp.id);
      assert.equal(p.kind, exp.kind, `${exp.id} kind`);
      if (exp.kind === "sports_pick") {
        assert.ok(p.sportsPick, `${exp.id} carries the pick`);
        assert.equal(p.sportsPick!.pick.type, exp.pickType);
        if (exp.team) assert.equal(p.sportsPick!.pick.team, exp.team);
        if (exp.line !== undefined) assert.equal(p.sportsPick!.pick.line, exp.line);
        if (exp.side) assert.equal(p.sportsPick!.pick.side, exp.side);
        assert.equal(p.deadlineDate, exp.deadlineDate, `${exp.id} deadline = game date`);
        assert.equal(p.deadlineBasis, "rule:event");
        assert.equal(p.components.length, 1, "one settleable component");
        assert.equal(p.components[0].deadlineDate, exp.deadlineDate);
      } else {
        assert.equal(p.sportsPick, undefined);
      }
    }
    assert.equal(ctx.predictions.list({ videoId: video.id, kind: "sports_pick" }).length, 3, "kind filter");
    assert.equal(ctx.predictions.list({ videoId: video.id, kind: "general" }).length, 1);

    // plan: no model call for a sports pick
    const spread = preds.find((p) => p.sportsPick?.pick.type === "spread")!;
    const modelCallsBefore = fake.requests.length;
    const pj = await waitFor(ctx.jobs.enqueue({ kind: "plan.generate", subjectType: "prediction", subjectId: spread.id, payload: { predictionId: spread.id } }));
    assert.equal(pj.status, "completed", pj.error);
    assert.equal(fake.requests.length, modelCallsBefore, "settlement plan is built by code, not the model");
    const plan = ctx.plans.latest(spread.id)!;
    assert.equal(plan.templateVersion, "plan.sports.v1");
    assert.equal(plan.provider, "app");
    assert.equal(plan.plan.dates.deadline, "2026-01-11");
    assert.match(plan.plan.supportingEvidence[0], /Kansas City Chiefs minus Buffalo Bills/);
    assert.ok(plan.plan.queries.neutral[0].includes("final score 2026-01-11"));

    // research: capped to a few look-ups even though Setup allows 8 searches / 12 sources
    searches.length = 0;
    const rj = await waitFor(ctx.jobs.enqueue({ kind: "research.run", subjectType: "prediction", subjectId: spread.id, payload: { predictionId: spread.id, planId: plan.id } }));
    assert.equal(rj.status, "completed", rj.error);
    assert.ok(searches.length <= SPORTS_RESEARCH_BUDGET.searches, `searches ${searches.length}`);
    assert.ok(fetcher.fetched.length <= SPORTS_RESEARCH_BUDGET.sources, `sources ${fetcher.fetched.length}`);

    // assessment (chained by research.run): the sports settlement template was used and the verdict stored
    const t0 = Date.now();
    let assessments = ctx.research.assessmentsForPrediction(spread.id);
    while (assessments.length === 0 && Date.now() - t0 < 15_000) { await sleep(150); assessments = ctx.research.assessmentsForPrediction(spread.id); }
    assert.equal(assessments.length, 1, "assessment created");
    const a = assessments[0];
    const ev = ctx.research.evidenceForRun(a.runId);
    assert.equal(a.evidenceAssessment, "supported", `guard notes: ${JSON.stringify(a.guardNotes)}; evidence: ${JSON.stringify(ev.map((e) => ({ stance: e.stance, inWindow: e.inWindow, independent: e.independent, stage: e.actionStage })))}; run coverage: ${JSON.stringify(ctx.research.getRun(a.runId)?.coverageNotes)}`);
    assert.equal(a.timeStatus, "reached");
    assert.match(a.explanation, /27-20/);
    const assessReq = fake.requests.filter((r) => r.jsonSchema?.name === "assessment_output").at(-1)!;
    assert.match(assessReq.messages[0].content, /SPORTS PICK/, "settlement template selected for sports picks");
    assert.match(assessReq.messages[1].content, /Settlement rule:/);
    assert.equal(a.templateVersion, "sports_assessment.v1");
  } finally {
    await ctx.jobs.stop();
    ctx.db.close();
  }
});
