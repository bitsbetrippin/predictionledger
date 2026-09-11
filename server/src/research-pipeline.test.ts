/**
 * Prediction Ledger — end-to-end research → evidence → assessment test with fake search, fetcher, and model.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Proves the worked example (docs/WORKED_EXAMPLE.md): local permit cancellations alone do not
 * make "approvals narrowed to government land" supported; invented excerpts and citation ids
 * are discarded; syndicated copies are detected; search failures become coverage notes; a
 * provider outage fails the run without an assessment; rechecks create new versions; export
 * carries no secrets. No network.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";
import type { ModelInfo, ProviderTestResult, SearchResult } from "@prediction-ledger/shared";
import type { CompletionRequest, CompletionResult, LanguageModelProvider, ProviderCredentials } from "./providers/llm/types.js";
import { setLlmProviderForTests } from "./providers/llm/registry.js";
import type { FetchOutcome, SourceFetcher } from "./research/fetcher.js";
import { extractHtml } from "./research/htmlExtract.js";
import { SearchError, setSearchProviderFactoryForTests } from "./research/search.js";
import { buildCsv } from "./services/export.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "..", "..", "fixtures");
const read = (...p: string[]) => fs.readFileSync(path.join(fixtures, ...p), "utf8");
const srt = read("transcripts", "data-center-approvals.srt");
const extractionReply = read("model-outputs", "extraction.data-center-approvals.json");
const planReply = read("model-outputs", "plan.data-center-approvals.json");
const searchFixture = JSON.parse(read("research", "search-results.json")) as Record<string, SearchResult[] | string>;
const evidenceFixture = JSON.parse(read("research", "evidence-outputs.json")) as Record<string, unknown>;
const assessmentFixture = read("research", "assessment-output.json");
const pages: Record<string, string> = {
  "https://county-news.example/2026/02/permit-cancelled": read("research", "pages", "county-permit-cancelled.html"),
  "https://regional-wire.example/story/permit-cancelled-madison": read("research", "pages", "regional-wire-syndicated.html"),
  "https://state-energy.example/reports/siting-h1-2026": read("research", "pages", "state-siting-report.html"),
  "https://federal-energy.example/news/data-center-sites-2026": read("research", "pages", "federal-announcement.html"),
};

/** Fake model: routes by what the request is for. */
class FakeModel implements LanguageModelProvider {
  readonly id = "lmstudio" as const;
  readonly displayName = "fake";
  readonly isLocal = true;
  ids: Record<string, string> = {};
  requests: CompletionRequest[] = [];
  /** When true, every page yields no evidence (simulates irrelevant pages). */
  noEvidence = false;
  assessmentReply = assessmentFixture;
  async testConnection(): Promise<ProviderTestResult> { return { ok: true, provider: this.id, message: "fake" }; }
  async listModels(): Promise<ModelInfo[]> { return []; }
  async complete(_c: ProviderCredentials, req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    const name = req.jsonSchema?.name;
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";
    let text = "{}";
    if (name === "extraction_output") text = extractionReply;
    else if (name === "validation_plan") text = planReply;
    else if (name === "evidence_output" && this.noEvidence) text = JSON.stringify({ items: [] });
    else if (name === "evidence_output") {
      const url = /Retrieved page \((\S+) ·/.exec(user)?.[1] ?? "";
      const key = Object.keys(evidenceFixture).find((k) => url.startsWith(k)) ?? "";
      text = JSON.stringify(evidenceFixture[key] ?? { items: [] });
    } else if (name === "assessment_output") text = this.assessmentReply;
    for (const [k, v] of Object.entries(this.ids)) text = text.split(`"${k}"`).join(`"${v}"`);
    return { text, model: req.model };
  }
}

class FakeFetcher implements SourceFetcher {
  fetched: string[] = [];
  async fetch(url: string): Promise<FetchOutcome> {
    this.fetched.push(url);
    const clean = url.split("?")[0];
    const html = pages[clean];
    if (!html) return { status: "error", finalUrl: url, httpStatus: 404, note: "HTTP 404" };
    const page = extractHtml(html);
    return { status: "ok", finalUrl: clean, httpStatus: 200, contentType: "text/html", page, rawText: page.text };
  }
}

let fake: FakeModel;
let failAllSearches = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(() => {
  process.env.PL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "prediction-ledger-research-"));
  fake = new FakeModel();
  setLlmProviderForTests("lmstudio", fake);
  // Fake search provider: swap the factory used by the research handler.
  setSearchProviderFactoryForTests(() => ({
    id: "searxng",
    isLocal: true,
    async search(query: string) {
      if (failAllSearches) throw new SearchError("Could not reach search provider: ECONNREFUSED", "searxng", true);
      if (searchFixture.__fail__ === query) throw new SearchError("Search provider rate limit reached.", "searxng", true);
      const r = searchFixture[query];
      return Array.isArray(r) ? r : [];
    },
  }));
});
after(() => { delete process.env.PL_DATA_DIR; });

async function waitForJob(ctx: { jobs: { get(id: string): { status: string; error?: string } | undefined } }, id: string, timeoutMs = 10_000) {
  const t0 = Date.now();
  for (;;) {
    const j = ctx.jobs.get(id)!;
    if (["completed", "failed", "cancelled"].includes(j.status)) return j;
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${id} timed out (${j.status})`);
    await sleep(100);
  }
}

test("research pipeline: worked example end to end, with guards, coverage notes, recheck, and export", async () => {
  const { createContext } = await import("./context.js");
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

  try {
    // ---- setup: import, extract, plan (0.2 path) ----
    const { video } = ctx.videos.importTranscript({ title: "Power, permits", content: srt, format: "srt", publishedAt: "2025-11-03" });
    assert.equal((await waitForJob(ctx, ctx.jobs.enqueue({ kind: "prediction.extract", payload: { videoId: video.id } }))).status, "completed");
    const p = ctx.predictions.list({ videoId: video.id }).find((x) => x.quoteExact.includes("narrowed down"))!;
    const fc = p.components.find((c) => c.kind === "future_claim")!;
    const pr = p.components.find((c) => c.kind === "premise")!;
    const cl = p.components.find((c) => c.kind === "causal_link")!;
    fake.ids = { FC: fc.id, PR: pr.id, CL: cl.id };
    assert.equal((await waitForJob(ctx, ctx.jobs.enqueue({ kind: "plan.generate", payload: { predictionId: p.id } }))).status, "completed");
    const plan = ctx.plans.latest(p.id)!;
    assert.equal(ctx.research.processingStatus(p.id), "not_researched");

    // ---- C2: provider outage → run failed, no assessment ----
    failAllSearches = true;
    const outage = await waitForJob(ctx, ctx.jobs.enqueue({ kind: "research.run", payload: { predictionId: p.id, planId: plan.id }, maxAttempts: 1 }));
    assert.equal(outage.status, "failed");
    assert.match(outage.error ?? "", /Every search failed/);
    assert.equal(ctx.research.runsForPrediction(p.id)[0].status, "failed");
    assert.equal(ctx.research.assessmentsForPrediction(p.id).length, 0, "no assessment from a failed run");
    assert.equal(ctx.research.processingStatus(p.id), "failed");
    failAllSearches = false;

    // ---- research run (real path with fakes) ----
    const rj = await waitForJob(ctx, ctx.jobs.enqueue({ kind: "research.run", payload: { predictionId: p.id, planId: plan.id }, maxAttempts: 1 }));
    assert.equal(rj.status, "completed", rj.error);
    const run = ctx.research.runsForPrediction(p.id)[0];
    assert.equal(run.status, "completed");
    assert.equal(run.planVersion, plan.version);
    assert.ok(run.queries.some((q) => q.error), "the failing query is recorded");
    assert.ok(run.coverageNotes.some((n) => n.includes("Search failed")), "search failure is a coverage note, not a verdict");
    assert.ok(!fetcher.fetched.some((u) => u.includes("192.168.1.5")), "private address never fetched");
    assert.equal(fetcher.fetched.length, 4);
    assert.ok(run.coverageNotes.some((n) => /discarded because their excerpts could not be found/.test(n)), "invented excerpt discarded");

    const evidence = ctx.research.evidenceForRun(run.id);
    assert.equal(evidence.length, 5, "5 verified items (1 invented dropped)");
    const fed = evidence.find((e) => e.source?.url.includes("federal-energy"))!;
    assert.equal(fed.actionStage, "announced");
    assert.equal(fed.inWindow, true);
    assert.equal(fed.componentId, fc.id);
    const wire = evidence.find((e) => e.source?.url.includes("regional-wire"))!;
    assert.equal(wire.independent, false, "syndicated copy detected by content hash");
    assert.ok(evidence.every((e) => e.excerpt.length > 15));
    const county = evidence.find((e) => e.source?.url.includes("county-news"))!;
    assert.ok(county.excerpt.startsWith("The Madison County board voted 5–2"), "excerpt stored verbatim from page");
    assert.equal(county.source?.publishedAt, "2026-02-11");

    // ---- assessment (auto-chained) with guard ----
    await sleep(1500);
    const aJob = ctx.jobs.list().find((j) => j.kind === "assessment.run")!;
    assert.ok(aJob, "assessment job chained");
    const aj = await waitForJob(ctx, aJob.id);
    assert.equal(aj.status, "completed", aj.error);

    // Substitute evidence ids into the fixture were done via fake.ids for components; now check guard results.
    const a = ctx.research.assessmentsForPrediction(p.id)[0];
    assert.equal(a.version, 1);
    assert.equal(a.timeStatus, "pending", "deadline 2027-11-03 is pending — computed by the app");
    assert.notEqual(a.evidenceAssessment, "supported", "C5: cancellations + an announcement do not make the future claim supported");
    const fcA = a.components.find((c) => c.componentId === fc.id)!;
    const prA = a.components.find((c) => c.componentId === pr.id)!;
    assert.equal(prA.assessment, "supported");
    assert.notEqual(fcA.assessment, "supported");
    assert.ok(a.guardNotes.some((n) => n.startsWith("G1")), "invented citation id dropped: " + a.guardNotes.join(" | "));
    assert.ok(!a.citations.some((c) => c.evidenceIds.some((id) => !evidence.some((e) => e.id === id))), "C6: every citation resolves to stored evidence");
    assert.ok(a.recheckAfter, "pending deadline → recheck suggested");
    assert.equal(ctx.research.processingStatus(p.id), "completed");
    const summary = ctx.research.latestSummary(p.id)!;
    assert.equal(summary.sourceCount, 4);

    // ---- C8: recheck creates version 2; v1 intact ----
    const rj2 = await waitForJob(ctx, ctx.jobs.enqueue({ kind: "research.run", payload: { predictionId: p.id, planId: plan.id }, maxAttempts: 1 }));
    assert.equal(rj2.status, "completed", rj2.error);
    await sleep(1500);
    const aJob2 = ctx.jobs.list().filter((j) => j.kind === "assessment.run").find((j) => j.id !== aJob.id)!;
    assert.equal((await waitForJob(ctx, aJob2.id)).status, "completed");
    const versions = ctx.research.assessmentsForPrediction(p.id);
    assert.equal(versions.length, 2);
    assert.equal(versions[0].version, 2);
    assert.equal(versions[1].id, a.id);
    assert.ok(ctx.research.runsForPrediction(p.id).find((r) => r.id === run.id)?.evidenceCount === 5, "v1 evidence set preserved");

    // ---- G6: a run whose pages yield no evidence → deterministic 'insufficient', no assessment model call ----
    const before = fake.requests.filter((r) => r.jsonSchema?.name === "assessment_output").length;
    fake.noEvidence = true;
    const rj3 = await waitForJob(ctx, ctx.jobs.enqueue({ kind: "research.run", payload: { predictionId: p.id, planId: plan.id }, maxAttempts: 1 }));
    assert.equal(rj3.status, "completed", rj3.error);
    await sleep(1500);
    const aJob3 = ctx.jobs.list().filter((j) => j.kind === "assessment.run").find((j) => j.id !== aJob.id && j.id !== aJob2.id)!;
    assert.equal((await waitForJob(ctx, aJob3.id)).status, "completed");
    const v3 = ctx.research.assessmentsForPrediction(p.id)[0];
    assert.equal(v3.version, 3);
    assert.equal(v3.evidenceAssessment, "insufficient");
    assert.equal(v3.provider, "app");
    assert.equal(fake.requests.filter((r) => r.jsonSchema?.name === "assessment_output").length, before, "no assessment model call for an empty evidence set");
    assert.equal(ctx.research.runsForPrediction(p.id)[0].evidenceCount, 0);
    fake.noEvidence = false;

    // ---- export: no secrets, CSV shape ----
    ctx.secrets.set("llm.anthropic.apiKey", "sk-ant-SHOULD-NOT-LEAK");
    const csv = buildCsv(ctx);
    assert.ok(csv.startsWith("﻿prediction_id,"));
    assert.ok(!csv.includes("SHOULD-NOT-LEAK"));
    const rows = csv.trim().split("\r\n");
    assert.equal(rows.length, 1 + ctx.predictions.list({ includeDismissed: true }).length);
    assert.ok(rows[1].includes("insufficient") || rows[1].includes("partially_supported"));
  } finally {
    await ctx.jobs.stop();
    ctx.db.close();
  }
});
