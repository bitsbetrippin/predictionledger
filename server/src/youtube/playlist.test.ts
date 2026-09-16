/**
 * Prediction Ledger — playlist / channel bulk import tests (1.8).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { parseFlatPlaylist, parseListUrl } from "./playlist.js";

test("parseListUrl: playlists, watch?list, channel forms; single videos rejected", () => {
  assert.deepEqual(parseListUrl("https://www.youtube.com/playlist?list=PL123abc"), { url: "https://www.youtube.com/playlist?list=PL123abc", kind: "playlist" });
  assert.deepEqual(parseListUrl("https://youtube.com/watch?v=abcdefghijk&list=PL9"), { url: "https://www.youtube.com/playlist?list=PL9", kind: "playlist" });
  assert.deepEqual(parseListUrl("https://www.youtube.com/@BitsBeTrippin"), { url: "https://www.youtube.com/@BitsBeTrippin/videos", kind: "channel" });
  assert.deepEqual(parseListUrl("https://www.youtube.com/@BitsBeTrippin/videos"), { url: "https://www.youtube.com/@BitsBeTrippin/videos", kind: "channel" });
  assert.deepEqual(parseListUrl("https://www.youtube.com/channel/UCabc_123/streams"), { url: "https://www.youtube.com/channel/UCabc_123/streams", kind: "channel" });
  assert.equal(parseListUrl("https://www.youtube.com/watch?v=abcdefghijk"), undefined);
  assert.equal(parseListUrl("https://example.com/playlist?list=x"), undefined);
  assert.equal(parseListUrl("not a url"), undefined);
});

test("parseFlatPlaylist: entries with valid ids, dates normalised, junk dropped", () => {
  const out = parseFlatPlaylist(JSON.stringify({ title: "Picks 2026", entries: [{ id: "abcdefghijk", title: "Week 1", upload_date: "20260909", duration: 600, channel: "BBT" }, { id: "short", title: "bad" }, null, { id: "lmnopqrstuv" }] }));
  assert.equal(out.title, "Picks 2026");
  assert.deepEqual(out.entries, [{ id: "abcdefghijk", title: "Week 1", uploadDate: "2026-09-09", durationS: 600, channel: "BBT" }, { id: "lmnopqrstuv", title: undefined, uploadDate: undefined, durationS: undefined, channel: undefined }]);
});

const skip = process.platform === "win32" ? "fake yt-dlp wrapper needs a POSIX shell" : false;
after(() => { delete process.env.PL_DATA_DIR; delete process.env.PL_YTDLP_PATH; });

test("playlist.import: lists via a fake yt-dlp, queues imports (with autoExtract), skips videos already in the ledger", { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pl-list-"));
  const fakeJs = path.join(dir, "fake.mjs");
  fs.writeFileSync(fakeJs, `
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2026.09.01"); process.exit(0); }
if (args.includes("--flat-playlist")) {
  console.log(JSON.stringify({ title: "Fake channel videos", entries: [
    { id: "aaaaaaaaaaa", title: "Ep 1", upload_date: "20260901" }, { id: "bbbbbbbbbbb", title: "Ep 2", upload_date: "20260908" }, { id: "ccccccccccc", title: "Ep 3" } ] }));
  process.exit(0);
}
process.stderr.write("fake: unsupported\\n"); process.exit(1);
`);
  const wrapper = path.join(dir, "yt-dlp");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  process.env.PL_YTDLP_PATH = wrapper;
  process.env.PL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pl-list-ctx-"));
  const { createContext } = await import("../context.js");
  const ctx = createContext();
  try {
    // Ep 2 is already in the ledger.
    ctx.videos.createFromYouTube({ youtubeId: "bbbbbbbbbbb", url: "https://www.youtube.com/watch?v=bbbbbbbbbbb", title: "Ep 2 (existing)" });
    // Run the handler directly (the job queue is not started, so the queued imports stay queued for inspection).
    const { makePlaylistImportHandler } = await import("./playlist.js");
    const handler = makePlaylistImportHandler(ctx);
    const result = await handler({ id: "job1", signal: new AbortController().signal, payload: { url: "https://www.youtube.com/@fake/videos", limit: 10, autoExtract: true }, progress: () => {} });
    assert.equal(result.found, 3);
    assert.equal(result.queued, 2);
    assert.equal(result.skipped, 1);
    assert.equal(result.listTitle, "Fake channel videos");
    const jobs = ctx.jobs.list(50).filter((j) => j.kind === "video.import");
    assert.equal(jobs.length, 2);
    const v = ctx.videos.list();
    assert.equal(v.length, 3);
    const ep1 = v.find((x) => x.title === "Ep 1")!;
    assert.equal(ep1.publishedAt, "2026-09-01");
    assert.equal(ctx.db.get<{ source_list: string }>("SELECT source_list FROM videos WHERE id = ?", ep1.id)?.source_list, "https://www.youtube.com/@fake/videos");
    const payload = ctx.db.get<{ payload_json: string }>("SELECT payload_json FROM jobs WHERE kind = 'video.import' AND subject_id = ?", ep1.id);
    assert.ok(payload && JSON.parse(payload.payload_json).autoExtract === true, "autoExtract rides on the import job");
  } finally {
    await ctx.jobs.stop();
    ctx.db.close();
  }
});
