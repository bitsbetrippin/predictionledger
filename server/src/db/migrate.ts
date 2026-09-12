/**
 * Prediction Ledger — forward-only SQL migration runner.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Migrations are plain .sql files in ./migrations named NNN_description.sql and are
 * applied in numeric order inside a transaction. Applied versions are recorded in
 * `schema_migrations`. There are no "down" migrations — the app makes a backup copy
 * of the database file before applying anything new (see docs/ARCHITECTURE.md §5.4).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Migrations live next to this file in src/. The build copies them into dist/db/migrations
 * (scripts/copy-migrations.mjs); as a safety net, fall back to the source tree so a build that
 * skipped the copy still starts instead of failing with ENOENT (first-run finding, rc.2).
 */
function resolveMigrationsDir(): string {
  const candidates = [path.join(here, "migrations"), path.resolve(here, "..", "..", "src", "db", "migrations")];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`Migration files not found. Looked in:\n  ${candidates.join("\n  ")}\nRun \`npm run build\` again.`);
}
const migrationsDir = resolveMigrationsDir();

interface MigrationFile {
  version: number;
  name: string;
  sql: string;
}

function loadMigrations(): MigrationFile[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => {
      const match = /^(\d+)_(.+)\.sql$/.exec(f);
      if (!match) throw new Error(`Migration file name not in NNN_name.sql form: ${f}`);
      return {
        version: Number.parseInt(match[1], 10),
        name: match[2],
        sql: fs.readFileSync(path.join(migrationsDir, f), "utf8"),
      };
    })
    .sort((a, b) => a.version - b.version);
}

/**
 * Apply pending migrations; returns the resulting schema version.
 * When `backup` is given and at least one migration is pending, the database file is copied
 * to `<backupDir>/<timestamp>-pre-<version>.db` first (RT-04). Callers pass the file path
 * only for on-disk databases (never for ":memory:").
 */
export function runMigrations(db: Database, backup?: { databasePath: string; backupDir: string }): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`);

  const applied = new Set(db.all<{ version: number }>("SELECT version FROM schema_migrations").map((r) => r.version));
  let current = applied.size ? Math.max(...applied) : 0;
  const migrations = loadMigrations();
  const pending = migrations.filter((m) => !applied.has(m.version));

  if (backup && pending.length > 0 && current > 0 && fs.existsSync(backup.databasePath)) {
    fs.mkdirSync(backup.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(backup.backupDir, `${stamp}-pre-${String(pending[0].version).padStart(3, "0")}.db`);
    // Checkpoint WAL so the copy is a complete, consistent snapshot.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    fs.copyFileSync(backup.databasePath, target);
    // eslint-disable-next-line no-console
    console.log(`[db] backup written before migration: ${target}`);
  }

  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.run("INSERT INTO schema_migrations (version, name) VALUES (?, ?)", m.version, m.name);
    });
    current = m.version;
    // eslint-disable-next-line no-console
    console.log(`[db] applied migration ${String(m.version).padStart(3, "0")}_${m.name}`);
  }
  return current;
}
