/**
 * Prediction Ledger — the execution scheduler (1.14, AUTO-01/02/04/05).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * A dedicated loop, separate from the job queue that runs transcription, extraction and research: a slow model or
 * media job can never delay a tick or a cancel. One tick does bounded work — a few `market.match` jobs for new picks
 * (queued, never awaited), a few contract verifications and revalidations, then at most N evaluations across sources
 * (fair share per creator) and at most M live orders — and persists every candidate's outcome, evaluated or not.
 *
 * Live orders happen only when the policy is `auto_live`, the owner's authorization names the *current* policy hash,
 * this process holds the dispatch lease, nothing blocks dispatch, and the decision passed every gate with a
 * production-qualified forecast. Orders go through the same preview → submit path as a manual order (with the
 * automatic indicator), so every guarantee of 1.13 (one send, ambiguity held, no top-ups) applies unchanged.
 * A consumed contract opportunity is never re-entered: not after a fill, an IOC cancel, a re-import, a same-creator
 * video, a policy edit or a restart (EXE-03 / AUTO-02).
 */

import crypto from "node:crypto";
import type { AutomationCandidate, AutomationRun, PredictionMarketLink, TradingMode } from "@prediction-ledger/shared";
import type { AppContext } from "../context.js";
import { ExecutionError } from "./execution.js";
import { DecisionError } from "./tradeDecisions.js";

const CAP_CODES = new Set(["ORDER_BUDGET_ZERO", "MARKET_CAP_REACHED", "TOTAL_RISK_CAP_REACHED", "DAILY_CAP_REACHED", "EVENT_CAP_REACHED", "DAILY_LOSS_STOP", "MAX_OPEN_MARKETS", "BUYING_POWER"]);

interface Candidate { link: PredictionMarketLink; predictionId: string; marketId: string; sourceKey: string; cutoffAt?: string; verificationId?: string }

export class AutoTraderService {
  private readonly now: () => Date;
  private running = false;
  private timer?: NodeJS.Timeout;

  constructor(private readonly ctx: AppContext, opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  // ---- lifecycle ----------------------------------------------------------------------------------------

  start(): void {
    if (this.timer) return;
    const schedule = () => {
      const interval = Math.max(5_000, this.ctx.trading.policy().automation.intervalMs);
      this.timer = setTimeout(() => { void this.tick().catch(() => undefined).finally(schedule); }, interval);
      this.timer.unref?.();
    };
    schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** True when the scheduler would place live orders on its next tick (the gate set of AUTO-01, re-read each time). */
  liveEnabled(): { ok: boolean; reasons: string[] } {
    const p = this.ctx.trading.policy();
    const reasons: string[] = [];
    if (p.mode !== "auto_live") reasons.push(`mode is ${p.mode}`);
    if (!p.liveAuthorizedAt || !p.authorizedPolicyHash) reasons.push("no automation authorization");
    else if (p.authorizedPolicyHash !== p.policyHash) reasons.push("policy changed since the authorization");
    if (!this.ctx.lease.held()) reasons.push("dispatch lease not held by this process");
    if (!this.ctx.settings.getPersisted().privacy.allowInternet) reasons.push("internet access disabled");
    reasons.push(...this.ctx.trading.dispatchBlockers());
    return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
  }

  // ---- one tick -----------------------------------------------------------------------------------------

  async tick(opts: { now?: string } = {}): Promise<AutomationRun> {
    const startedAt = opts.now ?? this.now().toISOString();
    const policy = this.ctx.trading.policy();
    const runId = crypto.randomUUID();
    const run: AutomationRun = { id: runId, startedAt, holder: this.ctx.lease.holder, mode: policy.mode, policyHash: policy.policyHash, outcome: "completed", candidates: 0, evaluated: 0, ordered: 0, skipped: {}, notes: [] };
    const skip = (reason: string) => { run.skipped[reason] = (run.skipped[reason] ?? 0) + 1; };
    if (this.running) { run.outcome = "skipped"; run.reason = "a tick is already running"; return this.persistRun(run); }
    this.running = true;
    try {
      const live = this.liveEnabled();
      const paperAutopilot = policy.mode === "paper" && policy.automation.paperAutopilot;
      if (!live.ok && !paperAutopilot) {
        run.outcome = "skipped";
        run.reason = policy.mode === "auto_live" ? `not dispatching: ${live.reasons.join("; ")}` : `mode ${policy.mode}${policy.mode === "paper" ? " (paper autopilot off)" : ""}`;
        return this.persistRun(run);
      }
      const accountKey = policy.mode === "auto_live" ? this.ctx.trading.connected()!.id : "paper";
      // Fresh account state first (AUTO-05: a stale sync is an alert, not a silent skip).
      if (policy.mode === "auto_live") {
        const age = this.ctx.trading.syncAgeSeconds();
        if (age === undefined || age * 1000 > policy.limits.syncMaxAgeMs) {
          try { await this.ctx.trading.sync(); this.ctx.tradingAlerts.resolve(`stale_sync:${accountKey}`); }
          catch (err) { this.ctx.tradingAlerts.raise("stale_sync", `stale_sync:${accountKey}`, `Account sync failed: ${(err as Error).message.slice(0, 200)}. No order is placed on stale account state.`, { subject: accountKey }); run.outcome = "skipped"; run.reason = "account sync failed; state stale"; return this.persistRun(run); }
        }
      }
      // Bounded discovery: queue matching for new picks, verify unverified links, revalidate old verifications.
      this.discover(run, startedAt, skip);
      // Evaluate candidates fairly across sources, then dispatch within the order budget.
      const candidates = this.candidates(accountKey, startedAt, run, skip);
      run.candidates += candidates.length;
      const perSource = new Map<string, number>();
      const a = policy.automation;
      for (const c of candidates) {
        if (run.evaluated >= a.maxEvaluationsPerTick) { this.record(run, c, "skipped", "tick_evaluation_budget"); skip("tick_evaluation_budget"); continue; }
        const used = perSource.get(c.sourceKey) ?? 0;
        if (used >= a.maxPerSourcePerTick) { this.record(run, c, "skipped", "source_budget"); skip("source_budget"); continue; }
        perSource.set(c.sourceKey, used + 1);
        // Re-check the gate set before every single order: a disarm, pause, hold or lease loss mid-tick stops the tick.
        if (policy.mode === "auto_live") { const g = this.liveEnabled(); if (!g.ok) { run.notes.push(`stopped mid-tick: ${g.reasons.join("; ")}`); this.record(run, c, "skipped", "stopped_mid_tick"); skip("stopped_mid_tick"); break; } }
        let decisionId: string | undefined;
        try {
          const d = await this.ctx.decisions.evaluate({ predictionId: c.predictionId, linkId: c.link.id, now: startedAt });
          decisionId = d.id;
          run.evaluated++;
          const capHit = d.reasonCodes.find((code) => CAP_CODES.has(code));
          if (capHit) this.ctx.tradingAlerts.raise("risk_limit", `risk_limit:${capHit}:${d.dailyBucket}`, `A risk limit blocked an evaluation today: ${capHit}.`, { subject: capHit, details: { decisionId: d.id, reasonCodes: d.reasonCodes } });
          if (d.outcome !== "eligible") { this.record(run, c, "evaluated", `${d.outcome}:${d.reasonCodes.join(",") || "no_reason"}`, d.id); continue; }
          if (policy.mode !== "auto_live") { this.record(run, c, "evaluated", "paper_dispatched", d.id, d.intentId); continue; }
          if (run.ordered >= a.maxOrdersPerTick) { this.record(run, c, "evaluated", "tick_order_budget", d.id); skip("tick_order_budget"); continue; }
          const preview = await this.ctx.execution.preview(d.id);
          const intent = await this.ctx.execution.submit(preview.id, { decisionHash: d.rationaleHash });
          run.ordered++;
          this.record(run, c, "ordered", intent.state, d.id, intent.id);
          if (intent.state === "submission_unknown" || intent.state === "rejected_local") { run.notes.push(`intent ${intent.id.slice(0, 8)} ended ${intent.state}: ${intent.unknownReason ?? intent.lastError ?? ""}`); }
        } catch (err) {
          const code = err instanceof ExecutionError || err instanceof DecisionError ? err.code : "error";
          this.record(run, c, "skipped", `${code}:${(err as Error).message.slice(0, 160)}`, decisionId);
          skip(code);
          run.notes.push(`${c.predictionId.slice(0, 8)}: ${code} ${(err as Error).message.slice(0, 120)}`);
          if (code === "dispatch_blocked" || code === "mode_not_live" || code === "not_authorized") break;
        }
      }
      return this.persistRun(run);
    } catch (err) {
      run.outcome = "failed";
      run.reason = (err as Error).message.slice(0, 300);
      return this.persistRun(run);
    } finally {
      this.running = false;
    }
  }

  // ---- discovery (bounded, never awaited when it is a job) ---------------------------------------------------

  private discover(run: AutomationRun, now: string, skip: (r: string) => void): void {
    const a = this.ctx.trading.policy().automation;
    const settings = this.ctx.settings.getPersisted();
    const usEnabled = settings.markets.enabled && settings.markets.venues.includes("polymarket_us") && settings.privacy.allowInternet;
    // 1. New sports picks from subscription sources with no US link at all → market.match (deduped by the queue).
    if (usEnabled && a.maxMatchJobsPerTick > 0) {
      const fresh = this.ctx.db.all<{ id: string }>(
        `SELECT p.id FROM predictions p JOIN videos v ON v.id = p.video_id
         WHERE p.kind = 'sports_pick' AND p.user_status NOT IN ('dismissed','merged') AND v.subscription_id IS NOT NULL
           AND (p.deadline_date IS NULL OR p.deadline_date >= ?)
           AND NOT EXISTS (SELECT 1 FROM prediction_market_links l JOIN markets m ON m.id = l.market_id WHERE l.prediction_id = p.id AND m.provider = 'polymarket_us')
           AND NOT EXISTS (SELECT 1 FROM automation_candidates ac WHERE ac.prediction_id = p.id AND ac.reason = 'market_match_queued' AND ac.at >= ?)
         ORDER BY p.created_at DESC LIMIT ?`, now.slice(0, 10), new Date(Date.parse(now) - 6 * 3_600_000).toISOString(), a.maxMatchJobsPerTick,
      );
      for (const r of fresh) {
        this.ctx.jobs.enqueue({ kind: "market.match", subjectType: "prediction", subjectId: r.id, payload: { predictionId: r.id, limit: 5 }, dedupeKey: `market.match:${r.id}`, maxAttempts: 1 });
        this.record(run, { predictionId: r.id, sourceKey: "discovery" }, "queued_work", "market_match_queued");
      }
    }
    // 2. Accepted US links never verified → run the checklist (computed; status derived, never asserted).
    const unverified = this.ctx.db.all<{ id: string; prediction_id: string }>(
      `SELECT l.id, l.prediction_id FROM prediction_market_links l JOIN markets m ON m.id = l.market_id
       WHERE l.status = 'accepted' AND m.provider = 'polymarket_us' AND l.verification_id IS NULL ORDER BY l.created_at DESC LIMIT ?`, a.maxVerificationsPerTick,
    );
    let verifications = 0;
    for (const l of unverified) {
      try { const v = this.ctx.contracts.verifyLink(l.id, { reviewer: "app" }); verifications++; this.record(run, { predictionId: l.prediction_id, linkId: l.id, sourceKey: "discovery" }, "queued_work", `verified:${v.status}`); }
      catch (err) { skip("verify_failed"); run.notes.push(`verify ${l.id.slice(0, 8)}: ${(err as Error).message.slice(0, 120)}`); }
    }
    // 3. Verified links whose verification is older than the revalidation window → revalidate against the venue (MAT-06).
    if (usEnabled && verifications < a.maxVerificationsPerTick) {
      const stale = this.ctx.db.all<{ id: string; prediction_id: string }>(
        `SELECT l.id, l.prediction_id FROM prediction_market_links l JOIN contract_verifications cv ON cv.id = l.verification_id
         WHERE l.status = 'accepted' AND l.verification_status = 'verified_equivalent' AND cv.created_at < ? ORDER BY cv.created_at ASC LIMIT ?`,
        new Date(Date.parse(now) - a.revalidateAfterMs).toISOString(), a.maxVerificationsPerTick - verifications,
      );
      for (const l of stale) {
        void this.ctx.contracts.revalidateLink(l.id, { refresh: true }).then((r) => { if (r.verification && r.verification.status !== "verified_equivalent") this.ctx.trading.audit("automation.link_stale", undefined, { linkId: l.id, reasons: r.reasons }); }).catch(() => undefined);
        this.record(run, { predictionId: l.prediction_id, linkId: l.id, sourceKey: "discovery" }, "queued_work", "revalidation_queued");
      }
    }
  }

  // ---- candidates -----------------------------------------------------------------------------------------

  private candidates(accountKey: string, now: string, run: AutomationRun, skip: (r: string) => void): Candidate[] {
    const a = this.ctx.trading.policy().automation;
    const buffer = this.ctx.trading.policy().limits.preEventBufferMs;
    const rows = this.ctx.db.all<{ link_id: string; prediction_id: string; market_id: string; venue_id: string; channel_id: string | null; channel: string | null; video_id: string; cutoff_at: string | null; cutoff_unknown: number; verification_id: string; resolved: number; closed: number; active: number }>(
      `SELECT l.id AS link_id, l.prediction_id, l.market_id, m.venue_id, v.channel_id, v.channel, v.id AS video_id, cv.cutoff_at, cv.cutoff_unknown, cv.id AS verification_id, m.resolved, m.closed, m.active
       FROM prediction_market_links l JOIN markets m ON m.id = l.market_id JOIN predictions p ON p.id = l.prediction_id JOIN videos v ON v.id = p.video_id JOIN contract_verifications cv ON cv.id = l.verification_id
       WHERE l.status = 'accepted' AND l.verification_status = 'verified_equivalent' AND m.provider = 'polymarket_us' AND p.user_status NOT IN ('dismissed','merged')
       ORDER BY cv.created_at DESC`,
    );
    const out: Candidate[] = [];
    const seenMarkets = new Set<string>();
    for (const r of rows) {
      const c: Candidate = { link: { id: r.link_id } as PredictionMarketLink, predictionId: r.prediction_id, marketId: r.market_id, sourceKey: r.channel_id ?? r.channel ?? `video:${r.video_id}`, cutoffAt: r.cutoff_at ?? undefined, verificationId: r.verification_id };
      if (r.resolved || r.closed || !r.active) { this.record(run, c, "skipped", "market_not_open"); skip("market_not_open"); continue; }
      if (r.cutoff_unknown || !r.cutoff_at) { this.record(run, c, "skipped", "cutoff_unknown"); skip("cutoff_unknown"); continue; }
      // AUTO-04: never a catch-up bet — an event whose cutoff (minus the buffer) passed is not evaluated at all.
      if (Date.parse(r.cutoff_at) - buffer <= Date.parse(now)) { this.record(run, c, "skipped", "cutoff_passed"); skip("cutoff_passed"); continue; }
      // EXE-03 / AUTO-02: one entry opportunity per contract, ever, regardless of which prediction or video points at it.
      if (this.ctx.risk.opportunityConsumed(accountKey, "polymarket_us", r.venue_id)) { this.record(run, c, "skipped", "opportunity_consumed"); skip("opportunity_consumed"); continue; }
      if (seenMarkets.has(r.venue_id)) { this.record(run, c, "skipped", "contract_already_queued"); skip("contract_already_queued"); continue; }
      const openIntent = this.ctx.db.get<{ id: string }>("SELECT id FROM trade_intents WHERE account_key = ? AND venue_market_id = ? AND state IN ('reserved','submitting','acknowledged','submission_unknown')", accountKey, r.venue_id);
      if (openIntent) { this.record(run, c, "skipped", "intent_open"); skip("intent_open"); continue; }
      // Re-evaluation window, unless the contract verification changed since the last decision.
      const last = this.ctx.db.get<{ clock_at: string; verification_id: string | null }>("SELECT clock_at, verification_id FROM trade_decisions WHERE prediction_id = ? AND mode = ? ORDER BY clock_at DESC LIMIT 1", r.prediction_id, this.ctx.trading.policy().mode);
      if (last && last.verification_id === r.verification_id && Date.parse(now) - Date.parse(last.clock_at) < a.minReevaluateMs) { this.record(run, c, "skipped", "reevaluate_window"); skip("reevaluate_window"); continue; }
      seenMarkets.add(r.venue_id);
      out.push(c);
    }
    return out;
  }

  // ---- persistence ------------------------------------------------------------------------------------------

  private record(run: AutomationRun, c: { predictionId: string; linkId?: string; link?: PredictionMarketLink; marketId?: string; sourceKey: string }, outcome: AutomationCandidate["outcome"], reason: string, decisionId?: string, intentId?: string): void {
    this.ctx.db.run(
      "INSERT INTO automation_candidates (id, run_id, prediction_id, link_id, market_id, source_key, outcome, reason, decision_id, intent_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(), run.id, c.predictionId, c.linkId ?? c.link?.id ?? null, c.marketId ?? null, c.sourceKey, outcome, reason.slice(0, 300), decisionId ?? null, intentId ?? null, this.now().toISOString(),
    );
  }

  private persistRun(run: AutomationRun): AutomationRun {
    run.finishedAt = this.now().toISOString();
    this.ctx.db.run(
      "INSERT INTO automation_runs (id, started_at, finished_at, holder, mode, policy_hash, outcome, reason, candidates, evaluated, ordered, skipped_json, notes_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      run.id, run.startedAt, run.finishedAt, run.holder, run.mode, run.policyHash, run.outcome, run.reason ?? null, run.candidates, run.evaluated, run.ordered, JSON.stringify(run.skipped), JSON.stringify(run.notes),
    );
    if (run.outcome !== "skipped" || run.candidates > 0) this.ctx.trading.audit("automation.tick", this.ctx.trading.connected()?.id, { runId: run.id, mode: run.mode, outcome: run.outcome, reason: run.reason, candidates: run.candidates, evaluated: run.evaluated, ordered: run.ordered, skipped: run.skipped });
    return run;
  }

  runs(limit = 50): AutomationRun[] {
    return this.ctx.db.all<{ id: string; started_at: string; finished_at: string | null; holder: string; mode: TradingMode; policy_hash: string; outcome: AutomationRun["outcome"]; reason: string | null; candidates: number; evaluated: number; ordered: number; skipped_json: string; notes_json: string }>("SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT ?", limit)
      .map((r) => ({ id: r.id, startedAt: r.started_at, finishedAt: r.finished_at ?? undefined, holder: r.holder, mode: r.mode, policyHash: r.policy_hash, outcome: r.outcome, reason: r.reason ?? undefined, candidates: r.candidates, evaluated: r.evaluated, ordered: r.ordered, skipped: JSON.parse(r.skipped_json) as Record<string, number>, notes: JSON.parse(r.notes_json) as string[] }));
  }

  candidatesFor(runId: string): AutomationCandidate[] {
    return this.ctx.db.all<{ id: string; run_id: string; prediction_id: string; link_id: string | null; market_id: string | null; source_key: string; outcome: AutomationCandidate["outcome"]; reason: string; decision_id: string | null; intent_id: string | null; at: string }>("SELECT * FROM automation_candidates WHERE run_id = ? ORDER BY at", runId)
      .map((r) => ({ id: r.id, runId: r.run_id, predictionId: r.prediction_id, linkId: r.link_id ?? undefined, marketId: r.market_id ?? undefined, sourceKey: r.source_key, outcome: r.outcome, reason: r.reason, decisionId: r.decision_id ?? undefined, intentId: r.intent_id ?? undefined, at: r.at }));
  }
}
