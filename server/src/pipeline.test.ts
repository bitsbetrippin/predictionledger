/**
 * Prediction Ledger — end-to-end pipeline test with a fake language model.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Exercises: transcript import → windowing → extraction job (fake provider returns the
 * canned fixture) → quote location → deadline resolution → dedupe → persistence → user
 * edit/merge/split → plan job → immutable plan versions → malformed-output handling.
 * No network, no real provider, throwaway data directory.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";
import type { ModelInfo, ProviderTestResult } from "@prediction-ledger/shared";
import type { CompletionRequest, CompletionResult, LanguageModelProvider, ProviderCredentials } from "./providers/llm/types.js";
import { setLlmProviderForTests } from "./providers/llm/registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "..", "..", "fixtures");
const srt = fs.readFileSync(path.join(fixtures, "transcripts", "data-center-approvals.srt"), "utf8");
const expected = JSON.parse(fs.readFileSync(path.join(fixtures, "transcripts", "data-center-approvals.expected.json"), "utf8"));
const extractionReply = fs.readFileSync(path.join(fixtures, "model-outputs", "extraction.data-center-approvals.json"), "utf8");
const planReply = fs.readFileSync(path.join(fixtures, "model-outputs", "plan.data-center-approvals.json"), "utf8");

/** Fake provider: returns whatever the test queues next; records every request. */
class FakeProvider implements LanguageModelProvider {
  readonly id = "lmstudio" as const;
  readonly displayName = "Fake local model";
  readonly isLocal = true;
  replies: string[] = [];
  requests: CompletionRequest[] = [];
  async testConnection(): Promise<ProviderTestResult> {
    return { ok: true, provider: this.id, message: "fake" };
  }
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "fake-model", source: "discovered" }];
  }
  async complete(_creds: ProviderCredentials, req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    const text = this.replies.shift() ?? "{}";
    return { text, model: req.model };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitForJob(ctx: Awaited<ReturnType<typeof makeCtx>>, id: string, timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    const j = ctx.jobs.get(id)!;
    if (j.status === "completed" || j.status === "failed" || j.status === "cancelled") return j;
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${id} timed out in status ${j.status}`);
    await sleep(100);
  }
}

let fake: FakeProvider;
let dataDir: string;

async function makeCtx() {
  const { createContext } = await import("./context.js");
  return createContext();
}

before(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prediction-ledger-pipeline-"));
  process.env.PL_DATA_DIR = dataDir;
  fake = new FakeProvider();
  setLlmProviderForTests("lmstudio", fake);
});
after(() => {
  delete process.env.PL_DATA_DIR;
});

test("pipeline: import → extract → dedupe/dates → edit/merge/split → plan versions → malformed output", async () => {
  const ctx = await makeCtx();
  const s = ctx.settings.getPersisted();
  s.providers.lmstudio.enabled = true;
  s.providers.lmstudio.model = "fake-model";
  s.stages.extraction = { provider: "lmstudio" };
  s.stages.validationPlan = { provider: "lmstudio" };
  s.privacy.allowInternet = false; // local provider must still work offline (B6)
  ctx.settings.savePersisted(s);
  ctx.jobs.start();

  try {
    // ---- import ---------------------------------------------------------------
    const { video, warnings } = ctx.videos.importTranscript({
      title: "Power, permits, and data centers",
      content: srt,
      format: "auto",
      filename: "data-center-approvals.srt",
      publishedAt: expected.publishedAt,
    });
    assert.equal(warnings.length, 0);
    assert.equal(video.segments.length, 9);
    assert.equal(video.segments[2].speaker, "Host");
    assert.equal(video.durationS, 53);

    // ---- extraction (fake returns the fixture twice: window only has one pass, but be safe) --
    fake.replies = [extractionReply];
    const jobId = ctx.jobs.enqueue({ kind: "prediction.extract", payload: { videoId: video.id }, dedupeKey: `x:${video.id}` });
    assert.equal(ctx.jobs.enqueue({ kind: "prediction.extract", payload: { videoId: video.id }, dedupeKey: `x:${video.id}` }), jobId, "dedupe");
    const job = await waitForJob(ctx, jobId);
    assert.equal(job.status, "completed", job.error);
    assert.equal(ctx.videos.get(video.id)?.status, "ready");

    // Untrusted content is in the user message inside delimiters, never in the system prompt.
    const req = fake.requests[0];
    assert.ok(req.messages[0].role === "system" && !req.messages[0].content.includes("narrowed down"));
    assert.ok(req.messages[1].content.includes("<transcript_window>"));
    assert.ok(req.messages[1].content.includes("published on 2025-11-03"));
    assert.ok(req.jsonSchema?.name === "extraction_output");

    const preds = ctx.predictions.list({ videoId: video.id });
    assert.equal(preds.length, 2, "two predictions, non-predictions excluded by the (fake) model");

    const dc = preds.find((p) => p.quoteExact.includes("narrowed down to government lands"))!;
    assert.ok(dc);
    assert.equal(dc.startS, 12.1, "quote located to segment 3");
    assert.equal(dc.endS, 19.8);
    assert.ok(dc.contextBefore?.includes("dozen county boards"));
    assert.equal(dc.geography, undefined, "geography not invented");
    assert.equal(dc.madeOnDate, "2025-11-03");
    assert.equal(dc.madeOnBasis, "publication");
    assert.equal(dc.deadlineDate, "2027-11-03");
    assert.equal(dc.deadlineBasis, "rule:relative", "app-resolved deadline beats the model's proposal");
    assert.deepEqual(dc.components.map((c) => c.kind), ["future_claim", "premise", "causal_link"]);
    assert.ok(dc.ambiguities.some((a) => /geograph/i.test(a)) && dc.ambiguities.some((a) => /narrowed/i.test(a)));
    assert.equal(dc.occurrences.length, 1);
    assert.equal(dc.extractionProvider, "lmstudio");
    assert.equal(dc.extractionTemplate, "extraction.v1");

    const hp = preds.find((p) => p.quoteExact.includes("hashprice"))!;
    assert.equal(hp.modality, "might");
    assert.ok(hp.normalizedStatement.includes("might"), "modality preserved");
    assert.equal(hp.deadlineDate, "2026-11-03", "'next year' resolved from statement date");

    // ---- user edits are revisions; originals immutable -------------------------------
    const edited = ctx.predictions.edit(dc.id, { geography: "United States (assumed by user)", deadlineDate: "2027-12-31" })!;
    assert.equal(edited.geography, "United States (assumed by user)");
    assert.equal(edited.deadlineBasis, "user");
    assert.equal(edited.quoteExact, dc.quoteExact);
    assert.equal(ctx.predictions.revisions(dc.id).length, 1);

    // ---- split a component out, then merge it back ---------------------------------------
    const premise = edited.components.find((c) => c.kind === "premise")!;
    const split = ctx.predictions.split(dc.id, premise.id)!;
    assert.equal(split.parent.components.length, 2);
    assert.equal(split.child.normalizedStatement, premise.statement);
    assert.equal(ctx.predictions.list({ videoId: video.id }).length, 3);
    const merged = ctx.predictions.merge(dc.id, [split.child.id])!;
    assert.equal(ctx.predictions.get(split.child.id)?.userStatus, "merged");
    assert.equal(ctx.predictions.get(split.child.id)?.mergedIntoId, merged.id);
    assert.equal(ctx.predictions.list({ videoId: video.id }).length, 2, "merged rows hidden by default");
    assert.equal(ctx.predictions.list({ videoId: video.id, includeDismissed: true }).length, 3);

    // ---- re-extraction preserves touched predictions, replaces untouched ones --------------
    fake.replies = [extractionReply];
    const job2 = await waitForJob(ctx, ctx.jobs.enqueue({ kind: "prediction.extract", payload: { videoId: video.id } }));
    assert.equal(job2.status, "completed", job2.error);
    const after2 = ctx.predictions.list({ videoId: video.id, includeDismissed: true });
    assert.ok(after2.some((p) => p.id === dc.id), "edited prediction kept");
    assert.ok(!after2.some((p) => p.id === hp.id), "untouched pending prediction replaced by the new run");

    // ---- accept / dismiss -----------------------------------------------------------------
    assert.equal(ctx.predictions.setStatus(dc.id, "accepted")?.userStatus, "accepted");
    const hp2 = after2.find((p) => p.quoteExact.includes("hashprice"))!;
    assert.equal(ctx.predictions.setStatus(hp2.id, "dismissed")?.userStatus, "dismissed");
    assert.equal(ctx.predictions.list({ videoId: video.id }).length, 1);

    // ---- validation plan: generated, dates owned by the app, versions immutable -------------
    fake.replies = [planReply];
    const planJob = await waitForJob(ctx, ctx.jobs.enqueue({ kind: "plan.generate", payload: { predictionId: dc.id } }));
    assert.equal(planJob.status, "completed", planJob.error);
    const planReq = fake.requests.at(-1)!;
    assert.ok(planReq.messages[0].content.includes("Do not determine the outcome yet"));
    assert.ok(planReq.messages[1].content.includes("Deadline: 2027-12-31 (basis: user)"), "prompt carries the app's dates");
    const v1 = ctx.plans.latest(dc.id)!;
    assert.equal(v1.version, 1);
    assert.equal(v1.plan.dates.deadline, "2027-12-31", "app overrode the model's date");
    assert.equal(v1.templateVersion, "plan.v1");
    assert.equal(v1.plan.queries.disconfirming.length, 3);
    assert.ok(v1.researchPrompt.includes("never cite from memory"));

    const v2 = ctx.plans.add({ predictionId: dc.id, plan: { ...v1.plan, ambiguities: [...v1.plan.ambiguities, "user note"] }, researchPrompt: v1.researchPrompt + "\nUser addition.", provider: "user", templateVersion: "user-edit", editedByUser: true });
    assert.equal(v2.version, 2);
    assert.equal(ctx.plans.get(v1.id)?.plan.ambiguities.length, 3, "v1 untouched");
    assert.equal(ctx.predictions.get(dc.id)?.latestPlanVersion, 2);

    // ---- malformed model output: one repair attempt, then a visible failure (B7) -------------
    fake.replies = ["Sure! Here is some prose and no JSON.", "{\"predictions\": \"not an array\"}"];
    const bad = await waitForJob(ctx, ctx.jobs.enqueue({ kind: "prediction.extract", payload: { videoId: video.id }, maxAttempts: 1 }));
    assert.equal(bad.status, "failed");
    assert.match(bad.error ?? "", /did not match the extraction_output schema/);
    const repair = fake.requests.at(-1)!;
    assert.ok(repair.messages.at(-1)?.content.includes("not valid according to the required JSON schema"), "repair prompt sent");
    assert.ok(ctx.predictions.list({ videoId: video.id }).some((p) => p.id === dc.id), "failed run did not destroy existing predictions");

    // ---- offline switch blocks cloud providers but not local ones --------------------------
    const s2 = ctx.settings.getPersisted();
    s2.providers.anthropic.enabled = true;
    s2.providers.anthropic.model = "claude-sonnet-5";
    s2.stages.validationPlan = { provider: "anthropic" };
    ctx.settings.savePersisted(s2);
    ctx.secrets.set("llm.anthropic.apiKey", "sk-ant-test");
    const offline = await waitForJob(ctx, ctx.jobs.enqueue({ kind: "plan.generate", payload: { predictionId: dc.id }, maxAttempts: 1 }));
    assert.equal(offline.status, "failed");
    assert.match(offline.error ?? "", /Internet access is disabled/);

    // ---- delete cascades -------------------------------------------------------------------
    assert.equal(ctx.videos.delete(video.id), true);
    assert.equal(ctx.predictions.list({ includeDismissed: true }).length, 0);
    assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM validation_plans")?.n, 0);
  } finally {
    await ctx.jobs.stop();
    ctx.db.close();
  }
});

test("fixture sanity: expected file lists the worked example and the exclusions", () => {
  assert.ok(expected.mustExtract.length >= 2);
  assert.ok(expected.mustNotExtract.length >= 4);
  for (const m of expected.mustNotExtract) assert.ok(srt.includes(m.quoteContains), m.quoteContains);
});
