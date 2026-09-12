/**
 * Prediction Ledger — LocalWhisperProvider with a fake Transformers.js module: readiness messages,
 * offline behaviour, preload progress, and the model.download job (Release 1.0-rc).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalWhisperProvider, TranscriptionError } from "./transcription.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeModule(modelsDir: string, modelId: string) {
  const calls: string[] = [];
  const env: Record<string, unknown> = {};
  return {
    calls,
    env,
    mod: {
      env,
      async pipeline(task: string, model: string, opts?: Record<string, unknown>) {
        calls.push(`${task}:${model}`);
        const cb = opts?.progress_callback as ((p: Record<string, unknown>) => void) | undefined;
        cb?.({ status: "initiate", file: "onnx/encoder.onnx" });
        cb?.({ status: "progress", file: "onnx/encoder.onnx", progress: 50 });
        cb?.({ status: "progress", file: "onnx/encoder.onnx", progress: 100 });
        // simulate the cache directory Transformers.js creates
        const dir = path.join(modelsDir, ...model.split("/"));
        fs.mkdirSync(path.join(dir, "onnx"), { recursive: true });
        fs.writeFileSync(path.join(dir, "onnx", "encoder.onnx"), "x");
        return async (_audio: Float32Array) => ({ text: " hello world", chunks: [{ timestamp: [0, 1.5] as [number, number], text: " hello world" }] });
      },
    },
  };
}

test("LocalWhisperProvider: missing package → engine_missing; not cached + offline → needsDownload/not ok; cached → ready", async () => {
  const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pl-whisper-"));
  const missing = new LocalWhisperProvider("onnx-community/whisper-base", modelsDir, () => true, async () => { throw new Error("Cannot find package"); });
  const m = await missing.check();
  assert.equal(m.ok, false);
  assert.match(m.message, /not installed/);
  await assert.rejects(missing.transcribeChunk("x.wav", {}), (e: Error) => e instanceof TranscriptionError && e.code === "engine_missing");

  const fake = fakeModule(modelsDir, "onnx-community/whisper-base");
  let internet = false;
  const p = new LocalWhisperProvider("onnx-community/whisper-base", modelsDir, () => internet, async () => fake.mod);
  const offline = await p.check();
  assert.equal(offline.ok, false);
  assert.equal(offline.needsDownload, true);
  assert.match(offline.message, /internet access is disabled/);
  await assert.rejects(p.preload(), (e: Error) => e instanceof TranscriptionError && e.code === "model_missing");
  assert.equal(fake.calls.length, 0, "no load attempted while offline and uncached");

  internet = true;
  const online = await p.check();
  assert.equal(online.ok, true);
  assert.equal(online.needsDownload, true);
  const notes: string[] = [];
  const res = await p.preload((f, note) => notes.push(`${Math.round(f * 100)}:${note}`));
  assert.deepEqual(res, { modelId: "onnx-community/whisper-base", cached: true });
  assert.deepEqual(notes, ["50:Downloading model onnx/encoder.onnx", "100:Downloading model onnx/encoder.onnx"]);
  assert.equal(fake.env.cacheDir, modelsDir);
  assert.equal(fake.env.allowRemoteModels, true);

  internet = false;
  const cached = await p.check();
  assert.equal(cached.ok, true, "cached model works offline");
  assert.equal(cached.needsDownload, undefined);
  // pipeline is reused, not re-created
  await p.preload();
  assert.equal(fake.calls.length, 1);
});

test("model.download job: reports progress and completes", async () => {
  process.env.PL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pl-whisper-ctx-"));
  const { createContext } = await import("../context.js");
  const modelsDir = path.join(process.env.PL_DATA_DIR, "models");
  const fake = fakeModule(modelsDir, "onnx-community/whisper-small");
  const engine = new LocalWhisperProvider("onnx-community/whisper-small", modelsDir, () => true, async () => fake.mod);
  const ctx = createContext({ transcription: () => engine });
  ctx.jobs.start();
  try {
    const id = ctx.jobs.enqueue({ kind: "model.download", payload: {}, maxAttempts: 1 });
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000 && !["completed", "failed"].includes(ctx.jobs.get(id)!.status)) await sleep(100);
    const j = ctx.jobs.get(id)!;
    assert.equal(j.status, "completed", j.error);
    assert.match(j.stage ?? "", /whisper-small ready/);
    assert.ok(fs.existsSync(path.join(modelsDir, "onnx-community", "whisper-small", "onnx")));
  } finally {
    await ctx.jobs.stop();
    ctx.db.close();
    delete process.env.PL_DATA_DIR;
  }
});
