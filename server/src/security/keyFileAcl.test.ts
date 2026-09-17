/**
 * Prediction Ledger — key-file protection (2.0, OPS-01 / O01): the icacls parser and judgement on captured Windows
 * output, and the POSIX path on this platform. Applying the ACL on a real Windows machine is the owner's O01 check.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyKeyFileProtection, checkKeyFileProtection, fixCommand, judgeWindowsAcl, parseIcacls } from "./keyFileAcl.js";

const FILE = "C:\\Users\\Michael Carter\\AppData\\Local\\PredictionLedger\\secret.key";
/** What `icacls` prints for a file that merely inherited the folder's ACL (the pre-2.0 state on Windows). */
const INHERITED = `${FILE} NT AUTHORITY\\SYSTEM:(I)(F)
                                                                 BUILTIN\\Administrators:(I)(F)
                                                                 DESKTOP-PL\\Michael Carter:(I)(F)
                                                                 BUILTIN\\Users:(I)(RX)

Successfully processed 1 files; Failed processing 0 files
`;
/** After `icacls <file> /inheritance:r /grant:r "DESKTOP-PL\\Michael Carter:F"`. */
const RESTRICTED = `${FILE} DESKTOP-PL\\Michael Carter:(F)

Successfully processed 1 files; Failed processing 0 files
`;
const EVERYONE = `${FILE} Everyone:(F)
                                                                 DESKTOP-PL\\Michael Carter:(F)
Successfully processed 1 files; Failed processing 0 files
`;

test("O01 — icacls output is parsed into principals, inheritance flags and rights (paths with spaces included)", () => {
  const e = parseIcacls(INHERITED, FILE);
  assert.deepEqual(e.map((x) => [x.principal, x.flags.join("+"), x.rights]), [
    ["NT AUTHORITY\\SYSTEM", "I", "F"], ["BUILTIN\\Administrators", "I", "F"], ["DESKTOP-PL\\Michael Carter", "I", "F"], ["BUILTIN\\Users", "I", "RX"],
  ]);
  assert.deepEqual(parseIcacls(RESTRICTED, FILE).map((x) => [x.principal, x.flags.join("+"), x.rights]), [["DESKTOP-PL\\Michael Carter", "", "F"]]);
  assert.equal(parseIcacls("Successfully processed 0 files; Failed processing 1 files").length, 0);
});

test("O01 — judgement: an inherited BUILTIN\\Users:(RX) or Everyone entry is OPEN; the current user (+ SYSTEM/Administrators) only is OK; the user must keep access", () => {
  const me = "DESKTOP-PL\\Michael Carter";
  const open = judgeWindowsAcl(parseIcacls(INHERITED, FILE), me);
  assert.equal(open.ok, false);
  assert.deepEqual(open.broad, ["BUILTIN\\Users:RX"]);
  const good = judgeWindowsAcl(parseIcacls(RESTRICTED, FILE), me);
  assert.equal(good.ok, true);
  assert.deepEqual(good.broad, []);
  assert.equal(judgeWindowsAcl(parseIcacls(RESTRICTED, FILE), "Michael Carter").ok, true, "a bare user name matches DOMAIN\\name");
  const everyone = judgeWindowsAcl(parseIcacls(EVERYONE, FILE), me);
  assert.equal(everyone.ok, false);
  assert.deepEqual(everyone.broad, ["Everyone:F"]);
  assert.equal(judgeWindowsAcl(parseIcacls(`${FILE} NT AUTHORITY\\SYSTEM:(F)\n`, FILE), me).ok, false, "a file the user cannot read is not 'protected', it is broken");
  const withAdmins = judgeWindowsAcl(parseIcacls(`${FILE} ${me}:(F)\n NT AUTHORITY\\SYSTEM:(F)\n BUILTIN\\Administrators:(F)\n`, FILE), me);
  assert.equal(withAdmins.ok, true, "SYSTEM and Administrators are documented exceptions");
});

test("O01 — on this platform: a fresh key file is verified by the platform's own method; a too-open POSIX mode is reported with the exact fix and tightened by apply", { skip: process.platform === "win32" ? "POSIX-mode branch; the Windows branch is the owner's O01 check" : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pl-acl-"));
  const file = path.join(dir, "secret.key");
  fs.writeFileSync(file, Buffer.alloc(32, 1), { mode: 0o644 });
  const open = checkKeyFileProtection(file);
  assert.equal(open.method, "posix_mode");
  assert.equal(open.ok, false);
  assert.equal(open.mode, "644");
  assert.equal(open.fix, `chmod 600 "${file}"`);
  const fixed = applyKeyFileProtection(file);
  assert.equal(fixed.ok, true);
  assert.equal(fixed.mode, "600");
  assert.equal(fixed.fix, undefined);
  assert.equal(checkKeyFileProtection(path.join(dir, "missing.key")).method, "unavailable");
  assert.match(fixCommand(file), /^chmod 600 /);
});
