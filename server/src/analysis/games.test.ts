/**
 * Prediction Ledger — tests for the sports look-ups (1.3.1 / 1.4): the deterministic date and score
 * parsers, settlement rules, and the sports.resolve_game job (one game record, every pick reconciled).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { ModelInfo, ProviderTestResult, SearchResult, SportsPick } from "@prediction-ledger/shared";
import type { CompletionRequest, CompletionResult, LanguageModelProvider, ProviderCredentials } from "../providers/llm/types.js";
import { setLlmProviderForTests } from "../providers/llm/registry.js";
import { setSearchProviderFactoryForTests } from "../research/search.js";
import type { FetchOutcome, SourceFetcher } from "../research/fetcher.js";
import { buildScheduleQueries, buildScoreQueries, findFinalScore, findGameDate, matchupKey, settlePick, teamMentioned } from "./sports.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick: SportsPick = { sport: "NFL", teams: ["Dallas Cowboys", "Philadelphia Eagles"], eventHint: "Week 1 opener", pick: { type: "moneyline", team: "Philadelphia Eagles" } };

test("findGameDate: date next to both teams wins; year-less dates take the nearest year; time attached", () => {
  const text = `NFL 2026 schedule — Week 1
Thursday, Sept. 10 — Dallas Cowboys at Philadelphia Eagles, 8:20 p.m. ET (NBC)
Sunday, Sept. 13 — Kansas City Chiefs at Los Angeles Chargers, 4:25 PM ET
Sunday, Sept. 13 — New York Giants at Washington Commanders, 1:00 PM ET
Week 10: Sunday, November 15 — Philadelphia Eagles at Dallas Cowboys, 4:25 PM ET`;
  const hit = findGameDate(text, pick, { anchor: "2026-09-09", radius: 90 });
  assert.ok(hit, "a date was found");
  assert.equal(hit.eventDate, "2026-09-10");
  assert.equal(hit.eventTime, "8:20 PM ET");
  assert.equal(hit.ambiguous, false, "the November rematch is outside the window");
});

test("findGameDate: nothing when the teams are not near a date, when the date is out of window, or ties are flagged", () => {
  assert.equal(findGameDate("Cowboys and Eagles. Some other game on September 10, 2026: Jets at Bills.", pick, { anchor: "2026-09-09", radius: 20 }), undefined);
  assert.equal(findGameDate("Dallas Cowboys at Philadelphia Eagles, December 25, 2026", pick, { anchor: "2026-09-09" }), undefined, "outside the 45-day window");
  const tie = findGameDate("Cowboys vs Eagles Sept 10, 2026. Cowboys vs Eagles Sept 11, 2026.", pick, { anchor: "2026-09-09", radius: 40 });
  assert.equal(tie?.ambiguous, true);
  // numeric and ISO forms
  assert.equal(findGameDate("9/10/2026 Cowboys @ Eagles", pick, { anchor: "2026-09-09" })?.eventDate, "2026-09-10");
  assert.equal(findGameDate("2026-09-10 DAL Cowboys vs PHI Eagles", pick, { anchor: "2026-09-09" })?.eventDate, "2026-09-10");
});

test("teamMentioned and buildScheduleQueries", () => {
  assert.equal(teamMentioned("the eagles host the cowboys", "Philadelphia Eagles"), true);
  assert.equal(teamMentioned("LA Chargers vs Chiefs", "Los Angeles Rams"), false);
  const q = buildScheduleQueries(pick, "2026-09-09");
  assert.equal(q.length, 2);
  assert.match(q[0], /Dallas Cowboys vs Philadelphia Eagles NFL Week 1 opener 2026/);
  assert.match(q[1], /2026 schedule/);
});

test("findFinalScore: 'Team 27, Team 20' lines, win-verb lines, noise skipped, records ignored, ties flagged, postponed reported", () => {
  const kc: SportsPick = { sport: "NFL", teams: ["Buffalo Bills", "Kansas City Chiefs"], pick: { type: "moneyline", team: "Bills" } };
  const text = `Chiefs vs Bills prediction: Chiefs -3.5, our pick is Kansas City 27-20
Final: Kansas City Chiefs 27, Buffalo Bills 20 — Arrowhead Stadium, Sept 13, 2026
Chiefs (2-0) beat Bills (1-1) 27-20 in a game that went to overtime
Box score: Bills 20 Chiefs 27`;
  const r = findFinalScore(text, kc);
  assert.ok(r.hit);
  assert.deepEqual(r.hit.scores, [20, 27], "scores in the pick's team order (Bills, Chiefs)");
  assert.equal(r.hit.ambiguous, false);
  assert.equal(r.hit.overtime, true);
  assert.match(r.hit.excerpt, /^Final: Kansas City Chiefs 27/);
  assert.equal(r.postponed, undefined);
  assert.equal(findFinalScore("Chiefs vs Bills odds and prediction 24-21", kc).hit, undefined, "betting chatter never yields a score");
  const tie = findFinalScore("Bills 20, Chiefs 27\nBills 24, Chiefs 21", kc);
  assert.equal(tie.hit?.ambiguous, true);
  const post = findFinalScore("Bills at Chiefs postponed due to weather", kc);
  assert.equal(post.hit, undefined);
  assert.match(post.postponed ?? "", /postponed/);
  assert.equal(findFinalScore("Bills 20-27 Chiefs", kc).hit?.scores.join("-"), "20-27", "mention order when no verb");
  assert.equal(findFinalScore("Chiefs beat Bills 27-20", kc).hit?.scores.join("-"), "20-27", "win verb assigns the higher score to the winner");
});

test("settlePick: moneyline / spread / total, push and tie, pending without a final", () => {
  const game = { teams: ["Buffalo Bills", "Kansas City Chiefs"] as [string, string], scores: [20, 27] as [number, number], status: "final", eventDate: "2026-09-13" };
  const ml = (team: string) => settlePick({ sport: "NFL", teams: ["Bills", "Chiefs"], pick: { type: "moneyline", team } }, game);
  assert.equal(ml("Chiefs").outcome, "hit");
  assert.equal(ml("Bills").outcome, "miss");
  assert.match(ml("Bills").explanation, /Kansas City Chiefs beat Buffalo Bills 27–20 on 2026-09-13/);
  const sp = (team: string, line: number) => settlePick({ sport: "NFL", teams: ["Bills", "Chiefs"], pick: { type: "spread", team, line } }, game).outcome;
  assert.equal(sp("Chiefs", -3.5), "hit");
  assert.equal(sp("Chiefs", -7), "push");
  assert.equal(sp("Bills", 6.5), "miss");
  assert.equal(sp("Bills", 7.5), "hit");
  const tot = (side: "over" | "under", line: number) => settlePick({ sport: "NFL", teams: ["Bills", "Chiefs"], pick: { type: "total", side, line } }, game).outcome;
  assert.equal(tot("over", 45.5), "hit");
  assert.equal(tot("under", 45.5), "miss");
  assert.equal(tot("over", 47), "push");
  assert.equal(settlePick({ sport: "NFL", teams: ["Bills", "Chiefs"], pick: { type: "moneyline", team: "Bills" } }, { ...game, scores: [24, 24] }).outcome, "push");
  assert.equal(settlePick({ sport: "NFL", teams: ["Bills", "Chiefs"], pick: { type: "moneyline", team: "Bills" } }, { teams: game.teams, status: "scheduled" }).outcome, "pending");
  assert.equal(settlePick({ sport: "NFL", teams: ["Bills", "Chiefs"], pick: { type: "moneyline", team: "Bills" } }, { teams: game.teams, status: "postponed" }).outcome, "pending");
  assert.equal(matchupKey({ sport: "NFL", teams: ["Kansas City Chiefs", "Buffalo Bills"] }), matchupKey({ sport: "nfl", teams: ["Bills", "Chiefs"] }));
  assert.match(buildScoreQueries({ sport: "NFL", teams: ["Bills", "Chiefs"], eventHint: "Week 2", pick: { type: "moneyline", team: "Bills" } }, "2026-09-09")[0], /Bills vs Chiefs final score Week 2 2026/);
});

// ---------------------------------------------------------------------------
// Job: sports.resolve_game — one look-up per matchup, every pick reconciled
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
    if (req.jsonSchema?.name === "score_lookup") return { text: JSON.stringify({ status: "final", score_a: 24, score_b: 20, event_date: "2026-09-10", event_time: null, overtime: false, excerpt: "The Eagles held on to win it twenty-four to twenty over Dallas.", source_url: null, confidence: "high", reason: "recap paragraph" }), model: req.model };
    return { text: "{}", model: req.model };
  }
}

const scorePage = `<html><head><title>Eagles 24, Cowboys 20 — Box Score</title></head><body><article><h1>Eagles 24, Cowboys 20</h1>
<p>Final: Philadelphia Eagles 24, Dallas Cowboys 20. Thursday, September 10, 2026, Lincoln Financial Field.</p>
<p>Dallas Cowboys at Philadelphia Eagles, 8:20 PM ET kickoff.</p></article></body></html>`;
let snippetsCarryScore = true;
let pageText = scorePage;
class FakeFetcher implements SourceFetcher {
  fetched: string[] = [];
  async fetch(url: string): Promise<FetchOutcome> {
    this.fetched.push(url);
    const { extractHtml } = await import("../research/htmlExtract.js");
    const page = extractHtml(pageText);
    return { status: "ok", finalUrl: url, httpStatus: 200, contentType: "text/html", page, rawText: page.text };
  }
}

let fake: FakeModel;
const searches: string[] = [];
before(() => {
  fake = new FakeModel();
  setLlmProviderForTests("lmstudio", fake);
  setSearchProviderFactoryForTests(() => ({
    id: "searxng",
    isLocal: true,
    async search(query: string): Promise<SearchResult[]> {
      searches.push(query);
      return [
        { url: "https://fan-blog.example/week1-recap", title: "Week 1 recap", snippet: "Cowboys and Eagles opened the season." },
        { url: "https://www.espn.com/nfl/game/_/gameId/401", title: snippetsCarryScore ? "Eagles 24-20 Cowboys (Sep 10, 2026) Final Score - ESPN" : "Cowboys at Eagles - Game Summary - ESPN", snippet: snippetsCarryScore ? "Final: Philadelphia Eagles 24, Dallas Cowboys 20" : "Game summary and stats." },
      ];
    },
  }));
});
after(() => { delete process.env.PL_DATA_DIR; });

const mkPick = (team: string, type: "moneyline" | "spread" = "moneyline", line?: number): SportsPick => ({ sport: "NFL", teams: ["Dallas Cowboys", "Philadelphia Eagles"], eventHint: "Week 1 opener", pick: { type, team, line } });

async function makeCtx(fetcher: SourceFetcher) {
  process.env.PL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pl-game-")); // fresh DB: no search cache carried over
  const { createContext } = await import("../context.js");
  const ctx = createContext({ fetcher });
  const s = ctx.settings.getPersisted();
  s.providers.lmstudio.enabled = true;
  s.providers.lmstudio.model = "fake";
  s.stages = { extraction: { provider: "lmstudio" }, validationPlan: { provider: "lmstudio" }, assessment: { provider: "lmstudio" } };
  s.search.provider = "searxng";
  s.search.baseUrl = "http://127.0.0.1:8080";
  s.privacy.allowInternet = true;
  s.sports.enabled = true;
  ctx.settings.savePersisted(s);
  const { video } = ctx.videos.importTranscript({ title: "2026 NFL Picks", content: "1\n00:00:00,000 --> 00:00:05,000\nEagles win the Week 1 opener over the Cowboys.\n", format: "srt", publishedAt: "2026-09-09" });
  const create = (quote: string, sp: SportsPick) => ctx.predictions.create({
    videoId: video.id, kind: "sports_pick", sportsPick: sp, quoteExact: quote, normalizedStatement: quote, entities: [], conditions: [], thresholds: [], madeOnDate: "2026-09-09", madeOnBasis: "publication",
    ambiguities: ["Game date not stated; the pick settles when the matchup is identified."], occurrences: [], components: [{ kind: "future_claim", statement: quote, notes: "Sports pick — settled from the final score." }],
  });
  const waitFor = async (id: string) => {
    const t0 = Date.now();
    for (;;) {
      const j = ctx.jobs.get(id)!;
      if (["completed", "failed", "cancelled"].includes(j.status)) return j;
      if (Date.now() - t0 > 15_000) throw new Error(`job ${id} timed out (${j.status})`);
      await sleep(100);
    }
  };
  return { ctx, video, create, waitFor };
}

test("sports.resolve_game: one look-up settles four picks on the same matchup; date and score written back; verdicts by rule; second run reuses the record", async () => {
  snippetsCarryScore = true;
  const fetcher = new FakeFetcher();
  const { ctx, create, waitFor } = await makeCtx(fetcher);
  const p1 = create("Eagles win the Week 1 opener over the Cowboys.", mkPick("Philadelphia Eagles"));
  const p2 = create("Give me Dallas outright in the opener, Cowboys win.", mkPick("Dallas Cowboys"));
  const p3 = create("Eagles minus three and a half, they cover in the opener.", mkPick("Philadelphia Eagles", "spread", -3.5));
  const p4 = create("Cowboys plus seven and a half is the play in Philly.", mkPick("Dallas Cowboys", "spread", 7.5));
  ctx.jobs.start();
  try {
    const searchesBefore = searches.length;
    const j = await waitFor(ctx.jobs.enqueue({ kind: "sports.resolve_game", subjectType: "prediction", subjectId: p1.id, payload: { predictionId: p1.id } }));
    assert.equal(j.status, "completed", j.error);
    assert.equal(searches.length - searchesBefore, 2, "two budgeted searches for the matchup, not per pick");
    assert.equal(fetcher.fetched.length, 0, "score and date both came from the search result; no page fetched");
    const game = ctx.games.list()[0];
    assert.ok(game);
    assert.equal(game.status, "final");
    assert.deepEqual(game.scores, [20, 24]);
    assert.equal(game.eventDate, "2026-09-10");
    assert.equal(game.winner, "Philadelphia Eagles");
    assert.match(game.excerpt ?? "", /Final: Philadelphia Eagles 24, Dallas Cowboys 20/);
    assert.ok(game.sourceUrl?.includes("espn.com"));
    const verdict = (id: string) => ctx.research.assessmentsForPrediction(id)[0];
    assert.equal(verdict(p1.id).evidenceAssessment, "supported", "Eagles ML hit");
    assert.equal(verdict(p2.id).evidenceAssessment, "contradicted", "Cowboys ML miss");
    assert.equal(verdict(p3.id).evidenceAssessment, "supported", "Eagles -3.5 covers by 4");
    assert.equal(verdict(p4.id).evidenceAssessment, "supported", "Cowboys +7.5 covers");
    assert.equal(verdict(p1.id).provider, "app");
    assert.equal(verdict(p1.id).templateVersion, "sports_settlement.v1");
    assert.equal(verdict(p1.id).confidence, "high", "trusted host");
    assert.match(verdict(p2.id).explanation, /Philadelphia Eagles beat Dallas Cowboys 24–20 on 2026-09-10\. Pick: Dallas Cowboys to win → MISS/);
    for (const id of [p1.id, p2.id, p3.id, p4.id]) {
      const p = ctx.predictions.get(id)!;
      assert.equal(p.gameId, game.id);
      assert.equal(p.deadlineDate, "2026-09-10");
      assert.equal(p.deadlineBasis, "lookup");
      assert.equal(p.sportsPick?.eventDate, "2026-09-10");
      const ev = ctx.research.evidenceForRun(verdict(id).runId);
      assert.equal(ev.length, 1);
      assert.equal(ev[0].componentId, p.components[0].id);
    }
    assert.equal(fake.requests.filter((r) => r.jsonSchema?.name === "score_lookup").length, 0, "parser settled it; no model call");

    // A fifth pick on the same game later: no search, the stored record settles it.
    const p5 = create("Philly wins this one going away.", mkPick("Philadelphia Eagles"));
    const before2 = searches.length;
    const j2 = await waitFor(ctx.jobs.enqueue({ kind: "sports.resolve_game", subjectType: "prediction", subjectId: p5.id, payload: { predictionId: p5.id } }));
    assert.equal(j2.status, "completed", j2.error);
    assert.equal(searches.length, before2, "stored game reused — no new search");
    assert.equal(verdict(p5.id).evidenceAssessment, "supported");
    assert.equal(ctx.games.list().length, 1, "still one game record");
  } finally {
    await ctx.jobs.stop();
    ctx.db.close();
  }
});

test("sports.resolve_game: page path (trusted first), model fallback with verified excerpt, and honest pending/failure", async () => {
  snippetsCarryScore = false;
  const fetcher = new FakeFetcher();
  const { ctx, create, waitFor } = await makeCtx(fetcher);
  fake.requests = [];
  const lookups = () => fake.requests.filter((r) => r.jsonSchema?.name === "score_lookup");
  ctx.jobs.start();
  try {
    const p1 = create("Eagles win the Week 1 opener over the Cowboys.", mkPick("Philadelphia Eagles"));
    const j = await waitFor(ctx.jobs.enqueue({ kind: "sports.resolve_game", subjectType: "prediction", subjectId: p1.id, payload: { predictionId: p1.id } }));
    assert.equal(j.status, "completed", j.error);
    assert.ok(fetcher.fetched[0].includes("espn.com"), `trusted host first: ${fetcher.fetched.join(", ")}`);
    assert.equal(lookups().length, 0);
    const g1 = ctx.games.list()[0];
    assert.deepEqual(g1.scores, [20, 24]);
    assert.equal(g1.lookupVia, "score page");
    assert.equal(ctx.research.assessmentsForPrediction(p1.id)[0].evidenceAssessment, "supported");

    // Different matchup, page has the result only in prose → model fallback; excerpt verified verbatim.
    pageText = "<html><body><article><p>Week 1 opener recap: The Eagles held on to win it twenty-four to twenty over Dallas. Cowboys fans left early.</p></article></body></html>";
    const other: SportsPick = { sport: "NFL", teams: ["Dallas Cowboys", "Philadelphia Eagles"], eventHint: "Week 1", pick: { type: "moneyline", team: "Dallas Cowboys" } };
    // force a new matchup key by using a different sport label so the stored record is not reused
    const p2 = create("Dallas wins the opener.", { ...other, sport: "NFL (rematch)" });
    const j2 = await waitFor(ctx.jobs.enqueue({ kind: "sports.resolve_game", subjectType: "prediction", subjectId: p2.id, payload: { predictionId: p2.id } }));
    assert.equal(j2.status, "completed", j2.error);
    assert.equal(lookups().length, 1, "model consulted once");
    assert.match(lookups()[0].messages[0].content, /never infer, estimate, or use prior knowledge/);
    const g2 = ctx.games.list().find((g) => g.sport === "NFL (rematch)")!;
    assert.deepEqual(g2.scores, [24, 20], "model scores are in team-A/team-B order as asked");
    assert.match(g2.excerpt ?? "", /twenty-four to twenty/);
    assert.equal(ctx.research.assessmentsForPrediction(p2.id)[0].evidenceAssessment, "supported", "Cowboys = team A scored 24 per the model");
    assert.equal(ctx.research.assessmentsForPrediction(p2.id)[0].confidence, "high", "page read by the model was on a trusted host");

    // Nothing anywhere: no game record with a score, no verdict, job fails honestly.
    pageText = "<html><body><article><p>Tickets and parking information for Lincoln Financial Field.</p></article></body></html>";
    const p3 = create("Take the Bears over the Packers.", { sport: "NFL", teams: ["Chicago Bears", "Green Bay Packers"], pick: { type: "moneyline", team: "Chicago Bears" } });
    const j3 = await waitFor(ctx.jobs.enqueue({ kind: "sports.resolve_game", subjectType: "prediction", subjectId: p3.id, payload: { predictionId: p3.id } }));
    assert.equal(j3.status, "failed");
    assert.match(j3.error ?? "", /Could not find a final score for Chicago Bears vs Green Bay Packers/);
    assert.equal(ctx.research.assessmentsForPrediction(p3.id).length, 0);
    assert.equal(ctx.predictions.get(p3.id)!.gameId, undefined);
  } finally {
    pageText = scorePage;
    await ctx.jobs.stop();
    ctx.db.close();
  }
});
