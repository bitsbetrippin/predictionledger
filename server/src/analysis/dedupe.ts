/**
 * Prediction Ledger — cross-window deduplication of extracted predictions.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Because extraction windows overlap, the same statement is often returned twice (once per
 * window). Two candidates are merged when their located time spans overlap, or when their
 * normalized statements are near-identical. Merging keeps ONE prediction row and records
 * every occurrence (PX-06) — nothing is thrown away. Repeats of the same claim at different
 * points in the video are also merged into one prediction with multiple occurrences; the
 * user can split them apart if they are meaningfully different.
 */

export interface DedupeCandidate<T> {
  item: T;
  windowId: string;
  normalizedStatement: string;
  quote: string;
  startS?: number;
  endS?: number;
  confidence?: number;
}

export interface DedupeGroup<C> {
  primary: C;
  occurrences: { windowId: string; startS?: number; endS?: number }[];
  merged: C[];
}

/** Generic over the candidate type so callers keep any extra fields on `primary`. */
export function dedupe<C extends DedupeCandidate<unknown>>(candidates: C[], opts: { similarity?: number } = {}): DedupeGroup<C>[] {
  const threshold = opts.similarity ?? 0.8;
  const groups: DedupeGroup<C>[] = [];

  for (const c of candidates) {
    const g = groups.find((grp) => isSame(grp.primary, c, threshold) || grp.merged.some((m) => isSame(m, c, threshold)));
    if (!g) {
      groups.push({ primary: c, occurrences: [{ windowId: c.windowId, startS: c.startS, endS: c.endS }], merged: [] });
      continue;
    }
    g.merged.push(c);
    // Keep the higher-confidence, longer-quoted candidate as primary.
    if (score(c) > score(g.primary)) {
      g.merged.push(g.primary);
      g.merged = g.merged.filter((m) => m !== c);
      g.primary = c;
    }
    const dup = g.occurrences.some((o) => spansOverlap(o, c));
    if (!dup) g.occurrences.push({ windowId: c.windowId, startS: c.startS, endS: c.endS });
  }
  return groups;
}

function score(c: DedupeCandidate<unknown>): number {
  return (c.confidence ?? 0.5) + Math.min(c.quote.length, 400) / 4000;
}

function isSame(a: DedupeCandidate<unknown>, b: DedupeCandidate<unknown>, threshold: number): boolean {
  // Same place in the video and clearly the same words — including a quote cut short at a window edge
  // whose tokens are all contained in the fuller quote from the next window (Release 0.6, fixture B1).
  if (spansOverlap(a, b) && (jaccard(a.quote, b.quote) >= 0.5 || containment(a.quote, b.quote) >= 0.9)) return true;
  return jaccard(a.normalizedStatement, b.normalizedStatement) >= threshold || jaccard(a.quote, b.quote) >= 0.9;
}

/** Share of the shorter quote's tokens that also appear in the longer one. */
export function containment(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (small.size < 4) return 0;
  let inter = 0;
  for (const t of small) if (big.has(t)) inter++;
  return inter / small.size;
}

function spansOverlap(a: { startS?: number; endS?: number }, b: { startS?: number; endS?: number }): boolean {
  if (a.startS === undefined || a.endS === undefined || b.startS === undefined || b.endS === undefined) return false;
  return a.startS <= b.endS + 1 && b.startS <= a.endS + 1;
}

const STOP = new Set(["the", "a", "an", "of", "to", "in", "and", "or", "is", "are", "be", "will", "that", "this", "it", "for", "on", "by", "with", "as"]);

export function jaccard(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t && !STOP.has(t)),
  );
}
