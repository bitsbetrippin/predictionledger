/**
 * Prediction Ledger — watch-rule alerts (1.8).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * An alert is a local note that a rule fired — nothing leaves the machine. `dedupe_key` keeps one
 * alert per rule/subject/period so a rule that stays true does not spam.
 */

import crypto from "node:crypto";
import type { Alert } from "@prediction-ledger/shared";
import type { Database } from "../db/index.js";

interface Row { id: string; kind: Alert["kind"]; market_id: string | null; side: string | null; prediction_id: string | null; message: string; value: number | null; threshold: number | null; created_at: string; seen_at: string | null; dismissed_at: string | null; question: string | null; url: string | null }

const SQL = "SELECT a.*, m.question, m.url FROM alerts a LEFT JOIN markets m ON m.id = a.market_id";

export class AlertService {
  constructor(private readonly db: Database) {}

  /** Insert unless the dedupe key exists; returns the alert when new. */
  raise(input: { kind: Alert["kind"]; marketId?: string; side?: string; predictionId?: string; message: string; value?: number; threshold?: number; dedupeKey: string }): Alert | undefined {
    const exists = this.db.get<{ id: string }>("SELECT id FROM alerts WHERE dedupe_key = ?", input.dedupeKey);
    if (exists) return undefined;
    const id = crypto.randomUUID();
    this.db.run(
      "INSERT INTO alerts (id, kind, market_id, side, prediction_id, message, value, threshold, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, input.kind, input.marketId ?? null, input.side ?? null, input.predictionId ?? null, input.message, input.value ?? null, input.threshold ?? null, input.dedupeKey,
    );
    return this.get(id);
  }

  get(id: string): Alert | undefined {
    const r = this.db.get<Row>(`${SQL} WHERE a.id = ?`, id);
    return r ? hydrate(r) : undefined;
  }

  list(opts: { includeDismissed?: boolean; limit?: number } = {}): Alert[] {
    const rows = opts.includeDismissed
      ? this.db.all<Row>(`${SQL} ORDER BY a.created_at DESC LIMIT ?`, opts.limit ?? 200)
      : this.db.all<Row>(`${SQL} WHERE a.dismissed_at IS NULL ORDER BY a.created_at DESC LIMIT ?`, opts.limit ?? 200);
    return rows.map(hydrate);
  }

  openCount(): number {
    return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM alerts WHERE dismissed_at IS NULL")?.n ?? 0);
  }

  markSeen(ids: string[]): void {
    for (const id of ids) this.db.run("UPDATE alerts SET seen_at = COALESCE(seen_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?", id);
  }

  dismiss(id: string): Alert | undefined {
    this.db.run("UPDATE alerts SET dismissed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", id);
    return this.get(id);
  }

  dismissAll(): number {
    return Number(this.db.run("UPDATE alerts SET dismissed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE dismissed_at IS NULL").changes);
  }
}

function hydrate(r: Row): Alert {
  return {
    id: r.id, kind: r.kind, marketId: r.market_id ?? undefined, side: r.side ?? undefined, predictionId: r.prediction_id ?? undefined, message: r.message, value: r.value ?? undefined,
    threshold: r.threshold ?? undefined, createdAt: r.created_at, seenAt: r.seen_at ?? undefined, dismissedAt: r.dismissed_at ?? undefined, market: r.question ? { question: r.question, url: r.url ?? "" } : undefined,
  };
}
