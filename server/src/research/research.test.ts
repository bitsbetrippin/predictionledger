/**
 * Prediction Ledger — tests for the pure research modules (URL safety, HTML extraction, fetcher guard, verdict guard).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalizeUrl, checkUrlSyntax, isPublicAddress, publisherFromHost } from "./urlSafety.js";
import { extractHtml, verifyExcerpt, toIsoDate } from "./htmlExtract.js";
import { GuardedFetcher } from "./fetcher.js";
import { applyVerdictGuard, suggestRecheck } from "./verdictGuard.js";

test("urlSafety: private, loopback, link-local, CGNAT, metadata and IPv6-local addresses are rejected", () => {
  for (const bad of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fd12::1", "::ffff:10.0.0.1", "2001:db8::1"]) {
    assert.equal(isPublicAddress(bad), false, bad);
  }
  for (const good of ["8.8.8.8", "93.184.216.34", "2606:4700::1111", "172.32.0.1", "100.128.0.1"]) assert.equal(isPublicAddress(good), true, good);
});

test("urlSafety: syntax checks reject non-http schemes, credentials, bare and local hostnames", () => {
  assert.equal(checkUrlSyntax("ftp://example.com/x").ok, false);
  assert.equal(checkUrlSyntax("file:///etc/passwd").ok, false);
  assert.equal(checkUrlSyntax("http://user:pw@example.com/").ok, false);
  assert.equal(checkUrlSyntax("http://localhost:7317/api/settings").ok, false);
  assert.equal(checkUrlSyntax("http://lmstudio/").ok, false);
  assert.equal(checkUrlSyntax("http://printer.local/").ok, false);
  assert.equal(checkUrlSyntax("http://127.0.0.1:1234/v1/models").ok, false);
  assert.equal(checkUrlSyntax("http://[::1]/").ok, false);
  assert.equal(checkUrlSyntax("https://www.example.com/news/1").ok, true);
});

test("urlSafety: canonicalization strips tracking params, fragments, default ports, trailing slash, amp", () => {
  assert.equal(canonicalizeUrl("HTTPS://WWW.Example.com:443/News/a/?utm_source=x&b=2&a=1#top"), "https://www.example.com/News/a?a=1&b=2");
  assert.equal(canonicalizeUrl("https://example.com/story/amp"), "https://example.com/story");
  assert.equal(publisherFromHost("www.reuters.com"), "reuters.com");
});

test("htmlExtract: pulls title, canonical, published date, and article text; drops nav/script", () => {
  const html = `<html><head><title>County board cancels data center permit &amp; vote</title>
  <link rel="canonical" href="https://news.example.com/story?id=1">
  <meta property="article:published_time" content="2026-03-04T10:00:00Z">
  <meta property="og:site_name" content="Example News"></head>
  <body><nav><a>Home</a><a>Subscribe now</a></nav><script>var x=1;</script>
  <article><h1>Headline here</h1><p>The county board voted 5&ndash;2 on Tuesday to cancel the permit for the proposed 300 MW campus, citing water use.</p>
  <p>Residents had organised for months.</p><aside>Related: ad</aside></article>
  <footer>© 2026</footer></body></html>`;
  const page = extractHtml(html);
  assert.equal(page.title, "County board cancels data center permit & vote");
  assert.equal(page.canonicalUrl, "https://news.example.com/story?id=1");
  assert.equal(page.publishedAt, "2026-03-04");
  assert.equal(page.publisher, "Example News");
  assert.ok(page.text.includes("voted 5–2 on Tuesday"));
  assert.ok(!page.text.includes("var x=1") && !page.text.includes("Subscribe now") && !page.text.includes("Related: ad"));
  assert.equal(toIsoDate("March 4, 2026"), "2026-03-04");
  assert.equal(toIsoDate("garbage"), undefined);
});

test("htmlExtract: verifyExcerpt accepts near-verbatim excerpts and rejects invented ones", () => {
  const text = "The county board voted 5–2 on Tuesday to cancel the permit for the proposed 300 MW campus, citing water use.\n\nResidents had organised for months.";
  const ok = verifyExcerpt('the county board voted 5-2 on tuesday to cancel the permit for the proposed 300 mw campus', text);
  assert.ok(ok && ok.startsWith("The county board voted 5–2"), ok);
  assert.equal(verifyExcerpt("The governor signed a law restricting approvals to federal land.", text), undefined);
  assert.equal(verifyExcerpt("too short", text), undefined);
});

test("fetcher: blocks non-public resolutions, re-checks redirects, caps size, handles content types (no network)", async () => {
  const resolver = async (host: string) => (host === "public.example.com" || host === "cdn.example.com" ? ["93.184.216.34"] : host === "evil.example.com" ? ["10.0.0.5"] : []);
  const responses: Record<string, () => Response> = {
    "https://public.example.com/a": () => new Response("<html><head><title>A</title></head><body><article><p>Hello world, this is a sufficiently long paragraph for extraction.</p></article></body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
    "https://public.example.com/redirect-to-private": () => new Response(null, { status: 302, headers: { location: "http://evil.example.com/secret" } }),
    "https://public.example.com/redirect-ok": () => new Response(null, { status: 301, headers: { location: "/a" } }),
    "https://public.example.com/big": () => new Response("x".repeat(6 * 1024 * 1024), { status: 200, headers: { "content-type": "text/html" } }),
    "https://public.example.com/pdf": () => new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } }),
    "https://public.example.com/404": () => new Response("nope", { status: 404, headers: { "content-type": "text/html" } }),
  };
  const http = async (url: string) => (responses[url] ?? (() => new Response("missing", { status: 500 })))();
  const f = new GuardedFetcher(resolver, http);

  const a = await f.fetch("https://public.example.com/a");
  assert.equal(a.status, "ok");
  assert.equal(a.page?.title, "A");
  assert.ok(a.rawText?.includes("Hello world"));

  const evil = await f.fetch("https://public.example.com/redirect-to-private");
  assert.equal(evil.status, "blocked");
  assert.match(evil.note ?? "", /non-public/);

  const direct = await f.fetch("http://192.168.0.10/admin");
  assert.equal(direct.status, "blocked");

  const ok = await f.fetch("https://public.example.com/redirect-ok");
  assert.equal(ok.status, "ok");
  assert.equal(ok.finalUrl, "https://public.example.com/a");

  assert.equal((await f.fetch("https://public.example.com/big")).status, "too_large");
  assert.equal((await f.fetch("https://public.example.com/pdf")).status, "unsupported");
  assert.equal((await f.fetch("https://public.example.com/404")).status, "error");
  assert.equal((await f.fetch("https://unknown.example.com/")).status, "blocked");
});

test("verdictGuard: no evidence → insufficient by rule; unknown citations dropped; supported requires in-window support on every future claim", () => {
  const comps = [
    { id: "fc", kind: "future_claim" as const },
    { id: "pr", kind: "premise" as const },
    { id: "cl", kind: "causal_link" as const },
  ];
  const empty = applyVerdictGuard({ components: comps, evidence: [], timeStatus: "pending", model: { overall: "contradicted", confidence: "high", supportingIds: [], contradictingIds: [], citations: [], components: [] } });
  assert.equal(empty.overall, "insufficient");
  assert.equal(empty.confidence, "low");
  assert.match(empty.notes[0], /G6/);

  // Worked example: cancellations documented (premise supported), nothing on the future claim.
  const evidence = [
    { id: "e1", componentId: "pr", stance: "supports" as const, inWindow: true, actionStage: "completed", independent: true, sourceId: "s1" },
    { id: "e2", componentId: "pr", stance: "supports" as const, inWindow: true, actionStage: "completed", independent: true, sourceId: "s2" },
    { id: "e3", componentId: "fc", stance: "context" as const, inWindow: true, actionStage: "other", independent: true, sourceId: "s3" },
  ];
  const out = applyVerdictGuard({
    components: comps,
    evidence,
    timeStatus: "pending",
    model: {
      overall: "supported",
      confidence: "high",
      supportingIds: ["e1", "e2", "ghost"],
      contradictingIds: [],
      citations: [{ claim: "Permits were cancelled", evidenceIds: ["e1", "e2"] }, { claim: "Approvals moved to federal land", evidenceIds: ["made-up"] }],
      components: [
        { componentId: "fc", assessment: "supported", evidenceIds: ["e3"] },
        { componentId: "pr", assessment: "supported", evidenceIds: ["e1", "e2"] },
        { componentId: "cl", assessment: "insufficient", evidenceIds: [] },
      ],
    },
  });
  assert.equal(out.overall, "insufficient", "local cancellations alone do not establish the future claim");
  assert.equal(out.components.find((c) => c.componentId === "fc")?.assessment, "insufficient");
  assert.equal(out.components.find((c) => c.componentId === "pr")?.assessment, "supported");
  assert.deepEqual(out.supportingIds, ["e1", "e2"]);
  assert.equal(out.citations.length, 1, "citation with invented id dropped");
  assert.ok(out.notes.some((n) => n.startsWith("G1")) && out.notes.some((n) => n.startsWith("G2")));
});

test("verdictGuard: announced-only support is capped; contradicted needs contradicting evidence; single-source caps confidence", () => {
  const comps = [{ id: "fc", kind: "future_claim" as const }];
  const announced = applyVerdictGuard({
    components: comps,
    evidence: [{ id: "e1", componentId: "fc", stance: "supports", inWindow: true, actionStage: "announced", independent: true, sourceId: "s1" }],
    timeStatus: "reached",
    model: { overall: "supported", confidence: "high", supportingIds: ["e1"], contradictingIds: [], citations: [], components: [{ componentId: "fc", assessment: "supported", evidenceIds: ["e1"] }] },
  });
  assert.equal(announced.components[0].assessment, "partially_supported");
  assert.equal(announced.overall, "partially_supported");
  assert.ok(announced.notes.some((n) => n.startsWith("G4")));

  const noContra = applyVerdictGuard({
    components: comps,
    evidence: [{ id: "e1", componentId: "fc", stance: "context", inWindow: true, independent: true, sourceId: "s1" }],
    timeStatus: "reached",
    model: { overall: "contradicted", confidence: "medium", supportingIds: [], contradictingIds: [], citations: [], components: [{ componentId: "fc", assessment: "contradicted", evidenceIds: ["e1"] }] },
  });
  assert.equal(noContra.overall, "insufficient");

  const single = applyVerdictGuard({
    components: comps,
    evidence: [
      { id: "e1", componentId: "fc", stance: "supports", inWindow: true, actionStage: "completed", independent: true, sourceId: "s1" },
      { id: "e2", componentId: "fc", stance: "supports", inWindow: true, actionStage: "completed", independent: false, sourceId: "s1b" },
    ],
    timeStatus: "reached",
    model: { overall: "supported", confidence: "high", supportingIds: ["e1", "e2"], contradictingIds: [], citations: [], components: [{ componentId: "fc", assessment: "supported", evidenceIds: ["e1", "e2"] }] },
  });
  assert.equal(single.overall, "supported");
  assert.equal(single.confidence, "medium");

  // Later developments are excluded from in-window support.
  const late = applyVerdictGuard({
    components: comps,
    evidence: [{ id: "e1", componentId: "fc", stance: "supports", inWindow: false, actionStage: "completed", independent: true, sourceId: "s1" }],
    timeStatus: "reached",
    model: { overall: "supported", confidence: "high", supportingIds: ["e1"], contradictingIds: [], citations: [], components: [{ componentId: "fc", assessment: "supported", evidenceIds: ["e1"] }] },
  });
  assert.equal(late.overall, "insufficient");

  assert.equal(suggestRecheck("2026-09-11", "reached", "supported", "2026-01-01", 90), undefined);
  assert.equal(suggestRecheck("2026-09-11", "pending", "insufficient", "2026-10-01", 90), "2026-10-01");
  assert.equal(suggestRecheck("2026-09-11", "pending", "insufficient", "2027-11-03", 90), "2026-12-10");
});
