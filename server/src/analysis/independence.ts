/**
 * Prediction Ledger — source independence and "what the app knew when" (1.11, SRC-03/04).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Pure functions. Two sources are one voice when they share a publisher, share the exact stored text
 * (content hash), or are near-duplicates of each other (a syndicated wire story with a different
 * headline and a local intro). Near-duplication is estimated with a bottom-k sketch of hashed 5-word
 * shingles — cheap, deterministic, and good enough to catch copy-paste with light editing; it is not a
 * plagiarism detector. Groups are labelled after the earliest member so the label is stable.
 *
 * `knownBy` answers the replay question honestly: the app knew a source at T only if it had fetched it
 * by T. Using a publication date instead is an assumption and is labelled as one.
 */

import crypto from "node:crypto";

export const SKETCH_SIZE = 64;
export const NEAR_DUPLICATE_THRESHOLD = 0.5;

function normalizeText(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 0);
}

/** Bottom-k sketch of 5-word shingles (sorted ascending hex-hash prefixes). Empty for texts under 5 words. */
export function contentSketch(text: string, k = SKETCH_SIZE): string[] {
  const words = normalizeText(text);
  if (words.length < 5) return [];
  const hashes = new Set<string>();
  for (let i = 0; i + 5 <= words.length; i++) {
    hashes.add(crypto.createHash("sha1").update(words.slice(i, i + 5).join(" ")).digest("hex").slice(0, 12));
  }
  return [...hashes].sort().slice(0, k);
}

/** Jaccard estimate from two bottom-k sketches. */
export function sketchSimilarity(a: string[], b: string[], k = SKETCH_SIZE): number {
  if (a.length === 0 || b.length === 0) return 0;
  const union = [...new Set([...a, ...b])].sort().slice(0, k);
  const setA = new Set(a), setB = new Set(b);
  let both = 0;
  for (const h of union) if (setA.has(h) && setB.has(h)) both++;
  return union.length ? both / union.length : 0;
}

/** Publisher key: hostname without www./m./amp. prefixes. Two outlets on one domain are one voice. */
export function publisherKey(url: string, publisher?: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^(www|m|amp|mobile)\./, "");
    return host || (publisher ?? "").toLowerCase();
  } catch {
    return (publisher ?? url).toLowerCase();
  }
}

export interface IndependenceInput {
  id: string;
  url: string;
  publisher?: string;
  contentHash?: string;
  sketch?: string[];
  /** Used to pick the group label (earliest member). */
  orderKey?: string;
}

/** Union-find over publisher, exact hash and near-duplicate text. Returns id → group label and the reasons per id. */
export function independenceGroups(sources: IndependenceInput[], threshold = NEAR_DUPLICATE_THRESHOLD): { groups: Map<string, string>; reasons: Map<string, string[]> } {
  const parent = new Map<string, string>();
  const reasons = new Map<string, string[]>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
    return r;
  };
  const union = (a: string, b: string, why: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
    reasons.set(a, [...(reasons.get(a) ?? []), why]);
    reasons.set(b, [...(reasons.get(b) ?? []), why]);
  };
  for (const s of sources) { parent.set(s.id, s.id); reasons.set(s.id, []); }
  const byPublisher = new Map<string, string>();
  const byHash = new Map<string, string>();
  for (const s of sources) {
    const pk = publisherKey(s.url, s.publisher);
    if (pk) {
      const prev = byPublisher.get(pk);
      if (prev) union(s.id, prev, `same publisher (${pk})`);
      else byPublisher.set(pk, s.id);
    }
    if (s.contentHash) {
      const prev = byHash.get(s.contentHash);
      if (prev) union(s.id, prev, "identical text");
      else byHash.set(s.contentHash, s.id);
    }
  }
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const a = sources[i], b = sources[j];
      if (!a.sketch?.length || !b.sketch?.length || find(a.id) === find(b.id)) continue;
      const sim = sketchSimilarity(a.sketch, b.sketch);
      if (sim >= threshold) union(a.id, b.id, `near-duplicate text (${Math.round(sim * 100)}% shared)`);
    }
  }
  // Label each cluster after its earliest member (orderKey, then id) so labels are stable across runs.
  const members = new Map<string, IndependenceInput[]>();
  for (const s of sources) {
    const r = find(s.id);
    members.set(r, [...(members.get(r) ?? []), s]);
  }
  const groups = new Map<string, string>();
  for (const list of members.values()) {
    const first = [...list].sort((x, y) => (x.orderKey ?? "").localeCompare(y.orderKey ?? "") || x.id.localeCompare(y.id))[0];
    const label = `grp-${first.id.slice(0, 8)}`;
    for (const s of list) groups.set(s.id, label);
  }
  return { groups, reasons };
}

export interface KnownByInput {
  firstSeenAt?: string;
  retrievedAt?: string;
  publishedAt?: string;
}

/**
 * Was this material available to the app at `asOf`? Fetch time is fact; a publication date is only an
 * assumption that it *could* have been fetched — allowed only when the caller opts in, and labelled.
 */
export function knownBy(item: KnownByInput, asOf: string, opts: { assumePublished?: boolean } = {}): { known: boolean; basis: "first_seen" | "published_assumption" | "unknown" } {
  const t = Date.parse(asOf);
  if (!Number.isFinite(t)) return { known: false, basis: "unknown" };
  const seen = item.firstSeenAt ?? item.retrievedAt;
  if (seen) {
    const s = Date.parse(seen);
    if (Number.isFinite(s) && s <= t) return { known: true, basis: "first_seen" };
  }
  if (opts.assumePublished && item.publishedAt) {
    const p = Date.parse(item.publishedAt.length === 10 ? `${item.publishedAt}T23:59:59Z` : item.publishedAt);
    if (Number.isFinite(p) && p <= t) return { known: true, basis: "published_assumption" };
  }
  return { known: false, basis: seen ? "first_seen" : "unknown" };
}

export const sha256 = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");
