/**
 * Prediction Ledger — tests for credential shape checks, fingerprints and the documented signing scheme (1.10).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Fixture secrets are random bytes generated at test time — never a real key.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { credentialFingerprint, decodeSecretSeed, inspectCredentials, publicKeyForSeed, signRequest, validateKeyId } from "./credentials.js";

const seed = crypto.randomBytes(32);
const KEY_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

test("secret decoding accepts 32/64-byte base64 (std and url-safe) and rejects everything else without touching the network", () => {
  const std = seed.toString("base64");
  const url = std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const sixtyFour = Buffer.concat([seed, crypto.randomBytes(32)]).toString("base64");
  for (const s of [std, url, sixtyFour]) {
    const d = decodeSecretSeed(s);
    assert.ok("seed" in d, s);
    assert.equal(d.seed.toString("hex"), seed.toString("hex"));
  }
  for (const bad of ["", "not base64!!", "c2hvcnQ=", crypto.randomBytes(48).toString("base64"), "sk-ant-api03-abc"]) {
    const d = decodeSecretSeed(bad);
    assert.ok("problem" in d && d.problem === "malformed_secret", bad);
  }
  assert.equal(validateKeyId(KEY_ID), undefined);
  assert.equal(validateKeyId("short"), "invalid_key_id");
  assert.equal(validateKeyId("has spaces in it"), "invalid_key_id");
});

test("fingerprint identifies the credential (same seed → same 16-hex fingerprint; different seed → different) and never contains the secret", () => {
  const fp = credentialFingerprint(seed);
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(credentialFingerprint(Buffer.from(seed)), fp);
  assert.notEqual(credentialFingerprint(crypto.randomBytes(32)), fp);
  const r = inspectCredentials({ keyId: KEY_ID, secretKey: seed.toString("base64") });
  assert.ok(r.ok);
  assert.equal(r.fingerprint, fp);
  assert.ok(!JSON.stringify(r).includes(seed.toString("base64")));
  const bad = inspectCredentials({ keyId: KEY_ID, secretKey: "nope" });
  assert.ok(!bad.ok && bad.problem === "malformed_secret");
});

test("signing scheme matches the venue's documented message (timestamp+method+path) and verifies with the derived public key", () => {
  const ts = "1789000000000";
  const sig = signRequest(seed, ts, "GET", "/v1/account/balances");
  const pub = publicKeyForSeed(seed);
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]);
  const key = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  assert.equal(crypto.verify(null, Buffer.from(`${ts}GET/v1/account/balances`), key, Buffer.from(sig, "base64")), true);
  // A different path or timestamp does not verify — the signature binds the request.
  assert.equal(crypto.verify(null, Buffer.from(`${ts}GET/v1/orders/open`), key, Buffer.from(sig, "base64")), false);
});
