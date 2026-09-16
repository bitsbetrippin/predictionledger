#!/usr/bin/env node
/**
 * Prediction Ledger — Polymarket probe (1.5). A plain `GET` with no account, no key, no wallet.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 *   npm run markets -- search "Bitcoin 100k"        free-text search (active markets)
 *   npm run markets -- tag nfl                       markets under a tag, by 24h volume
 *   npm run markets -- market xi-jinping-out-before-2027   one market by slug or numeric id
 *   npm run markets -- book <clobTokenId>            live order book + midpoint for one outcome
 *
 * Talks straight to the public Gamma / CLOB APIs (see docs/PREDICTION_MARKETS.md). Reads only.
 */

const GAMMA = process.env.POLYMARKET_GAMMA ?? "https://gamma-api.polymarket.com";
const CLOB = process.env.POLYMARKET_CLOB ?? "https://clob.polymarket.com";

const [cmd = "search", ...rest] = process.argv.slice(2);
const arg = rest.join(" ").trim();
const list = (v) => { try { const p = JSON.parse(v ?? "[]"); return Array.isArray(p) ? p : []; } catch { return []; } };
const money = (n) => (n === undefined || n === null || n === "" ? "—" : "$" + Math.round(Number(n)).toLocaleString("en-US"));
const pct = (p) => (p === undefined ? "—" : `${(Number(p) * 100).toFixed(1)}%`);

async function get(url) {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "prediction-ledger probe" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}\n${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function printMarket(m, ev) {
  const labels = list(m.outcomes), prices = list(m.outcomePrices), tokens = list(m.clobTokenIds);
  const e = ev ?? m.events?.[0];
  console.log(`\n${m.question}`);
  if (e) console.log(`  event: ${e.title}  (https://polymarket.com/event/${e.slug})`);
  console.log(`  id ${m.id} · slug ${m.slug} · ends ${m.endDate ?? "?"} · ${m.closed ? "CLOSED" : m.active ? "active" : "inactive"}${m.restricted ? " · restricted" : ""}`);
  console.log(`  liquidity ${money(m.liquidityNum ?? m.liquidity)} · volume ${money(m.volumeNum ?? m.volume)} · 24h ${money(m.volume24hr)} · spread ${m.spread ?? "—"}`);
  labels.forEach((l, i) => console.log(`    ${l.padEnd(28)} ${pct(prices[i]).padStart(6)}   token ${tokens[i] ?? "—"}`));
}

try {
  if (cmd === "search") {
    if (!arg) throw new Error('usage: search "<text>"');
    const d = await get(`${GAMMA}/public-search?q=${encodeURIComponent(arg)}&limit_per_type=5&events_status=active`);
    let n = 0;
    for (const ev of d.events ?? []) for (const m of ev.markets ?? []) if (!m.closed) { printMarket(m, ev); n++; }
    console.log(`\n${n} active market(s) for "${arg}"`);
  } else if (cmd === "tag") {
    const d = await get(`${GAMMA}/events?tag_slug=${encodeURIComponent(arg || "nfl")}&active=true&closed=false&limit=5&order=volume24hr&ascending=false`);
    for (const ev of d) { console.log(`\n== ${ev.title} (${ev.markets?.length ?? 0} markets)`); for (const m of (ev.markets ?? []).slice(0, 4)) printMarket(m, ev); }
  } else if (cmd === "market") {
    const m = /^\d+$/.test(arg) ? await get(`${GAMMA}/markets/${arg}`) : (await get(`${GAMMA}/markets?slug=${encodeURIComponent(arg)}`))[0];
    if (!m) throw new Error(`no market "${arg}"`);
    printMarket(m);
    console.log(`\n  rules: ${(m.description ?? "").slice(0, 600)}`);
  } else if (cmd === "book") {
    const [book, mid] = await Promise.all([get(`${CLOB}/book?token_id=${arg}`), get(`${CLOB}/midpoint?token_id=${arg}`)]);
    const top = (side, n = 5) => side.slice(0, n).map((l) => `${pct(l.price)} × ${Number(l.size).toFixed(0)}`).join(" | ");
    console.log(`midpoint ${pct(mid.mid)}`);
    console.log(`bids  ${top([...book.bids].sort((a, b) => b.price - a.price))}`);
    console.log(`asks  ${top([...book.asks].sort((a, b) => a.price - b.price))}`);
    const depth = (side) => side.reduce((s, l) => s + Number(l.size) * Number(l.price), 0);
    console.log(`depth: bids ${money(depth(book.bids))} · asks ${money(depth(book.asks))} (notional at quoted prices)`);
  } else throw new Error(`unknown command "${cmd}" — search | tag | market | book`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
