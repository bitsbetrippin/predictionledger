/**
 * Prediction Ledger — one dispatcher per data directory (1.13, OPS-03).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * A durable lease row in SQLite names the process allowed to dispatch live orders. Acquisition is a single
 * conditional UPDATE (free, expired, or already ours), so two processes on the same database cannot both hold it.
 * The dispatch-marker transaction re-checks the lease with the same condition; a process that lost it cannot send.
 */

import crypto from "node:crypto";
import type { DispatchLease } from "@prediction-ledger/shared";
import type { Database } from "../db/index.js";

export class DispatchLeaseService {
  readonly holder: string;
  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date(), holder?: string) {
    this.holder = holder ?? `${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  }

  /** Try to take (or renew) the lease for `ttlMs`. Returns true when this process holds it afterwards. */
  acquire(ttlMs = 60_000): boolean {
    const now = this.now().toISOString();
    const expires = new Date(this.now().getTime() + ttlMs).toISOString();
    const r = this.db.run(
      "UPDATE dispatch_leases SET holder = ?, acquired_at = CASE WHEN holder = ? THEN acquired_at ELSE ? END, expires_at = ?, heartbeat_at = ? WHERE id = 'default' AND (holder IS NULL OR holder = ? OR expires_at IS NULL OR expires_at < ?)",
      this.holder, this.holder, now, expires, now, this.holder, now,
    );
    return Number(r.changes) > 0;
  }

  /** True when this process holds an unexpired lease at this instant (evaluated inside the caller's transaction when needed). */
  held(): boolean {
    const now = this.now().toISOString();
    return !!this.db.get<{ n: number }>("SELECT 1 AS n FROM dispatch_leases WHERE id = 'default' AND holder = ? AND expires_at > ?", this.holder, now);
  }

  release(): void {
    this.db.run("UPDATE dispatch_leases SET holder = NULL, expires_at = NULL WHERE id = 'default' AND holder = ?", this.holder);
  }

  status(): DispatchLease {
    const r = this.db.get<{ holder: string | null; acquired_at: string | null; expires_at: string | null }>("SELECT holder, acquired_at, expires_at FROM dispatch_leases WHERE id = 'default'");
    return { holder: r?.holder ?? undefined, acquiredAt: r?.acquired_at ?? undefined, expiresAt: r?.expires_at ?? undefined, heldByThisProcess: this.held() };
  }
}
