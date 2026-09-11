/**
 * Prediction Ledger — encrypted secret storage for provider credentials.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Strategy (docs/ARCHITECTURE.md §7.2):
 *  - A random 256-bit key is generated once and stored at <dataDir>/secret.key with
 *    owner-only permissions (0600 on POSIX; on Windows the per-user LOCALAPPDATA ACL applies).
 *  - Each secret is AES-256-GCM encrypted with a fresh IV and stored in the `secrets` table.
 *  - Only a masked hint ("sk-ant-…4f2a") is ever returned to the browser.
 *  - Plaintext is decrypted on demand for outbound provider calls and never logged.
 *
 * This protects against casual disclosure (database copied, exported, or committed by
 * mistake). It does NOT protect against another process running as the same OS user —
 * that is the same trust boundary as the OS keychain for an unsigned local app.
 * OS-keychain integration is a deferred enhancement (see docs/BUILD_PLAN.md).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import type { Database } from "../db/index.js";

const ALGO = "aes-256-gcm";

export class SecretStore {
  private readonly key: Buffer;

  constructor(
    private readonly db: Database,
    keyFilePath: string,
  ) {
    this.key = loadOrCreateKey(keyFilePath);
  }

  set(name: string, plaintext: string): void {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    this.db.run(
      `INSERT INTO secrets (name, ciphertext, iv, auth_tag, hint, updated_at)
       VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(name) DO UPDATE SET ciphertext=excluded.ciphertext, iv=excluded.iv,
         auth_tag=excluded.auth_tag, hint=excluded.hint, updated_at=excluded.updated_at`,
      name,
      ciphertext,
      iv,
      authTag,
      maskSecret(plaintext),
    );
  }

  get(name: string): string | undefined {
    const row = this.db.get<{ ciphertext: Uint8Array; iv: Uint8Array; auth_tag: Uint8Array }>(
      "SELECT ciphertext, iv, auth_tag FROM secrets WHERE name = ?",
      name,
    );
    if (!row) return undefined;
    const decipher = crypto.createDecipheriv(ALGO, this.key, Buffer.from(row.iv));
    decipher.setAuthTag(Buffer.from(row.auth_tag));
    return Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]).toString("utf8");
  }

  hint(name: string): string | undefined {
    return this.db.get<{ hint: string }>("SELECT hint FROM secrets WHERE name = ?", name)?.hint;
  }

  has(name: string): boolean {
    return this.hint(name) !== undefined;
  }

  delete(name: string): void {
    this.db.run("DELETE FROM secrets WHERE name = ?", name);
  }
}

/** "sk-ant-api03-abcdef…" -> "sk-ant-…cdef". Never reveals more than 4 trailing characters. */
export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return "••••";
  const prefixMatch = /^([a-zA-Z0-9_-]{2,7})-/.exec(trimmed);
  const prefix = prefixMatch ? `${prefixMatch[1]}-` : "";
  return `${prefix}…${trimmed.slice(-4)}`;
}

function loadOrCreateKey(keyFilePath: string): Buffer {
  if (fs.existsSync(keyFilePath)) {
    const key = fs.readFileSync(keyFilePath);
    if (key.length !== 32) {
      throw new Error(
        `Secret key file at ${keyFilePath} is corrupt (expected 32 bytes). ` +
          `Delete it to reset — saved API keys will need to be re-entered.`,
      );
    }
    return key;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFilePath, key, { mode: 0o600 });
  return key;
}
