/**
 * Prediction Ledger — dependency-free HTML → readable text extractor.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * A deliberately simple, regex-based extractor (no DOM): drops script/style/nav/footer/aside,
 * prefers <article>/<main> when present, turns block tags into paragraph breaks, decodes
 * entities, and reads title / canonical / published-date metadata. Good enough for
 * evidence gathering on news and government pages; Mozilla Readability remains the planned
 * upgrade once dependencies can be installed and verified (docs/ARCHITECTURE.md §8).
 */

export interface ExtractedPage {
  title?: string;
  canonicalUrl?: string;
  publishedAt?: string; // YYYY-MM-DD
  publisher?: string; // og:site_name when present
  text: string;
  paragraphs: number;
}

export function extractHtml(html: string): ExtractedPage {
  const head = html.slice(0, 200_000);
  const title = decode(firstMatch(head, /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ?? firstMatch(head, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? "").trim() || undefined;
  const canonicalUrl = firstMatch(head, /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) ?? firstMatch(head, /<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']+)["']/i) ?? undefined;
  const publisher = decode(firstMatch(head, /<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i) ?? "").trim() || undefined;
  const publishedAt = findPublishedDate(head);

  // Prefer the main content container when present.
  let body = html;
  const article = /<article[\s\S]*?<\/article>/i.exec(html)?.[0] ?? /<main[\s\S]*?<\/main>/i.exec(html)?.[0];
  if (article && article.length > 500) body = article;

  body = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe|template|nav|footer|aside|form|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|li|h[1-6]|blockquote|tr|pre|figcaption|dd|dt)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");

  const paragraphs = decode(body)
    .split(/\n{2,}/)
    .map((p) => p.replace(/[ \t\r\f\v]+/g, " ").replace(/\s*\n\s*/g, " ").trim())
    .filter((p) => p.length >= 40 || /[.!?]$/.test(p)) // drop menus/labels
    .filter((p) => !/^(cookie|accept all|subscribe|sign in|share this|advertisement)/i.test(p));

  return { title, canonicalUrl, publishedAt, publisher, text: paragraphs.join("\n\n"), paragraphs: paragraphs.length };
}

function findPublishedDate(head: string): string | undefined {
  const candidates = [
    /<meta[^>]+property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+name=["'](?:pubdate|publishdate|date|dc\.date|dcterms\.created|parsely-pub-date|sailthru\.date)["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+itemprop=["']datePublished["'][^>]*content=["']([^"']+)["']/i,
    /"datePublished"\s*:\s*"([^"]+)"/i,
    /<time[^>]+datetime=["']([^"']+)["']/i,
  ];
  for (const re of candidates) {
    const m = re.exec(head);
    if (m) {
      const iso = toIsoDate(m[1]);
      if (iso) return iso;
    }
  }
  return undefined;
}

export function toIsoDate(s: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString().slice(0, 10);
}

function firstMatch(s: string, re: RegExp): string | undefined {
  return re.exec(s)?.[1];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©" };

export function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/**
 * Verify that an excerpt the model claims to have found really occurs in the source text
 * (ADR-007). Whitespace/case/punctuation tolerant; returns the matching slice of the source
 * so the stored excerpt is always verbatim from the retrieved page.
 */
export function verifyExcerpt(excerpt: string, sourceText: string): string | undefined {
  const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const e = norm(excerpt);
  if (e.length < 15) return undefined;
  const words = e.split(" ");
  // Try progressively shorter prefixes of the excerpt (models often paraphrase the tail).
  for (let n = words.length; n >= Math.min(8, words.length); n--) {
    const needle = words.slice(0, n).join(" ");
    const idx = norm(sourceText).indexOf(needle);
    if (idx >= 0) {
      // Recover the verbatim span: walk the source aligning normalized characters.
      const span = recoverSpan(sourceText, needle);
      if (span) return span;
    }
  }
  return undefined;
}

function recoverSpan(source: string, normNeedle: string): string | undefined {
  // Build a map from normalized index → source index.
  const map: number[] = [];
  let out = "";
  let lastSpace = true;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i].toLowerCase();
    if (/[\p{L}\p{N}]/u.test(ch)) {
      out += ch;
      map.push(i);
      lastSpace = false;
    } else if (!lastSpace) {
      out += " ";
      map.push(i);
      lastSpace = true;
    }
  }
  const idx = out.indexOf(normNeedle);
  if (idx < 0) return undefined;
  const start = map[idx];
  const end = map[Math.min(idx + normNeedle.length - 1, map.length - 1)] + 1;
  return source.slice(start, end).trim();
}
