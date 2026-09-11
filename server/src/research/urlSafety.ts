/**
 * Prediction Ledger — outbound URL safety (SSRF guard) and canonicalization.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Research URLs come from search engines and model-generated queries — untrusted. Before any
 * fetch (and again on every redirect) we require http/https, a public hostname, and resolved
 * addresses outside private/loopback/link-local/metadata ranges. Explicitly configured local
 * endpoints (LM Studio, SearXNG) never pass through this module; they use the provider
 * adapters' own allow-list (docs/ARCHITECTURE.md §7.4).
 *
 * Pure functions here take pre-resolved addresses so they can be unit-tested without DNS.
 */

export interface UrlCheck {
  ok: boolean;
  reason?: string;
  url?: URL;
}

/** Syntactic checks only (scheme, credentials, hostname shape). */
export function checkUrlSyntax(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: `unsupported scheme ${url.protocol}` };
  if (url.username || url.password) return { ok: false, reason: "URL contains credentials" };
  const host = url.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) {
    // Bare names and local suffixes are never research targets. (IP literals are checked below.)
    if (!isIpLiteral(host)) return { ok: false, reason: `hostname "${host}" is not a public host` };
  }
  if (isIpLiteral(host) && !isPublicAddress(host.replace(/^\[|\]$/g, ""))) return { ok: false, reason: `address ${host} is not public` };
  return { ok: true, url };
}

export function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.includes(":");
}

/** True when an IPv4/IPv6 address is globally routable (not private, loopback, link-local, multicast, metadata…). */
export function isPublicAddress(addr: string): boolean {
  const a = addr.replace(/^\[|\]$/g, "").toLowerCase();
  // IPv4-mapped IPv6 (::ffff:a.b.c.d)
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return isPublicAddress(mapped[1]);

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) {
    const [o1, o2] = a.split(".").map(Number);
    if ([o1, o2].some((n) => n > 255)) return false;
    if (o1 === 0) return false; // 0.0.0.0/8
    if (o1 === 10) return false; // 10/8
    if (o1 === 127) return false; // loopback
    if (o1 === 169 && o2 === 254) return false; // link-local + cloud metadata
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return false; // 172.16/12
    if (o1 === 192 && o2 === 168) return false; // 192.168/16
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return false; // CGNAT 100.64/10
    if (o1 === 192 && o2 === 0) return false; // 192.0.0/24, 192.0.2/24 test-net
    if (o1 === 198 && (o2 === 18 || o2 === 19)) return false; // benchmarking
    if (o1 >= 224) return false; // multicast + reserved + broadcast
    return true;
  }
  // IPv6
  if (a === "::" || a === "::1") return false;
  if (a.startsWith("fe8") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb")) return false; // link-local fe80::/10
  if (a.startsWith("fc") || a.startsWith("fd")) return false; // unique local fc00::/7
  if (a.startsWith("ff")) return false; // multicast
  if (a.startsWith("2001:db8")) return false; // documentation
  if (a.startsWith("64:ff9b")) return false; // NAT64 (could map to private)
  return true;
}

/** Strip tracking parameters and fragments; lower-case host; drop default ports; sort query. */
export function canonicalizeUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = "";
  const drop = /^(utm_.*|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|igshid|_ga|yclid|msclkid|si)$/i;
  const keep = [...url.searchParams.entries()].filter(([k]) => !drop.test(k)).sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [k, v] of keep) url.searchParams.append(k, v);
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
  // AMP variants → treat as same page
  url.pathname = url.pathname.replace(/\/amp$/, "");
  return url.toString();
}

/** Publisher label from hostname: "www.reuters.com" → "reuters.com". */
export function publisherFromHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^(www|m|amp|news)\./, "");
}
