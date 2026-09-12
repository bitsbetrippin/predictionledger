/**
 * Prediction Ledger — YouTube tests: URL parsing, caption cleaning, track choice, checksum verification,
 * error classification, and an end-to-end video.import run against a FAKE yt-dlp executable
 * (captions → ready; auto captions; no captions → audio → 0.4 transcription; private; offline; duplicate).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { locateTools, run } from "../media/ffmpeg.js";
import { readWavMono16k, type TranscriptionProvider } from "../media/transcription.js";
import { chooseCaptionTrack, classifyYtDlpError, parseInfoJson, parseYouTubeUrl, parseYouTubeVtt, verifySha256Sums, ytDlpAssetName } from "./ytdlp.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("parseYouTubeUrl: accepts the usual forms, rejects everything else", () => {
  const id = "dQw4w9WgXcQ";
  for (const u of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&t=42s&list=PL123`,
    `youtu.be/${id}`,
    `https://youtu.be/${id}?si=abc`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`,
    `https://www.youtube.com/embed/${id}`,
    id,
  ]) {
    assert.deepEqual(parseYouTubeUrl(u), { videoId: id, canonicalUrl: `https://www.youtube.com/watch?v=${id}` }, u);
  }
  for (const u of ["https://vimeo.com/12345", "https://www.youtube.com/watch?v=short", "https://evil.com/watch?v=" + id, "not a url", "", "https://www.youtube.com/@channel"]) {
    assert.equal(parseYouTubeUrl(u), undefined, u);
  }
});

test("parseYouTubeVtt: strips word-timing tags, removes rolling duplicates, keeps timestamps monotonic", () => {
  const vtt = `WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.500 align:start position:0%

within<00:00:00.500><c> two</c><00:00:00.900><c> years</c>

00:00:02.500 --> 00:00:02.510 align:start position:0%
within two years


00:00:02.510 --> 00:00:05.000 align:start position:0%
within two years
data<00:00:03.000><c> center</c><00:00:03.400><c> approvals</c>

00:00:05.000 --> 00:00:05.010 align:start position:0%
data center approvals


00:00:05.010 --> 00:00:08.000 align:start position:0%
data center approvals
will<00:00:05.500><c> be</c><00:00:06.000><c> narrowed</c>
`;
  const cues = parseYouTubeVtt(vtt);
  assert.deepEqual(cues.map((c) => c.text), ["within two years", "data center approvals", "will be narrowed"]);
  for (let i = 1; i < cues.length; i++) assert.ok(cues[i].startS >= cues[i - 1].endS - 1e-9, "monotonic");
  assert.equal(cues[0].startS, 0);
  assert.ok(cues[2].endS >= 7.9);

  // creator captions: plain multi-line cues, HTML entities, hh:mm:ss and mm:ss clocks
  const manual = `WEBVTT\n\n1\n00:01.000 --> 00:03.000\nHello &amp; welcome\nto the show\n\n2\n01:00:03.000 --> 01:00:04.000\n<v Host>Next item</v>\n`;
  assert.deepEqual(parseYouTubeVtt(manual), [
    { startS: 1, endS: 3, text: "Hello & welcome to the show" },
    { startS: 3603, endS: 3604, text: "Next item" },
  ]);
});

test("chooseCaptionTrack: policy and language preference", () => {
  const tracks = [
    { lang: "de", kind: "manual" as const },
    { lang: "en-US", kind: "manual" as const },
    { lang: "en", kind: "auto" as const },
    { lang: "fr", kind: "auto" as const },
  ];
  assert.deepEqual(chooseCaptionTrack(tracks, "manual-then-auto", ["en"]), { lang: "en-US", kind: "manual" }, "prefix match on manual wins over exact auto");
  assert.deepEqual(chooseCaptionTrack(tracks, "manual-then-auto", ["fr"]), { lang: "de", kind: "manual" }, "no preferred manual → any manual before auto");
  assert.deepEqual(chooseCaptionTrack([{ lang: "en", kind: "auto" }, { lang: "fr", kind: "auto" }], "manual-then-auto", ["fr"]), { lang: "fr", kind: "auto" });
  assert.equal(chooseCaptionTrack([{ lang: "es", kind: "auto" }], "manual-then-auto", ["en"]), undefined, "auto in another language is not used");
  assert.equal(chooseCaptionTrack([{ lang: "en", kind: "auto" }], "manual-only", ["en"]), undefined);
  assert.equal(chooseCaptionTrack(tracks, "never", ["en"]), undefined);
});

test("parseInfoJson: normalises fields, dates, caption lists; rejects junk", () => {
  const info = parseInfoJson(JSON.stringify({ id: "caps0000001", title: " Talk ", channel: "BBT", duration: 1800, upload_date: "20251103", language: "en", live_status: "not_live", subtitles: { en: [{ ext: "vtt", name: "English" }], "": [{}] }, automatic_captions: { "en-orig": [{ ext: "vtt" }], en: [] } }));
  assert.equal(info.title, "Talk");
  assert.equal(info.publishedAt, "2025-11-03");
  assert.equal(info.durationS, 1800);
  assert.equal(info.isLive, false);
  assert.deepEqual(info.captions, [{ lang: "en", kind: "manual", name: "English" }, { lang: "en-orig", kind: "auto", name: undefined }]);
  assert.throws(() => parseInfoJson("{}"), /no video id/);
  assert.throws(() => parseInfoJson("not json"), /unreadable/);
  assert.equal(parseInfoJson(JSON.stringify({ id: "live0000001", is_live: true })).isLive, true);
});

test("verifySha256Sums + asset names", () => {
  const data = Buffer.from("binary");
  const digest = "5ab77c3f3b7cf8fa8a7a2b3c9a0eaa2e7a5d4ea54a0b8b4d2b0d9e6fbb8dcd2b"; // some other file's digest
  const real = crypto.createHash("sha256").update(data).digest("hex");
  const sums = `${digest}  yt-dlp_x86.exe\n${real} *yt-dlp_linux\nabc  something-else\n`;
  assert.equal(verifySha256Sums(sums, "yt-dlp_linux", data).ok, true);
  assert.equal(verifySha256Sums(sums, "yt-dlp_x86.exe", data).ok, false);
  assert.equal(verifySha256Sums(sums, "yt-dlp_macos", data).ok, false, "asset not listed → not ok");
  assert.equal(ytDlpAssetName("win32", "x64"), "yt-dlp.exe");
  assert.equal(ytDlpAssetName("darwin", "arm64"), "yt-dlp_macos");
  assert.equal(ytDlpAssetName("linux", "x64"), "yt-dlp_linux");
  assert.equal(ytDlpAssetName("linux", "arm64"), "yt-dlp_linux_aarch64");
});
test("classifyYtDlpError: distinct classes, each naming the transcript-import fallback", () => {
  const cases: [string, string][] = [
    ["ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video", "private"],
    ["ERROR: [youtube] abc: Video unavailable", "unavailable"],
    ["ERROR: [youtube] abc: Sign in to confirm your age", "age_restricted"],
    ["ERROR: The uploader has not made this video available in your country", "geo_blocked"],
    ["ERROR: Sign in to confirm you’re not a bot.", "network"],
    ["ERROR: Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>", "network"],
    ["something entirely new", "failed"],
  ];
  for (const [msg, code] of cases) {
    const e = classifyYtDlpError(new Error(msg));
    assert.equal(e.code, code, msg);
    assert.match(e.message, /import a transcript/i);
  }
});

// ---------------------------------------------------------------------------
// End to end with a fake yt-dlp (POSIX shell wrapper around a Node script; skipped on Windows)
// ---------------------------------------------------------------------------

const tools = await locateTools().catch(() => undefined);
const skipE2E = process.platform === "win32" ? "fake yt-dlp wrapper needs a POSIX shell" : tools ? false : "ffmpeg not installed";

const FAKE = String.raw`
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, args.join(" ") + "\n");
const url = args[args.length - 1];
const id = /v=([A-Za-z0-9_-]{11})/.exec(url)?.[1];
const out = args.includes("-o") ? args[args.indexOf("-o") + 1] : null;
const outDir = out ? path.dirname(out) : null;
const fail = (msg) => { process.stderr.write(msg + "\n"); process.exit(1); };
if (args.includes("--version")) { console.log("2026.09.01"); process.exit(0); }
if (args.includes("--dump-single-json")) {
  if (id === "priv0000004") fail("ERROR: [youtube] priv0000004: Private video. Sign in if you've been granted access to this video");
  if (id === "gone0000005") fail("ERROR: [youtube] gone0000005: Video unavailable");
  const base = { id, title: "Fake talk " + id, channel: "Fake Channel", duration: 20, upload_date: "20251103", language: "en" };
  if (id === "caps0000001") base.subtitles = { en: [{ ext: "vtt" }], de: [{ ext: "vtt" }] };
  if (id === "auto0000002") base.automatic_captions = { en: [{ ext: "vtt" }] };
  console.log(JSON.stringify(base)); process.exit(0);
}
if (args.includes("--write-subs") || args.includes("--write-auto-subs")) {
  const lang = args[args.indexOf("--sub-langs") + 1];
  fs.mkdirSync(outDir, { recursive: true });
  const auto = args.includes("--write-auto-subs");
  const body = auto
    ? "WEBVTT\n\n00:00:00.000 --> 00:00:02.000 align:start position:0%\n \nwithin<00:00:00.500><c> two years</c>\n\n00:00:02.000 --> 00:00:02.010\nwithin two years\n \n\n00:00:02.010 --> 00:00:05.000\nwithin two years\napprovals<00:00:03.000><c> will narrow</c>\n"
    : "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nWithin two years, data center approvals\nwill be narrowed down to government lands.\n\n2\n00:00:04.000 --> 00:00:06.000\nBecause local markets keep cancelling the permits.\n";
  fs.writeFileSync(path.join(outDir, id + "." + lang + ".vtt"), body);
  process.exit(0);
}
if (args.includes("-f")) {
  fs.mkdirSync(outDir, { recursive: true });
  console.log("[download]  10.0% of 1.00MiB"); console.log("[download] 100.0% of 1.00MiB");
  fs.copyFileSync(process.env.FAKE_AUDIO_SRC, path.join(outDir, id + ".m4a"));
  process.exit(0);
}
fail("fake yt-dlp: unrecognised invocation");
`;

test("video.import end to end with a fake yt-dlp: captions, auto captions, audio fallback, private, offline, duplicate", { skip: skipE2E }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pl-yt-"));
  const fakeJs = path.join(dir, "fake-ytdlp.mjs");
  const wrapper = path.join(dir, "yt-dlp");
  fs.writeFileSync(fakeJs, FAKE);
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(log, "");
  const audioSrc = path.join(dir, "src.m4a");
  await run(tools!.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=20", "-c:a", "aac", audioSrc]);
  process.env.FAKE_LOG = log;
  process.env.FAKE_AUDIO_SRC = audioSrc;
  process.env.PL_YTDLP_PATH = wrapper;
  process.env.PL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pl-yt-ctx-"));
  const { createContext } = await import("../context.js");
  const { startYouTubeImport, precheckYouTubeImport, YouTubeImportError } = await import("./importer.js");

  const engineCalls: string[] = [];
  const engine: TranscriptionProvider = {
    id: "local-whisper",
    isLocal: true,
    async check() { return { ok: true, message: "fake" }; },
    async transcribeChunk(wavPath) {
      engineCalls.push(path.basename(wavPath));
      const dur = readWavMono16k(wavPath).length / 16000;
      return [{ startS: 0.2, endS: dur - 0.2, text: "transcribed from downloaded audio" }];
    },
  };
  const ctx = createContext({ transcription: () => engine });
  ctx.jobs.start();
  const calls = () => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  const waitVideo = async (id: string) => {
    const t0 = Date.now();
    for (;;) {
      const v = ctx.videos.get(id)!;
      if (v.status === "ready" || v.status === "failed") return v;
      if (Date.now() - t0 > 60_000) throw new Error(`timeout; status ${v.status}`);
      await sleep(150);
    }
  };
  try {
    // E1: creator captions → ready, no audio download
    const a = await startYouTubeImport(ctx, { url: "https://youtu.be/caps0000001?si=x" });
    assert.equal(a.duplicate, false);
    assert.equal(a.video.status, "importing");
    let v = await waitVideo(a.video.id);
    assert.equal(v.status, "ready", v.error);
    assert.equal(v.title, "Fake talk caps0000001");
    assert.equal(v.publishedAt, "2025-11-03");
    assert.equal(v.channel, "Fake Channel");
    assert.equal(v.durationS, 20);
    assert.equal(v.transcriptSource, "captions-manual");
    assert.equal(v.segments.length, 2);
    assert.equal(v.segments[0].textOriginal, "Within two years, data center approvals will be narrowed down to government lands.");
    assert.equal(v.segments[0].startS, 1);
    assert.ok(calls().some((c) => c.includes("--write-subs") && c.includes("--sub-langs en")), "manual English captions requested");
    assert.ok(!calls().some((c) => c.startsWith("-f ")), "no audio download for a captioned video");

    // duplicate URL → existing video, nothing queued
    const dup = await startYouTubeImport(ctx, { url: "https://www.youtube.com/watch?v=caps0000001&t=10" });
    assert.equal(dup.duplicate, true);
    assert.equal(dup.video.id, a.video.id);

    // user-supplied date wins over YouTube's upload date
    const b = await startYouTubeImport(ctx, { url: "auto0000002", publishedAt: "2024-01-01" });
    v = await waitVideo(b.video.id);
    assert.equal(v.status, "ready", v.error);
    assert.equal(v.transcriptSource, "captions-auto");
    assert.equal(v.publishedAt, "2024-01-01");
    assert.deepEqual(v.segments.map((s) => s.textOriginal), ["within two years", "approvals will narrow"]);
    assert.match(v.notes ?? "", /auto-generated/);

    // E2: no captions → audio download → audio.extract → transcript.generate
    const c = await startYouTubeImport(ctx, { url: "https://www.youtube.com/watch?v=noca0000003" });
    v = await waitVideo(c.video.id);
    assert.equal(v.status, "ready", v.error);
    assert.equal(v.transcriptSource, "transcribed");
    assert.ok(v.mediaSize! > 0);
    assert.equal(engineCalls.length, 1, "one 20 s chunk transcribed");
    assert.equal(v.segments.length, 1);
    assert.ok(calls().some((c2) => c2.startsWith("-f ")), "audio download invoked");
    const mediaFiles = fs.readdirSync(ctx.paths.media);
    assert.ok(mediaFiles.some((f) => /^[0-9a-f]{64}\.m4a$/.test(f)), `audio stored under its hash: ${mediaFiles}`);
    assert.ok(!fs.existsSync(path.join(ctx.paths.artifacts, "youtube", c.video.id)), "scratch removed");

    // E3: private → failed with the fallback named; no job left running
    const d = await startYouTubeImport(ctx, { url: "https://youtu.be/priv0000004" });
    v = await waitVideo(d.video.id);
    assert.equal(v.status, "failed");
    assert.match(v.error ?? "", /private/i);
    assert.match(v.error ?? "", /import a transcript/i);
    await sleep(300);
    assert.equal(ctx.jobs.list().filter((j) => j.status === "running" || j.status === "queued").length, 0);
    const e = await startYouTubeImport(ctx, { url: "https://youtu.be/gone0000005" });
    v = await waitVideo(e.video.id);
    assert.match(v.error ?? "", /unavailable/i);

    // audio download disabled + no captions → clear refusal, nothing downloaded
    const s = ctx.settings.getPersisted();
    s.youtube.allowAudioDownload = false;
    ctx.settings.savePersisted(s);
    const before = calls().length;
    const f = await startYouTubeImport(ctx, { url: "nocb0000006" });
    v = await waitVideo(f.video.id);
    assert.equal(v.status, "failed");
    assert.match(v.error ?? "", /audio download is turned off/);
    assert.equal(calls().slice(before).filter((c2) => c2.startsWith("-f ")).length, 0);
    s.youtube.allowAudioDownload = true;

    // E4: internet off → refused before anything is queued
    s.privacy.allowInternet = false;
    ctx.settings.savePersisted(s);
    const jobsBefore = ctx.jobs.list().length;
    await assert.rejects(precheckYouTubeImport(ctx, "https://youtu.be/caps0000001"), (err: Error) => err instanceof YouTubeImportError && err.code === "offline" && /Setup → Privacy/.test(err.message));
    assert.equal(ctx.jobs.list().length, jobsBefore);
    s.privacy.allowInternet = true;
    ctx.settings.savePersisted(s);

    // invalid URL → 400-class error
    await assert.rejects(precheckYouTubeImport(ctx, "https://vimeo.com/123"), (err: Error) => err instanceof YouTubeImportError && err.code === "invalid_url");

    // tool missing → 409-class error naming Setup (env override removed, tools dir empty, not on PATH in the sandbox)
    delete process.env.PL_YTDLP_PATH;
    const onPath = await run("yt-dlp", ["--version"]).then(() => true).catch(() => false);
    if (!onPath) await assert.rejects(precheckYouTubeImport(ctx, "https://youtu.be/caps0000001"), (err: Error) => err instanceof YouTubeImportError && err.code === "tool_missing");
  } finally {
    await ctx.jobs.stop();
    ctx.db.close();
    delete process.env.PL_DATA_DIR;
    delete process.env.PL_YTDLP_PATH;
  }
});
