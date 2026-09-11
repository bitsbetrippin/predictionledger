/**
 * Prediction Ledger — transcript file parsers (SRT, WebVTT, plain text, JSON).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Pure functions: string in, ParsedSegment[] out. No I/O, no dependencies, so they are
 * unit-tested directly (see parsers.test.ts). Timestamps are seconds (float).
 *
 * Plain text rules: lines may start with an optional "[hh:mm:ss]" / "(mm:ss)" / "hh:mm:ss"
 * timestamp and an optional "Speaker:" prefix. Without timestamps, segments get
 * monotonically increasing synthetic times (1 s per segment) so ordering is preserved and
 * the UI can still show them; `hasRealTimestamps` tells the caller which case applies.
 */

export interface ParsedSegment {
  startS: number;
  endS: number;
  text: string;
  speaker?: string;
}

export interface ParseResult {
  format: "srt" | "vtt" | "txt" | "json";
  segments: ParsedSegment[];
  hasRealTimestamps: boolean;
  warnings: string[];
}

export type TranscriptFormat = "srt" | "vtt" | "txt" | "json" | "auto";

export function parseTranscript(content: string, format: TranscriptFormat = "auto", filename?: string): ParseResult {
  const text = content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const detected = format === "auto" ? detectFormat(text, filename) : format;
  switch (detected) {
    case "srt":
      return parseSrt(text);
    case "vtt":
      return parseVtt(text);
    case "json":
      return parseJson(text);
    default:
      return parseTxt(text);
  }
}

export function detectFormat(text: string, filename?: string): "srt" | "vtt" | "txt" | "json" {
  const ext = filename?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === "srt" || ext === "vtt" || ext === "json") return ext;
  const head = text.trimStart().slice(0, 200);
  if (head.startsWith("WEBVTT")) return "vtt";
  if (head.startsWith("{") || head.startsWith("[")) return "json";
  if (/^\d+\n\d{2}:\d{2}:\d{2},\d{3} --> /m.test(head)) return "srt";
  return "txt";
}

// ---- SRT ------------------------------------------------------------------

const SRT_TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

export function parseSrt(text: string): ParseResult {
  const segments: ParsedSegment[] = [];
  const warnings: string[] = [];
  const blocks = text.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    // Optional numeric index line.
    if (/^\d+$/.test(lines[0])) lines.shift();
    const timing = lines.shift();
    const m = timing ? /^(.+?)\s*-->\s*(.+?)(?:\s|$)/.exec(timing) : null;
    if (!m) {
      warnings.push(`Skipped block without timing: "${(timing ?? "").slice(0, 40)}"`);
      continue;
    }
    const startS = parseClock(m[1], SRT_TIME);
    const endS = parseClock(m[2], SRT_TIME);
    if (startS === null || endS === null) {
      warnings.push(`Skipped block with unparseable timing: "${timing}"`);
      continue;
    }
    const { speaker, body } = splitSpeaker(stripTags(lines.join(" ")));
    if (body) segments.push({ startS, endS, text: body, speaker });
  }
  return { format: "srt", segments: normalize(segments), hasRealTimestamps: true, warnings };
}

// ---- WebVTT ---------------------------------------------------------------

const VTT_TIME = /(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})/;

export function parseVtt(text: string): ParseResult {
  const segments: ParsedSegment[] = [];
  const warnings: string[] = [];
  const body = text.replace(/^WEBVTT[^\n]*\n/, "");
  const blocks = body.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    let timingIdx = lines.findIndex((l) => l.includes("-->"));
    if (timingIdx === -1) continue;
    const timing = lines[timingIdx];
    const m = /^(.+?)\s*-->\s*(\S+)/.exec(timing);
    if (!m) continue;
    const startS = parseVttClock(m[1]);
    const endS = parseVttClock(m[2]);
    if (startS === null || endS === null) {
      warnings.push(`Skipped cue with unparseable timing: "${timing}"`);
      continue;
    }
    const cueText = stripTags(lines.slice(timingIdx + 1).join(" "));
    // YouTube auto-captions often repeat the previous cue's text in the next cue; drop exact repeats.
    const { speaker, body: t } = splitSpeaker(cueText);
    if (!t) continue;
    if (segments.length && segments[segments.length - 1].text === t) {
      segments[segments.length - 1].endS = Math.max(segments[segments.length - 1].endS, endS);
      continue;
    }
    segments.push({ startS, endS, text: t, speaker });
  }
  return { format: "vtt", segments: normalize(segments), hasRealTimestamps: true, warnings };
}

function parseVttClock(s: string): number | null {
  const m = VTT_TIME.exec(s.trim());
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  return h * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

// ---- Plain text -------------------------------------------------------------

const TXT_STAMP = /^[\[(]?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,3}))?[\])]?\s*[-–—]?\s*/;

export function parseTxt(text: string): ParseResult {
  const segments: ParsedSegment[] = [];
  const warnings: string[] = [];
  let anyStamp = false;
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  lines.forEach((line, i) => {
    let startS: number | undefined;
    const m = TXT_STAMP.exec(line);
    let rest = line;
    if (m) {
      const parts = [m[1], m[2], m[3]].filter((p) => p !== undefined);
      const nums = parts.map(Number);
      startS = nums.length === 3 ? nums[0] * 3600 + nums[1] * 60 + nums[2] : nums[0] * 60 + nums[1];
      if (m[4]) startS += Number(m[4].padEnd(3, "0")) / 1000;
      anyStamp = true;
      rest = line.slice(m[0].length);
    }
    const { speaker, body } = splitSpeaker(rest);
    if (!body) return;
    segments.push({ startS: startS ?? i, endS: startS ?? i, text: body, speaker });
  });

  // Fill end times from the next segment's start (or +1 s at the end).
  for (let i = 0; i < segments.length; i++) {
    const next = segments[i + 1];
    segments[i].endS = next ? Math.max(segments[i].startS, next.startS) : segments[i].startS + 1;
  }
  if (!anyStamp && segments.length) warnings.push("No timestamps found in plain text; segments are ordered but times are synthetic.");
  return { format: "txt", segments: normalize(segments), hasRealTimestamps: anyStamp, warnings };
}

// ---- JSON -------------------------------------------------------------------
// Accepts either our own export shape {segments:[{startS,endS,text,speaker?}]} or the common
// Whisper-style {segments:[{start,end,text}]} / bare arrays of either.

export function parseJson(text: string): ParseResult {
  const warnings: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Transcript JSON is not valid JSON: ${(e as Error).message}`);
  }
  const arr = Array.isArray(data) ? data : (data as { segments?: unknown[] })?.segments;
  if (!Array.isArray(arr)) throw new Error('Transcript JSON must be an array or an object with a "segments" array.');
  const segments: ParsedSegment[] = [];
  arr.forEach((raw, i) => {
    const r = raw as Record<string, unknown>;
    const startS = num(r.startS ?? r.start);
    const endS = num(r.endS ?? r.end);
    const t = typeof r.text === "string" ? r.text.trim() : "";
    if (startS === null || endS === null || !t) {
      warnings.push(`Skipped segment ${i}: missing start/end/text.`);
      return;
    }
    segments.push({ startS, endS, text: t, speaker: typeof r.speaker === "string" ? r.speaker : undefined });
  });
  return { format: "json", segments: normalize(segments), hasRealTimestamps: true, warnings };
}

// ---- helpers ----------------------------------------------------------------

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function parseClock(s: string, re: RegExp): number | null {
  const m = re.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\{\\an\d\}/g, "").replace(/\s+/g, " ").trim();
}

/** "Alice: hello" → { speaker: "Alice", body: "hello" }. Conservative: short label, no digits-only. */
function splitSpeaker(s: string): { speaker?: string; body: string } {
  const m = /^([A-Z][\w .'-]{0,30}?):\s+(.+)$/.exec(s);
  if (m && !/^\d+$/.test(m[1]) && !/^(https?|note)$/i.test(m[1])) return { speaker: m[1].trim(), body: m[2].trim() };
  return { body: s.trim() };
}

/** Sort by start, clamp end >= start, round to ms. */
function normalize(segments: ParsedSegment[]): ParsedSegment[] {
  return segments
    .map((s) => ({ ...s, startS: round3(s.startS), endS: round3(Math.max(s.endS, s.startS)) }))
    .sort((a, b) => a.startS - b.startS);
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Format seconds as h:mm:ss for display and prompts. */
export function formatClock(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
