/**
 * Prediction Ledger — Polymarket US account connection tests (1.10): A01–A08, OPS-01/02 checks, fake adapter only.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * No test here can reach a venue: the adapter is the in-memory fake, and every secret is random bytes
 * generated for the run. A unique canary inside the secret proves nothing stores or echoes it.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { MarketSummary } from "../providers/markets/types.js";
import { fakeBalance, FakeTradingAdapter } from "../providers/trading/fake.js";
import { setTradingAdapterForTests } from "../providers/trading/registry.js";
import { credentialFingerprint } from "../providers/trading/credentials.js";
import { createBackup } from "./backup.js";
import { buildCsv, buildExportBundle } from "./export.js";
import { TradingConnectError, TradingGateError, TRADING_SECRET_NAMES } from "./tradingAccounts.js";

after(() => { delete process.env.PL_DATA_DIR; setTradingAdapterForTests(undefined); });

const KEY_A = "aaaaaaaa-1111-2222-3333-444444444444";
const KEY_B = "bbbbbbbb-1111-2222-3333-444444444444";
const seedA = crypto.randomBytes(32), seedB = crypto.randomBytes(32);
// A canary that can only come from the secret; base64 of random bytes never contains it by accident.
const SECRET_A = seedA.toString("base64");
const SECRET_B = seedB.toString("base64");
const CANARY = SECRET_A.slice(0, 12);

async function makeCtx() {
  process.env.PL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pl-trading-"));
  const fake = new FakeTradingAdapter();
  setTradingAdapterForTests(fake);
  const { createContext } = await import("../context.js");
  const ctx = createContext();
  return { ctx, fake, dataDir: process.env.PL_DATA_DIR };
}

const usMarket = (venueId: string): MarketSummary => ({
  provider: "polymarket_us", id: venueId, slug: `us-${venueId}`, url: "https://polymarket.us/event/x", question: "US question", outcomes: [{ label: "Yes", tokenId: `us-${venueId}:YES`, price: 0.5 }, { label: "No", tokenId: `us-${venueId}:NO`, price: 0.5 }],
  active: true, closed: false, retrievedAt: "2026-09-16T00:00:00Z", constraints: { venue: "polymarket_us", slug: `us-${venueId}`, tickSize: "0.01", minQuantity: "1", feeCoefficient: "0.06", status: "MARKET_STATUS_OPEN", sides: [{ id: "s1", label: "Yes", long: true }, { id: "s2", label: "No", long: false }], retrievedAt: "2026-09-16T00:00:00Z" },
});

test("A01 — the same venue id on three venues is three records; only the US one carries execution constraints", async () => {
  const { ctx } = await makeCtx();
  try {
    const intl = ctx.markets.upsertFromSummary({ provider: "polymarket", id: "123", slug: "intl-123", url: "https://polymarket.com/event/x", question: "Intl", outcomes: [{ label: "Yes", tokenId: "t1", price: 0.4 }, { label: "No", tokenId: "t2", price: 0.6 }], active: true, closed: false, retrievedAt: "2026-09-16T00:00:00Z" });
    const mf = ctx.markets.upsertFromSummary({ provider: "manifold", id: "123", slug: "mf-123", url: "https://manifold.markets/u/x", question: "Manifold", outcomes: [{ label: "Yes", tokenId: "123:YES", price: 0.4 }, { label: "No", tokenId: "123:NO", price: 0.6 }], active: true, closed: false, retrievedAt: "2026-09-16T00:00:00Z", tags: ["token:mana"] });
    const us = ctx.markets.upsertFromSummary(usMarket("123"));
    assert.equal(new Set([intl.id, mf.id, us.id]).size, 3);
    assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM markets WHERE venue_id = '123'")!.n, 3);
    assert.equal(intl.constraints, undefined);
    assert.equal(mf.constraints, undefined);
    assert.equal(us.constraints?.venue, "polymarket_us");
    assert.equal(us.constraints?.tickSize, "0.01");
    // Existing rows are untouched by the new column: refreshing the international market leaves constraints NULL.
    ctx.markets.upsertFromSummary({ provider: "polymarket", id: "123", slug: "intl-123", url: "https://polymarket.com/event/x", question: "Intl", outcomes: [{ label: "Yes", tokenId: "t1", price: 0.45 }, { label: "No", tokenId: "t2", price: 0.55 }], active: true, closed: false, retrievedAt: "2026-09-16T01:00:00Z" });
    assert.equal(ctx.markets.get(intl.id)?.constraints, undefined);
    assert.equal(ctx.markets.list().filter((m) => m.provider === "polymarket_us" && m.constraints).length, 1, "the US execution path can only start from a polymarket_us record");
  } finally { ctx.db.close(); }
});

test("A02/A05 — test + save: connection and buying power appear, zero order calls, live stays disarmed; A06 — the canary never leaks", async () => {
  const { ctx, fake } = await makeCtx();
  try {
    fake.script(KEY_A, { secretKey: SECRET_A, balances: [fakeBalance("95.25", "100.50")], positions: [{ marketSlug: "m1", netQuantity: "10", expired: false }], openOrders: [] });
    const before = ctx.trading.status();
    assert.equal(before.binding, undefined);
    assert.equal(before.policy.mode, "paper");
    assert.equal(before.armed, false);
    assert.equal(before.submissionAvailable, false);
    assert.deepEqual(before.features, { submission: false, automation: false });

    const t = await ctx.trading.testConnection({ keyId: KEY_A, secretKey: SECRET_A });
    assert.equal(t.ok, true, t.message);
    assert.equal(t.code, "ok");
    assert.equal(t.orderCalls, 0);
    assert.equal(t.credentialFingerprint, credentialFingerprint(seedA));
    assert.deepEqual(t.balances?.[0].buyingPower, { value: "95.25", currency: "USD" });
    assert.equal(ctx.trading.connected(), undefined, "a test does not save anything");

    const saved = await ctx.trading.connect({ keyId: KEY_A, secretKey: SECRET_A });
    const s = ctx.trading.status();
    assert.equal(s.binding?.state, "connected");
    assert.equal(s.binding?.continuity, "first");
    assert.equal(s.binding?.identityKind, "local_binding");
    assert.equal(s.binding?.externalIdentity, undefined, "no invented account id");
    assert.equal(s.binding?.credentialFingerprint, credentialFingerprint(seedA));
    assert.equal(s.binding?.keyIdHint, "…4444");
    assert.ok(s.binding?.secretHint && s.binding.secretHint.length <= 6 && !SECRET_A.startsWith(s.binding.secretHint));
    assert.deepEqual(s.latestSync?.balances[0].buyingPower, { value: "95.25", currency: "USD" });
    assert.equal(s.latestSync?.positions.length, 1);
    assert.equal(s.latestSync?.complete, true);
    assert.equal(s.stale, false);
    assert.equal(s.policy.mode, "paper");
    assert.equal(s.policy.liveAuthorizedAt, undefined);
    assert.equal(s.armed, false);
    assert.equal(saved.sync?.ok, true);
    assert.equal(fake.orderCalls, 0, "no create/cancel calls");
    assert.deepEqual(fake.calls.map((c) => c.method), ["balances", "balances", "balances", "positions", "openOrders"], "test; connect re-tests; then one read-only sync");
    assert.ok(s.gates.every((g) => g.id === "credentials_valid" || g.id === "account_fresh" || g.id === "reconciled" ? g.satisfied : !g.satisfied), JSON.stringify(s.gates));
    assert.match(s.identityNote, /does not expose a stable account identifier/);

    // A06: canary in every surface a browser, an export, a job or a model could see.
    const audit = ctx.trading.auditEvents();
    assert.ok(audit.some((e) => e.kind === "connection.tested") && audit.some((e) => e.kind === "connection.saved"));
    const surfaces: Record<string, string> = {
      status: JSON.stringify(s), settings: JSON.stringify(ctx.settings.getPublic()), audit: JSON.stringify(audit), export: JSON.stringify(buildExportBundle(ctx)), csv: buildCsv(ctx), jobs: JSON.stringify(ctx.jobs.list()),
      secretsTable: ctx.db.all<{ name: string; ciphertext: Uint8Array; hint: string }>("SELECT name, ciphertext, hint FROM secrets").map((r) => `${r.name}:${Buffer.from(r.ciphertext).toString("latin1")}:${r.hint}`).join("|"),
      accounts: JSON.stringify(ctx.db.all("SELECT * FROM trading_accounts")), syncs: JSON.stringify(ctx.db.all("SELECT * FROM trading_account_syncs")), policy: JSON.stringify(ctx.db.all("SELECT * FROM trading_policy")),
    };
    for (const [name, text] of Object.entries(surfaces)) {
      assert.ok(!text.includes(CANARY), `${name} leaks the secret`);
      assert.ok(!text.includes(SECRET_A), `${name} leaks the secret`);
    }
    assert.ok(surfaces.secretsTable.includes("trading.polymarket_us.secretKey"), "stored (encrypted)");
    // Export carries the secret-free binding and audit trail.
    const bundle = buildExportBundle(ctx);
    assert.equal(bundle.tradingBindings?.[0].id, s.binding?.id);
    assert.ok((bundle.tradingAudit?.length ?? 0) >= 2);
    // OPS-01: the ordinary secret store cannot read the trading namespace; only the vault can.
    assert.throws(() => ctx.secrets.get(TRADING_SECRET_NAMES.secretKey), /protected namespace/);
    assert.throws(() => ctx.secrets.has(TRADING_SECRET_NAMES.keyId), /protected namespace/);
    assert.throws(() => ctx.secrets.set("trading.anything", "x"), /protected namespace/);
    assert.equal(ctx.secrets.get("llm.anthropic.apiKey"), undefined, "model keys keep working through the ordinary store");
    // A venue error that echoes the credential is redacted before it is stored or returned.
    fake.script(KEY_A, { secretKey: SECRET_A, failWith: "forbidden", failMessage: `account restricted for key ${KEY_A} / ${SECRET_A}` });
    await assert.rejects(() => ctx.trading.sync(), (e: Error) => !e.message.includes(CANARY) && /refused access/.test(e.message));
    const failed = ctx.trading.status();
    assert.equal(failed.latestSync?.ok, false);
    assert.ok(!JSON.stringify(failed).includes(CANARY));
    assert.ok(!JSON.stringify(ctx.trading.auditEvents()).includes(CANARY));
    assert.match(failed.binding?.lastValidationError ?? "", /^forbidden:/);
    assert.equal(failed.gates.find((g) => g.id === "credentials_valid")?.satisfied, false, "a forbidden account disables anything downstream");
  } finally { ctx.db.close(); }
});

test("A03 — malformed secret, invalid key, revoked key, restricted account, clock skew and outage give specific redacted errors, no binding, no trading calls", async () => {
  const { ctx, fake } = await makeCtx();
  try {
    fake.script("revoked0-1111-2222-3333-444444444444", { secretKey: SECRET_B, failWith: "unauthorized", failMessage: "API key revoked" });
    fake.script("restrict-1111-2222-3333-444444444444", { secretKey: SECRET_B, failWith: "forbidden", failMessage: "identity verification incomplete" });
    const cases: [string, Record<string, string>, string, number][] = [
      ["malformed secret", { keyId: KEY_A, secretKey: "not-a-key" }, "malformed_secret", 0],
      ["48-byte secret", { keyId: KEY_A, secretKey: crypto.randomBytes(48).toString("base64") }, "malformed_secret", 0],
      ["invalid key id", { keyId: "x", secretKey: SECRET_A }, "invalid_key_id", 0],
      ["unknown key", { keyId: KEY_B, secretKey: SECRET_B }, "unauthorized", 1],
      ["wrong secret for a known key", { keyId: "revoked0-1111-2222-3333-444444444444", secretKey: SECRET_A }, "unauthorized", 1],
      ["revoked key", { keyId: "revoked0-1111-2222-3333-444444444444", secretKey: SECRET_B }, "unauthorized", 1],
      ["restricted / unverified account", { keyId: "restrict-1111-2222-3333-444444444444", secretKey: SECRET_B }, "forbidden", 1],
    ];
    for (const [label, input, code, calls] of cases) {
      const n0 = fake.calls.length;
      const r = await ctx.trading.testConnection(input);
      assert.equal(r.ok, false, label);
      assert.equal(r.code, code, `${label}: ${r.message}`);
      assert.equal(fake.calls.length - n0, calls, `${label}: adapter calls`);
      assert.ok(!r.message.includes(SECRET_A) && !r.message.includes(SECRET_B), label);
      await assert.rejects(() => ctx.trading.connect({ keyId: input.keyId, secretKey: input.secretKey }), (e: unknown) => e instanceof TradingConnectError && e.test.code === code);
      assert.equal(ctx.trading.connected(), undefined, `${label}: nothing saved`);
    }
    // 31-second clock skew and a venue outage: reported as such, never as "credentials bad".
    fake.outage = "clock_skew";
    const skew = await ctx.trading.testConnection({ keyId: KEY_A, secretKey: SECRET_A });
    assert.equal(skew.code, "clock_skew");
    assert.match(skew.message, /within 30 s/);
    fake.outage = "venue_unavailable";
    const down = await ctx.trading.testConnection({ keyId: KEY_A, secretKey: SECRET_A });
    assert.equal(down.code, "venue_unavailable");
    assert.match(down.message, /No conclusion/);
    fake.outage = undefined;
    assert.equal(fake.orderCalls, 0);
    assert.equal(ctx.trading.connected(), undefined);
    assert.equal(ctx.trading.status().policy.mode, "paper");
    // Offline mode: no network call at all (A07).
    const s = ctx.settings.getPersisted(); s.privacy.allowInternet = false; ctx.settings.savePersisted(s);
    const n0 = fake.calls.length;
    const off = await ctx.trading.testConnection({ keyId: KEY_A, secretKey: SECRET_A });
    assert.equal(off.code, "offline_mode");
    assert.equal(fake.calls.length, n0);
    await assert.rejects(() => ctx.trading.connect({ keyId: KEY_A, secretKey: SECRET_A }), (e: unknown) => e instanceof TradingConnectError && e.test.code === "offline_mode");
  } finally { ctx.db.close(); }
});

test("A04/A05 — same credential continues the binding; a different credential starts a new binding (unverified, reconcile required) unless the owner asserts continuity; bindings are never merged automatically", async () => {
  const { ctx, fake } = await makeCtx();
  try {
    fake.script(KEY_A, { secretKey: SECRET_A }).script(KEY_B, { secretKey: SECRET_B });
    const first = (await ctx.trading.connect({ keyId: KEY_A, secretKey: SECRET_A })).binding;
    // Re-entering the same secret (e.g. after a disconnect) keeps the binding id.
    const again = (await ctx.trading.connect({ keyId: KEY_A, secretKey: SECRET_A })).binding;
    assert.equal(again.id, first.id);
    assert.equal(again.continuity, "same_credential");
    assert.equal(again.reconcileRequired, false);
    // Rotation to a different key without any assertion: new binding, old one superseded, reconcile required.
    const rotated = (await ctx.trading.connect({ keyId: KEY_B, secretKey: SECRET_B })).binding;
    assert.notEqual(rotated.id, first.id);
    assert.equal(rotated.continuity, "unverified");
    assert.equal(rotated.reconcileRequired, true);
    assert.equal(rotated.credentialFingerprint, credentialFingerprint(seedB));
    const st = ctx.trading.status();
    assert.equal(st.previousBindings.length, 1);
    assert.equal(st.previousBindings[0].state, "superseded");
    assert.equal(st.previousBindings[0].supersededBy, rotated.id);
    assert.equal(st.gates.find((g) => g.id === "reconciled")?.satisfied, false);
    const replaced = ctx.trading.auditEvents().find((e) => e.kind === "credential.replaced")!;
    assert.deepEqual({ c: replaced.details.continuity, prev: replaced.details.previousBinding, inv: replaced.details.intentsInvalidated }, { c: "unverified", prev: first.id, inv: 0 });
    assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trading_accounts")!.n, 2, "history retained, nothing merged");
    // Owner-asserted continuity keeps the binding id but is labelled as an assertion and still requires reconciliation.
    const asserted = (await ctx.trading.connect({ keyId: KEY_A, secretKey: SECRET_A, assertSameAccount: true })).binding;
    assert.equal(asserted.id, rotated.id);
    assert.equal(asserted.continuity, "user_asserted");
    assert.equal(asserted.reconcileRequired, true);
    assert.equal(asserted.credentialFingerprint, credentialFingerprint(seedA));
    assert.equal(ctx.trading.status().binding?.identityKind, "local_binding");
    assert.equal(ctx.trading.status().binding?.externalIdentity, undefined);
  } finally { ctx.db.close(); }
});

test("A08 — disconnect disarms first, then removes credentials; history survives; local removal is not venue revocation; reconnect continues the binding", async () => {
  const { ctx, fake } = await makeCtx();
  try {
    fake.script(KEY_A, { secretKey: SECRET_A });
    const b = (await ctx.trading.connect({ keyId: KEY_A, secretKey: SECRET_A })).binding;
    const syncsBefore = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trading_account_syncs")!.n;
    const r = await ctx.trading.disconnect();
    assert.equal(r.disconnected, true);
    assert.deepEqual(r.cancellations, [], "1.10 cannot have placed an order, so there is nothing to cancel");
    assert.match(r.note, /not a venue revocation/);
    assert.equal(ctx.trading.connected(), undefined);
    assert.equal(ctx.trading.hasCredentials(), false);
    assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM secrets WHERE name LIKE 'trading.%'")!.n, 0);
    const st = ctx.trading.status();
    assert.equal(st.previousBindings[0].id, b.id);
    assert.equal(st.previousBindings[0].state, "disconnected");
    assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trading_account_syncs")!.n, syncsBefore, "syncs retained");
    const kinds = ctx.trading.auditEvents(50).reverse().map((e) => e.kind);
    assert.ok(kinds.indexOf("trading.disarmed") < kinds.indexOf("orders.cancel_requested") && kinds.indexOf("orders.cancel_requested") < kinds.indexOf("connection.disconnected"), kinds.join(","));
    assert.equal(ctx.trading.auditEvents().find((e) => e.kind === "connection.disconnected")?.details.venueRevocation, false);
    assert.equal(fake.orderCalls, 0);
    // Second disconnect is a no-op; reconnect with the same key continues the same binding.
    assert.equal((await ctx.trading.disconnect()).disconnected, false);
    const again = (await ctx.trading.connect({ keyId: KEY_A, secretKey: SECRET_A })).binding;
    assert.equal(again.id, b.id);
    assert.equal(again.continuity, "same_credential");
    assert.equal(ctx.trading.status().previousBindings.length, 0);
  } finally { ctx.db.close(); }
});

test("ACC-05 — live modes are refused with their unmet gates; a generic settings save cannot touch the policy; a live mode found at startup is disarmed", async () => {
  const { ctx, fake } = await makeCtx();
  try {
    fake.script(KEY_A, { secretKey: SECRET_A });
    await ctx.trading.connect({ keyId: KEY_A, secretKey: SECRET_A });
    for (const mode of ["manual_live", "auto_live"] as const) {
      assert.throws(() => ctx.trading.setMode(mode), (e: unknown) => e instanceof TradingGateError && e.gates.some((g) => g.id === "submission_feature") && e.gates.some((g) => g.id === "live_authorization"));
    }
    assert.equal(ctx.trading.setMode("disabled").mode, "disabled");
    assert.equal(ctx.trading.setMode("paper").mode, "paper");
    // Settings document has no trading key; anything smuggled in is dropped by the schema and the policy row is untouched.
    const s = ctx.settings.getPersisted() as Record<string, unknown>;
    s.trading = { mode: "auto_live" };
    ctx.settings.savePersisted(s as never);
    assert.equal(ctx.trading.policy().mode, "paper");
    assert.equal((ctx.settings.getPersisted() as Record<string, unknown>).trading, undefined);
    // OPS-02 / AUTO-04: an old database that says live comes up disarmed.
    ctx.db.run("UPDATE trading_policy SET mode = 'auto_live', live_authorized_at = '2026-01-01T00:00:00Z', live_authorization_hash = 'h' WHERE id = 'default'");
    const boot = ctx.trading.startupCheck();
    assert.equal(boot.disarmed, true);
    assert.deepEqual({ mode: ctx.trading.policy().mode, auth: ctx.trading.policy().liveAuthorizedAt }, { mode: "paper", auth: undefined });
    assert.equal(ctx.trading.auditEvents().find((e) => e.kind === "trading.disarmed")?.details.reason, "startup");
  } finally { ctx.db.close(); }
});

test("OPS-02 — a backup omits trading credentials and live authorization; restoring it comes up needs_rebind and requires reconnect + reconcile", async () => {
  const { ctx, fake, dataDir } = await makeCtx();
  fake.script(KEY_A, { secretKey: SECRET_A });
  const b = (await ctx.trading.connect({ keyId: KEY_A, secretKey: SECRET_A })).binding;
  const info = createBackup(ctx.db, ctx.paths);
  assert.equal(info.tradingCredentialsIncluded, false);
  assert.deepEqual(info.scrubbed, { tradingSecrets: 2, bindingsMarkedForRebind: 1, liveAuthorizationCleared: true });
  // The live database is untouched.
  assert.equal(ctx.trading.hasCredentials(), true);
  assert.equal(ctx.trading.connected()?.state, "connected");
  const copy = path.join(ctx.paths.backups, info.file);
  const raw = fs.readFileSync(copy);
  assert.ok(!raw.includes(CANARY));
  ctx.db.close();
  // Restore into a fresh data directory (same secret key file, as docs/SETUP.md describes) and boot.
  const restored = fs.mkdtempSync(path.join(os.tmpdir(), "pl-restore-"));
  fs.copyFileSync(copy, path.join(restored, path.basename(ctx.paths.database)));
  fs.copyFileSync(path.join(dataDir, path.basename(ctx.paths.secretKey)), path.join(restored, path.basename(ctx.paths.secretKey)));
  process.env.PL_DATA_DIR = restored;
  const { createContext } = await import("../context.js");
  const ctx2 = createContext();
  try {
    const st = ctx2.trading.status();
    assert.equal(st.binding, undefined, "not connected");
    assert.equal(st.previousBindings[0].id, b.id);
    assert.equal(st.previousBindings[0].state, "needs_rebind");
    assert.equal(st.policy.mode, "paper");
    assert.equal(ctx2.trading.hasCredentials(), false);
    assert.ok(ctx2.trading.auditEvents().some((e) => e.kind === "backup.scrubbed"));
    await assert.rejects(() => ctx2.trading.sync());
    const re = (await ctx2.trading.connect({ keyId: KEY_A, secretKey: SECRET_A })).binding;
    assert.equal(re.id, b.id, "same fingerprint → same binding");
    assert.equal(re.continuity, "same_credential");
    assert.equal(re.reconcileRequired, true, "a restore always requires reconciliation before anything could activate");
    assert.equal(ctx2.trading.status().gates.find((g) => g.id === "reconciled")?.satisfied, false);
  } finally { ctx2.db.close(); }
});
