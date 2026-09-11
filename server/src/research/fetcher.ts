/**
 * Prediction Ledger — SourceFetcher: guarded outbound page retrieval.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Guarantees (docs/ARCHITECTURE.md §7.4):
 *  - http/https only; credentials stripped; hostnames resolved and checked against private,
 *    loopback, link-local, CGNAT and metadata ranges BEFORE connecting, and again on every
 *    redirect (redirects are followed manually, max 5).
 *  - Response capped at 5 MB and 20 s; only text/html, text/plain, application/xhtml,
 *    application/json, application/pdf* are accepted (*PDF is recorded as 'unsupported' in
 *    0.3; text extraction for PDFs is a later item).
 *  - Fixed User-Agent identifying the app; no cookies; no auth headers ever.
 * The `Resolver` and `HttpClient` are injectable so tests run without a network.
 */

import dns from "node:dns/promises";
import { checkUrlSyntax, isIpLiteral, isPublicAddress } from "./urlSafety.js";
import { extractHtml, type ExtractedPage } from "./htmlExtract.js";

export const FETCH_USER_AGENT = "PredictionLedger/0.3 (+https://github.com/bitsbetrippin/prediction-ledger; local research tool)";
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

export type Resolver = (hostname: string) => Promise<string[]>;
export type HttpClient = (url: string, init: RequestInit) => Promise<Response>;

export interface FetchOutcome {
  status: "ok" | "blocked" | "error" | "too_large" | "timeout" | "unsupported";
  finalUrl: string;
  httpStatus?: number;
  contentType?: string;
  page?: ExtractedPage;
  rawText?: string;
  note?: string;
}

export interface SourceFetcher {
  fetch(url: string, signal?: AbortSignal): Promise<FetchOutcome>;
}

export const defaultResolver: Resolver = async (hostname) => {
  if (isIpLiteral(hostname)) return [hostname.replace(/^\[|\]$/g, "")];
  const records = await dns.lookup(hostname, { all: true });
  return records.map((r) => r.address);
};

export class GuardedFetcher implements SourceFetcher {
  constructor(
    private readonly resolve: Resolver = defaultResolver,
    private readonly http: HttpClient = (u, i) => fetch(u, i),
  ) {}

  async fetch(rawUrl: string, signal?: AbortSignal): Promise<FetchOutcome> {
    let current = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const syn = checkUrlSyntax(current);
      if (!syn.ok || !syn.url) return { status: "blocked", finalUrl: current, note: syn.reason };
      const url = syn.url;

      let addresses: string[];
      try {
        addresses = await this.resolve(url.hostname);
      } catch (err) {
        return { status: "error", finalUrl: current, note: `DNS lookup failed: ${(err as Error).message}` };
      }
      if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a))) {
        return { status: "blocked", finalUrl: current, note: `host ${url.hostname} resolves to a non-public address` };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      let res: Response;
      try {
        res = await this.http(url.toString(), {
          method: "GET",
          redirect: "manual",
          headers: { "user-agent": FETCH_USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1", "accept-language": "en" },
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const aborted = controller.signal.aborted;
        return { status: aborted ? "timeout" : "error", finalUrl: current, note: aborted ? `no response within ${TIMEOUT_MS / 1000}s` : (err as Error).message };
      }

      if (res.status >= 300 && res.status < 400) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const loc = res.headers.get("location");
        if (!loc) return { status: "error", finalUrl: current, httpStatus: res.status, note: "redirect without location" };
        current = new URL(loc, url).toString();
        continue; // re-checked at the top of the loop
      }

      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      if (!res.ok) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        return { status: "error", finalUrl: current, httpStatus: res.status, contentType, note: `HTTP ${res.status}` };
      }
      if (contentType.includes("pdf")) {
        clearTimeout(timer);
        return { status: "unsupported", finalUrl: current, httpStatus: res.status, contentType, note: "PDF sources are recorded but not text-extracted in this release" };
      }
      if (!/text\/html|application\/xhtml|text\/plain|application\/json/.test(contentType)) {
        clearTimeout(timer);
        return { status: "unsupported", finalUrl: current, httpStatus: res.status, contentType, note: `unsupported content type ${contentType || "(none)"}` };
      }

      try {
        const raw = await readCapped(res, MAX_BYTES);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (raw === null) return { status: "too_large", finalUrl: current, httpStatus: res.status, contentType, note: `exceeded ${MAX_BYTES / 1024 / 1024} MB` };
        const page = contentType.includes("html") || contentType.includes("xhtml") ? extractHtml(raw) : { text: raw.trim(), paragraphs: raw.split(/\n{2,}/).length };
        return { status: "ok", finalUrl: current, httpStatus: res.status, contentType, page, rawText: page.text };
      } catch (err) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        return { status: controller.signal.aborted ? "timeout" : "error", finalUrl: current, httpStatus: res.status, contentType, note: (err as Error).message };
      }
    }
    return { status: "error", finalUrl: current, note: `more than ${MAX_REDIRECTS} redirects` };
  }
}

async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > max) return null;
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(concat(chunks, total));
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}
