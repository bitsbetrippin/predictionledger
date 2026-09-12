/**
 * Prediction Ledger — media tests: pure helpers plus an end-to-end upload → audio → chunked transcription
 * run against REAL ffmpeg (skipped automatically when ffmpeg/ffprobe are not installed).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { locateTools, parseProbe, planChunks, stitchChunk, run, MediaError, probe } from "./ffmpeg.js";
import { checkUploadName, UploadError } from "./importer.js";
import { readWavMono16k, type TranscriptionProvider } from "./transcription.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tools = await locateTools().catch(() => undefined);
const skipNoFfmpeg = tools ? false : "ffmpeg/ffprobe not installed — media integration tests skipped";

test("parseProbe: reads duration, audio/video presence, codecs; rejects empty", () => {
  const p = parseProbe(JSON.stringify({ format: { duration: "125.5", format_name: "mov,mp4", size: "1000" }, streams: [{ codec_type: "video", codec_name: "h264" }, { codec_type: "audio", codec_name: "aac" }] }));
  assert.equal(p.durationS, 125.5);
  assert.equal(p.hasAudio, true);
  assert.equal(p.audioCodec, "aac");
  assert.equal(p.videoCodec, "h264");
  const noAudio = parseProbe(JSON.stringify({ format: { duration: "10" }, streams: [{ codec_type: "video", codec_name: "h264" }] }));
  assert.equal(noAudio.hasAudio, false);
  assert.throws(() => parseProbe(JSON.stringify({ streams: [] })), MediaError);
});

test("planChunks: overlap, tail absorption, monotonic coverage", () => {
  const plan = planChunks(1800, 300, 5);
  assert.equal(plan[0].startS, 0);
  assert.equal(plan[0].endS, 300);
  assert.equal(plan[1].startS, 295, "next chunk starts overlapS before the previous end");
  assert.equal(plan.at(-1)!.endS, 1800);
  for (let i = 1; i < plan.length; i++) assert.ok(plan[i].startS < plan[i - 1].endS && plan[i].startS > plan[i - 1].startS);
  assert.equal(planChunks(330, 300, 5).length, 1, "a 30 s tail is absorbed into the last chunk");
  assert.equal(planChunks(0).length, 0);
  assert.equal(planChunks(45, 300, 5).length, 1);
});

test("stitchChunk: offsets to absolute time and drops segments already covered by the overlap", () => {
  const chunk = { index: 1, startS: 295, endS: 600 };
  const local = [
    { startS: 0, endS: 4, text: "already said in chunk 0" }, // mid = 297 ≤ 298 committed → dropped
    { startS: 2, endS: 8, text: "straddles the boundary" }, // mid = 300 > 298 → kept, clamped start
    { startS: 10, endS: 15, text: "new" },
    { startS: 16, endS: 17, text: "   " }, // blank → dropped
  ];
  const out = stitchChunk(chunk, local, 298);
  assert.deepEqual(out, [
    { startS: 298, endS: 303, text: "straddles the boundary" },
    { startS: 305, endS: 310, text: "new" },
  ]);
});

test("checkUploadName: extension allow-list, traversal-proof title", () => {
  assert.deepEqual(checkUploadName("..\\..\\My.Talk_2026.MP4"), { ext: ".mp4", title: "My Talk 2026" });
  assert.throws(() => checkUploadName("payload.exe"), UploadError);
  assert.throws(() => checkUploadName("noext"), UploadError);
  // fuzz: odd but legal names never escape the allow-list or produce an empty/oversized title
  for (const name of ["C:\\Users\\x\\..\\..\\clip.MOV", "/etc/passwd.mp4", "ünïcödé 🎥.mp4", "a".repeat(5000) + ".mp3", "%2e%2e%2fclip.mkv"]) {
    const r = checkUploadName(name);
    assert.ok([".mov", ".mp4", ".mp3", ".mkv"].includes(r.ext), `${name} → ${r.ext}`);
    assert.ok(r.title.length >= 1 && r.title.length <= 200, `${name} → title ${r.title.length}`);
    assert.ok(!r.title.includes("/") && !r.title.includes("\\"), "title carries no path separators");
  }
  for (const name of ["clip.mp4.exe", ".mp4", " .mp4", "clip.php", "clip.mp4/evil.exe", "x.mp4\u0000.exe"]) {
    assert.throws(() => checkUploadName(name), UploadError, name); // a bare dotfile has no extension; a null byte does not hide the real one
  }
});

test("ffmpeg integration: probe, extract, silence detection, chunk cut, WAV reader", { skip: skipNoFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pl-media-"));
  const mp4 = path.join(dir, "tone.mp4");
  await run(tools!.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=4", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", mp4]);
  const info = await probe(tools!, mp4);
  assert.ok(info.hasAudio && info.hasVideo && info.durationS >= 3.9 && info.durationS <= 4.2, JSON.stringify(info));

  const { extractWav, meanVolumeDb, cutWav } = await import("./ffmpeg.js");
  const wav = path.join(dir, "tone.wav");
  await extractWav(tools!, mp4, wav);
  const samples = readWavMono16k(wav);
  assert.ok(Math.abs(samples.length / 16000 - 4) < 0.2, `duration ${samples.length / 16000}`);
  assert.ok((await meanVolumeDb(tools!, wav)) > -30, "tone is not silent");

  const silent = path.join(dir, "silent.wav");
  await run(tools!.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "3", "-c:a", "pcm_s16le", silent]);
  assert.ok((await meanVolumeDb(tools!, silent)) < -60, "digital silence detected");

  const piece = path.join(dir, "piece.wav");
  await cutWav(tools!, wav, 1, 2, piece);
  assert.ok(Math.abs(readWavMono16k(piece).length / 16000 - 2) < 0.1);

  const videoOnly = path.join(dir, "video-only.mp4");
  await run(tools!.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", videoOnly]);
  assert.equal((await probe(tools!, videoOnly)).hasAudio, false);
  await assert.rejects(probe(tools!, path.join(dir, "nope.mp4")), MediaError);
});

test("upload → audio.extract → chunked transcript.generate with resume after a failed chunk (real ffmpeg, fake engine)", { skip: skipNoFfmpeg }, async () => {
  process.env.PL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pl-media-ctx-"));
  const { createContext } = await import("../context.js");
  const { importMediaStream } = await import("./importer.js");

  // Fake engine: returns two segments per chunk; fails once on chunk 1 to exercise resume.
  let failOnce = true;
  const calls: string[] = [];
  const engine: TranscriptionProvider = {
    id: "local-whisper",
    isLocal: true,
    async check() { return { ok: true, message: "fake" }; },
    async transcribeChunk(wavPath) {
      calls.push(path.basename(wavPath));
      const dur = readWavMono16k(wavPath).length / 16000;
      if (failOnce && wavPath.endsWith("c1.wav")) { failOnce = false; throw new Error("simulated engine crash"); }
      return [
        { startS: 0.5, endS: Math.min(dur, 20), text: `first half of ${path.basename(wavPath)}` },
        { startS: Math.min(dur, 20) + 0.5, endS: dur - 0.2, text: `second half of ${path.basename(wavPath)}` },
      ];
    },
  };
  const ctx = createContext({ transcription: () => engine });
  const s = ctx.settings.getPersisted();
  s.transcription.chunkSeconds = 60;
  s.transcription.overlapSeconds = 5;
  ctx.settings.savePersisted(s);
  ctx.jobs.start();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pl-media-src-"));
    const mp4 = path.join(dir, "Long Talk_2026.mp4");
    // 130 s with 60 s chunks / 5 s overlap → 0–60, 55–115, 110–130 (the 20 s tail is ≥ chunk/4, so it stays a separate chunk)
    await run(tools!.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=130", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=130", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", mp4]);

    const up = await importMediaStream(ctx, fs.createReadStream(mp4), { fileName: "Long Talk_2026.mp4", publishedAt: "2026-01-15" });
    assert.equal(up.duplicate, false);
    assert.equal(up.video.title, "Long Talk 2026");
    assert.equal(up.video.status, "importing");
    assert.ok(fs.existsSync(path.join(ctx.paths.media, `${up.video.sourceRef}.mp4`)), "stored under its content hash");
    assert.ok(up.jobId);

    // duplicate upload is recognised
    const dup = await importMediaStream(ctx, fs.createReadStream(mp4), { fileName: "copy.mp4" });
    assert.equal(dup.duplicate, true);
    assert.equal(dup.video.id, up.video.id);

    // video-only file is rejected at upload
    const videoOnly = path.join(dir, "video-only.mp4");
    await run(tools!.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", videoOnly]);
    await assert.rejects(importMediaStream(ctx, fs.createReadStream(videoOnly), { fileName: "video-only.mp4" }), (e: Error) => e instanceof UploadError && /no audio track/.test(e.message));

    // wait for audio.extract → transcript.generate. The engine crashes on chunk 1 the first time;
    // the queue's bounded retry (maxAttempts 2) re-runs the job, which resumes at chunk 1 (IN-04).
    const t0 = Date.now();
    let v = ctx.videos.get(up.video.id)!;
    let tj = ctx.jobs.list().find((j) => j.kind === "transcript.generate");
    while (Date.now() - t0 < 90_000) {
      v = ctx.videos.get(up.video.id)!;
      tj = ctx.jobs.list().find((j) => j.kind === "transcript.generate");
      if (tj && (tj.status === "failed" || tj.status === "completed")) break;
      await sleep(200);
    }
    assert.ok(tj, "transcript.generate was enqueued by audio.extract");
    assert.equal(tj.status, "completed", `job error: ${tj.error}`);
    assert.equal(tj.attempts, 2, "first attempt crashed on chunk 1, second attempt resumed");
    assert.equal(v.status, "ready");
    assert.equal(v.chunksTotal, 3, `chunks: ${JSON.stringify(ctx.videos.chunkStates(v.id))}`);
    assert.equal(v.chunksDone, 3);
    assert.equal(v.segmentCount, 6);
    assert.deepEqual(calls, ["c0.wav", "c1.wav", "c1.wav", "c2.wav"], "chunk 0 was committed before the crash and never re-transcribed");

    // an explicit re-run (e.g. the Re-transcribe button without restart) is a no-op: every chunk is already done
    const rerunId = ctx.jobs.enqueue({ kind: "transcript.generate", payload: { videoId: v.id }, maxAttempts: 1 });
    const t1 = Date.now();
    while (Date.now() - t1 < 30_000 && !["completed", "failed"].includes(ctx.jobs.get(rerunId)!.status)) await sleep(200);
    assert.equal(ctx.jobs.get(rerunId)!.status, "completed", ctx.jobs.get(rerunId)!.error);
    v = ctx.videos.get(v.id)!;
    assert.equal(v.status, "ready");
    assert.equal(v.segmentCount, 6, "re-running never duplicates segments");
    assert.equal(calls.length, 4, "no chunk was transcribed again");
    const segs = v.segments;
    for (let i = 1; i < segs.length; i++) assert.ok(segs[i].startS >= segs[i - 1].endS - 0.001, "timestamps are monotonic across the chunk boundary");
    assert.ok(segs[2].startS >= 55 && segs[2].startS < 61, `chunk 1 offset applied: ${segs[2].startS}`);
    assert.ok(segs.at(-1)!.endS > 125, `last segment reaches the end of the recording: ${segs.at(-1)!.endS}`);
    assert.equal(v.transcriptionEngine, "local-whisper");

    // silent media → audio.extract fails with a clear message
    const silentMp4 = path.join(dir, "silent.mp4");
    await run(tools!.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=3", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", silentMp4]);
    const sil = await importMediaStream(ctx, fs.createReadStream(silentMp4), { fileName: "silent.mp4" });
    const t2 = Date.now();
    while (Date.now() - t2 < 30_000 && !["completed", "failed"].includes(ctx.jobs.get(sil.jobId!)!.status)) await sleep(200);
    assert.equal(ctx.jobs.get(sil.jobId!)!.status, "failed");
    assert.match(ctx.videos.get(sil.video.id)!.error ?? "", /silent/);
  } finally {
    await ctx.jobs.stop();
    ctx.db.close();
    delete process.env.PL_DATA_DIR;
  }
});
