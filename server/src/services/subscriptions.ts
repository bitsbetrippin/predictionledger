/**
 * Prediction Ledger — saved channel/playlist subscriptions (1.11, SRC-01/02).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * A subscription is a bounded, repeatable version of "Import a playlist or channel": it lists the
 * source on a schedule, dedupes by the canonical YouTube id (so tracking-parameter variants of the
 * same video never import twice), applies a lookback window, a title allowlist and a per-run budget,
 * and queues the ordinary `video.import` job for what is new. Discovery never invents content: a
 * queued video that turns out private, unavailable or captionless fails through the same explicit
 * paths as a manual import, and the run summary records what happened.
 */

import crypto from "node:crypto";
import type { SourceSubscription, SubscriptionRunSummary } from "@prediction-ledger/shared";
import type { Database } from "../db/index.js";
import type { JobContext } from "../jobs/queue.js";
import type { AppContext } from "../context.js";
import { canonicalUrlFor, locateYtDlp } from "../youtube/ytdlp.js";
import { enqueueImport, OFFLINE_MESSAGE } from "../youtube/importer.js";
import { listVideos, parseListUrl, type ListedVideo } from "../youtube/playlist.js";

interface Row {
  id: string; kind: SourceSubscription["kind"]; url: string; title: string | null; enabled: number; poll_interval_hours: number; lookback_days: number; max_videos_per_run: number;
  auto_extract: number; allowlist_json: string; research_budget_json: string | null; last_run_at: string | null; next_run_at: string | null; created_at: string; updated_at: string;
}
interface RunRow { id: string; subscription_id: string; at: string; listed: number; queued: number; already_known: number; skipped_lookback: number; skipped_allowlist: number; skipped_budget: number; error: string | null; queued_video_ids_json: string }

export interface SubscriptionInput {
  url: string;
  title?: string;
  enabled?: boolean;
  pollIntervalHours?: number;
  lookbackDays?: number;
  maxVideosPerRun?: number;
  autoExtract?: boolean;
  categoryAllowlist?: string[];
  researchBudget?: { maxSearches?: number; maxSources?: number };
}

/** Lists a channel/playlist. Injected so tests never need yt-dlp. */
export type VideoLister = (url: string, limit: number, signal?: AbortSignal) => Promise<{ title?: string; entries: ListedVideo[] }>;

export class SubscriptionService {
  constructor(private readonly db: Database) {}

  list(): SourceSubscription[] {
    return this.db.all<Row>("SELECT * FROM source_subscriptions ORDER BY created_at").map((r) => this.hydrate(r));
  }

  get(id: string): SourceSubscription | undefined {
    const r = this.db.get<Row>("SELECT * FROM source_subscriptions WHERE id = ?", id);
    return r ? this.hydrate(r) : undefined;
  }

  create(input: SubscriptionInput): SourceSubscription {
    const parsed = parseListUrl(input.url);
    if (!parsed) throw new Error("That does not look like a YouTube playlist or channel link.");
    const existing = this.db.get<Row>("SELECT * FROM source_subscriptions WHERE url = ?", parsed.url);
    if (existing) return this.hydrate(existing);
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO source_subscriptions (id, kind, url, title, enabled, poll_interval_hours, lookback_days, max_videos_per_run, auto_extract, allowlist_json, research_budget_json, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      id, parsed.kind, parsed.url, input.title?.trim() || null, input.enabled === false ? 0 : 1, clamp(input.pollIntervalHours ?? 24, 1, 24 * 30), clamp(input.lookbackDays ?? 30, 0, 3650),
      clamp(input.maxVideosPerRun ?? 5, 1, 50), input.autoExtract === false ? 0 : 1, JSON.stringify((input.categoryAllowlist ?? []).map((s) => s.trim()).filter(Boolean)), input.researchBudget ? JSON.stringify(input.researchBudget) : null,
    );
    return this.get(id)!;
  }

  update(id: string, patch: Partial<Omit<SubscriptionInput, "url">>): SourceSubscription | undefined {
    const cur = this.db.get<Row>("SELECT * FROM source_subscriptions WHERE id = ?", id);
    if (!cur) return undefined;
    this.db.run(
      `UPDATE source_subscriptions SET title = ?, enabled = ?, poll_interval_hours = ?, lookback_days = ?, max_videos_per_run = ?, auto_extract = ?, allowlist_json = ?, research_budget_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      patch.title !== undefined ? patch.title.trim() || null : cur.title,
      patch.enabled === undefined ? cur.enabled : patch.enabled ? 1 : 0,
      patch.pollIntervalHours !== undefined ? clamp(patch.pollIntervalHours, 1, 24 * 30) : cur.poll_interval_hours,
      patch.lookbackDays !== undefined ? clamp(patch.lookbackDays, 0, 3650) : cur.lookback_days,
      patch.maxVideosPerRun !== undefined ? clamp(patch.maxVideosPerRun, 1, 50) : cur.max_videos_per_run,
      patch.autoExtract === undefined ? cur.auto_extract : patch.autoExtract ? 1 : 0,
      patch.categoryAllowlist !== undefined ? JSON.stringify(patch.categoryAllowlist.map((s) => s.trim()).filter(Boolean)) : cur.allowlist_json,
      patch.researchBudget !== undefined ? (patch.researchBudget ? JSON.stringify(patch.researchBudget) : null) : cur.research_budget_json,
      id,
    );
    return this.get(id);
  }

  delete(id: string): boolean {
    return Number(this.db.run("DELETE FROM source_subscriptions WHERE id = ?", id).changes) > 0;
  }

  /** Enabled subscriptions whose next run is due at `now`. */
  due(now = new Date().toISOString()): SourceSubscription[] {
    return this.db.all<Row>("SELECT * FROM source_subscriptions WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY next_run_at", now).map((r) => this.hydrate(r));
  }

  recordRun(id: string, summary: Omit<SubscriptionRunSummary, "runId" | "at">, now = new Date().toISOString()): SubscriptionRunSummary {
    const runId = crypto.randomUUID();
    const sub = this.db.get<Row>("SELECT * FROM source_subscriptions WHERE id = ?", id);
    const next = new Date(Date.parse(now) + (sub?.poll_interval_hours ?? 24) * 3_600_000).toISOString();
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO subscription_runs (id, subscription_id, at, listed, queued, already_known, skipped_lookback, skipped_allowlist, skipped_budget, error, queued_video_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        runId, id, now, summary.listed, summary.queued, summary.alreadyKnown, summary.skippedLookback, summary.skippedAllowlist, summary.skippedBudget, summary.error ?? null, JSON.stringify(summary.queuedVideoIds),
      );
      this.db.run("UPDATE source_subscriptions SET last_run_at = ?, next_run_at = ? WHERE id = ?", now, next, id);
      this.db.run("DELETE FROM subscription_runs WHERE subscription_id = ? AND id NOT IN (SELECT id FROM subscription_runs WHERE subscription_id = ? ORDER BY at DESC LIMIT 100)", id, id);
    });
    return { runId, at: now, ...summary };
  }

  runs(id: string, limit = 20): SubscriptionRunSummary[] {
    return this.db.all<RunRow>("SELECT * FROM subscription_runs WHERE subscription_id = ? ORDER BY at DESC LIMIT ?", id, limit).map(toRunSummary);
  }

  private hydrate(r: Row): SourceSubscription {
    const last = this.db.get<RunRow>("SELECT * FROM subscription_runs WHERE subscription_id = ? ORDER BY at DESC LIMIT 1", r.id);
    return {
      id: r.id, kind: r.kind, url: r.url, title: r.title ?? undefined, enabled: r.enabled === 1, pollIntervalHours: r.poll_interval_hours, lookbackDays: r.lookback_days, maxVideosPerRun: r.max_videos_per_run,
      autoExtract: r.auto_extract === 1, categoryAllowlist: JSON.parse(r.allowlist_json) as string[], researchBudget: r.research_budget_json ? (JSON.parse(r.research_budget_json) as SourceSubscription["researchBudget"]) : undefined,
      lastRunAt: r.last_run_at ?? undefined, lastResult: last ? toRunSummary(last) : undefined, nextRunAt: r.next_run_at ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }
}

function toRunSummary(r: RunRow): SubscriptionRunSummary {
  return { runId: r.id, at: r.at, listed: r.listed, queued: r.queued, alreadyKnown: r.already_known, skippedLookback: r.skipped_lookback, skippedAllowlist: r.skipped_allowlist, skippedBudget: r.skipped_budget, error: r.error ?? undefined, queuedVideoIds: JSON.parse(r.queued_video_ids_json) as string[] };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

/** Default lister: yt-dlp flat playlist listing (needs the tool and internet). */
export function ytDlpLister(ctx: AppContext): VideoLister {
  return async (url, limit, signal) => {
    if (!ctx.settings.getPersisted().privacy.allowInternet) throw new Error(OFFLINE_MESSAGE);
    const tool = await locateYtDlp(ctx.paths.tools);
    return listVideos(tool, url, limit, signal);
  };
}

/** Pure decision for one listed entry — what a poll does with it and why. */
export function classifyEntry(e: ListedVideo, sub: Pick<SourceSubscription, "lookbackDays" | "categoryAllowlist" | "maxVideosPerRun">, known: boolean, queuedSoFar: number, now: string): "known" | "lookback" | "allowlist" | "budget" | "queue" {
  if (known) return "known";
  if (sub.lookbackDays > 0 && e.uploadDate) {
    const age = (Date.parse(now) - Date.parse(`${e.uploadDate}T00:00:00Z`)) / 86_400_000;
    if (age > sub.lookbackDays) return "lookback";
  }
  if (sub.categoryAllowlist.length > 0) {
    const title = (e.title ?? "").toLowerCase();
    if (!sub.categoryAllowlist.some((k) => title.includes(k.toLowerCase()))) return "allowlist";
  }
  if (queuedSoFar >= sub.maxVideosPerRun) return "budget";
  return "queue";
}

/** subscription.poll job: list → classify → queue ordinary imports for the new ones; record the run. */
export function makeSubscriptionPollHandler(ctx: AppContext, lister?: VideoLister) {
  const list = lister ?? ytDlpLister(ctx);
  return async (job: JobContext): Promise<Record<string, unknown>> => {
    const id = String(job.payload.subscriptionId ?? "");
    const sub = ctx.subscriptions.get(id);
    if (!sub) throw new Error(`Subscription ${id} no longer exists.`);
    const now = new Date().toISOString();
    const summary = { listed: 0, queued: 0, alreadyKnown: 0, skippedLookback: 0, skippedAllowlist: 0, skippedBudget: 0, queuedVideoIds: [] as string[], error: undefined as string | undefined };
    if (!sub.enabled && job.payload.force !== true) {
      ctx.subscriptions.recordRun(id, { ...summary, error: "subscription disabled" }, now);
      return { ...summary, skipped: "disabled" };
    }
    try {
      job.progress(5, `Listing ${sub.title ?? sub.url}`);
      const listing = await list(sub.url, Math.min(100, Math.max(sub.maxVideosPerRun * 4, 20)), job.signal);
      summary.listed = listing.entries.length;
      if (listing.title && !sub.title) ctx.subscriptions.update(id, { title: listing.title });
      for (let i = 0; i < listing.entries.length; i++) {
        if (job.signal.aborted) throw new Error("Cancelled");
        const e = listing.entries[i];
        const known = !!ctx.videos.findByYouTubeId(e.id);
        const verdict = classifyEntry(e, sub, known, summary.queued, now);
        if (verdict === "known") summary.alreadyKnown++;
        else if (verdict === "lookback") summary.skippedLookback++;
        else if (verdict === "allowlist") summary.skippedAllowlist++;
        else if (verdict === "budget") summary.skippedBudget++;
        else {
          job.progress(10 + Math.round((i / Math.max(1, listing.entries.length)) * 85), `Queuing ${e.title?.slice(0, 50) ?? e.id}`);
          const video = ctx.videos.createFromYouTube({ youtubeId: e.id, url: canonicalUrlFor(e.id), title: e.title, publishedAt: e.uploadDate, channel: e.channel, subscriptionId: id, firstSeenAt: now });
          ctx.videos.setSourceList(video.id, sub.url);
          enqueueImport(ctx, video.id, { title: !!e.title, publishedAt: !!e.uploadDate }, false, sub.autoExtract);
          summary.queued++;
          summary.queuedVideoIds.push(video.id);
        }
      }
      const rec = ctx.subscriptions.recordRun(id, summary, now);
      job.progress(100, `${summary.queued} new video(s) queued, ${summary.alreadyKnown} already known`);
      return { ...rec };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.subscriptions.recordRun(id, { ...summary, error: message }, now);
      throw err;
    }
  };
}
