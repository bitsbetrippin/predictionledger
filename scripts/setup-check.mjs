#!/usr/bin/env node
/**
 * Prediction Ledger — pre-install environment check (`npm run setup` runs this first).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Verifies the Node.js version and reports (without failing) whether optional external
 * tools for later releases are on PATH. npm alone does not supply ffmpeg or yt-dlp.
 */
import { execFileSync } from "node:child_process";

const MIN_NODE = [22, 13, 0];
const [major, minor, patch] = process.versions.node.split(".").map(Number);
const okNode =
  major > MIN_NODE[0] ||
  (major === MIN_NODE[0] && (minor > MIN_NODE[1] || (minor === MIN_NODE[1] && patch >= MIN_NODE[2])));

console.log(`Node.js ${process.versions.node} ${okNode ? "✓" : "✕ (need >= 22.13; Node 24 LTS recommended)"}`);
if (!okNode) {
  console.error("Install Node.js 24 LTS from https://nodejs.org and re-run `npm run setup`.");
  process.exit(1);
}
if (major < 24) {
  console.log("  note: Node 24 LTS is recommended; node:sqlite is newer on 22.x but works from 22.13.");
}

for (const tool of [
  { cmd: "ffmpeg", args: ["-version"], why: "importing local video/audio files and YouTube audio. Install it if you want those (docs/SETUP.md §1)." },
  { cmd: "ffprobe", args: ["-version"], why: "the same (ships with ffmpeg)." },
  { cmd: "yt-dlp", args: ["--version"], why: "YouTube links. Not needed on PATH — Setup → YouTube → Install yt-dlp fetches it into the data directory." },
]) {
  try {
    const out = execFileSync(tool.cmd, tool.args, { stdio: ["ignore", "pipe", "ignore"] }).toString().split("\n")[0];
    console.log(`${tool.cmd}: found (${out.trim().slice(0, 60)})`);
  } catch {
    console.log(`${tool.cmd}: not on PATH — used for ${tool.why}`);
  }
}
console.log("Optional: `npm install @huggingface/transformers -w server` enables on-device Whisper transcription (docs/SETUP.md §4.7).");
console.log("Environment check complete.\n");
