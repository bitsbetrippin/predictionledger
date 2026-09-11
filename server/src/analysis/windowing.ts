/**
 * Prediction Ledger — transcript windowing for extraction.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Long transcripts are sent to the model in overlapping windows so that a prediction
 * spanning a boundary is seen whole in at least one window. Windows are built by time
 * (default 12 min, 2 min overlap) but never split a segment. Each window renders as
 * timestamped lines the model can quote from; the timestamp prefix is what lets us map a
 * quotation back to segments afterwards (see quoteLocator.ts).
 */

export interface WindowSegment {
  seq: number;
  startS: number;
  endS: number;
  text: string;
  speaker?: string;
}

export interface TranscriptWindow {
  id: string; // "w1", "w2", …
  index: number;
  startS: number;
  endS: number;
  segments: WindowSegment[];
  /** Rendered text: one line per segment "[h:mm:ss] Speaker: text". */
  rendered: string;
}

export interface WindowOptions {
  windowSeconds?: number; // default 720
  overlapSeconds?: number; // default 120
  /** Hard cap on characters per window as a safety net for dense transcripts. */
  maxChars?: number; // default 24000
}

export function buildWindows(segments: WindowSegment[], opts: WindowOptions = {}): TranscriptWindow[] {
  const windowSeconds = opts.windowSeconds ?? 720;
  const overlapSeconds = opts.overlapSeconds ?? 120;
  const maxChars = opts.maxChars ?? 24_000;
  if (segments.length === 0) return [];

  const sorted = [...segments].sort((a, b) => a.startS - b.startS || a.seq - b.seq);
  const windows: TranscriptWindow[] = [];
  let cursor = 0; // index into sorted

  while (cursor < sorted.length) {
    const windowStart = sorted[cursor].startS;
    const windowEnd = windowStart + windowSeconds;
    const chosen: WindowSegment[] = [];
    let chars = 0;
    let i = cursor;
    for (; i < sorted.length; i++) {
      const s = sorted[i];
      if (s.startS >= windowEnd && chosen.length > 0) break;
      const line = renderLine(s);
      if (chars + line.length > maxChars && chosen.length > 0) break;
      chosen.push(s);
      chars += line.length + 1;
    }
    const last = chosen[chosen.length - 1];
    windows.push({
      id: `w${windows.length + 1}`,
      index: windows.length,
      startS: chosen[0].startS,
      endS: last.endS,
      segments: chosen,
      rendered: chosen.map(renderLine).join("\n"),
    });
    if (i >= sorted.length) break;

    // Next window starts `overlapSeconds` before the end of this one, but always advances.
    const nextStartTime = last.endS - overlapSeconds;
    let next = i;
    while (next > cursor + 1 && sorted[next - 1].startS >= nextStartTime) next--;
    cursor = Math.max(next, cursor + 1);
  }
  return windows;
}

export function renderLine(s: WindowSegment): string {
  const stamp = formatStamp(s.startS);
  return s.speaker ? `[${stamp}] ${s.speaker}: ${s.text}` : `[${stamp}] ${s.text}`;
}

export function formatStamp(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
