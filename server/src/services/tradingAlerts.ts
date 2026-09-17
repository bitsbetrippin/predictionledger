/**
 * Prediction Ledger — local trading alerts, one row per incident (1.14, AUTO-05).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * An alert is keyed by an incident (`unknown_submission:<intent>`, `stale_sync:<binding>`, `circuit_breaker:<incident>`…):
 * raising the same incident again increments its count and last-seen time instead of adding a row, so a poll that
 * finds nothing new produces nothing new. Alerts are local (no notification service), secret-free, and acknowledged
 * by the owner; they never change policy or mode by themselves.
 */

import crypto from "node:crypto";
import type { TradingAlert } from "@prediction-ledger/shared";
import type { Database } from "../db/index.js";

interface Row { id: string; kind: TradingAlert["kind"]; severity: TradingAlert["severity"]; incident_key: string; subject: string | null; message: string; details_json: string; first_at: string; last_at: string; count: number; acknowledged_at: string | null }

export class TradingAlertService {
  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date(), private readonly redact: (s: string) => string = (s) => s) {}

  /** Raise (or bump) an incident. Returns the row and whether it was new. */
  raise(kind: TradingAlert["kind"], incidentKey: string, message: string, opts: { severity?: TradingAlert["severity"]; subject?: string; details?: Record<string, unknown> } = {}): { alert: TradingAlert; created: boolean } {
    const at = this.now().toISOString();
    const safeMessage = this.redact(message).slice(0, 500);
    const details = JSON.parse(this.redact(JSON.stringify(opts.details ?? {}))) as Record<string, unknown>;
    const existing = this.db.get<Row>("SELECT * FROM trading_alerts WHERE incident_key = ?", incidentKey);
    if (existing) {
      // A repeat of an acknowledged incident re-opens it; an open one just counts up.
      this.db.run("UPDATE trading_alerts SET count = count + 1, last_at = ?, message = ?, details_json = ?, acknowledged_at = NULL WHERE id = ?", at, safeMessage, JSON.stringify(details), existing.id);
      return { alert: this.get(existing.id)!, created: false };
    }
    const id = crypto.randomUUID();
    this.db.run(
      "INSERT INTO trading_alerts (id, kind, severity, incident_key, subject, message, details_json, first_at, last_at, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
      id, kind, opts.severity ?? (kind === "unknown_submission" || kind === "circuit_breaker" || kind === "emergency_stop" || kind === "discrepancy" ? "critical" : kind === "resolution" ? "info" : "warning"), incidentKey, opts.subject ?? null, safeMessage, JSON.stringify(details), at, at,
    );
    return { alert: this.get(id)!, created: true };
  }

  get(id: string): TradingAlert | undefined {
    const r = this.db.get<Row>("SELECT * FROM trading_alerts WHERE id = ?", id);
    return r ? hydrate(r) : undefined;
  }

  list(opts: { openOnly?: boolean; limit?: number } = {}): TradingAlert[] {
    return this.db.all<Row>(`SELECT * FROM trading_alerts ${opts.openOnly ? "WHERE acknowledged_at IS NULL" : ""} ORDER BY last_at DESC LIMIT ?`, opts.limit ?? 200).map(hydrate);
  }

  openCount(): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trading_alerts WHERE acknowledged_at IS NULL")?.n ?? 0;
  }

  acknowledge(id: string): TradingAlert | undefined {
    this.db.run("UPDATE trading_alerts SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL", this.now().toISOString(), id);
    return this.get(id);
  }

  /** Close an incident that resolved itself (e.g. the sync is fresh again) without owner action. */
  resolve(incidentKey: string): void {
    this.db.run("UPDATE trading_alerts SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE incident_key = ?", this.now().toISOString(), incidentKey);
  }
}

function hydrate(r: Row): TradingAlert {
  return { id: r.id, kind: r.kind, severity: r.severity, incidentKey: r.incident_key, subject: r.subject ?? undefined, message: r.message, details: JSON.parse(r.details_json) as Record<string, unknown>, firstAt: r.first_at, lastAt: r.last_at, count: r.count, acknowledgedAt: r.acknowledged_at ?? undefined };
}
