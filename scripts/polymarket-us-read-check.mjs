#!/usr/bin/env node
/**
 * Prediction Ledger — opt-in, owner-run, READ-ONLY Polymarket US connection check (1.10).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 *   POLYMARKET_US_KEY_ID=… POLYMARKET_US_SECRET_KEY=… npm run trading:read-check
 *
 * Credentials come from environment variables only (never arguments, never files in the repo). The script
 * performs three authenticated GETs — balances, positions (first page), open orders — through the pinned
 * official SDK and prints a redacted summary. It has no code path that creates, modifies or cancels an
 * order. This is the "read-only integration test" the acceptance plan allows; it is not part of `npm test`.
 */

const keyId = process.env.POLYMARKET_US_KEY_ID?.trim();
const secretKey = process.env.POLYMARKET_US_SECRET_KEY?.trim();
const mask = (s) => (s && s.length > 4 ? `…${s.slice(-4)}` : "•••");

if (!keyId || !secretKey) {
  console.error("Set POLYMARKET_US_KEY_ID and POLYMARKET_US_SECRET_KEY in the environment (do not pass them as arguments).");
  process.exit(2);
}

let PolymarketUS;
try {
  ({ PolymarketUS } = await import("polymarket-us"));
} catch (err) {
  console.error(`The polymarket-us SDK is not installed: ${err.message}\nRun \`npm install\` in the project folder.`);
  process.exit(2);
}

const redact = (text) => String(text).split(secretKey).join("[redacted]").split(keyId).join(mask(keyId));
const client = new PolymarketUS({ keyId, secretKey, timeout: 20_000 });
const started = Date.now();
console.log(`Polymarket US read-only check · key ${mask(keyId)} · hosts api.polymarket.us / gateway.polymarket.us · ${new Date().toISOString()}`);

try {
  const balances = await client.get("/v1/account/balances", { authenticated: true });
  for (const b of balances.balances ?? []) {
    console.log(`  balance ${b.currency}: current ${b.currentBalance} · buying power ${b.buyingPower} · open orders ${b.openOrders ?? 0} · unsettled ${b.unsettledFunds ?? 0}`);
  }
  const positions = await client.get("/v1/portfolio/positions", { query: { limit: 100 }, authenticated: true });
  const rows = Object.entries(positions.positions ?? {});
  console.log(`  positions: ${rows.length}${positions.eof === false ? " (more pages)" : ""}`);
  for (const [slug, p] of rows.slice(0, 10)) console.log(`    ${slug}: net ${p.netPositionDecimal ?? p.netPosition} · cost ${p.cost?.value ?? "—"} ${p.cost?.currency ?? ""}`);
  const orders = await client.get("/v1/orders/open", { authenticated: true });
  console.log(`  open orders: ${(orders.orders ?? []).length}`);
  for (const o of (orders.orders ?? []).slice(0, 10)) console.log(`    ${o.id} ${o.marketSlug} ${o.intent} ${o.state} price ${o.price?.value} qty ${o.quantity} filled ${o.cumQuantity}`);
  console.log(`OK — 3 authenticated reads in ${Date.now() - started} ms; 0 order calls.`);
} catch (err) {
  const status = err?.status ?? "";
  console.error(`FAILED ${status} ${redact(err?.message ?? err)}`);
  if (status === 401) console.error("  401: the key ID/secret pair was rejected (wrong, revoked, or the clock is >30 s off).");
  if (status === 403) console.error("  403: the venue refuses this account (identity verification incomplete or restricted).");
  process.exit(1);
}
