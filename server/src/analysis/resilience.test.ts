/**
 * Prediction Ledger — tests for provider-call resilience (timeout, 429 backoff, no retry on 401) and backups.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ProviderTimeoutError, withResilience } from "./structured.js";
import { ProviderHttpError, parseRetryAfter } from "../providers/llm/types.js";
import { openDatabase } from "../db/index.js";
import { createBackup, listBackups } from "../services/backup.js";

const noSleep = { sleep: async () => {} };

test("withResilience: 429 then success retries with Retry-After; 5xx retries with backoff; gives up after maxTries", async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => { waits.push(ms); };
  let calls = 0;
  const out = await withResilience(async () => {
    calls++;
    if (calls === 1) throw new ProviderHttpError("P", 429, "slow down", 2500);
    if (calls === 2) throw new ProviderHttpError("P", 503, "busy");
    return "ok";
  }, { sleep, maxTries: 3 });
  assert.equal(out, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2500, 4000], "Retry-After honoured, then quadratic backoff for try 2");

  calls = 0;
  await assert.rejects(withResilience(async () => { calls++; throw new ProviderHttpError("P", 500, "down"); }, { ...noSleep, maxTries: 3 }), /HTTP 500/);
  assert.equal(calls, 3);
});

test("withResilience: 401/403 fail immediately; non-HTTP errors are not retried; network errors are", async () => {
  let calls = 0;
  await assert.rejects(withResilience(async () => { calls++; throw new ProviderHttpError("P", 401, "bad key"); }, noSleep), (e: Error) => e instanceof ProviderHttpError && e.invalidCredentials);
  assert.equal(calls, 1, "invalid credentials are never retried");

  calls = 0;
  await assert.rejects(withResilience(async () => { calls++; throw new Error("something else"); }, noSleep), /something else/);
  assert.equal(calls, 1);

  calls = 0;
  const v = await withResilience(async () => { calls++; if (calls < 2) throw new TypeError("fetch failed"); return 1; }, noSleep);
  assert.equal(v, 1);
  assert.equal(calls, 2);
});

test("withResilience: per-try timeout aborts the call and surfaces a readable error; caller cancel wins", async () => {
  let aborted = 0;
  await assert.rejects(
    withResilience((signal) => new Promise((_, reject) => signal.addEventListener("abort", () => { aborted++; reject(signal.reason); })), { ...noSleep, timeoutMs: 30, maxTries: 2 }),
    (e: Error) => e instanceof ProviderTimeoutError,
  );
  assert.equal(aborted, 2, "timed-out tries are retried up to maxTries");

  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(
    withResilience((signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("Cancelled")))), { signal: ctl.signal, timeoutMs: 5000 }),
    /Cancelled/,
  );
});

test("parseRetryAfter: seconds, HTTP date, junk, cap", () => {
  assert.equal(parseRetryAfter("3"), 3000);
  assert.equal(parseRetryAfter("999"), 60_000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter("soon"), undefined);
  const inFuture = new Date(Date.now() + 5000).toUTCString();
  const ms = parseRetryAfter(inFuture)!;
  assert.ok(ms > 3000 && ms <= 5000, String(ms));
});

test("backups: VACUUM INTO produces an openable copy with the same schema; secret key copied; listing sorted", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pl-backup-"));
  const paths = { root, database: path.join(root, "pl.db"), secretKey: path.join(root, "secret.key"), backups: path.join(root, "backups") };
  const { db } = openDatabase(paths as never);
  db.run("INSERT INTO settings (key, value_json) VALUES ('app', '{\"x\":1}')");
  fs.writeFileSync(paths.secretKey, "k".repeat(32));
  const info = createBackup(db, paths);
  assert.match(info.file, /^manual-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.db$/);
  assert.equal(info.hasSecretKey, true);
  assert.ok(fs.existsSync(path.join(paths.backups, info.file.replace(/\.db$/, ".secret.key"))));
  const copy = openDatabase({ ...paths, database: path.join(paths.backups, info.file), backups: path.join(root, "b2") } as never);
  assert.equal(copy.schemaVersion, db.all("SELECT version FROM schema_migrations").length);
  assert.equal(copy.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key='app'")?.value_json, '{"x":1}');
  copy.db.close();
  const list = listBackups(paths.backups);
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "manual");
  db.close();
});
