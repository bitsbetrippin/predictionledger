/**
 * Prediction Ledger — SQLite access layer.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Uses the built-in `node:sqlite` module (no native compile step, no extra binary).
 * As of Node 26.8 the module is "Release Candidate" stability; it has not needed the
 * --experimental-sqlite flag since Node 22.13. Every query in the codebase goes through
 * this file's small wrapper so the driver could be swapped (e.g. better-sqlite3) in one
 * place if that ever becomes necessary.
 */

import { DatabaseSync } from "node:sqlite";
import type { DataPaths } from "../config.js";
import { runMigrations } from "./migrate.js";

export type Row = Record<string, unknown>;

export class Database {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath);
    // WAL gives crash-safe durability with good concurrent read performance
    // for the single-process, single-user model this app targets.
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, ...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.db.prepare(sql).run(...(params as never[]));
  }

  get<T extends object = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  all<T extends object = Row>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  /** Run `fn` inside a transaction; rolls back on throw. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

/** Open the database and bring the schema up to date. */
export function openDatabase(paths: DataPaths): { db: Database; schemaVersion: number } {
  const db = new Database(paths.database);
  const schemaVersion = runMigrations(db);
  return { db, schemaVersion };
}
