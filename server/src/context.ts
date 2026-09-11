/**
 * Prediction Ledger — application context (composition root).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import { ensureDataDirs, resolveDataPaths, type DataPaths } from "./config.js";
import { openDatabase, type Database } from "./db/index.js";
import { JobQueue } from "./jobs/queue.js";
import { makeExtractHandler } from "./jobs/handlers/extract.js";
import { makePlanHandler } from "./jobs/handlers/plan.js";
import { SecretStore } from "./security/secrets.js";
import { SettingsService } from "./settings.js";
import { RateLimiter } from "./analysis/structured.js";
import { VideoService } from "./services/videos.js";
import { PredictionService } from "./services/predictions.js";
import { PlanService } from "./services/plans.js";
import { TemplateService } from "./services/templates.js";

export interface AppContext {
  paths: DataPaths;
  db: Database;
  schemaVersion: number;
  secrets: SecretStore;
  settings: SettingsService;
  jobs: JobQueue;
  rateLimiter: RateLimiter;
  videos: VideoService;
  predictions: PredictionService;
  plans: PlanService;
  templates: TemplateService;
}

export function createContext(): AppContext {
  const paths = resolveDataPaths();
  ensureDataDirs(paths);
  const { db, schemaVersion } = openDatabase(paths);
  const secrets = new SecretStore(db, paths.secretKey);
  const settings = new SettingsService(db, secrets, paths.root);
  const jobs = new JobQueue(db, () => settings.getPersisted().limits.concurrency);
  const rateLimiter = new RateLimiter(() => settings.getPersisted().limits.requestsPerMinute);

  const ctx: AppContext = {
    paths,
    db,
    schemaVersion,
    secrets,
    settings,
    jobs,
    rateLimiter,
    videos: new VideoService(db),
    predictions: new PredictionService(db),
    plans: new PlanService(db),
    templates: new TemplateService(db),
  };

  // Job handlers (Release 0.2). Later releases register audio/transcript/research/assessment kinds.
  jobs.register("prediction.extract", makeExtractHandler(ctx));
  jobs.register("plan.generate", makePlanHandler(ctx));
  return ctx;
}
