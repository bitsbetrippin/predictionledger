/**
 * Prediction Ledger — redaction of credential material from text (1.10, ACC-04).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Every string that leaves the trading adapter (error messages, audit details, sync errors) passes
 * through `redactSecrets` with the live key material, so a venue error that echoes a header, a stack
 * trace that prints an options object, or a URL that carries a key can never reach the database, the
 * browser, a job payload or a log line. Patterns for the venue's auth headers are scrubbed even when the
 * exact values are unknown.
 */

const HEADER_PATTERNS: RegExp[] = [
  /x-pm-signature["'=:\s]+[A-Za-z0-9+/=_-]{16,}/gi,
  /x-pm-access-key["'=:\s]+[A-Za-z0-9-]{8,}/gi,
  /x-pm-timestamp["'=:\s]+\d{10,}/gi,
  /secretKey["'=:\s]+[A-Za-z0-9+/=_-]{16,}/g,
  /keyId["'=:\s]+[A-Za-z0-9-]{8,}/g,
  /authorization["'=:\s]+(?:bearer\s+)?[A-Za-z0-9._+/=-]{12,}/gi,
];

export const REDACTED = "[redacted]";

/** Remove exact secret values (and their base64/URL-encoded forms) plus known auth-header shapes. */
export function redactSecrets(text: string, secrets: (string | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    for (const form of new Set([s, encodeURIComponent(s), Buffer.from(s, "utf8").toString("base64"), s.replace(/=+$/, "")])) {
      if (form.length >= 4) out = out.split(form).join(REDACTED);
    }
  }
  for (const re of HEADER_PATTERNS) out = out.replace(re, (m) => `${m.split(/["'=:\s]/)[0]}=${REDACTED}`);
  return out;
}

/** Error → safe message: type + redacted message, never a stack, capped in length. */
export function safeErrorMessage(err: unknown, secrets: (string | undefined)[] = [], max = 400): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err ?? null);
  return redactSecrets(raw ?? "", secrets).slice(0, max);
}
