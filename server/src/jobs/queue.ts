/**
 * Prediction Ledger — durable in-process job queue backed by SQLite.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Design (docs/ARCHITECTURE.md §4.5):
 *  - Jobs are rows in the `jobs` table, so they survive restarts. No Redis, no extra process.
 *  - A single worker loop claims up to `concurrency` queued jobs, runs their handler, and
 *    writes progress + heartbeat back to the row so the dashboard can poll it.
 *  - On startup, "running" jobs whose heartbeat is stale are put back to "queued"
 *    (restart recovery). Attempts are bounded; the final failure is stored with its error.
 *  - Handlers receive an AbortSignal; cancellation flips the row to "cancelled" and aborts.
 *  - `dedupeKey` prevents the same work being queued twice for the same subject.
 *
 * Release 0.1 ships the machinery with no registered handlers. Each later release adds
 * handlers for its JobKind (audio.extract, transcript.generate, ...).
 */

import crypto from "node:crypto";
import type { JobKind, JobStatus, JobSummary } from "@prediction-ledger/shared";
import type { Database } from "../db/index.js";

export interface JobContext {
  id: string;
  signal: AbortSignal;
  payload: Record<string, unknown>;
  /** Report progress (0–100) and an optional human-readable stage label. */
  progress(percent: number, stage?: string): void;
}

export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown> | void>;

interface JobRow {
  id: string;
  kind: JobKind;
  status: JobStatus;
  subject_type: string | null;
  subject_id: string | null;
  payload_json: string;
  progress: number;
  stage: string | null;
  attempts: number;
  max_attempts: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const STALE_HEARTBEAT_SECONDS = 120;
const POLL_INTERVAL_MS = 1000;

export class JobQueue {
  private readonly handlers = new Map<JobKind, JobHandler>();
  private readonly running = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly db: Database,
    private readonly concurrency: () => number,
  ) {}

  register(kind: JobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  enqueue(opts: {
    kind: JobKind;
    payload?: Record<string, unknown>;
    subjectType?: string;
    subjectId?: string;
    dedupeKey?: string;
    maxAttempts?: number;
  }): string {
    const id = crypto.randomUUID();
    try {
      this.db.run(
        `INSERT INTO jobs (id, kind, subject_type, subject_id, payload_json, dedupe_key, max_attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        opts.kind,
        opts.subjectType ?? null,
        opts.subjectId ?? null,
        JSON.stringify(opts.payload ?? {}),
        opts.dedupeKey ?? null,
        opts.maxAttempts ?? 3,
      );
    } catch (err) {
      // UNIQUE violation on dedupe_key → an identical job is already queued/running.
      const existing = opts.dedupeKey
        ? this.db.get<{ id: string }>(
            "SELECT id FROM jobs WHERE dedupe_key = ? AND status IN ('queued','running')",
            opts.dedupeKey,
          )
        : undefined;
      if (existing) return existing.id;
      throw err;
    }
    return id;
  }

  cancel(id: string): boolean {
    const ctl = this.running.get(id);
    if (ctl) ctl.abort();
    const result = this.db.run(
      `UPDATE jobs SET status='cancelled', finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND status IN ('queued','running')`,
      id,
    );
    return Number(result.changes) > 0;
  }

  get(id: string): JobSummary | undefined {
    const row = this.db.get<JobRow>("SELECT * FROM jobs WHERE id = ?", id);
    return row ? toSummary(row) : undefined;
  }

  list(limit = 50): JobSummary[] {
    return this.db.all<JobRow>("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", limit).map(toSummary);
  }

  /** Restart recovery + start polling. */
  start(): void {
    const recovered = this.db.run(
      `UPDATE jobs SET status='queued', stage='Recovered after restart', heartbeat_at=NULL
       WHERE status='running'
         AND (heartbeat_at IS NULL OR heartbeat_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?))`,
      `-${STALE_HEARTBEAT_SECONDS} seconds`,
    );
    if (Number(recovered.changes) > 0) {
      // eslint-disable-next-line no-console
      console.log(`[jobs] re-queued ${recovered.changes} interrupted job(s)`);
    }
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const ctl of this.running.values()) ctl.abort();
    // Give handlers a moment to observe the abort and write their state.
    await new Promise((r) => setTimeout(r, 250));
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const slots = this.concurrency() - this.running.size;
    if (slots <= 0) return;

    const kinds = [...this.handlers.keys()];
    if (kinds.length === 0) return;
    const placeholders = kinds.map(() => "?").join(",");
    const candidates = this.db.all<JobRow>(
      `SELECT * FROM jobs WHERE status='queued' AND kind IN (${placeholders}) ORDER BY created_at ASC LIMIT ?`,
      ...kinds,
      slots,
    );

    for (const row of candidates) {
      // Atomic claim: only one tick can flip queued→running for a given id.
      const claimed = this.db.run(
        `UPDATE jobs SET status='running', attempts=attempts+1,
           started_at=COALESCE(started_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
           heartbeat_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), error=NULL
         WHERE id = ? AND status='queued'`,
        row.id,
      );
      if (Number(claimed.changes) === 0) continue;
      void this.execute(row);
    }
  }

  private async execute(row: JobRow): Promise<void> {
    const handler = this.handlers.get(row.kind);
    if (!handler) return;
    const ctl = new AbortController();
    this.running.set(row.id, ctl);

    const heartbeat = setInterval(() => {
      this.db.run("UPDATE jobs SET heartbeat_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", row.id);
    }, 15_000);

    const ctx: JobContext = {
      id: row.id,
      signal: ctl.signal,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      progress: (percent, stage) => {
        this.db.run(
          "UPDATE jobs SET progress=?, stage=COALESCE(?, stage) WHERE id = ?",
          Math.max(0, Math.min(100, Math.round(percent))),
          stage ?? null,
          row.id,
        );
      },
    };

    try {
      const result = await handler(ctx);
      if (ctl.signal.aborted) return; // cancel() already wrote the final status
      this.db.run(
        `UPDATE jobs SET status='completed', progress=100, result_json=?, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        JSON.stringify(result ?? {}),
        row.id,
      );
    } catch (err) {
      if (ctl.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      const attempts = row.attempts + 1;
      const final = attempts >= row.max_attempts;
      this.db.run(
        `UPDATE jobs SET status=?, error=?, finished_at=CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END WHERE id = ?`,
        final ? "failed" : "queued",
        message.slice(0, 2000),
        final ? 1 : 0,
        row.id,
      );
    } finally {
      clearInterval(heartbeat);
      this.running.delete(row.id);
    }
  }
}

function toSummary(row: JobRow): JobSummary {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    progress: row.progress,
    stage: row.stage ?? undefined,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    error: row.error ?? undefined,
    subjectType: row.subject_type ?? undefined,
    subjectId: row.subject_id ?? undefined,
  };
}
