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

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

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

/** Apply pending migrations; returns the resulting schema version. */
export function runMigrations(db: Database): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`);

  const applied = new Set(db.all<{ version: number }>("SELECT version FROM schema_migrations").map((r) => r.version));
  let current = applied.size ? Math.max(...applied) : 0;

  for (const m of loadMigrations()) {
    if (applied.has(m.version)) continue;
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
