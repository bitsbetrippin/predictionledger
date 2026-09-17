/**
 * Prediction Ledger — protection of the secret key file on each platform (2.0, OPS-01 / O01).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * `fs.writeFileSync(..., { mode: 0o600 })` protects the key on macOS/Linux but does nothing on Windows, where the file
 * inherits the folder's ACL. Here the key file gets an explicit Windows ACL (inheritance removed; the current user only —
 * SYSTEM and Administrators are left as documented exceptions), applied with `icacls` as an argument array (never a
 * shell), and a *verification* that parses the ACL back instead of inferring it from a POSIX mode. The pure parser is
 * unit-tested with captured `icacls` output; applying/verifying on a real Windows machine is an owner check (O01).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

export interface AclEntry { principal: string; flags: string[]; rights: string }
export interface AclReport {
  platform: NodeJS.Platform;
  /** How the check was made: a parsed Windows ACL, a POSIX mode, or nothing (file missing / tool missing). */
  method: "icacls" | "posix_mode" | "unavailable";
  ok: boolean;
  /** Principals other than the current user, SYSTEM and Administrators that can read the file. */
  broadPrincipals: string[];
  entries?: AclEntry[];
  mode?: string;
  detail: string;
  /** The exact command an owner can run to fix it (no secrets in it). */
  fix?: string;
}

/** Principals that are acceptable on a per-user secret file. */
const ALLOWED_WINDOWS_PRINCIPALS = [/^NT AUTHORITY\\SYSTEM$/i, /^BUILTIN\\Administrators$/i];
/** Groups that mean "anyone on this computer" — never acceptable for the key file. */
const BROAD_WINDOWS_PRINCIPALS = [/^BUILTIN\\Users$/i, /^Everyone$/i, /^NT AUTHORITY\\Authenticated Users$/i, /^NT AUTHORITY\\INTERACTIVE$/i, /\\Users$/i, /^Users$/i];

/**
 * Parse `icacls <file>` output. Format (one file):
 *   C:\path\secret.key DESKTOP\alice:(F)
 *                      NT AUTHORITY\SYSTEM:(I)(F)
 *                      BUILTIN\Users:(I)(RX)
 *   Successfully processed 1 files; Failed processing 0 files
 */
export function parseIcacls(output: string, filePath?: string): AclEntry[] {
  const entries: AclEntry[] = [];
  for (const raw of output.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || /^Successfully processed|^Failed processing/i.test(line)) continue;
    if (filePath && line.toLowerCase().startsWith(filePath.toLowerCase())) line = line.slice(filePath.length).trim();
    // The first line carries the path followed by the first ACE; a path with spaces is handled by matching the ACE tail.
    const m = /([^\s:][^:]*?):((?:\([A-Z,]+\))+)\s*$/i.exec(line);
    if (!m) continue;
    const principal = m[1].trim();
    const groups = [...m[2].matchAll(/\(([A-Z,]+)\)/gi)].map((g) => g[1].toUpperCase());
    const flags = groups.filter((g) => ["OI", "CI", "IO", "NP", "I"].includes(g));
    const rights = groups.filter((g) => !flags.includes(g)).join(",");
    entries.push({ principal, flags, rights });
  }
  return entries;
}

/** Judge a parsed Windows ACL for a secret file owned by `user` (DOMAIN\name or name). */
export function judgeWindowsAcl(entries: AclEntry[], user: string): { ok: boolean; broad: string[]; detail: string } {
  const me = user.toLowerCase();
  const broad: string[] = [];
  let selfHasAccess = false;
  for (const e of entries) {
    const p = e.principal;
    const pl = p.toLowerCase();
    if (pl === me || pl.endsWith(`\\${me}`) || me.endsWith(`\\${pl}`)) { selfHasAccess = true; continue; }
    if (ALLOWED_WINDOWS_PRINCIPALS.some((r) => r.test(p))) continue;
    if (BROAD_WINDOWS_PRINCIPALS.some((r) => r.test(p)) || /R|F|M|GR|GA/i.test(e.rights)) broad.push(`${p}:${e.rights}`);
  }
  const inherited = entries.some((e) => e.flags.includes("I"));
  const detail = broad.length ? `readable by ${broad.join(", ")}` : `${entries.length} ACE(s): ${entries.map((e) => `${e.principal}:${e.rights}`).join(", ")}${inherited ? " (some inherited)" : ""}`;
  return { ok: selfHasAccess && broad.length === 0, broad, detail };
}

function currentWindowsUser(): string {
  const domain = process.env.USERDOMAIN;
  const name = process.env.USERNAME ?? os.userInfo().username;
  return domain ? `${domain}\\${name}` : name;
}

/** Verify the key file's protection without changing anything. */
export function checkKeyFileProtection(keyFilePath: string): AclReport {
  const platform = process.platform;
  if (!fs.existsSync(keyFilePath)) return { platform, method: "unavailable", ok: false, broadPrincipals: [], detail: "key file does not exist yet (created on first start)" };
  if (platform === "win32") {
    const r = spawnSync("icacls", [keyFilePath], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    if (r.error || r.status !== 0) return { platform, method: "unavailable", ok: false, broadPrincipals: [], detail: `icacls unavailable or failed: ${r.error?.message ?? r.stderr ?? r.status}`, fix: fixCommand(keyFilePath) };
    const entries = parseIcacls(r.stdout, keyFilePath);
    const j = judgeWindowsAcl(entries, currentWindowsUser());
    return { platform, method: "icacls", ok: j.ok, broadPrincipals: j.broad, entries, detail: j.detail, fix: j.ok ? undefined : fixCommand(keyFilePath) };
  }
  const mode = fs.statSync(keyFilePath).mode & 0o777;
  const ok = (mode & 0o077) === 0;
  return { platform, method: "posix_mode", ok, broadPrincipals: ok ? [] : ["group/other"], mode: mode.toString(8).padStart(3, "0"), detail: `mode ${mode.toString(8).padStart(3, "0")}`, fix: ok ? undefined : `chmod 600 "${keyFilePath}"` };
}

/** The exact fix, shown to the owner and applied by `applyKeyFileProtection`. */
export function fixCommand(keyFilePath: string): string {
  return process.platform === "win32"
    ? `icacls "${keyFilePath}" /inheritance:r /grant:r "${currentWindowsUser()}:F"`
    : `chmod 600 "${keyFilePath}"`;
}

/**
 * Apply the protection: chmod 600 on POSIX; on Windows remove inheritance and grant the current user only. Idempotent,
 * argument-array spawn, never fatal (the caller logs the report). Returns the verification made afterwards.
 */
export function applyKeyFileProtection(keyFilePath: string): AclReport {
  if (!fs.existsSync(keyFilePath)) return checkKeyFileProtection(keyFilePath);
  if (process.platform === "win32") {
    spawnSync("icacls", [keyFilePath, "/inheritance:r", "/grant:r", `${currentWindowsUser()}:F`], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  } else {
    try { fs.chmodSync(keyFilePath, 0o600); } catch { /* reported by the check below */ }
  }
  return checkKeyFileProtection(keyFilePath);
}
