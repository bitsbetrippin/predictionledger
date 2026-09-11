/**
 * Prediction Ledger — tests for the dependency-free core: migrations, secret store, job queue.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Run with `npm test` (uses the built-in node:test runner via tsx). Uses a throwaway
 * data directory under the OS temp folder; never touches the real data directory.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDatabase } from "./db/index.js";
import { JobQueue } from "./jobs/queue.js";
import { maskSecret, SecretStore } from "./security/secrets.js";

function tempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prediction-ledger-test-"));
  return { root, database: path.join(root, "pl.db"), secretKey: path.join(root, "secret.key") } as const;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("migrations apply in order and create the expected tables", () => {
  const paths = tempPaths();
  const { db, schemaVersion } = openDatabase(paths as never);
  assert.equal(schemaVersion, 2);
  const tables = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .map((r) => r.name);
  assert.deepEqual(tables, [
    "jobs", "prediction_components", "prediction_revisions", "predictions", "prompt_templates",
    "schema_migrations", "secrets", "settings", "transcript_segments", "validation_plans", "videos",
  ]);
  assert.deepEqual(db.all<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version").map((r) => r.version), [1, 2]);
  db.close();
});

test("nested transactions use savepoints; inner rollback does not abort the outer one", () => {
  const paths = tempPaths();
  const { db } = openDatabase(paths as never);
  db.transaction(() => {
    db.run("INSERT INTO settings (key, value_json) VALUES ('outer', '{}')");
    assert.throws(() =>
      db.transaction(() => {
        db.run("INSERT INTO settings (key, value_json) VALUES ('inner', '{}')");
        throw new Error("inner failure");
      }),
    );
    db.transaction(() => db.run("INSERT INTO settings (key, value_json) VALUES ('inner2', '{}')"));
  });
  const keys = db.all<{ key: string }>("SELECT key FROM settings ORDER BY key").map((r) => r.key);
  assert.deepEqual(keys, ["inner2", "outer"]);
  db.close();
});

test("secrets are encrypted at rest and only a masked hint is exposed", () => {
  const paths = tempPaths();
  const { db } = openDatabase(paths as never);
  const secrets = new SecretStore(db, paths.secretKey);
  secrets.set("llm.anthropic.apiKey", "sk-ant-api03-abcdefghijklmnop4f2a");
  assert.equal(secrets.get("llm.anthropic.apiKey"), "sk-ant-api03-abcdefghijklmnop4f2a");
  assert.equal(secrets.hint("llm.anthropic.apiKey"), "sk-ant-…4f2a");
  const row = db.get<{ ciphertext: Uint8Array }>("SELECT ciphertext FROM secrets")!;
  assert.ok(!Buffer.from(row.ciphertext).toString("utf8").includes("abcdefghijklmnop"));
  assert.equal(maskSecret("short"), "••••");
  if (process.platform !== "win32") assert.equal(fs.statSync(paths.secretKey).mode & 0o777, 0o600);
  secrets.delete("llm.anthropic.apiKey");
  assert.equal(secrets.has("llm.anthropic.apiKey"), false);
  db.close();
});

test("job queue dedupes, reports progress, retries to maxAttempts, and recovers after restart", async () => {
  const paths = tempPaths();
  let { db } = openDatabase(paths as never);
  const q = new JobQueue(db, () => 2);
  let runs = 0;
  q.register("video.import", async (ctx) => {
    runs++;
    ctx.progress(50, "half");
    if (ctx.payload.fail) throw new Error("boom");
    return { done: true };
  });

  const a = q.enqueue({ kind: "video.import", dedupeKey: "v1" });
  const dup = q.enqueue({ kind: "video.import", dedupeKey: "v1" });
  assert.equal(a, dup, "dedupeKey returns the existing queued job");
  const f = q.enqueue({ kind: "video.import", payload: { fail: true }, maxAttempts: 2 });

  q.start();
  await sleep(3500);
  assert.equal(q.get(a)?.status, "completed");
  assert.equal(q.get(a)?.progress, 100);
  assert.equal(q.get(f)?.status, "failed");
  assert.equal(q.get(f)?.attempts, 2);
  assert.equal(q.get(f)?.error, "boom");
  assert.equal(runs, 3);
  await q.stop();

  // Simulate a crash mid-run: a "running" row with a stale heartbeat.
  db.run(
    "INSERT INTO jobs (id, kind, status, heartbeat_at) VALUES ('stale','video.import','running', strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes'))",
  );
  db.close();
  ({ db } = openDatabase(paths as never));
  const q2 = new JobQueue(db, () => 1);
  q2.start();
  await sleep(50);
  await q2.stop();
  assert.equal(db.get<{ status: string }>("SELECT status FROM jobs WHERE id='stale'")?.status, "queued");
  assert.equal(db.get<{ status: string }>("SELECT status FROM jobs WHERE id=?", a)?.status, "completed");
  db.close();
});
