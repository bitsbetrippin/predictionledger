/**
 * Prediction Ledger — application context (composition root).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import { ensureDataDirs, resolveDataPaths, type DataPaths } from "./config.js";
import { openDatabase, type Database } from "./db/index.js";
import { JobQueue } from "./jobs/queue.js";
import { SecretStore } from "./security/secrets.js";
import { SettingsService } from "./settings.js";

export interface AppContext {
  paths: DataPaths;
  db: Database;
  schemaVersion: number;
  secrets: SecretStore;
  settings: SettingsService;
  jobs: JobQueue;
}

export function createContext(): AppContext {
  const paths = resolveDataPaths();
  ensureDataDirs(paths);
  const { db, schemaVersion } = openDatabase(paths);
  const secrets = new SecretStore(db, paths.secretKey);
  const settings = new SettingsService(db, secrets, paths.root);
  const jobs = new JobQueue(db, () => settings.getPersisted().limits.concurrency);
  return { paths, db, schemaVersion, secrets, settings, jobs };
}
