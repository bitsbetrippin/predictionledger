/**
 * Prediction Ledger — tests for the 1.3.1 schedule look-up: the deterministic date parser and the
 * sports.resolve_date job (snippets → pages → write-back → settlement chain).
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
import { buildScheduleQueries, findGameDate, teamMentioned } from "./sports.js";

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

// ---------------------------------------------------------------------------
// Job: sports.resolve_date
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
    if (req.jsonSchema?.name === "schedule_lookup") return { text: JSON.stringify({ event_date: "2026-09-10", event_time: "8:20 PM ET", source_url: null, confidence: "high", reason: "row for Cowboys at Eagles" }), model: req.model };
    return { text: "{}", model: req.model };
  }
}

const schedulePage = `<html><head><title>2026 NFL Schedule — Week 1</title></head><body><article><h1>Week 1</h1>
<p>Thursday, September 10, 2026 — Dallas Cowboys at Philadelphia Eagles, 8:20 PM ET</p>
<p>Sunday, September 13, 2026 — Chiefs at Chargers, 4:25 PM ET</p></article></body></html>`;
let snippetsCarryDate = true;
let pageText = schedulePage;
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
  process.env.PL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pl-schedule-"));
  fake = new FakeModel();
  setLlmProviderForTests("lmstudio", fake);
  setSearchProviderFactoryForTests(() => ({
    id: "searxng",
    isLocal: true,
    async search(query: string): Promise<SearchResult[]> {
      searches.push(query);
      return [
        { url: "https://fan-blog.example/week1-preview", title: "Week 1 preview", snippet: "Cowboys and Eagles open the season." },
        { url: "https://www.espn.com/nfl/schedule/_/week/1/year/2026", title: "NFL Schedule - Week 1 2026", snippet: snippetsCarryDate ? "Thu, Sep 10 — Dallas Cowboys at Philadelphia Eagles 8:20 PM ET" : "Week 1 games and times." },
      ];
    },
  }));
});
after(() => { delete process.env.PL_DATA_DIR; });

async function makeCtx(fetcher: SourceFetcher) {
  process.env.PL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pl-schedule-")); // fresh DB: no search cache carried over
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
  const p = ctx.predictions.create({
    videoId: video.id, kind: "sports_pick", sportsPick: pick, quoteExact: "Eagles win the Week 1 opener over the Cowboys.", normalizedStatement: "Philadelphia Eagles beat Dallas Cowboys (NFL)",
    entities: ["Philadelphia Eagles", "Dallas Cowboys"], conditions: [], thresholds: [], madeOnDate: "2026-09-09", madeOnBasis: "publication", ambiguities: ["Game date not stated; the pick settles when the matchup is identified."],
    occurrences: [], components: [{ kind: "future_claim", statement: "Philadelphia Eagles beat Dallas Cowboys (NFL)", notes: "Sports pick — settled from the final score." }],
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
  return { ctx, p, waitFor };
}

test("sports.resolve_date: date parsed from search snippets, written back with basis 'lookup', settlement chain queued", async () => {
  snippetsCarryDate = true;
  const fetcher = new FakeFetcher();
  const { ctx, p, waitFor } = await makeCtx(fetcher);
  ctx.jobs.start();
  try {
    assert.equal(p.deadlineDate, undefined);
    const j = await waitFor(ctx.jobs.enqueue({ kind: "sports.resolve_date", subjectType: "prediction", subjectId: p.id, payload: { predictionId: p.id, thenValidate: true } }));
    assert.equal(j.status, "completed", j.error);
    assert.equal(fetcher.fetched.length, 0, "snippets were enough; no page fetched");
    const after1 = ctx.predictions.get(p.id)!;
    assert.equal(after1.deadlineDate, "2026-09-10");
    assert.equal(after1.deadlineBasis, "lookup");
    assert.equal(after1.sportsPick?.eventDate, "2026-09-10");
    assert.equal(after1.sportsPick?.eventTime, "8:20 PM ET");
    assert.equal(after1.sportsPick?.eventDateSource, "lookup");
    assert.equal(after1.components[0].deadlineDate, "2026-09-10");
    assert.match(after1.components[0].statement, /on 2026-09-10/);
    assert.ok(after1.ambiguities.some((a) => /schedule look-up/.test(a)) && !after1.ambiguities.some((a) => /^Game date not stated/.test(a)));
    assert.equal(ctx.predictions.revisions(p.id)[0]?.reason, "schedule-lookup");
    await sleep(300);
    const chained = ctx.jobs.list().find((x) => x.subjectId === p.id && x.kind === "plan.generate");
    assert.ok(chained, "plan.generate was queued because the game is already played");
  } finally {
    await ctx.jobs.stop();
    ctx.db.close();
  }
});

test("sports.resolve_date: falls back to fetching the schedule page (trusted host first), then to the model; fails honestly when nothing states a date", async () => {
  snippetsCarryDate = false;
  const fetcher = new FakeFetcher();
  const { ctx, p, waitFor } = await makeCtx(fetcher);
  fake.requests = [];
  const lookups = () => fake.requests.filter((r) => r.jsonSchema?.name === "schedule_lookup");
  ctx.jobs.start();
  try {
    const j = await waitFor(ctx.jobs.enqueue({ kind: "sports.resolve_date", subjectType: "prediction", subjectId: p.id, payload: { predictionId: p.id } }));
    assert.equal(j.status, "completed", j.error);
    assert.ok(fetcher.fetched[0].includes("espn.com"), `trusted schedule host fetched first: ${fetcher.fetched.join(", ")}`);
    assert.equal(ctx.predictions.get(p.id)!.sportsPick?.eventDate, "2026-09-10");
    assert.equal(ctx.predictions.get(p.id)!.sportsPick?.eventDateSourceUrl, fetcher.fetched[0]);
    assert.equal(lookups().length, 0, "parser found the date; no model call");

    // Page names both teams but carries no parsable date → model fallback reads it.
    pageText = "<html><body><article><p>Week 1 opener: Dallas Cowboys at Philadelphia Eagles, Thursday night on NBC.</p></article></body></html>";
    const p2 = ctx.predictions.create({
      videoId: p.videoId, kind: "sports_pick", sportsPick: pick, quoteExact: "Eagles over Cowboys, take it to the bank in Week 1.", normalizedStatement: "Philadelphia Eagles beat Dallas Cowboys (NFL)",
      entities: [], conditions: [], thresholds: [], madeOnDate: "2026-09-09", madeOnBasis: "publication", ambiguities: [], occurrences: [], components: [{ kind: "future_claim", statement: "Philadelphia Eagles beat Dallas Cowboys (NFL)" }],
    });
    const j2 = await waitFor(ctx.jobs.enqueue({ kind: "sports.resolve_date", subjectType: "prediction", subjectId: p2.id, payload: { predictionId: p2.id } }));
    assert.equal(j2.status, "completed", j2.error);
    assert.equal(lookups().length, 1, "model consulted once");
    assert.match(lookups()[0].messages[0].content, /never infer or guess/);
    assert.equal(ctx.predictions.get(p2.id)!.deadlineDate, "2026-09-10");

    // Nothing anywhere: no date is invented.
    pageText = "<html><body><article><p>Tickets and parking information.</p></article></body></html>";
    const p3 = ctx.predictions.create({
      videoId: p.videoId, kind: "sports_pick", sportsPick: pick, quoteExact: "Eagles are winning this one, no doubt about it.", normalizedStatement: "Philadelphia Eagles beat Dallas Cowboys (NFL)",
      entities: [], conditions: [], thresholds: [], madeOnDate: "2026-09-09", madeOnBasis: "publication", ambiguities: [], occurrences: [], components: [{ kind: "future_claim", statement: "Philadelphia Eagles beat Dallas Cowboys (NFL)" }],
    });
    const j3 = await waitFor(ctx.jobs.enqueue({ kind: "sports.resolve_date", subjectType: "prediction", subjectId: p3.id, payload: { predictionId: p3.id } }));
    assert.equal(j3.status, "failed");
    assert.match(j3.error ?? "", /Could not find the game date/);
    assert.equal(ctx.predictions.get(p3.id)!.deadlineDate, undefined);
  } finally {
    pageText = schedulePage;
    await ctx.jobs.stop();
    ctx.db.close();
  }
});
