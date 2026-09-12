/**
 * Prediction Ledger — acceptance-criteria pipeline tests (Release 0.6): a 30-minute transcript across
 * three overlapping windows (B1), a prediction spanning a window boundary, a repeated statement, a
 * transcript with no predictions (B2), invalid credentials at extraction, and job retry.
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
import type { ModelInfo, ProviderTestResult } from "@prediction-ledger/shared";
import type { CompletionRequest, CompletionResult, LanguageModelProvider, ProviderCredentials } from "./providers/llm/types.js";
import { ProviderHttpError } from "./providers/llm/types.js";
import { setLlmProviderForTests } from "./providers/llm/registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "..", "..", "fixtures");
const srt = fs.readFileSync(path.join(fixtures, "transcripts", "energy-outlook-30min.srt"), "utf8");
const expected = JSON.parse(fs.readFileSync(path.join(fixtures, "transcripts", "energy-outlook-30min.expected.json"), "utf8")) as {
  publishedAt: string;
  expectedWindowCount: number;
  mustExtract: { id: string; quoteContains: string; startS?: number; endS?: number; deadlineDate?: string; deadlineBasis?: string; modality?: string; occurrences?: number; minComponents?: number }[];
  mustNotExtract: { quoteContains: string }[];
};
const replies = ["w1", "w2", "w3"].map((w) => fs.readFileSync(path.join(fixtures, "model-outputs", `extraction.energy-outlook-30min.${w}.json`), "utf8"));
const noPredSrt = fs.readFileSync(path.join(fixtures, "transcripts", "no-predictions.srt"), "utf8");

class FakeProvider implements LanguageModelProvider {
  readonly id = "lmstudio" as const;
  readonly displayName = "Fake local model";
  readonly isLocal = true;
  replies: (string | Error)[] = [];
  requests: CompletionRequest[] = [];
  async testConnection(): Promise<ProviderTestResult> {
    return { ok: true, provider: this.id, message: "fake" };
  }
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "fake-model", source: "discovered" }];
  }
  async complete(_creds: ProviderCredentials, req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    const next = this.replies.shift() ?? "{}";
    if (next instanceof Error) throw next;
    return { text: next, model: req.model };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fake: FakeProvider;
before(() => {
  process.env.PL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pl-30min-"));
  fake = new FakeProvider();
  setLlmProviderForTests("lmstudio", fake);
});
after(() => {
  delete process.env.PL_DATA_DIR;
});

test("B1: 30-minute transcript → 3 windows; boundary-spanning prediction stored once; repeat = one prediction with two occurrences; no-predictions transcript; invalid credentials; retry", async () => {
  const { createContext } = await import("./context.js");
  const ctx = createContext();
  const s = ctx.settings.getPersisted();
  s.providers.lmstudio.enabled = true;
  s.providers.lmstudio.model = "fake-model";
  s.stages.extraction = { provider: "lmstudio" };
  s.privacy.allowInternet = false;
  ctx.settings.savePersisted(s);
  ctx.jobs.start();
  const waitFor = async (id: string) => {
    const t0 = Date.now();
    for (;;) {
      const j = ctx.jobs.get(id)!;
      if (j.status === "completed" || j.status === "failed" || j.status === "cancelled") return j;
      if (Date.now() - t0 > 20_000) throw new Error(`job ${id} stuck in ${j.status}`);
      await sleep(100);
    }
  };
  try {
    // ---- B1 -------------------------------------------------------------------
    const { video } = ctx.videos.importTranscript({ title: "Q1 energy outlook", content: srt, format: "srt", publishedAt: expected.publishedAt });
    assert.equal(video.durationS, 1800);
    assert.ok(video.segments.length > 140);

    fake.replies = [...replies];
    const jobId = ctx.jobs.enqueue({ kind: "prediction.extract", subjectType: "video", subjectId: video.id, payload: { videoId: video.id }, dedupeKey: `x:${video.id}` });
    const job = await waitFor(jobId);
    assert.equal(job.status, "completed", job.error);
    assert.equal(fake.requests.length, expected.expectedWindowCount, "one model call per window");
    const result = ctx.db.get<{ result_json: string }>("SELECT result_json FROM jobs WHERE id = ?", jobId);
    const r = JSON.parse(result?.result_json ?? "{}") as { windows: number; created: number; candidates: number };
    assert.equal(r.windows, expected.expectedWindowCount);
    assert.equal(r.candidates, 8, "3 + 3 + 2 candidates across the windows");
    assert.equal(r.created, 6, "P3 (twice, once truncated) and P1 (twice) collapse into one row each");

    const preds = ctx.predictions.list({ videoId: video.id });
    assert.equal(preds.length, 6);
    for (const exp of expected.mustExtract) {
      const p = preds.find((x) => x.quoteExact.includes(exp.quoteContains));
      assert.ok(p, `${exp.id} extracted`);
      if (exp.startS !== undefined) assert.ok(Math.abs((p.startS ?? -1) - exp.startS) < 0.5, `${exp.id} startS ${p.startS}`);
      if (exp.endS !== undefined) assert.ok(Math.abs((p.endS ?? -1) - exp.endS) < 0.5, `${exp.id} endS ${p.endS}`);
      if (exp.deadlineDate) assert.equal(p.deadlineDate, exp.deadlineDate, `${exp.id} deadline`);
      if (exp.deadlineBasis === "unresolved") {
        assert.equal(p.deadlineDate, undefined, `${exp.id} must not invent a deadline`);
        assert.equal(p.deadlineBasis, undefined, `${exp.id} unresolved deadlines carry no basis`);
      } else if (exp.deadlineBasis) assert.equal(p.deadlineBasis, exp.deadlineBasis, `${exp.id} basis`);
      if (exp.modality) assert.equal(p.modality, exp.modality, `${exp.id} modality preserved`);
      if (exp.occurrences) assert.equal(p.occurrences.length, exp.occurrences, `${exp.id} occurrences`);
      if (exp.minComponents) assert.ok(p.components.length >= exp.minComponents, `${exp.id} components ${p.components.length}`);
      assert.equal(p.madeOnDate, expected.publishedAt);
    }
    for (const bad of expected.mustNotExtract) assert.ok(!preds.some((p) => p.quoteExact.includes(bad.quoteContains)), `must not extract: ${bad.quoteContains}`);

    // boundary prediction: quote located across the two 6 s cues, and the full (not truncated) quote won
    const p3 = preds.find((p) => p.quoteExact.includes("moratorium"))!;
    assert.match(p3.quoteExact, /^within eighteen months the state legislature will pass a moratorium/);
    assert.ok(p3.contextBefore?.includes("load forecast"), "context before comes from the preceding cue");
    // repeated statement: second occurrence is at ~1700 s
    const p1 = preds.find((p) => p.quoteExact.includes("gigawatt-scale"))!;
    assert.ok(p1.occurrences.some((o) => (o.startS ?? 0) > 1690), JSON.stringify(p1.occurrences));

    // ---- B2: no predictions --------------------------------------------------
    const v2 = ctx.videos.importTranscript({ title: "County recap", content: noPredSrt, format: "srt", publishedAt: "2026-02-10" }).video;
    fake.replies = [JSON.stringify({ predictions: [], notes: "Past events and background only; nothing forward-looking." })];
    const j2 = await waitFor(ctx.jobs.enqueue({ kind: "prediction.extract", subjectType: "video", subjectId: v2.id, payload: { videoId: v2.id } }));
    assert.equal(j2.status, "completed", j2.error);
    assert.equal(j2.stage, "No predictions found");
    assert.equal(ctx.predictions.list({ videoId: v2.id }).length, 0);
    assert.equal(ctx.videos.get(v2.id)?.status, "ready", "an empty result is not a failure");

    // ---- invalid credentials: fails with the provider's message, never silently ----
    fake.replies = [new ProviderHttpError("Fake local model", 401, '{"error":"invalid api key"}')];
    const j3 = await waitFor(ctx.jobs.enqueue({ kind: "prediction.extract", subjectType: "video", subjectId: v2.id, payload: { videoId: v2.id }, maxAttempts: 1 }));
    assert.equal(j3.status, "failed");
    assert.match(j3.error ?? "", /HTTP 401/);
    assert.match(j3.error ?? "", /invalid api key/);
    assert.equal(fake.requests.length, expected.expectedWindowCount + 2, "401 was not retried");

    // ---- retry re-enqueues the same work; a successful run follows ----
    fake.replies = [JSON.stringify({ predictions: [], notes: null })];
    const retryId = ctx.jobs.retry(j3.id)!;
    assert.ok(retryId && retryId !== j3.id);
    const j4 = await waitFor(retryId);
    assert.equal(j4.status, "completed", j4.error);
    assert.equal(j4.kind, "prediction.extract");
    assert.equal(ctx.jobs.retry(j4.id), undefined, "completed jobs are not retryable");
  } finally {
    await ctx.jobs.stop();
    ctx.db.close();
  }
});
