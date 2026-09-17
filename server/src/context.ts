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
import { SubscriptionService, makeSubscriptionPollHandler, type VideoLister } from "./services/subscriptions.js";
import { ContractService } from "./services/contracts.js";
import { ForecastService } from "./services/forecasts.js";
import { RiskService } from "./services/riskReservations.js";
import { PaperUsService } from "./services/paperUs.js";
import { TradeDecisionService } from "./services/tradeDecisions.js";
import { DispatchLeaseService } from "./services/dispatchLease.js";
import { ExecutionService, type FaultInjector } from "./services/execution.js";
import { TradingAlertService } from "./services/tradingAlerts.js";
import { TradeLedgerService } from "./services/ledger.js";
import { AutoTraderService } from "./services/autoTrader.js";
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
  /** 1.11: saved channel/playlist subscriptions and contract verification. */
  subscriptions: SubscriptionService;
  contracts: ContractService;
  /** 1.12: immutable forecasts, risk reservations, US paper book and decisions (paper dispatch; the live path is `execution`). */
  forecasts: ForecastService;
  risk: RiskService;
  paperUs: PaperUsService;
  decisions: TradeDecisionService;
  /** 1.13: one dispatcher per data directory and the manual-live execution path (preview → confirm → reconcile). */
  lease: DispatchLeaseService;
  execution: ExecutionService;
  /** 1.14: local trading alerts (deduped by incident), the Trades ledger/summary/metrics, and the execution scheduler. */
  tradingAlerts: TradingAlertService;
  ledger: TradeLedgerService;
  autoTrader: AutoTraderService;
  fetcher: SourceFetcher;
  /** Builds the transcription engine selected in Setup (or a test override). */
  transcription: () => TranscriptionProvider;
}

export function createContext(overrides: Partial<Pick<AppContext, "fetcher" | "transcription">> & { lister?: VideoLister; now?: () => Date; faults?: FaultInjector; leaseHolder?: string } = {}): AppContext {
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
    trading: new TradingAccountService(db, secrets.openVault("trading."), () => createTradingAdapter("polymarket_us"), { allowInternet: () => settings.getPersisted().privacy.allowInternet, now: overrides.now }),
    subscriptions: new SubscriptionService(db),
    contracts: undefined as unknown as ContractService,
    forecasts: undefined as unknown as ForecastService,
    risk: new RiskService(db),
    paperUs: new PaperUsService(db),
    decisions: undefined as unknown as TradeDecisionService,
    lease: new DispatchLeaseService(db, overrides.now, overrides.leaseHolder),
    execution: undefined as unknown as ExecutionService,
    tradingAlerts: undefined as unknown as TradingAlertService,
    ledger: undefined as unknown as TradeLedgerService,
    autoTrader: undefined as unknown as AutoTraderService,
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

  ctx.contracts = new ContractService(ctx);
  ctx.forecasts = new ForecastService(ctx);
  ctx.decisions = new TradeDecisionService(ctx, { now: overrides.now });
  ctx.execution = new ExecutionService(ctx, { now: overrides.now, faults: overrides.faults });
  // Alerts never see secrets: every message and detail is redacted against the trading vault's material before storage.
  ctx.tradingAlerts = new TradingAlertService(db, overrides.now, (text) => ctx.trading.redact(text));
  ctx.ledger = new TradeLedgerService(ctx, overrides.now);
  ctx.autoTrader = new AutoTraderService(ctx, { now: overrides.now });
  ctx.trading.onBreakerOpened = (state, code) => ctx.tradingAlerts.raise("circuit_breaker", `circuit_breaker:${state.incidentId ?? state.openedAt}`, `Circuit breaker opened after ${state.consecutiveFailures} consecutive adapter failures (${code ?? "unknown"}). New orders stop; reads and cancels keep working; nothing re-arms by itself.`, { details: { code, failures: state.consecutiveFailures } });
  ctx.trading.onDisarmed = (reason, previousMode) => ctx.tradingAlerts.raise("disarmed", `disarmed:${reason}:${previousMode}`, `Trading disarmed (was ${previousMode}): ${reason}. Reconcile, then re-arm deliberately.`, { severity: "warning", details: { reason, previousMode } });

  // Job handlers (Release 0.2). Later releases register audio/transcript/research/assessment kinds.
  jobs.register("prediction.extract", makeExtractHandler(ctx));
  jobs.register("subscription.poll", makeSubscriptionPollHandler(ctx, overrides.lister));
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
