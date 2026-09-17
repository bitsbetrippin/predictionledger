/**
 * Prediction Ledger — Polymarket US account connection service (1.10: ACC-02…06, OPS-02).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Owns the only vault handle for `trading.*` secrets and the only reference to the trading adapter.
 * Everything it returns is secret-free: bindings carry masked hints and a credential fingerprint, audit
 * events carry codes, and every adapter error is redacted before it is stored or returned.
 *
 * Binding model (ACC-03, spec §14.1 — verified 2026-09-16: the retail API exposes no account identity):
 * a binding is an app-generated id plus the fingerprint of the credential's Ed25519 public key. Re-entering
 * the same secret continues the binding; a different secret either starts a new binding (continuity
 * "unverified", old row "superseded") or — only when the owner explicitly asserts it — continues the
 * binding as "user_asserted". Either way `reconcile_required` is set, and nothing can activate in 1.10.
 *
 * Connection never arms anything (ACC-05): mode lives in `trading_policy`, live authorization is absent,
 * and the feature flags below keep submission/automation off regardless of stored state.
 */

import crypto from "node:crypto";
import type {
  TradingAccountBinding, TradingAccountSync, TradingAuditEvent, TradingConnectionTest, TradingGate, TradingMode, TradingOpenOrderSummary, TradingPolicy, TradingPositionSummary, TradingStatus,
  RiskLimits,
} from "@prediction-ledger/shared";
import { AUTO_LIVE_ACKNOWLEDGEMENT, DEFAULT_AUTOMATION, LIVE_ACKNOWLEDGEMENT, type AutomationSettings, type CircuitBreakerState } from "@prediction-ledger/shared";
import type { Database } from "../db/index.js";
import type { SecretVault } from "../security/secrets.js";
import { maskSecret } from "../security/secrets.js";
import { redactSecrets, safeErrorMessage } from "../security/redact.js";
import { inspectCredentials, type TradingCredentials } from "../providers/trading/credentials.js";
import { POLYMARKET_US_HOSTS, POLYMARKET_US_SDK } from "../providers/trading/polymarketUs.js";
import { TradingAdapterError, type TradingAdapter } from "../providers/trading/types.js";
import { DEFAULT_LIMITS, POLICY_VERSION } from "../analysis/tradeDecision.js";

/** 1.13: manual-live submission exists behind its gates; automation arrives with 1.14. */
export const TRADING_FEATURES = { submission: true, automation: true } as const;
/** 1.14 (AUTO-01) pilot default: settled US paper positions required before automation can be armed ("paper rehearsal"). */
export const PAPER_REHEARSAL_MIN_SETTLED = 20;
/** The exact acknowledgement an owner must send to enter manual-live mode (ACC-05 / AUTO-01 groundwork). */
export { LIVE_ACKNOWLEDGEMENT };
export const TRADING_SECRET_NAMES = { keyId: "trading.polymarket_us.keyId", secretKey: "trading.polymarket_us.secretKey" } as const;
/** RSK-03 freshness bound for account state. */
export const SYNC_FRESH_SECONDS = 30;
const MAX_POSITION_PAGES = 50;
const SYNC_RETENTION = 200;

export const IDENTITY_NOTE =
  "Polymarket US does not expose a stable account identifier through its retail API (checked 2026-09-16). This binding is local: an app-generated id plus a fingerprint of your API key's public key. Rotating the key therefore cannot be verified as the same account — you can assert it, and the binding will be marked as needing reconciliation.";

export class TradingGateError extends Error {
  constructor(message: string, public readonly gates: TradingGate[]) {
    super(message);
    this.name = "TradingGateError";
  }
}

interface AccountRow {
  id: string; venue: "polymarket_us"; state: TradingAccountBinding["state"]; identity_kind: TradingAccountBinding["identityKind"]; external_identity: string | null; credential_fingerprint: string | null;
  key_id_hint: string | null; secret_hint: string | null; continuity: TradingAccountBinding["continuity"]; reconcile_required: number; superseded_by: string | null; created_at: string;
  last_validated_at: string | null; last_validation_error: string | null; last_sync_at: string | null; disconnected_at: string | null;
}
interface SyncRow { id: string; binding_id: string; at: string; ok: number; error: string | null; balances_json: string; positions_json: string; open_orders_json: string; complete: number }
interface PolicyRow { mode: TradingMode; live_authorized_at: string | null; live_authorization_hash: string | null; updated_at: string; policy_version: string | null; limits_json: string | null; budget_timezone: string | null; policy_hash: string | null; authorized_policy_hash: string | null; authorized_strategy_version: string | null; authorized_category: string | null; pause_reason: string | null; paused_at: string | null; automation_json: string | null }

const sortedKeys = (o: object) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, (o as Record<string, unknown>)[k]]));

/**
 * sha256 over the canonical policy content (RSK-07): any change produces a new hash and is audited. Since 1.14 the
 * scheduler budgets are part of it (AUTO-01: a scheduled run can never widen what the owner authorized).
 */
export function policyHashOf(policyVersion: string, limits: RiskLimits, budgetTimezone: string, automation: AutomationSettings = DEFAULT_AUTOMATION): string {
  const canon = JSON.stringify({ policyVersion, budgetTimezone, limits: sortedKeys(limits), automation: sortedKeys(automation) });
  return crypto.createHash("sha256").update(canon).digest("hex");
}

export interface TradingAccountServiceOptions {
  allowInternet: () => boolean;
  now?: () => Date;
}

export class TradingAccountService {
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    private readonly vault: SecretVault,
    private readonly adapter: () => TradingAdapter,
    private readonly opts: TradingAccountServiceOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  // ---- read side ---------------------------------------------------------------------------------

  status(): TradingStatus {
    const binding = this.connected();
    const previous = this.db.all<AccountRow>("SELECT * FROM trading_accounts WHERE state <> 'connected' ORDER BY created_at DESC").map(hydrate);
    const latestSync = binding ? this.latestSync(binding.id) : undefined;
    const age = this.syncAgeSeconds(binding);
    const policy = this.policy();
    const blockers = this.dispatchBlockers();
    return {
      venue: "polymarket_us",
      policy,
      features: { ...TRADING_FEATURES },
      breaker: this.breaker(binding?.id),
      armed: (policy.mode === "manual_live" || policy.mode === "auto_live") && !!policy.liveAuthorizedAt && !!binding,
      submissionAvailable: blockers.length === 0,
      dispatchBlockers: blockers,
      binding,
      previousBindings: previous,
      latestSync,
      syncAgeSeconds: age,
      stale: age === undefined || age > SYNC_FRESH_SECONDS,
      gates: this.gates(binding, age),
      identityNote: IDENTITY_NOTE,
      hosts: { ...POLYMARKET_US_HOSTS },
      sdk: { ...POLYMARKET_US_SDK },
    };
  }

  policy(): TradingPolicy {
    const r = this.db.get<PolicyRow>("SELECT * FROM trading_policy WHERE id = 'default'");
    const policyVersion = r?.policy_version ?? POLICY_VERSION;
    const limits: RiskLimits = { ...DEFAULT_LIMITS, ...(r?.limits_json ? (JSON.parse(r.limits_json) as Partial<RiskLimits>) : {}) };
    const budgetTimezone = r?.budget_timezone ?? "UTC";
    const automation: AutomationSettings = { ...DEFAULT_AUTOMATION, ...(r?.automation_json ? (JSON.parse(r.automation_json) as Partial<AutomationSettings>) : {}) };
    // The hash is a pure function of the content; a 1.12/1.13 row (hashed without the automation budgets) is re-hashed on first read and stored.
    const policyHash = policyHashOf(policyVersion, limits, budgetTimezone, automation);
    if (r && r.policy_hash !== policyHash) this.db.run("UPDATE trading_policy SET policy_hash = ? WHERE id = 'default'", policyHash);
    if (!r) return { mode: "paper", updatedAt: this.now().toISOString(), policyVersion, limits, budgetTimezone, policyHash, automation };
    return {
      mode: r.mode, liveAuthorizedAt: r.live_authorized_at ?? undefined, liveAuthorizationHash: r.live_authorization_hash ?? undefined, updatedAt: r.updated_at, policyVersion, limits, budgetTimezone, policyHash, automation,
      authorizedPolicyHash: r.authorized_policy_hash ?? undefined, authorizedStrategyVersion: r.authorized_strategy_version ?? undefined, authorizedCategory: r.authorized_category ?? undefined,
      pauseReason: r.pause_reason ?? undefined, pausedAt: r.paused_at ?? undefined,
    };
  }

  /** 1.14 (AUTO-02): change the scheduler budgets. Part of the policy hash, so any change disarms and is audited like a limits change. */
  setAutomation(patch: Partial<AutomationSettings>): TradingPolicy {
    const prev = this.policy();
    const automation: AutomationSettings = { ...prev.automation, ...patch };
    for (const [k, v] of Object.entries(automation)) if (k !== "paperAutopilot" && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) throw new Error(`Automation setting ${k} must be a non-negative number`);
    if (typeof automation.paperAutopilot !== "boolean") throw new Error("paperAutopilot must be a boolean");
    if (automation.intervalMs < 5_000) throw new Error("intervalMs must be at least 5000");
    const hash = policyHashOf(prev.policyVersion, prev.limits, prev.budgetTimezone, automation);
    if (hash === prev.policyHash) return prev;
    const wasLive = prev.mode === "manual_live" || prev.mode === "auto_live" || !!prev.liveAuthorizedAt;
    this.db.run(
      `UPDATE trading_policy SET automation_json = ?, policy_hash = ?, ${wasLive ? "mode = 'paper', live_authorized_at = NULL, live_authorization_hash = NULL, authorized_policy_hash = NULL, authorized_strategy_version = NULL, authorized_category = NULL," : ""} updated_at = ? WHERE id = 'default'`,
      JSON.stringify(automation), hash, this.now().toISOString(),
    );
    this.audit("policy.changed", this.connected()?.id, { from: prev.policyHash, to: hash, changed: Object.keys(patch).map((k) => `automation.${k}`), disarmed: wasLive });
    if (wasLive) { this.audit("trading.disarmed", this.connected()?.id, { reason: "policy changed", previousMode: prev.mode }); this.onDisarmed?.("policy changed", prev.mode); }
    return this.policy();
  }

  /**
   * 1.12 (RSK-02/07): change the pilot limits or the budget timezone. Any material change disarms (live modes →
   * paper, authorization cleared) and is audited with both hashes. Consumed daily allowances are untouched: every
   * reservation carries the bucket it was made in, so a timezone change never resets usage.
   */
  setLimits(patch: Partial<RiskLimits>, opts: { budgetTimezone?: string } = {}): TradingPolicy {
    const prev = this.policy();
    const limits: RiskLimits = { ...prev.limits, ...patch, currency: "USD" };
    const tz = opts.budgetTimezone ?? prev.budgetTimezone;
    try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); } catch { throw new Error(`Unknown timezone "${tz}"`); }
    const hash = policyHashOf(prev.policyVersion, limits, tz, prev.automation);
    if (hash === prev.policyHash) return prev;
    const wasLive = prev.mode === "manual_live" || prev.mode === "auto_live" || !!prev.liveAuthorizedAt;
    this.db.transaction(() => {
      this.db.run(
        `UPDATE trading_policy SET limits_json = ?, budget_timezone = ?, policy_hash = ?, ${wasLive ? "mode = 'paper', live_authorized_at = NULL, live_authorization_hash = NULL, authorized_policy_hash = NULL, authorized_strategy_version = NULL, authorized_category = NULL," : ""} updated_at = ? WHERE id = 'default'`,
        JSON.stringify(limits), tz, hash, this.now().toISOString(),
      );
    });
    this.audit("policy.changed", this.connected()?.id, { from: prev.policyHash, to: hash, changed: Object.keys(patch), budgetTimezone: tz, disarmed: wasLive });
    if (wasLive) { this.audit("trading.disarmed", this.connected()?.id, { reason: "policy changed", previousMode: prev.mode }); this.onDisarmed?.("policy changed", prev.mode); }
    return this.policy();
  }

  /** The release gates a live mode would need. All live gates are unmet in 1.10 by construction. */
  /** Seconds since the last successful sync of `binding` (undefined = never). */
  syncAgeSeconds(binding = this.connected()): number | undefined {
    const lastOk = binding ? this.latestSync(binding.id, true) : undefined;
    return lastOk ? Math.max(0, Math.round((this.now().getTime() - Date.parse(lastOk.at)) / 1000)) : undefined;
  }

  gates(binding = this.connected(), syncAge: number | undefined = this.syncAgeSeconds(binding)): TradingGate[] {
    const validated = !!binding && !!binding.lastValidatedAt && !binding.lastValidationError;
    const policy = this.policy();
    const breaker = this.breaker(binding?.id);
    return [
      { id: "credentials_valid", label: "Credentials validated", satisfied: validated, detail: validated ? `validated ${binding!.lastValidatedAt}` : binding?.lastValidationError ?? "no connected, validated credential" },
      { id: "account_fresh", label: "Account state fresh (≤ 30 s)", satisfied: syncAge !== undefined && syncAge <= SYNC_FRESH_SECONDS, detail: syncAge === undefined ? "never synced" : `${syncAge} s old` },
      { id: "reconciled", label: "Binding reconciled", satisfied: !!binding && !binding.reconcileRequired, detail: binding?.reconcileRequired ? "credential or restore changed the binding; reconciliation (1.13) required" : "ok" },
      { id: "contract_verification", label: "Verified executable contract (1.11)", satisfied: this.hasVerifiedContract(), detail: this.hasVerifiedContract() ? "at least one link is verified equivalent" : "no link verified equivalent yet" },
      { id: "strategy_qualified", label: "Qualified strategy for the category (1.12)", satisfied: this.hasProductionQualification(), detail: this.hasProductionQualification() ? "a production qualification record exists" : "no production qualification record (paper evidence still accumulating; fixtures never count)" },
      { id: "paper_rehearsal", label: `Paper rehearsal (≥ ${PAPER_REHEARSAL_MIN_SETTLED} settled US paper positions)`, satisfied: this.settledPaperCount() >= PAPER_REHEARSAL_MIN_SETTLED, detail: `${this.settledPaperCount()} settled` },
      { id: "submission_feature", label: "Order submission built and gated (1.13)", satisfied: TRADING_FEATURES.submission, detail: TRADING_FEATURES.submission ? "manual-live submission exists behind preview → confirm" : "no submission code exists in this build" },
      { id: "automation_feature", label: "Automatic execution built and gated (1.14)", satisfied: TRADING_FEATURES.automation, detail: TRADING_FEATURES.automation ? "the scheduler exists; it runs only under an explicit arming with the reviewed policy hash" : "no automation code exists in this build" },
      { id: "no_holds", label: "No unresolved reconciliation holds or unknown submissions", satisfied: this.openHoldCount(binding?.id) === 0, detail: this.openHoldCount(binding?.id) === 0 ? "none" : `${this.openHoldCount(binding?.id)} open` },
      { id: "not_paused", label: "New orders not paused by the owner", satisfied: !policy.pauseReason, detail: policy.pauseReason ?? "not paused" },
      { id: "breaker_closed", label: "Circuit breaker closed", satisfied: breaker.state !== "open", detail: breaker.state === "open" ? `open since ${breaker.openedAt} (${breaker.consecutiveFailures} consecutive failures)` : breaker.state },
      { id: "live_authorization", label: "Explicit owner live authorization", satisfied: !!policy.liveAuthorizedAt, detail: policy.liveAuthorizedAt ? `authorized ${policy.liveAuthorizedAt}${policy.authorizedPolicyHash ? ` for automation under policy ${policy.authorizedPolicyHash.slice(0, 12)}…` : ""}` : "absent — set manual-live mode with the acknowledgement text, or arm automation with the reviewed policy hash" },
    ];
  }

  private settledPaperCount(): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM paper_us_positions WHERE status = 'settled'")?.n ?? 0;
  }

  /** A production (never fixture) qualification for this strategy version and category (FOR-06). */
  qualificationFor(strategyVersion: string, category: string): boolean {
    // RV-11 (2.0): the newest production evaluation of the pair decides; a later failed evaluation revokes qualification.
    const r = this.db.get<{ qualified: number }>("SELECT qualified FROM strategy_qualifications WHERE source = 'production' AND strategy_version = ? AND category = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", strategyVersion, category);
    return r?.qualified === 1;
  }

  // ---- 1.14: circuit breaker (AUTO-05) -----------------------------------------------------------------

  breaker(bindingId = this.connected()?.id): CircuitBreakerState {
    if (!bindingId) return { state: "closed", consecutiveFailures: 0 };
    const r = this.db.get<{ breaker_json: string | null }>("SELECT breaker_json FROM trading_accounts WHERE id = ?", bindingId);
    return r?.breaker_json ? (JSON.parse(r.breaker_json) as CircuitBreakerState) : { state: "closed", consecutiveFailures: 0 };
  }

  /**
   * Record the outcome of an adapter call. Repeated failures open the breaker: no new orders (the dispatch marker
   * re-reads the blockers), reads and cancels keep working, an alert is raised once per incident, and nothing re-arms by
   * itself — a later successful read (after the cooldown) closes the breaker but the owner must arm again (AUTO-04/05).
   */
  recordAdapterOutcome(ok: boolean, code?: string): CircuitBreakerState {
    const binding = this.connected();
    if (!binding) return { state: "closed", consecutiveFailures: 0 };
    const b = this.breaker(binding.id);
    const now = this.now().toISOString();
    const { breakerThreshold, breakerCooldownMs } = this.policy().automation;
    let next: CircuitBreakerState;
    if (ok) {
      const cooled = b.state !== "open" || (b.openedAt !== undefined && Date.parse(now) - Date.parse(b.openedAt) >= breakerCooldownMs);
      next = cooled ? { state: "closed", consecutiveFailures: 0 } : { ...b, state: "half_open", consecutiveFailures: 0 };
      if (b.state !== "closed" && next.state === "closed") this.audit("breaker.closed", binding.id, { after: b.consecutiveFailures, incidentId: b.incidentId });
    } else {
      const failures = b.consecutiveFailures + 1;
      next = { ...b, consecutiveFailures: failures, lastFailureAt: now, lastFailureCode: code };
      if (b.state !== "open" && failures >= breakerThreshold) {
        next = { ...next, state: "open", openedAt: now, incidentId: crypto.randomUUID() };
        this.db.run("UPDATE trading_accounts SET breaker_json = ? WHERE id = ?", JSON.stringify(next), binding.id);
        this.audit("breaker.opened", binding.id, { failures, code, incidentId: next.incidentId });
        const p = this.policy();
        if (p.mode === "auto_live" || p.mode === "manual_live" || p.liveAuthorizedAt) this.disarm(`circuit breaker opened after ${failures} consecutive adapter failures (${code ?? "unknown"})`);
        this.onBreakerOpened?.(next, code);
        return next;
      }
    }
    this.db.run("UPDATE trading_accounts SET breaker_json = ? WHERE id = ?", JSON.stringify(next), binding.id);
    return next;
  }

  /** Hooks for the alert service (set by the context; optional so this service has no hard dependency on it). */
  onBreakerOpened?: (state: CircuitBreakerState, code?: string) => void;
  onDisarmed?: (reason: string, previousMode: TradingMode) => void;

  // ---- 1.14: owner pause / resume (AUTO-03) ------------------------------------------------------------

  pause(reason: string): TradingPolicy {
    const now = this.now().toISOString();
    this.db.run("UPDATE trading_policy SET pause_reason = ?, paused_at = ?, updated_at = ? WHERE id = 'default'", reason, now, now);
    this.audit("trading.paused", this.connected()?.id, { reason });
    return this.policy();
  }

  resume(): TradingPolicy {
    const prev = this.policy();
    this.db.run("UPDATE trading_policy SET pause_reason = NULL, paused_at = NULL, updated_at = ? WHERE id = 'default'", this.now().toISOString());
    this.audit("trading.resumed", this.connected()?.id, { previousReason: prev.pauseReason ?? null });
    return this.policy();
  }

  /**
   * 1.14 (AUTO-01): arm automatic trading. Every gate must hold, the owner must send the exact acknowledgement AND the
   * policy hash they reviewed (a mismatch means the policy changed under them), and the strategy/category pair must
   * hold a production qualification. The authorization records the hash; the scheduler refuses whenever the live hash
   * differs, so nothing can silently widen it.
   */
  arm(input: { acknowledge?: string; policyHash?: string; category: string; strategyVersion: string }): TradingPolicy {
    const prev = this.policy();
    const gates = this.gates();
    const required = ["credentials_valid", "account_fresh", "reconciled", "contract_verification", "strategy_qualified", "paper_rehearsal", "submission_feature", "automation_feature", "no_holds", "not_paused", "breaker_closed"];
    const unmet = gates.filter((g) => required.includes(g.id) && !g.satisfied);
    if (!unmet.some((g) => g.id === "strategy_qualified") && !this.qualificationFor(input.strategyVersion, input.category)) unmet.push({ id: "strategy_qualified", label: `Qualified strategy ${input.strategyVersion} for category ${input.category}`, satisfied: false, detail: "no production qualification record for this strategy/category (fixtures never count)" });
    if (unmet.length) throw new TradingGateError(`auto_live is not available: ${unmet.map((g) => g.label).join("; ")}.`, unmet);
    if (input.acknowledge !== AUTO_LIVE_ACKNOWLEDGEMENT) throw new TradingGateError(`auto_live requires the exact acknowledgement "${AUTO_LIVE_ACKNOWLEDGEMENT}".`, [{ id: "live_authorization", label: "Explicit owner automation authorization", satisfied: false, detail: "acknowledgement text missing or different" }]);
    if (input.policyHash !== prev.policyHash) throw new TradingGateError("The policy hash you reviewed is not the current policy hash; review the current limits and budgets and arm again.", [{ id: "policy_reviewed", label: "Policy reviewed (hash matches)", satisfied: false, detail: `reviewed ${input.policyHash?.slice(0, 12) ?? "none"}… vs current ${prev.policyHash.slice(0, 12)}…` }]);
    const at = this.now().toISOString();
    const hash = crypto.createHash("sha256").update(JSON.stringify({ mode: "auto_live", at, policyHash: prev.policyHash, strategy: input.strategyVersion, category: input.category, binding: this.connected()?.id })).digest("hex");
    this.db.run(
      "UPDATE trading_policy SET mode = 'auto_live', live_authorized_at = ?, live_authorization_hash = ?, authorized_policy_hash = ?, authorized_strategy_version = ?, authorized_category = ?, updated_at = ? WHERE id = 'default'",
      at, hash, prev.policyHash, input.strategyVersion, input.category, at,
    );
    this.audit("policy.mode_changed", this.connected()?.id, { from: prev.mode, to: "auto_live", liveAuthorizationHash: hash, authorizedPolicyHash: prev.policyHash, strategyVersion: input.strategyVersion, category: input.category, acknowledged: true });
    return this.policy();
  }

  private openHoldCount(bindingId?: string): number {
    if (!bindingId) return 0;
    const holds = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reconciliation_holds WHERE binding_id = ? AND resolved_at IS NULL", bindingId)?.n ?? 0;
    const unknown = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trade_intents WHERE binding_id = ? AND state = 'submission_unknown'", bindingId)?.n ?? 0;
    return holds + unknown;
  }

  private hasVerifiedContract(): boolean {
    return !!this.db.get<{ n: number }>("SELECT 1 AS n FROM prediction_market_links WHERE verification_status = 'verified_equivalent' LIMIT 1");
  }

  private hasProductionQualification(): boolean {
    return !!this.db.get<{ n: number }>("SELECT 1 AS n FROM strategy_qualifications WHERE source = 'production' AND qualified = 1 LIMIT 1");
  }

  auditEvents(limit = 100): TradingAuditEvent[] {
    return this.db
      .all<{ id: string; at: string; binding_id: string | null; kind: string; details_json: string }>("SELECT * FROM trading_audit_events ORDER BY at DESC, rowid DESC LIMIT ?", limit)
      .map((r) => ({ id: r.id, at: r.at, bindingId: r.binding_id ?? undefined, kind: r.kind, details: JSON.parse(r.details_json) as Record<string, unknown> }));
  }

  connected(): TradingAccountBinding | undefined {
    const r = this.db.get<AccountRow>("SELECT * FROM trading_accounts WHERE state = 'connected' AND venue = 'polymarket_us'");
    return r ? hydrate(r) : undefined;
  }

  hasCredentials(): boolean {
    return this.vault.has(TRADING_SECRET_NAMES.keyId) && this.vault.has(TRADING_SECRET_NAMES.secretKey);
  }

  // ---- connection test (ACC-02: no trade) ---------------------------------------------------------

  async testConnection(input: Partial<TradingCredentials> = {}, signal?: AbortSignal): Promise<TradingConnectionTest> {
    const creds = this.resolveCredentials(input);
    const bindingId = this.connected()?.id;
    if (!creds) return this.recordTest(bindingId, { ok: false, code: "missing_credentials", message: "Enter a key ID and secret, or connect first.", orderCalls: 0 });
    const shape = inspectCredentials(creds);
    if (!shape.ok) return this.recordTest(bindingId, { ok: false, code: shape.problem, message: shape.problem === "malformed_secret" ? `The secret does not look like a Polymarket US API secret (${shape.reason}). Copy it exactly as the developer portal showed it.` : shape.reason, orderCalls: 0 });
    if (!this.opts.allowInternet()) return this.recordTest(bindingId, { ok: false, code: "offline_mode", message: "Internet access is disabled in Setup → Privacy. Enable it to validate credentials.", credentialFingerprint: shape.fingerprint, orderCalls: 0 });
    try {
      const balances = await this.adapter().balances(creds, signal);
      return this.recordTest(bindingId, { ok: true, code: "ok", message: `Connected. ${balances.length} balance record(s) read; no order was placed.`, credentialFingerprint: shape.fingerprint, balances, orderCalls: 0 });
    } catch (err) {
      const { code, message } = describeError(err, creds);
      return this.recordTest(bindingId, { ok: false, code, message, credentialFingerprint: shape.fingerprint, orderCalls: 0 });
    }
  }

  private recordTest(bindingId: string | undefined, result: TradingConnectionTest): TradingConnectionTest {
    this.audit("connection.tested", bindingId, { ok: result.ok, code: result.code, fingerprint: result.credentialFingerprint });
    return result;
  }

  // ---- connect / replace (ACC-02/03) ---------------------------------------------------------------

  async connect(input: TradingCredentials & { assertSameAccount?: boolean }, signal?: AbortSignal): Promise<{ binding: TradingAccountBinding; test: TradingConnectionTest; sync?: TradingAccountSync }> {
    const creds = { keyId: input.keyId.trim(), secretKey: input.secretKey.trim() };
    const test = await this.testConnection(creds, signal);
    if (!test.ok || !test.credentialFingerprint) throw new TradingConnectError(test);
    const fp = test.credentialFingerprint;
    const at = this.now().toISOString();
    const hints = { key: maskSecret(creds.keyId), secret: maskSecret(creds.secretKey) };

    const binding = this.db.transaction(() => {
      const current = this.db.get<AccountRow>("SELECT * FROM trading_accounts WHERE venue = 'polymarket_us' AND state IN ('connected','needs_rebind') ORDER BY created_at DESC LIMIT 1")
        ?? this.db.get<AccountRow>("SELECT * FROM trading_accounts WHERE venue = 'polymarket_us' AND state = 'disconnected' ORDER BY created_at DESC LIMIT 1");
      let id: string;
      if (!current) {
        id = crypto.randomUUID();
        this.db.run(
          "INSERT INTO trading_accounts (id, venue, state, credential_fingerprint, key_id_hint, secret_hint, continuity, reconcile_required, created_at, last_validated_at) VALUES (?, 'polymarket_us', 'connected', ?, ?, ?, 'first', 0, ?, ?)",
          id, fp, hints.key, hints.secret, at, at,
        );
        this.audit("connection.saved", id, { continuity: "first", fingerprint: fp });
      } else if (current.credential_fingerprint === fp) {
        // Same credential re-entered (reconnect after disconnect, or rebind after restore).
        id = current.id;
        const reconcile = current.state === "needs_rebind" ? 1 : current.reconcile_required;
        this.db.run(
          "UPDATE trading_accounts SET state = 'connected', key_id_hint = ?, secret_hint = ?, continuity = 'same_credential', reconcile_required = ?, last_validated_at = ?, last_validation_error = NULL, disconnected_at = NULL WHERE id = ?",
          hints.key, hints.secret, reconcile, at, id,
        );
        this.audit("connection.saved", id, { continuity: "same_credential", fingerprint: fp, previousState: current.state, reconcileRequired: reconcile === 1 });
      } else if (input.assertSameAccount) {
        id = current.id;
        this.db.run(
          "UPDATE trading_accounts SET state = 'connected', credential_fingerprint = ?, key_id_hint = ?, secret_hint = ?, continuity = 'user_asserted', reconcile_required = 1, last_validated_at = ?, last_validation_error = NULL, disconnected_at = NULL WHERE id = ?",
          fp, hints.key, hints.secret, at, id,
        );
        this.audit("credential.replaced", id, { continuity: "user_asserted", previousFingerprint: current.credential_fingerprint, fingerprint: fp, intentsInvalidated: 0, reconcileRequired: true });
      } else {
        id = crypto.randomUUID();
        this.db.run("UPDATE trading_accounts SET state = 'superseded', superseded_by = ?, disconnected_at = ? WHERE id = ?", id, at, current.id);
        this.db.run(
          "INSERT INTO trading_accounts (id, venue, state, credential_fingerprint, key_id_hint, secret_hint, continuity, reconcile_required, created_at, last_validated_at) VALUES (?, 'polymarket_us', 'connected', ?, ?, ?, 'unverified', 1, ?, ?)",
          id, fp, hints.key, hints.secret, at, at,
        );
        this.audit("credential.replaced", id, { continuity: "unverified", previousBinding: current.id, previousFingerprint: current.credential_fingerprint, fingerprint: fp, intentsInvalidated: 0, reconcileRequired: true });
      }
      this.vault.set(TRADING_SECRET_NAMES.keyId, creds.keyId);
      this.vault.set(TRADING_SECRET_NAMES.secretKey, creds.secretKey);
      return this.connected()!;
    });
    // AUTO-04: any credential change (rotation, replacement, rebind) returns to disarmed; the owner re-arms after reconciliation.
    { const p = this.policy(); if (p.mode === "manual_live" || p.mode === "auto_live" || p.liveAuthorizedAt) this.disarm("credential change"); }
    let sync: TradingAccountSync | undefined;
    try {
      sync = await this.sync(signal);
    } catch {
      /* the failed sync row carries the redacted reason; status() shows it */
    }
    return { binding: this.connected() ?? binding, test, sync };
  }

  // ---- disconnect (ACC-06: disarm first, then remove) -----------------------------------------------

  async disconnect(signal?: AbortSignal): Promise<{ disconnected: boolean; bindingId?: string; cancellations: { orderId: string; outcome: string; message?: string }[]; note: string }> {
    const binding = this.connected();
    if (!binding) return { disconnected: false, cancellations: [], note: "No connected account." };
    // 1. Disarm: live modes fall back to paper, authorization is cleared, prepared intents are invalidated (none can exist in 1.10).
    this.db.run("UPDATE trading_policy SET mode = CASE WHEN mode IN ('manual_live','auto_live') THEN 'paper' ELSE mode END, live_authorized_at = NULL, live_authorization_hash = NULL, updated_at = ? WHERE id = 'default'", this.now().toISOString());
    this.audit("trading.disarmed", binding.id, { reason: "disconnect", intentsInvalidated: 0 });
    // 2. Targeted cancellation of the app's own outstanding orders while the credential still works.
    //    1.10 cannot have placed any (no submission path), so the set is empty; the hook stays so 1.13 fills it.
    const cancellations: { orderId: string; outcome: string; message?: string }[] = [];
    const appOwned = this.appOwnedOpenOrders();
    if (appOwned.length) {
      const creds = this.resolveCredentials({});
      for (const o of appOwned) {
        try {
          const r = creds ? await this.adapter().cancelOrder(creds, o.id, o.marketSlug, signal) : { orderId: o.id, outcome: "failed" as const, message: "no credentials" };
          cancellations.push({ orderId: r.orderId, outcome: r.outcome, message: r.message });
        } catch (err) {
          cancellations.push({ orderId: o.id, outcome: "failed", message: safeErrorMessage(err, this.secretMaterial()) });
        }
      }
    }
    this.audit("orders.cancel_requested", binding.id, { count: appOwned.length, results: cancellations.map((c) => ({ orderId: c.orderId, outcome: c.outcome })) });
    // 3. Remove the credential; keep the binding row and every sync/audit row.
    this.db.transaction(() => {
      this.vault.delete(TRADING_SECRET_NAMES.keyId);
      this.vault.delete(TRADING_SECRET_NAMES.secretKey);
      this.db.run("UPDATE trading_accounts SET state = 'disconnected', disconnected_at = ? WHERE id = ?", this.now().toISOString(), binding.id);
      this.audit("connection.disconnected", binding.id, { venueRevocation: false, historyRetained: true });
    });
    return {
      disconnected: true,
      bindingId: binding.id,
      cancellations,
      note: "Credentials were removed from this computer only. This is not a venue revocation: to revoke the key, delete it at polymarket.us/developer. History, syncs and audit events are retained.",
    };
  }

  /** App-owned outstanding venue orders. No intents/orders table exists before 1.13, so this is always empty in 1.10. */
  /** 1.13: orders this app placed that the venue still shows as open/partial/pending (cancel targets on disconnect / emergency stop). */
  private appOwnedOpenOrders(): { id: string; marketSlug: string }[] {
    return this.db.all<{ id: string; market_slug: string }>("SELECT id, market_slug FROM venue_orders WHERE intent_id IS NOT NULL AND state IN ('pending','open','partial','cancel_pending')").map((r) => ({ id: r.id, marketSlug: r.market_slug }));
  }

  /**
   * 1.13: run an adapter call with the stored credential. The vault never leaves this service; the callback gets the
   * credential for the duration of one call and the adapter, nothing else.
   */
  /** The adapter without credentials — only for classifying an error it threw (no venue call is possible through it). */
  adapterForClassification(): TradingAdapter {
    return this.adapter();
  }

  async withCredentials<T>(fn: (creds: TradingCredentials, adapter: TradingAdapter) => Promise<T>): Promise<T> {
    const binding = this.connected();
    if (!binding) throw new TradingAdapterError("unauthorized", "No connected Polymarket US account.");
    const creds = this.resolveCredentials({});
    if (!creds) {
      this.markNeedsRebind(binding.id, "credentials missing from the secret store");
      throw new TradingAdapterError("unauthorized", "Stored credentials are missing (restored backup?). Reconnect to rebind.");
    }
    if (!this.opts.allowInternet()) throw new TradingAdapterError("network", "Internet access is disabled in Setup → Privacy.");
    try {
      const r = await fn(creds, this.adapter());
      this.recordAdapterOutcome(true);
      return r;
    } catch (err) {
      const message = safeErrorMessage(err, this.secretMaterial());
      const mapped = err instanceof TradingAdapterError ? new TradingAdapterError(err.code, message, err.status) : new TradingAdapterError("unknown", message);
      // Venue refusals of a request (400/404) are not infrastructure failures; auth, rate limit, network, timeout and 5xx are.
      if (mapped.code !== "bad_request" && mapped.code !== "not_found") this.recordAdapterOutcome(false, mapped.code);
      throw mapped;
    }
  }

  /** 1.13: pause / resume new dispatch for the connected account (EXE-04 unknown submission, EXE-07 discrepancy). */
  setDispatchPause(bindingId: string, reason: string | null): void {
    const current = this.dispatchPauseReason(bindingId);
    if ((current ?? null) === reason) return;
    this.db.run("UPDATE trading_accounts SET dispatch_paused_reason = ? WHERE id = ?", reason, bindingId);
    this.audit(reason ? "dispatch.paused" : "dispatch.resumed", bindingId, { reason });
  }

  dispatchPauseReason(bindingId: string): string | undefined {
    return this.db.get<{ dispatch_paused_reason: string | null }>("SELECT dispatch_paused_reason FROM trading_accounts WHERE id = ?", bindingId)?.dispatch_paused_reason ?? undefined;
  }

  /** Everything that blocks a new live order right now (empty = dispatch possible). */
  dispatchBlockers(): string[] {
    const out: string[] = [];
    const p = this.policy();
    const binding = this.connected();
    if (p.mode !== "manual_live" && p.mode !== "auto_live") out.push(`mode is ${p.mode}`);
    if ((p.mode === "manual_live" || p.mode === "auto_live") && !p.liveAuthorizedAt) out.push("live authorization absent");
    if (p.mode === "auto_live" && p.authorizedPolicyHash && p.authorizedPolicyHash !== p.policyHash) out.push("policy changed since the automation authorization");
    if (p.pauseReason) out.push(`paused by owner: ${p.pauseReason}`);
    if (!binding) out.push("no connected account");
    else {
      const b = this.breaker(binding.id);
      if (b.state === "open") out.push(`circuit breaker open (${b.consecutiveFailures} consecutive adapter failures)`);
      if (binding.reconcileRequired) out.push("binding requires reconciliation");
      const paused = this.dispatchPauseReason(binding.id);
      if (paused) out.push(`dispatch paused: ${paused}`);
      const holds = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reconciliation_holds WHERE binding_id = ? AND resolved_at IS NULL", binding.id)?.n ?? 0;
      if (holds > 0) out.push(`${holds} unresolved reconciliation hold(s)`);
      const unknown = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trade_intents WHERE binding_id = ? AND state = 'submission_unknown'", binding.id)?.n ?? 0;
      if (unknown > 0) out.push(`${unknown} submission(s) with unknown outcome`);
    }
    return out;
  }

  /**
   * 1.13: disarm — live modes fall back to paper and the authorization is cleared, in one statement. The dispatch
   * marker transaction re-reads this row, so no submission can begin after the disarm is recorded.
   */
  disarm(reason: string, opts: { pause?: boolean } = {}): TradingPolicy {
    const prev = this.policy();
    const now = this.now().toISOString();
    // One statement: mode, authorization and (for an emergency stop) the pause land together; the dispatch marker re-reads this row.
    this.db.run(
      `UPDATE trading_policy SET mode = CASE WHEN mode IN ('manual_live','auto_live') THEN 'paper' ELSE mode END, live_authorized_at = NULL, live_authorization_hash = NULL, authorized_policy_hash = NULL, authorized_strategy_version = NULL, authorized_category = NULL${opts.pause ? ", pause_reason = ?, paused_at = ?" : ""}, updated_at = ? WHERE id = 'default'`,
      ...(opts.pause ? [reason, now] : []), now,
    );
    this.audit("trading.disarmed", this.connected()?.id, { reason, previousMode: prev.mode, paused: opts.pause === true });
    if (prev.mode === "manual_live" || prev.mode === "auto_live" || prev.liveAuthorizedAt) this.onDisarmed?.(reason, prev.mode);
    return this.policy();
  }

  // ---- sync (ACC-02/05 reads) ----------------------------------------------------------------------

  async sync(signal?: AbortSignal): Promise<TradingAccountSync> {
    const binding = this.connected();
    if (!binding) throw new TradingAdapterError("unauthorized", "No connected Polymarket US account.");
    const creds = this.resolveCredentials({});
    if (!creds) {
      this.markNeedsRebind(binding.id, "credentials missing from the secret store");
      throw new TradingAdapterError("unauthorized", "Stored credentials are missing (restored backup?). Reconnect to rebind.");
    }
    if (!this.opts.allowInternet()) throw new TradingAdapterError("network", "Internet access is disabled in Setup → Privacy.");
    const at = this.now().toISOString();
    try {
      const adapter = this.adapter();
      const balances = await adapter.balances(creds, signal);
      const positions: TradingPositionSummary[] = [];
      let cursor: string | undefined;
      let complete = false;
      for (let page = 0; page < MAX_POSITION_PAGES; page++) {
        const r = await adapter.positions(creds, { cursor, signal });
        positions.push(...r.positions);
        if (r.eof || !r.nextCursor) { complete = true; break; }
        cursor = r.nextCursor;
      }
      const openOrders: TradingOpenOrderSummary[] = await adapter.openOrders(creds, { signal });
      const id = crypto.randomUUID();
      this.db.transaction(() => {
        this.db.run(
          "INSERT INTO trading_account_syncs (id, binding_id, at, ok, error, balances_json, positions_json, open_orders_json, complete) VALUES (?, ?, ?, 1, NULL, ?, ?, ?, ?)",
          id, binding.id, at, JSON.stringify(balances), JSON.stringify(positions), JSON.stringify(openOrders), complete ? 1 : 0,
        );
        this.db.run("UPDATE trading_accounts SET last_sync_at = ?, last_validated_at = ?, last_validation_error = NULL WHERE id = ?", at, at, binding.id);
        this.db.run("DELETE FROM trading_account_syncs WHERE binding_id = ? AND id NOT IN (SELECT id FROM trading_account_syncs WHERE binding_id = ? ORDER BY at DESC LIMIT ?)", binding.id, binding.id, SYNC_RETENTION);
      });
      this.recordAdapterOutcome(true);
      return { id, bindingId: binding.id, at, ok: true, balances, positions, openOrders, complete };
    } catch (err) {
      const { code, message } = describeError(err, creds);
      if (code !== "bad_request" && code !== "not_found") this.recordAdapterOutcome(false, code);
      const id = crypto.randomUUID();
      this.db.run("INSERT INTO trading_account_syncs (id, binding_id, at, ok, error, complete) VALUES (?, ?, ?, 0, ?, 0)", id, binding.id, at, `${code}: ${message}`);
      if (code === "unauthorized" || code === "forbidden" || code === "clock_skew") {
        this.db.run("UPDATE trading_accounts SET last_validation_error = ? WHERE id = ?", `${code}: ${message}`, binding.id);
        this.audit("connection.validation_failed", binding.id, { code });
      } else {
        this.audit("sync.failed", binding.id, { code });
      }
      throw err instanceof TradingAdapterError ? new TradingAdapterError(err.code, message, err.status) : new TradingAdapterError(code as TradingAdapterError["code"], message);
    }
  }

  latestSync(bindingId: string, okOnly = false): TradingAccountSync | undefined {
    const r = this.db.get<SyncRow>(`SELECT * FROM trading_account_syncs WHERE binding_id = ? ${okOnly ? "AND ok = 1" : ""} ORDER BY at DESC LIMIT 1`, bindingId);
    if (!r) return undefined;
    return {
      id: r.id, bindingId: r.binding_id, at: r.at, ok: r.ok === 1, error: r.error ?? undefined,
      balances: JSON.parse(r.balances_json), positions: JSON.parse(r.positions_json), openOrders: JSON.parse(r.open_orders_json), complete: r.complete === 1,
    };
  }

  // ---- policy (ACC-05) -------------------------------------------------------------------------------

  setMode(mode: TradingMode, opts: { acknowledge?: string } = {}): TradingPolicy {
    const prev = this.policy();
    if (mode === "auto_live") {
      // Automation is armed only through `arm()` (acknowledgement + reviewed policy hash + qualified strategy/category); a bare mode switch never arms it.
      const unmet = this.gates().filter((g) => !g.satisfied && g.id !== "live_authorization");
      throw new TradingGateError(`auto_live is armed only through POST /api/trading/arm with the acknowledgement, the reviewed policy hash and a qualified strategy/category${unmet.length ? `; unmet: ${unmet.map((g) => g.label).join("; ")}` : ""}.`, unmet.length ? unmet : [{ id: "live_authorization", label: "Explicit owner automation authorization", satisfied: false, detail: "use /api/trading/arm" }]);
    }
    if (mode === "manual_live") {
      // 1.13: manual live needs the account gates (not strategy qualification) and an explicit owner acknowledgement.
      const required = ["credentials_valid", "account_fresh", "reconciled", "submission_feature", "no_holds", "not_paused", "breaker_closed"];
      const unmet = this.gates().filter((g) => required.includes(g.id) && !g.satisfied);
      if (unmet.length) throw new TradingGateError(`manual_live is not available: ${unmet.map((g) => g.label).join("; ")}.`, unmet);
      if (opts.acknowledge !== LIVE_ACKNOWLEDGEMENT) throw new TradingGateError(`manual_live requires the exact acknowledgement "${LIVE_ACKNOWLEDGEMENT}".`, [{ id: "live_authorization", label: "Explicit owner live authorization", satisfied: false, detail: "acknowledgement text missing or different" }]);
      const at = this.now().toISOString();
      const hash = crypto.createHash("sha256").update(JSON.stringify({ mode, at, policyHash: prev.policyHash, binding: this.connected()?.id })).digest("hex");
      this.db.run("UPDATE trading_policy SET mode = 'manual_live', live_authorized_at = ?, live_authorization_hash = ?, updated_at = ? WHERE id = 'default'", at, hash, at);
      this.audit("policy.mode_changed", this.connected()?.id, { from: prev.mode, to: mode, liveAuthorizationHash: hash, acknowledged: true });
      return this.policy();
    }
    const wasLive = prev.mode === "manual_live" || prev.mode === "auto_live";
    this.db.run("UPDATE trading_policy SET mode = ?, live_authorized_at = NULL, live_authorization_hash = NULL, authorized_policy_hash = NULL, authorized_strategy_version = NULL, authorized_category = NULL, updated_at = ? WHERE id = 'default'", mode, this.now().toISOString());
    this.audit("policy.mode_changed", this.connected()?.id, { from: prev.mode, to: mode, disarmed: wasLive });
    return this.policy();
  }

  // ---- startup / restore (OPS-02) ---------------------------------------------------------------------

  /** Called once at boot: a restored or scrubbed database must never look armed or connected without its secrets. */
  startupCheck(): { needsRebind: boolean; disarmed: boolean } {
    let needsRebind = false;
    let disarmed = false;
    const binding = this.connected();
    if (binding && !this.hasCredentials()) {
      this.markNeedsRebind(binding.id, "database restored without its trading credentials");
      needsRebind = true;
    }
    const p = this.policy();
    if (p.mode === "manual_live" || p.mode === "auto_live" || p.liveAuthorizedAt) {
      this.db.run("UPDATE trading_policy SET mode = 'paper', live_authorized_at = NULL, live_authorization_hash = NULL, authorized_policy_hash = NULL, authorized_strategy_version = NULL, authorized_category = NULL, updated_at = ? WHERE id = 'default'", this.now().toISOString());
      this.audit("trading.disarmed", binding?.id, { reason: "startup", previousMode: p.mode });
      disarmed = true;
    }
    return { needsRebind, disarmed };
  }

  private markNeedsRebind(bindingId: string, reason: string): void {
    this.db.run("UPDATE trading_accounts SET state = 'needs_rebind', reconcile_required = 1, last_validation_error = ? WHERE id = ? AND state = 'connected'", reason, bindingId);
    this.audit("connection.needs_rebind", bindingId, { reason });
  }

  // ---- helpers --------------------------------------------------------------------------------------

  private resolveCredentials(input: Partial<TradingCredentials>): TradingCredentials | undefined {
    const keyId = input.keyId?.trim() || this.vault.get(TRADING_SECRET_NAMES.keyId);
    const secretKey = input.secretKey?.trim() || this.vault.get(TRADING_SECRET_NAMES.secretKey);
    return keyId && secretKey ? { keyId, secretKey } : undefined;
  }

  private secretMaterial(): (string | undefined)[] {
    return [this.vault.get(TRADING_SECRET_NAMES.secretKey), this.vault.get(TRADING_SECRET_NAMES.keyId)];
  }

  /** Redact the trading secret material from free text (alerts, logs). The vault handle never leaves this service. */
  redact(text: string): string {
    return redactSecrets(text, this.secretMaterial());
  }

  audit(kind: string, bindingId: string | undefined, details: Record<string, unknown>): void {
    const safe = JSON.parse(redactSecrets(JSON.stringify(details), this.secretMaterial())) as Record<string, unknown>;
    this.db.run("INSERT INTO trading_audit_events (id, at, binding_id, kind, details_json) VALUES (?, ?, ?, ?, ?)", crypto.randomUUID(), this.now().toISOString(), bindingId ?? null, kind, JSON.stringify(safe));
  }
}

export class TradingConnectError extends Error {
  constructor(public readonly test: TradingConnectionTest) {
    super(test.message);
    this.name = "TradingConnectError";
  }
}

function describeError(err: unknown, creds: TradingCredentials): { code: string; message: string } {
  const secrets = [creds.secretKey, creds.keyId];
  if (err instanceof TradingAdapterError) {
    const m = redactSecrets(err.message, secrets);
    switch (err.code) {
      case "unauthorized": return { code: err.code, message: `Polymarket US rejected the credentials (${m}). Check the key ID and secret, and that the key has not been revoked in the developer portal.` };
      case "forbidden": return { code: err.code, message: `Polymarket US refused access for this account (${m}). Identity verification may be incomplete or the account restricted; nothing can trade until the venue permits it.` };
      case "clock_skew": return { code: err.code, message: `The venue rejected the request timestamp (${m}). Requests must be within 30 s of the venue's clock — sync this computer's clock and retry.` };
      case "rate_limited": return { code: err.code, message: "Polymarket US rate limit reached (20 requests/s per key). Wait a moment and retry." };
      case "venue_unavailable": return { code: err.code, message: `Polymarket US is unavailable right now (${m}). No conclusion about the credentials can be drawn.` };
      case "sdk_missing": return { code: err.code, message: m };
      case "host_not_allowed": return { code: err.code, message: m };
      case "network": case "timeout": return { code: err.code, message: `Could not reach ${POLYMARKET_US_HOSTS.api} (${m}).` };
      default: return { code: err.code, message: m };
    }
  }
  return { code: "unknown", message: safeErrorMessage(err, secrets) };
}

function hydrate(r: AccountRow): TradingAccountBinding {
  return {
    id: r.id, venue: r.venue, state: r.state, identityKind: r.identity_kind, externalIdentity: r.external_identity ?? undefined, credentialFingerprint: r.credential_fingerprint ?? undefined,
    keyIdHint: r.key_id_hint ?? undefined, secretHint: r.secret_hint ?? undefined, continuity: r.continuity, reconcileRequired: r.reconcile_required === 1, supersededBy: r.superseded_by ?? undefined,
    createdAt: r.created_at, lastValidatedAt: r.last_validated_at ?? undefined, lastValidationError: r.last_validation_error ?? undefined, lastSyncAt: r.last_sync_at ?? undefined, disconnectedAt: r.disconnected_at ?? undefined,
  };
}
