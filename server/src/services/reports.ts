/**
 * Prediction Ledger — release reports (2.0): the paper-soak report (O07) and the strategy/category qualification
 * report (FOR-06/07). Both are derived read-only from the database and say plainly when the evidence is insufficient.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Neither report can turn a fixture, a green test or a short run into evidence: the soak report checks the O07
 * thresholds (7 calendar days, ≥ 100 evaluations, ≥ 10 events, zero duplicate entries, zero cap breaches, every intent
 * explained) and the qualification report checks the FOR-06 gate (≥ 100 settled held-out events, Brier no worse than
 * the market baseline, ≥ 20 usable observations per weighted creator, two independent clusters). "Pending" is a
 * result; it is never rounded up to "qualified".
 */

import type { ForecastEvaluation } from "@prediction-ledger/shared";
import type { AppContext } from "../context.js";
import { D, Dec, dsum } from "../analysis/decimal.js";

export interface SoakReport {
  generatedAt: string;
  window: { from: string; to: string; calendarDays: number; daysWithActivity: number };
  mode: { paper: number; live: number };
  ticks: { total: number; completed: number; skipped: number; failed: number; skippedReasons: Record<string, number> };
  evaluations: { candidates: number; evaluated: number; ordered: number; reasons: Record<string, number> };
  decisions: { total: number; eligible: number; skipped: number; needsReview: number; reasonCodes: Record<string, number>; missingData: number; abstentionRate?: number };
  events: { distinctContracts: number; distinctEvents: number };
  intents: { byState: Record<string, number>; unexplained: { id: string; state: string; ageHours: number }[]; unknownResolved: number; unknownOpen: number };
  duplicates: { accountMarketPairsWithMultipleEntries: { accountKey: string; venueMarketId: string; entries: number }[] };
  capChecks: { orderBudgetBreaches: number; dailyCapBreaches: { bucket: string; committed: string; cap: string }[]; openMarketsMax: number; openMarketsLimit: number };
  faults: { alertsByKind: Record<string, number>; breakerOpened: number; restarts: number; disarms: number; emergencyStops: number; leaseHolders: number };
  paper: { positions: number; settled: number; wins: number; losses: number; voids: number; pnl: string; fees: string };
  thresholds: { sevenCalendarDays: boolean; hundredEvaluations: boolean; tenEvents: boolean; zeroDuplicates: boolean; zeroCapBreaches: boolean; allIntentsExplained: boolean };
  verdict: "complete" | "incomplete";
  shortfalls: string[];
  note: string;
}

export interface QualificationReport {
  generatedAt: string;
  strategyVersion: string;
  category: string;
  asOf: string;
  evaluation: ForecastEvaluation;
  cohort: { decisions: number; settledEvents: number; pendingOrVoid: number; firstDecisionAt?: string; lastDecisionAt?: string; firstOutcomeAt?: string; lastOutcomeAt?: string; heldOut: string };
  exclusions: { reason: string; count: number }[];
  creators: { key: string; observations: number; weighted: boolean }[];
  creatorGate: { minObservations: number; below: string[]; independentClustersMedian?: number };
  paper: { positions: number; settled: number; feeAdjustedReturn: string; fees: string; maxDrawdown?: number };
  status: "qualified" | "pending" | "failed";
  eventsNeeded: number;
  productionRecord?: { id: string; createdAt: string; qualified: boolean };
  statement: string;
}

const MIN_EVENTS = 100;
const MIN_CREATOR_OBS = 20;

export class ReportService {
  constructor(private readonly ctx: AppContext, private readonly now: () => Date = () => new Date()) {}

  // ---- O07 paper soak --------------------------------------------------------------------------------------

  soak(o: { from?: string; to?: string } = {}): SoakReport {
    const db = this.ctx.db;
    const generatedAt = this.now().toISOString();
    const first = db.get<{ at: string | null }>("SELECT MIN(started_at) AS at FROM automation_runs")?.at ?? undefined;
    const from = o.from ?? first ?? generatedAt;
    const to = o.to ?? generatedAt;
    const runs = db.all<{ started_at: string; mode: string; outcome: string; reason: string | null; candidates: number; evaluated: number; ordered: number; skipped_json: string; holder: string }>("SELECT * FROM automation_runs WHERE started_at >= ? AND started_at <= ? ORDER BY started_at", from, to);
    const days = new Set(runs.map((r) => r.started_at.slice(0, 10)));
    const calendarDays = Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / 86_400_000)) + (runs.length ? 1 : 0);
    const skippedReasons: Record<string, number> = {};
    for (const r of runs) for (const [k, v] of Object.entries(JSON.parse(r.skipped_json) as Record<string, number>)) skippedReasons[k] = (skippedReasons[k] ?? 0) + v;
    const cands = db.all<{ outcome: string; reason: string }>("SELECT c.outcome, c.reason FROM automation_candidates c JOIN automation_runs r ON r.id = c.run_id WHERE r.started_at >= ? AND r.started_at <= ?", from, to);
    const reasons: Record<string, number> = {};
    for (const c of cands) { const key = `${c.outcome}:${c.reason.split(":")[0]}`; reasons[key] = (reasons[key] ?? 0) + 1; }
    const decisions = db.all<{ id: string; outcome: string; reason_codes_json: string; venue_market_id: string; event_id: string | null; mode: string; worst_cost: string | null; daily_bucket: string; policy_hash: string }>("SELECT id, outcome, reason_codes_json, venue_market_id, event_id, mode, worst_cost, daily_bucket, policy_hash FROM trade_decisions WHERE created_at >= ? AND created_at <= ?", from, to);
    const reasonCodes: Record<string, number> = {};
    let missingData = 0;
    for (const d of decisions) for (const code of JSON.parse(d.reason_codes_json) as string[]) { reasonCodes[code] = (reasonCodes[code] ?? 0) + 1; if (/MISSING|INSUFFICIENT|STALE|INCOMPLETE/.test(code)) missingData++; }
    const eligible = decisions.filter((d) => d.outcome === "eligible").length;
    const skipped = decisions.filter((d) => d.outcome === "skipped").length;
    const needsReview = decisions.filter((d) => d.outcome === "needs_review").length;
    const policy = this.ctx.trading.policy();
    const budget = D(policy.limits.orderBudget);
    const orderBudgetBreaches = decisions.filter((d) => d.worst_cost && D(d.worst_cost).gt(budget)).length;
    // Daily commitment per bucket from reservations (reserved + filled, released remainders excluded) vs the daily cap.
    const buckets = db.all<{ daily_bucket: string; account_key: string; committed: string }>("SELECT daily_bucket, account_key, SUM(CASE WHEN state = 'reserved' THEN CAST(amount AS REAL) ELSE CAST(filled_amount AS REAL) END) AS committed FROM risk_reservations WHERE created_at >= ? AND created_at <= ? GROUP BY daily_bucket, account_key", from, to);
    const dailyCap = D(policy.limits.dailyCommitmentCap);
    const dailyCapBreaches = buckets.filter((b) => D(String(b.committed)).round(2).gt(dailyCap)).map((b) => ({ bucket: `${b.daily_bucket}/${b.account_key}`, committed: D(String(b.committed)).round(2).toString(), cap: dailyCap.toString() }));
    const openMarketsMax = db.get<{ n: number }>("SELECT COUNT(DISTINCT venue_market_id) AS n FROM paper_us_positions WHERE status = 'open'")?.n ?? 0;
    const intents = db.all<{ id: string; state: string; updated_at: string; account_key: string; venue_market_id: string; provider: string }>("SELECT id, state, updated_at, account_key, venue_market_id, provider FROM trade_intents WHERE created_at >= ? AND created_at <= ?", from, to);
    const byState: Record<string, number> = {};
    for (const i of intents) byState[i.state] = (byState[i.state] ?? 0) + 1;
    const nowMs = Date.parse(to);
    const unexplained = intents.filter((i) => ["prepared", "reserved", "submitting"].includes(i.state) && nowMs - Date.parse(i.updated_at) > 5 * 60_000).map((i) => ({ id: i.id, state: i.state, ageHours: Math.round((nowMs - Date.parse(i.updated_at)) / 36_000) / 100 }));
    const unknownOpen = intents.filter((i) => i.state === "submission_unknown").length;
    const unknownResolved = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reconciliation_holds WHERE kind = 'submission_unknown' AND resolved_at IS NOT NULL AND opened_at >= ? AND opened_at <= ?", from, to)?.n ?? 0;
    // Duplicate entries: more than one entry-holding intent per (account, market) is the pyramiding the design forbids.
    const entryStates = ["reserved", "submitting", "acknowledged", "submission_unknown", "filled", "partially_filled"];
    const pairs = new Map<string, number>();
    for (const i of intents) if (entryStates.includes(i.state)) { const k = `${i.account_key}|${i.provider}|${i.venue_market_id}`; pairs.set(k, (pairs.get(k) ?? 0) + 1); }
    const dup = [...pairs].filter(([, n]) => n > 1).map(([k, n]) => { const [accountKey, , venueMarketId] = k.split("|"); return { accountKey, venueMarketId, entries: n }; });
    const alerts = db.all<{ kind: string; count: number }>("SELECT kind, SUM(count) AS count FROM trading_alerts WHERE first_at >= ? AND first_at <= ? GROUP BY kind", from, to);
    const alertsByKind: Record<string, number> = {};
    for (const a of alerts) alertsByKind[a.kind] = Number(a.count);
    const audit = (kind: string, where = "") => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM trading_audit_events WHERE kind = ? AND at >= ? AND at <= ? ${where}`, kind, from, to)?.n ?? 0;
    const restarts = audit("trading.disarmed", "AND details_json LIKE '%\"reason\":\"startup\"%'");
    const paper = db.get<{ positions: number; settled: number; wins: number; losses: number; voids: number; pnl: number | null; fees: number | null }>("SELECT COUNT(*) AS positions, SUM(status = 'settled') AS settled, SUM(outcome = 'win') AS wins, SUM(outcome = 'loss') AS losses, SUM(outcome = 'void') AS voids, SUM(CAST(pnl AS REAL)) AS pnl, SUM(CAST(fees AS REAL)) AS fees FROM paper_us_positions WHERE opened_at >= ? AND opened_at <= ?", from, to)!;
    const distinctContracts = new Set(decisions.map((d) => d.venue_market_id)).size;
    const distinctEvents = new Set(decisions.map((d) => d.event_id ?? d.venue_market_id)).size;
    const thresholds = {
      sevenCalendarDays: days.size >= 7,
      hundredEvaluations: decisions.length >= 100,
      tenEvents: distinctEvents >= 10,
      zeroDuplicates: dup.length === 0,
      zeroCapBreaches: orderBudgetBreaches === 0 && dailyCapBreaches.length === 0 && openMarketsMax <= policy.limits.maxOpenMarkets,
      allIntentsExplained: unexplained.length === 0 && unknownOpen === 0,
    };
    const shortfalls: string[] = [];
    if (!thresholds.sevenCalendarDays) shortfalls.push(`${days.size} of 7 calendar days with scheduler activity`);
    if (!thresholds.hundredEvaluations) shortfalls.push(`${decisions.length} of 100 decision evaluations`);
    if (!thresholds.tenEvents) shortfalls.push(`${distinctEvents} of 10 distinct events`);
    if (!thresholds.zeroDuplicates) shortfalls.push(`${dup.length} (account, market) pair(s) with more than one entry`);
    if (!thresholds.zeroCapBreaches) shortfalls.push(`cap breaches: order budget ${orderBudgetBreaches}, daily ${dailyCapBreaches.length}, open markets ${openMarketsMax}/${policy.limits.maxOpenMarkets}`);
    if (!thresholds.allIntentsExplained) shortfalls.push(`${unexplained.length} stuck intent(s), ${unknownOpen} unresolved unknown submission(s)`);
    return {
      generatedAt, window: { from, to, calendarDays, daysWithActivity: days.size },
      mode: { paper: runs.filter((r) => r.mode === "paper").length, live: runs.filter((r) => r.mode === "auto_live").length },
      ticks: { total: runs.length, completed: runs.filter((r) => r.outcome === "completed").length, skipped: runs.filter((r) => r.outcome === "skipped").length, failed: runs.filter((r) => r.outcome === "failed").length, skippedReasons },
      evaluations: { candidates: cands.length, evaluated: runs.reduce((n, r) => n + r.evaluated, 0), ordered: runs.reduce((n, r) => n + r.ordered, 0), reasons },
      decisions: { total: decisions.length, eligible, skipped, needsReview, reasonCodes, missingData, abstentionRate: decisions.length ? Math.round((skipped / decisions.length) * 1000) / 1000 : undefined },
      events: { distinctContracts, distinctEvents },
      intents: { byState, unexplained, unknownResolved, unknownOpen },
      duplicates: { accountMarketPairsWithMultipleEntries: dup },
      capChecks: { orderBudgetBreaches, dailyCapBreaches, openMarketsMax, openMarketsLimit: policy.limits.maxOpenMarkets },
      faults: { alertsByKind, breakerOpened: audit("breaker.opened"), restarts, disarms: audit("trading.disarmed"), emergencyStops: audit("trading.emergency_stop"), leaseHolders: new Set(runs.map((r) => r.holder)).size },
      paper: { positions: paper.positions, settled: Number(paper.settled ?? 0), wins: Number(paper.wins ?? 0), losses: Number(paper.losses ?? 0), voids: Number(paper.voids ?? 0), pnl: D((paper.pnl ?? 0).toFixed(6)).round(2).toString(), fees: D((paper.fees ?? 0).toFixed(6)).round(2).toString() },
      thresholds, verdict: Object.values(thresholds).every(Boolean) ? "complete" : "incomplete", shortfalls,
      note: "A soak measures the scheduler's behaviour under real time and faults; it is not strategy evidence and does not replace the separate ≥ 100-settled-event qualification. A synthetic (compressed-clock, fake-venue) run is a harness rehearsal and must be labelled as such.",
    };
  }

  // ---- FOR-06/07 qualification ------------------------------------------------------------------------------

  qualification(o: { strategyVersion?: string; category?: string; asOf?: string } = {}): QualificationReport {
    const strategyVersion = o.strategyVersion ?? this.ctx.forecasts.strategyVersion;
    const category = o.category ?? "sports";
    const asOf = o.asOf ?? this.now().toISOString();
    const evaluation = this.ctx.forecasts.evaluate({ strategyVersion, category, asOf });
    const records = this.ctx.forecasts.evaluationRecords(strategyVersion, category, asOf);
    const db = this.ctx.db;
    const decisionsRows = db.all<{ created_at: string; forecast_id: string | null; market_id: string }>("SELECT d.created_at, d.forecast_id, d.market_id FROM trade_decisions d JOIN forecast_snapshots f ON f.id = d.forecast_id WHERE f.strategy_version = ? AND COALESCE(f.category, 'general') = ? AND d.created_at <= ? ORDER BY d.created_at", strategyVersion, category, asOf);
    const settledOutcomes = db.all<{ resolved_at: string | null }>("SELECT m.resolved_at FROM trade_decisions d JOIN forecast_snapshots f ON f.id = d.forecast_id JOIN markets m ON m.id = d.market_id WHERE f.strategy_version = ? AND COALESCE(f.category, 'general') = ? AND m.resolved_at IS NOT NULL AND m.resolved_at <= ? ORDER BY m.resolved_at", strategyVersion, category, asOf);
    // Distinct settled events (FOR-06 counts events, not decisions); `evaluation.events` is the settled-decision count.
    const settledEvents = evaluation.groups;
    const pendingOrVoid = records.filter((r) => r.outcome === null && Number.isFinite(r.pYes)).length;
    const unscorable = records.filter((r) => !Number.isFinite(r.pYes)).length;
    const perCreator = new Map<string, number>();
    for (const r of records) for (const [k, n] of Object.entries(r.creatorObservations ?? {})) perCreator.set(k, Math.max(perCreator.get(k) ?? 0, n));
    const creators = [...perCreator].map(([key, observations]) => ({ key, observations, weighted: observations > 0 })).sort((a, b) => b.observations - a.observations);
    const below = creators.filter((c) => c.weighted && c.observations < MIN_CREATOR_OBS).map((c) => `${c.key} (${c.observations})`);
    const clusters = records.map((r) => (r as { independentClusters?: number }).independentClusters ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
    const paperRows = db.all<{ pnl: string | null; fees: string; status: string; settled_at: string | null }>("SELECT p.pnl, p.fees, p.status, p.settled_at FROM paper_us_positions p JOIN trade_decisions d ON d.id = p.decision_id JOIN forecast_snapshots f ON f.id = d.forecast_id WHERE f.strategy_version = ? AND COALESCE(f.category, 'general') = ? AND p.opened_at <= ? ORDER BY COALESCE(p.settled_at, p.opened_at)", strategyVersion, category, asOf);
    let peak = Dec.ZERO, cum = Dec.ZERO, maxDd = Dec.ZERO;
    for (const p of paperRows) { if (p.status !== "settled") continue; cum = cum.add(p.pnl ?? "0"); if (cum.gt(peak)) peak = cum; const dd = peak.sub(cum); if (dd.gt(maxDd)) maxDd = dd; }
    const record = db.get<{ id: string; created_at: string; qualified: number }>("SELECT id, created_at, qualified FROM strategy_qualifications WHERE source = 'production' AND strategy_version = ? AND category = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", strategyVersion, category);
    const eventsNeeded = Math.max(0, MIN_EVENTS - settledEvents);
    const status: QualificationReport["status"] = evaluation.gate.qualified ? "qualified" : settledEvents < MIN_EVENTS ? "pending" : "failed";
    const statement = status === "qualified"
      ? `${strategyVersion} / ${category}: qualified on ${settledEvents} settled held-out events (Brier ${evaluation.brier?.toFixed(4)} vs market ${evaluation.baselineBrier?.toFixed(4)}).${record?.qualified ? "" : " No production record has been written yet: run the evaluation with record=true (owner action) to unlock arming."}`
      : status === "pending"
        ? `${strategyVersion} / ${category}: qualification PENDING — ${settledEvents} of ${MIN_EVENTS} settled held-out events (${eventsNeeded} more needed). Insufficient data is an unmet auto-live gate, not a failure and not a pass; keep collecting paper evidence.`
        : `${strategyVersion} / ${category}: qualification FAILED on ${settledEvents} settled events — ${evaluation.gate.reasons.join("; ")}. Automation stays unavailable for this pair.`;
    return {
      generatedAt: this.now().toISOString(), strategyVersion, category, asOf, evaluation,
      cohort: { decisions: decisionsRows.length, settledEvents, pendingOrVoid, firstDecisionAt: decisionsRows[0]?.created_at, lastDecisionAt: decisionsRows.at(-1)?.created_at, firstOutcomeAt: settledOutcomes[0]?.resolved_at ?? undefined, lastOutcomeAt: settledOutcomes.at(-1)?.resolved_at ?? undefined, heldOut: "chronological: every forecast is frozen at its decision instant with as-of inputs (FOR-05); outcomes are read only when official and known by asOf, so no decision sees its own or a later outcome" },
      exclusions: [{ reason: "unsettled_or_void", count: pendingOrVoid }, { reason: "no_usable_probability", count: unscorable }, ...evaluation.skipped],
      creators, creatorGate: { minObservations: MIN_CREATOR_OBS, below, independentClustersMedian: clusters.length ? clusters[Math.floor(clusters.length / 2)] : undefined },
      paper: { positions: paperRows.length, settled: paperRows.filter((p) => p.status === "settled").length, feeAdjustedReturn: dsum(paperRows.filter((p) => p.status === "settled").map((p) => D(p.pnl ?? "0"))).round(2).toString(), fees: dsum(paperRows.map((p) => D(p.fees))).round(2).toString(), maxDrawdown: Number(maxDd.round(2).toString()) },
      status, eventsNeeded, productionRecord: record ? { id: record.id, createdAt: record.created_at, qualified: record.qualified === 1 } : undefined, statement,
    };
  }

  // ---- rendering ----------------------------------------------------------------------------------------------

  soakMarkdown(r: SoakReport, label = "Paper-soak report"): string {
    const kv = (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
    return [
      `# ${label}`, "",
      `Generated ${r.generatedAt}. Window ${r.window.from} → ${r.window.to} (${r.window.daysWithActivity} day(s) with scheduler activity of ${r.window.calendarDays} calendar day(s)). Verdict: **${r.verdict}**${r.shortfalls.length ? ` — ${r.shortfalls.join("; ")}` : ""}.`, "",
      `> ${r.note}`, "",
      "| Check | Threshold | Result |", "|---|---|---|",
      `| Calendar days with activity | ≥ 7 | ${r.window.daysWithActivity} ${r.thresholds.sevenCalendarDays ? "✓" : "✗"} |`,
      `| Decision evaluations | ≥ 100 | ${r.decisions.total} ${r.thresholds.hundredEvaluations ? "✓" : "✗"} |`,
      `| Distinct events | ≥ 10 | ${r.events.distinctEvents} (${r.events.distinctContracts} contracts) ${r.thresholds.tenEvents ? "✓" : "✗"} |`,
      `| Duplicate entries | 0 | ${r.duplicates.accountMarketPairsWithMultipleEntries.length} ${r.thresholds.zeroDuplicates ? "✓" : "✗"} |`,
      `| Risk-cap breaches | 0 | order ${r.capChecks.orderBudgetBreaches}, daily ${r.capChecks.dailyCapBreaches.length}, open markets max ${r.capChecks.openMarketsMax}/${r.capChecks.openMarketsLimit} ${r.thresholds.zeroCapBreaches ? "✓" : "✗"} |`,
      `| Every intent explained | yes | ${r.intents.unexplained.length} stuck, ${r.intents.unknownOpen} unknown open (${r.intents.unknownResolved} resolved) ${r.thresholds.allIntentsExplained ? "✓" : "✗"} |`, "",
      `Ticks: ${r.ticks.total} (${r.ticks.completed} completed, ${r.ticks.skipped} skipped, ${r.ticks.failed} failed; skip reasons: ${kv(r.ticks.skippedReasons)}). Modes: paper ${r.mode.paper}, auto-live ${r.mode.live}. Lease holders seen: ${r.faults.leaseHolders}.`, "",
      `Candidates: ${r.evaluations.candidates} (${kv(r.evaluations.reasons)}). Decisions: ${r.decisions.total} — eligible ${r.decisions.eligible}, skipped ${r.decisions.skipped}, needs review ${r.decisions.needsReview}; abstention rate ${r.decisions.abstentionRate ?? "n/a"}; missing-data gates hit ${r.decisions.missingData}. Reason codes: ${kv(r.decisions.reasonCodes)}.`, "",
      `Intents by state: ${kv(r.intents.byState)}. Faults: alerts ${kv(r.faults.alertsByKind)}; breaker opened ${r.faults.breakerOpened}; restarts ${r.faults.restarts}; disarms ${r.faults.disarms}; emergency stops ${r.faults.emergencyStops}.`, "",
      `Paper: ${r.paper.positions} positions, ${r.paper.settled} settled (${r.paper.wins} wins, ${r.paper.losses} losses, ${r.paper.voids} voids), fee-adjusted P&L ${r.paper.pnl}, fees ${r.paper.fees}.`, "",
    ].join("\n");
  }

  qualificationMarkdown(r: QualificationReport, label = "Strategy/category qualification report"): string {
    const e = r.evaluation;
    return [
      `# ${label}`, "",
      `Generated ${r.generatedAt} · strategy \`${r.strategyVersion}\` · category \`${r.category}\` · as of ${r.asOf}.`, "",
      `**${r.statement}**`, "",
      "| Quantity | Value |", "|---|---|",
      `| Cohort | ${r.cohort.decisions} decisions; ${r.cohort.settledEvents} distinct settled events (${e.events} settled decisions); ${r.cohort.pendingOrVoid} pending/void excluded |`,
      `| Chronology | decisions ${r.cohort.firstDecisionAt ?? "—"} → ${r.cohort.lastDecisionAt ?? "—"}; outcomes ${r.cohort.firstOutcomeAt ?? "—"} → ${r.cohort.lastOutcomeAt ?? "—"} |`,
      `| Held-out rule | ${r.cohort.heldOut} |`,
      `| Brier (forecast) | ${e.brier?.toFixed(4) ?? "n/a"} |`,
      `| Brier (market baseline, same events/times) | ${e.baselineBrier?.toFixed(4) ?? "n/a"} |`,
      `| Calibration bins | ${e.calibration.map((b) => `${b.lo}–${b.hi}: n=${b.count}${b.meanForecast !== undefined ? ` f=${b.meanForecast.toFixed(2)}` : ""}${b.hitRate !== undefined ? ` hit=${b.hitRate.toFixed(2)}` : ""}`).join("; ") || "none"} |`,
      `| Coverage | ${e.coverage.traded} traded of ${e.coverage.decisions} decisions (${e.coverage.skipped} skipped; abstention ${e.coverage.abstentionRate !== undefined ? e.coverage.abstentionRate.toFixed(3) : "n/a"}) |`,
      `| Fee-adjusted paper return | ${r.paper.feeAdjustedReturn} over ${r.paper.settled} settled paper positions (fees ${r.paper.fees}; max drawdown ${r.paper.maxDrawdown ?? "n/a"}) |`,
      `| Exclusions | ${r.exclusions.map((x) => `${x.reason} ${x.count}`).join(", ") || "none"} |`,
      `| Creators (usable observations) | ${r.creators.map((c) => `${c.key}: ${c.observations}`).join(", ") || "none"}; below ${r.creatorGate.minObservations}: ${r.creatorGate.below.join(", ") || "none"}; independent clusters (median) ${r.creatorGate.independentClustersMedian ?? "n/a"} |`,
      `| Gate | ${e.gate.qualified ? "passes" : "does not pass"}${e.gate.reasons.length ? ` — ${e.gate.reasons.join("; ")}` : ""} |`,
      `| Production record | ${r.productionRecord ? `${r.productionRecord.id.slice(0, 8)}… (${r.productionRecord.createdAt}, ${r.productionRecord.qualified ? "qualified" : "not qualified"})` : "none written"} |`, "",
      `Status: **${r.status}**${r.eventsNeeded ? ` (${r.eventsNeeded} more settled events needed)` : ""}. A synthetic or fixture-driven cohort is never written as a production record and never unlocks arming.`, "",
    ].join("\n");
  }
}
