/**
 * Prediction Ledger — map a model-returned quotation back to transcript segments.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * The model is asked to quote verbatim, but small differences (punctuation, case, an
 * elided word) are common. We locate the quote by fuzzy token matching over the window's
 * segments and return the covering time range plus surrounding context. If the match is
 * too weak we still keep the prediction but flag it, so nothing is silently dropped.
 */

import type { WindowSegment } from "./windowing.js";

export interface QuoteLocation {
  startS: number;
  endS: number;
  contextBefore: string;
  contextAfter: string;
  /** 0..1 — fraction of quote tokens found in order within the matched span. */
  matchScore: number;
  /** Verbatim text from the transcript for the matched span (may differ slightly from the model's quote). */
  matchedText: string;
}

const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

export function locateQuote(quote: string, segments: WindowSegment[], contextSegments = 2): QuoteLocation | undefined {
  const qTokens = tokenize(quote);
  if (qTokens.length === 0 || segments.length === 0) return undefined;

  // Build a token stream with segment indices.
  const stream: { tok: string; seg: number }[] = [];
  segments.forEach((s, i) => tokenize(s.text).forEach((tok) => stream.push({ tok, seg: i })));
  if (stream.length === 0) return undefined;

  // Anchor on the first quote token (or the first rare-ish token) and greedily match in order.
  let best: { score: number; startIdx: number; endIdx: number } | undefined;
  for (let i = 0; i < stream.length; i++) {
    if (stream[i].tok !== qTokens[0]) continue;
    let qi = 1;
    let j = i + 1;
    let matched = 1;
    let lastMatch = i;
    const limit = Math.min(stream.length, i + qTokens.length * 2 + 8);
    while (qi < qTokens.length && j < limit) {
      if (stream[j].tok === qTokens[qi]) {
        matched++;
        lastMatch = j;
        qi++;
      } else if (j + 1 < limit && stream[j + 1].tok === qTokens[qi]) {
        // transcript has an extra token
        j++;
        continue;
      } else {
        // quote has an extra/different token — skip it
        qi++;
        continue;
      }
      j++;
    }
    const score = matched / qTokens.length;
    if (!best || score > best.score) best = { score, startIdx: i, endIdx: lastMatch };
    if (score === 1) break;
  }
  if (!best || best.score < 0.5) return undefined;

  const firstSeg = stream[best.startIdx].seg;
  const lastSeg = stream[best.endIdx].seg;
  const before = segments.slice(Math.max(0, firstSeg - contextSegments), firstSeg).map((s) => s.text).join(" ");
  const after = segments.slice(lastSeg + 1, lastSeg + 1 + contextSegments).map((s) => s.text).join(" ");
  return {
    startS: segments[firstSeg].startS,
    endS: segments[lastSeg].endS,
    contextBefore: before,
    contextAfter: after,
    matchScore: Math.round(best.score * 100) / 100,
    matchedText: segments.slice(firstSeg, lastSeg + 1).map((s) => s.text).join(" "),
  };
}
