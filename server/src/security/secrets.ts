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
 *
 * 1.10 — protected namespaces. Trading credentials (`trading.*`) are refused by the ordinary
 * get/set/hint/has/delete methods; only the holder of a `SecretVault` opened for that namespace can
 * reach them (OPS-01: model and search code is handed key *getters* for their own names and never
 * receives the vault). This is a capability boundary inside one process, not cryptographic isolation.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { applyKeyFileProtection, checkKeyFileProtection, type AclReport } from "./keyFileAcl.js";
import type { Database } from "../db/index.js";

const ALGO = "aes-256-gcm";

/** Namespaces whose secrets are reachable only through a SecretVault. */
export const PROTECTED_NAMESPACES = ["trading."] as const;

export function isProtectedSecretName(name: string): boolean {
  return PROTECTED_NAMESPACES.some((ns) => name.startsWith(ns));
}

/** Scoped accessor for one protected namespace. Handed to exactly one service (1.10: TradingAccountService). */
export interface SecretVault {
  readonly namespace: string;
  set(name: string, plaintext: string): void;
  get(name: string): string | undefined;
  hint(name: string): string | undefined;
  has(name: string): boolean;
  delete(name: string): void;
  /** Names currently stored in the namespace (no values). */
  names(): string[];
}

export class SecretStore {
  private readonly key: Buffer;
  /** 2.0 (OPS-01): how the key file is protected on this platform, verified (not inferred) at startup. */
  readonly keyFileProtection: AclReport;

  constructor(
    private readonly db: Database,
    keyFilePath: string,
  ) {
    const created = !fs.existsSync(keyFilePath);
    this.key = loadOrCreateKey(keyFilePath);
    // A fresh key gets the explicit ACL / mode; an existing one is verified and tightened if it is too open.
    const check = created ? applyKeyFileProtection(keyFilePath) : checkKeyFileProtection(keyFilePath);
    this.keyFileProtection = check.ok || check.method === "unavailable" ? check : applyKeyFileProtection(keyFilePath);
  }

  private guard(name: string): void {
    if (isProtectedSecretName(name)) throw new Error(`Secret "${name}" is in a protected namespace; use the vault opened for it.`);
  }

  /**
   * Open the scoped accessor for a protected namespace. The returned object is the only way to read those
   * secrets; keep it inside the owning service.
   */
  openVault(namespace: (typeof PROTECTED_NAMESPACES)[number]): SecretVault {
    const check = (name: string) => {
      if (!name.startsWith(namespace)) throw new Error(`Vault for "${namespace}" cannot access "${name}".`);
    };
    return {
      namespace,
      set: (name, plaintext) => { check(name); this.write(name, plaintext); },
      get: (name) => { check(name); return this.read(name); },
      hint: (name) => { check(name); return this.readHint(name); },
      has: (name) => { check(name); return this.readHint(name) !== undefined; },
      delete: (name) => { check(name); this.db.run("DELETE FROM secrets WHERE name = ?", name); },
      names: () => this.db.all<{ name: string }>("SELECT name FROM secrets WHERE name LIKE ? ORDER BY name", `${namespace}%`).map((r) => r.name),
    };
  }

  set(name: string, plaintext: string): void {
    this.guard(name);
    this.write(name, plaintext);
  }

  private write(name: string, plaintext: string): void {
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
    this.guard(name);
    return this.read(name);
  }

  private read(name: string): string | undefined {
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
    this.guard(name);
    return this.readHint(name);
  }

  private readHint(name: string): string | undefined {
    return this.db.get<{ hint: string }>("SELECT hint FROM secrets WHERE name = ?", name)?.hint;
  }

  has(name: string): boolean {
    this.guard(name);
    return this.readHint(name) !== undefined;
  }

  delete(name: string): void {
    this.guard(name);
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
