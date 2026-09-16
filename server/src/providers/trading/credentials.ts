/**
 * Prediction Ledger — Polymarket US credential shape checks and fingerprinting (1.10, ACC-03/04).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Pure functions — no network, no database. The retail API signs requests with Ed25519 (docs
 * "Authentication", verified 2026-09-16): the secret is a base64-encoded 32-byte seed (the official SDK
 * also accepts a 64-byte key and uses its first 32 bytes). From the seed we derive the public key and
 * hash it; that hash identifies *the credential* without revealing it and is the only identity the
 * venue lets us observe — it is not an account id (spec §14.1).
 */

import crypto from "node:crypto";

export interface TradingCredentials {
  keyId: string;
  secretKey: string;
}

export type CredentialProblem = "malformed_secret" | "invalid_key_id";

/** PKCS#8 DER prefix for an Ed25519 private key; the 32-byte seed follows. */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

/** Key IDs are UUIDs per the venue docs; we accept a slightly wider shape so a future format does not lock users out. */
export function validateKeyId(keyId: string): CredentialProblem | undefined {
  return KEY_ID_RE.test(keyId.trim()) ? undefined : "invalid_key_id";
}

/** Decode the secret to its 32-byte seed, or report why it cannot be one. */
export function decodeSecretSeed(secretKey: string): { seed: Buffer } | { problem: CredentialProblem; reason: string } {
  const trimmed = secretKey.trim();
  if (!trimmed || !/^[A-Za-z0-9+/=_-]+$/.test(trimmed)) return { problem: "malformed_secret", reason: "secret is not base64 text" };
  let bytes: Buffer;
  try {
    bytes = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  } catch {
    return { problem: "malformed_secret", reason: "secret is not valid base64" };
  }
  if (bytes.length !== 32 && bytes.length !== 64) return { problem: "malformed_secret", reason: `secret decodes to ${bytes.length} bytes; an Ed25519 secret is 32 (or 64) bytes` };
  return { seed: bytes.subarray(0, 32) };
}

/** Ed25519 public key (32 raw bytes) for a seed. Throws only if Node lacks Ed25519 (Node ≥ 12 has it). */
export function publicKeyForSeed(seed: Buffer): Buffer {
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  const spki = crypto.createPublicKey(priv).export({ type: "spki", format: "der" }) as Buffer;
  return spki.subarray(spki.length - 32);
}

/** 16 hex chars of SHA-256(public key). Stable for the credential; useless for signing. */
export function credentialFingerprint(seed: Buffer): string {
  return crypto.createHash("sha256").update(publicKeyForSeed(seed)).digest("hex").slice(0, 16);
}

/** Shape-check both parts and compute the fingerprint. Never logs or returns the secret. */
export function inspectCredentials(creds: TradingCredentials): { ok: true; fingerprint: string; seedLength: 32 } | { ok: false; problem: CredentialProblem; reason: string } {
  const keyProblem = validateKeyId(creds.keyId);
  if (keyProblem) return { ok: false, problem: keyProblem, reason: "key ID must be the identifier shown in the developer portal (letters, digits, dashes; 8–128 characters)" };
  const decoded = decodeSecretSeed(creds.secretKey);
  if ("problem" in decoded) return { ok: false, problem: decoded.problem, reason: decoded.reason };
  return { ok: true, fingerprint: credentialFingerprint(decoded.seed), seedLength: 32 };
}

/** Sign the venue's canonical message `timestamp + method + path` — kept here so a test can prove the SDK-equivalent scheme without the SDK. */
export function signRequest(seed: Buffer, timestampMs: string, method: string, path: string): string {
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  return crypto.sign(null, Buffer.from(`${timestampMs}${method}${path}`, "utf8"), priv).toString("base64");
}
