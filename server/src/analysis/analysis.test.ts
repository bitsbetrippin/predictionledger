/**
 * Prediction Ledger — tests for the pure analysis modules (parsers, windowing, quotes, dates, dedupe).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTranscript, detectFormat } from "../transcripts/parsers.js";
import { buildWindows } from "./windowing.js";
import { locateQuote } from "./quoteLocator.js";
import { resolveDeadline, timeStatus } from "./dates.js";
import { dedupe, jaccard } from "./dedupe.js";

const SRT = `1
00:00:01,000 --> 00:00:04,000
Welcome back everyone.

2
00:00:04,500 --> 00:00:09,250
Host: Within two years, data center approvals will be
narrowed down to government lands.

3
00:00:09,500 --> 00:00:12,000
<i>because local markets keep cancelling the permits.</i>
`;

const VTT = `WEBVTT

00:01.000 --> 00:04.000
Welcome back everyone.

00:04.000 --> 00:06.000
Welcome back everyone.

00:06.000 --> 00:09.000
Bitcoin might hit a new high next year.
`;

test("parsers: SRT with speaker prefix and tags", () => {
  const r = parseTranscript(SRT, "auto", "talk.srt");
  assert.equal(r.format, "srt");
  assert.equal(r.segments.length, 3);
  assert.equal(r.segments[1].speaker, "Host");
  assert.equal(r.segments[1].startS, 4.5);
  assert.equal(r.segments[1].endS, 9.25);
  assert.equal(r.segments[2].text, "because local markets keep cancelling the permits.");
  assert.equal(r.hasRealTimestamps, true);
});

test("parsers: VTT collapses YouTube-style repeated cues", () => {
  const r = parseTranscript(VTT, "auto");
  assert.equal(r.format, "vtt");
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[0].endS, 6);
  assert.equal(r.segments[1].text, "Bitcoin might hit a new high next year.");
});

test("parsers: plain text with and without timestamps", () => {
  const stamped = parseTranscript("[00:12] Hello there\n[01:05] Alice: Second line", "txt");
  assert.equal(stamped.hasRealTimestamps, true);
  assert.equal(stamped.segments[1].startS, 65);
  assert.equal(stamped.segments[1].speaker, "Alice");
  assert.equal(stamped.segments[0].endS, 65);

  const plain = parseTranscript("Line one.\n\nLine two.\n", "txt");
  assert.equal(plain.hasRealTimestamps, false);
  assert.equal(plain.segments.length, 2);
  assert.ok(plain.warnings[0].includes("synthetic"));
});

test("parsers: JSON in our shape and Whisper shape; detection", () => {
  const ours = parseTranscript(JSON.stringify({ segments: [{ startS: 1, endS: 2, text: "a" }] }), "auto");
  const whisper = parseTranscript(JSON.stringify([{ start: 0, end: 1.5, text: " b " }]), "json");
  assert.equal(ours.segments[0].text, "a");
  assert.equal(whisper.segments[0].endS, 1.5);
  assert.equal(detectFormat("WEBVTT\n"), "vtt");
  assert.equal(detectFormat("1\n00:00:01,000 --> 00:00:02,000\nx"), "srt");
  assert.equal(detectFormat("just words"), "txt");
  assert.throws(() => parseTranscript("{not json", "json"), /not valid JSON/);
});

test("windowing: overlapping windows never split a segment and always advance", () => {
  const segs = Array.from({ length: 200 }, (_, i) => ({ seq: i, startS: i * 10, endS: i * 10 + 9, text: `segment ${i} words words` }));
  const windows = buildWindows(segs, { windowSeconds: 300, overlapSeconds: 60 });
  assert.ok(windows.length > 1);
  for (let i = 1; i < windows.length; i++) {
    assert.ok(windows[i].startS > windows[i - 1].startS, "windows advance");
    assert.ok(windows[i].startS <= windows[i - 1].endS, "windows overlap");
    assert.ok(windows[i - 1].endS - windows[i].startS >= 50, "overlap is close to the requested 60s");
  }
  assert.equal(windows[windows.length - 1].segments.at(-1)?.seq, 199, "last segment is covered");
  assert.ok(windows[0].rendered.startsWith("[0:00:00] segment 0"));
  assert.deepEqual(buildWindows([]), []);
});

test("quoteLocator: finds a quotation spanning two segments with minor differences", () => {
  const r = parseTranscript(SRT, "srt");
  const segs = r.segments.map((s, i) => ({ seq: i, startS: s.startS, endS: s.endS, text: s.text, speaker: s.speaker }));
  const loc = locateQuote("within two years data center approvals will be narrowed down to government lands, because local markets keep canceling the permits", segs);
  assert.ok(loc);
  assert.equal(loc!.startS, 4.5);
  assert.equal(loc!.endS, 12);
  assert.ok(loc!.matchScore >= 0.9, `score ${loc!.matchScore}`);
  assert.equal(loc!.contextBefore, "Welcome back everyone.");
  assert.equal(locateQuote("completely unrelated sentence about cats", segs), undefined);
});

test("dates: relative expressions resolve from the statement date, never invented", () => {
  assert.deepEqual(resolveDeadline("within two years", "2025-11-03"), { deadlineDate: "2027-11-03", basis: "rule:relative" });
  assert.equal(resolveDeadline("in 18 months", "2025-01-31").deadlineDate, "2026-07-31");
  assert.equal(resolveDeadline("over the next couple of years", "2026-02-28").deadlineDate, "2028-02-28");
  assert.equal(resolveDeadline("by the end of the year", "2026-03-01").deadlineDate, "2026-12-31");
  assert.equal(resolveDeadline("next year", "2026-03-01").deadlineDate, "2027-03-01");
  assert.equal(resolveDeadline("by the end of next year", "2026-03-10").deadlineDate, "2027-12-31");
  assert.equal(resolveDeadline("by the end of next month", "2026-12-10").deadlineDate, "2027-01-31");
  const unknown = resolveDeadline("within two years", undefined);
  assert.equal(unknown.basis, "unresolved");
  assert.equal(unknown.deadlineDate, undefined);
});

test("dates: absolute expressions resolve without a base date; model fallback recorded", () => {
  assert.deepEqual(resolveDeadline("by 2027", undefined), { deadlineDate: "2027-12-31", basis: "rule:absolute" });
  assert.equal(resolveDeadline("by Q3 2026", undefined).deadlineDate, "2026-09-30");
  assert.equal(resolveDeadline("before March 2027", undefined).deadlineDate, "2027-03-31");
  assert.equal(resolveDeadline("mid-2027", undefined).deadlineDate, "2027-06-30");
  assert.equal(resolveDeadline("in the first half of 2028", undefined).deadlineDate, "2028-06-30");
  const model = resolveDeadline("someday soonish", "2026-01-01", "2026-09-01");
  assert.equal(model.basis, "model");
  assert.equal(resolveDeadline("someday soonish", "2026-01-01").basis, "unresolved");
  assert.equal(timeStatus("2027-11-03", "2026-09-11"), "pending");
  assert.equal(timeStatus("2026-01-01", "2026-09-11"), "reached");
  assert.equal(timeStatus(undefined), "unknown");
});

test("dedupe: same claim from two overlapping windows becomes one prediction with two occurrences", () => {
  const a = { item: 1, windowId: "w1", normalizedStatement: "Data center approvals will be restricted to government land within two years", quote: "within two years, data center approvals will be narrowed down to government lands", startS: 840, endS: 855, confidence: 0.8 };
  const b = { item: 2, windowId: "w2", normalizedStatement: "Within two years data center approvals will be narrowed to government-owned land", quote: "within two years, data center approvals will be narrowed down to government lands", startS: 840, endS: 855, confidence: 0.9 };
  const c = { item: 3, windowId: "w2", normalizedStatement: "Hashprice might recover next year", quote: "hashprice might recover next year", startS: 1200, endS: 1204, confidence: 0.7 };
  const d = { item: 4, windowId: "w3", normalizedStatement: "Data center approvals will be restricted to government land within two years", quote: "approvals are going to be narrowed to government land within two years", startS: 2400, endS: 2406, confidence: 0.6 };
  const groups = dedupe([a, b, c, d]);
  assert.equal(groups.length, 2);
  const g = groups.find((x) => x.primary.item === 2)!;
  assert.ok(g, "higher-confidence candidate becomes primary");
  assert.equal(g.occurrences.length, 2, "same span counted once; later repeat is a second occurrence");
  assert.equal(g.merged.length, 2);
  assert.ok(jaccard("a b c", "a b c") === 1);
});
