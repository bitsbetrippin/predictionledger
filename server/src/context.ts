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
import { makeResearchHandler } from "./jobs/handlers/research.js";
import { makeGameHandler } from "./jobs/handlers/game.js";
import { makeMarketBackfillHandler, makeMarketMatchHandler, makeMarketSnapshotHandler } from "./jobs/handlers/markets.js";
import { makeAssessHandler } from "./jobs/handlers/assess.js";
import { SecretStore } from "./security/secrets.js";
import { SettingsService } from "./settings.js";
import { RateLimiter } from "./analysis/structured.js";
import { VideoService } from "./services/videos.js";
import { PredictionService } from "./services/predictions.js";
import { PlanService } from "./services/plans.js";
import { TemplateService } from "./services/templates.js";
import { ResearchService } from "./services/research.js";
import { GameService } from "./services/games.js";
import { MarketService } from "./services/markets.js";
import { SignalService } from "./services/signals.js";
import { AlertService } from "./services/alerts.js";
import { ConsensusService } from "./services/consensus.js";
import { PaperService } from "./services/paper.js";
import { makeMarketWatchHandler } from "./jobs/handlers/watch.js";
import { makePlaylistImportHandler } from "./youtube/playlist.js";
import { TradingAccountService } from "./services/tradingAccounts.js";
import { createTradingAdapter } from "./providers/trading/registry.js";
import { GuardedFetcher, type SourceFetcher } from "./research/fetcher.js";
import { makeAudioExtractHandler, makeModelDownloadHandler, makeTranscribeHandler } from "./jobs/handlers/media.js";
import { LocalWhisperProvider, OpenAiTranscriptionProvider, type TranscriptionProvider } from "./media/transcription.js";
import { SECRET_NAMES } from "./settings.js";
import { makeToolInstallHandler, makeYouTubeImportHandler } from "./youtube/importer.js";

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
  research: ResearchService;
  /** 1.4: game records shared by every pick on a matchup. */
  games: GameService;
  /** 1.6: prediction markets, snapshots, links. */
  markets: MarketService;
  /** 1.7: creator records and market-side signals (computed on read). */
  signals: SignalService;
  /** 1.8: watch-rule alerts and cross-channel consensus. */
  alerts: AlertService;
  consensus: ConsensusService;
  /** 1.9: paper-trading ledger (hypothetical positions; never orders). */
  paper: PaperService;
  /** 1.10: Polymarket US account connection (reads only; owns the trading secret vault). */
  trading: TradingAccountService;
  fetcher: SourceFetcher;
  /** Builds the transcription engine selected in Setup (or a test override). */
  transcription: () => TranscriptionProvider;
}

export function createContext(overrides: Partial<Pick<AppContext, "fetcher" | "transcription">> = {}): AppContext {
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
    research: new ResearchService(db, paths.artifacts),
    games: new GameService(db),
    markets: new MarketService(db),
    signals: new SignalService(db),
    alerts: new AlertService(db),
    consensus: new ConsensusService(db, new SignalService(db)),
    paper: new PaperService(db),
    // The vault handle is created here and handed to exactly one service; nothing else can read trading.* secrets.
    trading: new TradingAccountService(db, secrets.openVault("trading."), () => createTradingAdapter("polymarket_us"), { allowInternet: () => settings.getPersisted().privacy.allowInternet }),
    fetcher: overrides.fetcher ?? new GuardedFetcher(),
    transcription:
      overrides.transcription ??
      (() => {
        const s = settings.getPersisted();
        const allow = () => settings.getPersisted().privacy.allowInternet;
        if (s.transcription.engine === "openai-transcribe") return new OpenAiTranscriptionProvider(() => secrets.get(SECRET_NAMES.llm("openai")), s.transcription.openaiModel, allow);
        return new LocalWhisperProvider(s.transcription.localModel, paths.models, allow);
      }),
  };

  // Job handlers (Release 0.2). Later releases register audio/transcript/research/assessment kinds.
  jobs.register("prediction.extract", makeExtractHandler(ctx));
  jobs.register("plan.generate", makePlanHandler(ctx));
  jobs.register("research.run", makeResearchHandler(ctx));
  jobs.register("sports.resolve_game", makeGameHandler(ctx));
  jobs.register("market.snapshot", makeMarketSnapshotHandler(ctx));
  jobs.register("market.match", makeMarketMatchHandler(ctx));
  jobs.register("market.backfill", makeMarketBackfillHandler(ctx));
  jobs.register("market.watch", makeMarketWatchHandler(ctx));
  jobs.register("playlist.import", makePlaylistImportHandler(ctx));
  jobs.register("assessment.run", makeAssessHandler(ctx));
  jobs.register("audio.extract", makeAudioExtractHandler(ctx));
  jobs.register("transcript.generate", makeTranscribeHandler(ctx));
  jobs.register("video.import", makeYouTubeImportHandler(ctx));
  jobs.register("tool.install", makeToolInstallHandler(ctx));
  jobs.register("model.download", makeModelDownloadHandler(ctx));

  // Research runs interrupted by a crash: the job queue re-runs the job, which creates a new run.
  const orphaned = ctx.research.failOrphanedRuns();
  if (orphaned) console.log(`[research] marked ${orphaned} interrupted run(s) as failed`);
  // 1.10 (OPS-02): a restored database never comes up armed or "connected" without its credentials.
  const boot = ctx.trading.startupCheck();
  if (boot.needsRebind) console.log("[trading] Polymarket US binding needs rebind: credentials are not in this data directory (restored backup?)");
  if (boot.disarmed) console.log("[trading] live trading mode found in the database was reset to paper at startup");
  return ctx;
}
