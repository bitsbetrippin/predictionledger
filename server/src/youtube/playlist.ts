/**
 * Prediction Ledger — playlist / channel bulk import (1.8).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * `yt-dlp --flat-playlist --dump-single-json <url>` lists a playlist, a channel's videos tab, or a
 * search-free "@handle" page without downloading anything; each listed video that is not already in
 * the ledger is created and queued through the ordinary video.import job (captions → audio fallback),
 * optionally followed by prediction extraction. The listing URL is recorded on each video
 * (`source_list`) so a channel can be re-imported later and its videos grouped.
 */

import type { JobContext } from "../jobs/queue.js";
import type { AppContext } from "../context.js";
import { run } from "../media/ffmpeg.js";
import { enqueueImport, OFFLINE_MESSAGE, YouTubeImportError } from "./importer.js";
import { canonicalUrlFor, classifyYtDlpError, commonArgs, locateYtDlp, type YtDlpTool } from "./ytdlp.js";

export interface ListedVideo { id: string; title?: string; uploadDate?: string; durationS?: number; channel?: string }

/** Accept playlist, channel (/channel/…, /c/…, /@handle[/videos]), and user URLs; reject single-video links. */
export function parseListUrl(input: string): { url: string; kind: "playlist" | "channel" } | undefined {
  let u: URL;
  try { u = new URL(input.trim()); } catch { return undefined; }
  if (!/(^|\.)youtube\.com$/i.test(u.hostname)) return undefined;
  if (u.pathname === "/playlist" && u.searchParams.get("list")) return { url: `https://www.youtube.com/playlist?list=${u.searchParams.get("list")}`, kind: "playlist" };
  if (u.pathname === "/watch" && u.searchParams.get("list")) return { url: `https://www.youtube.com/playlist?list=${u.searchParams.get("list")}`, kind: "playlist" };
  const ch = /^\/(channel\/[A-Za-z0-9_-]+|c\/[^/]+|user\/[^/]+|@[^/]+)(\/videos|\/streams|\/shorts)?\/?$/.exec(u.pathname);
  if (ch) return { url: `https://www.youtube.com/${ch[1]}${ch[2] ?? "/videos"}`, kind: "channel" };
  return undefined;
}

export function parseFlatPlaylist(json: string): { title?: string; entries: ListedVideo[] } {
  const data = JSON.parse(json) as { title?: string; entries?: { id?: string; title?: string; upload_date?: string; duration?: number; channel?: string; uploader?: string; _type?: string }[] };
  const entries: ListedVideo[] = [];
  for (const e of data.entries ?? []) {
    if (!e?.id || !/^[A-Za-z0-9_-]{11}$/.test(e.id)) continue;
    entries.push({ id: e.id, title: e.title, uploadDate: e.upload_date && /^\d{8}$/.test(e.upload_date) ? `${e.upload_date.slice(0, 4)}-${e.upload_date.slice(4, 6)}-${e.upload_date.slice(6, 8)}` : undefined, durationS: typeof e.duration === "number" ? e.duration : undefined, channel: e.channel ?? e.uploader });
  }
  return { title: data.title, entries };
}

export async function listVideos(tool: YtDlpTool, url: string, limit: number, signal?: AbortSignal): Promise<{ title?: string; entries: ListedVideo[] }> {
  try {
    const { stdout } = await run(tool.path, ["--flat-playlist", "--dump-single-json", "--skip-download", "--no-progress", "--playlist-end", String(limit), ...commonArgs(), "--", url], signal);
    return parseFlatPlaylist(stdout);
  } catch (err) {
    throw classifyYtDlpError(err as Error);
  }
}

export async function precheckListImport(ctx: AppContext, input: string): Promise<{ url: string; kind: "playlist" | "channel" }> {
  const parsed = parseListUrl(input);
  if (!parsed) throw new YouTubeImportError("That does not look like a YouTube playlist or channel link. Paste a youtube.com/playlist?list=… or youtube.com/@channel/videos URL.", 400, "invalid_url");
  if (!ctx.settings.getPersisted().privacy.allowInternet) throw new YouTubeImportError(OFFLINE_MESSAGE, 409, "offline");
  try { await locateYtDlp(ctx.paths.tools); } catch (err) { throw new YouTubeImportError((err as Error).message, 409, "tool_missing"); }
  return parsed;
}

export function makePlaylistImportHandler(ctx: AppContext) {
  return async (job: JobContext): Promise<Record<string, unknown>> => {
    const url = String(job.payload.url ?? "");
    const limit = Math.min(Math.max(Number(job.payload.limit ?? 20), 1), 200);
    const autoExtract = job.payload.autoExtract === true;
    if (!ctx.settings.getPersisted().privacy.allowInternet) throw new Error(OFFLINE_MESSAGE);
    const tool = await locateYtDlp(ctx.paths.tools);
    job.progress(5, "Listing videos");
    const listing = await listVideos(tool, url, limit, job.signal);
    const queued: string[] = [];
    const skipped: string[] = [];
    for (let i = 0; i < listing.entries.length; i++) {
      if (job.signal.aborted) throw new Error("Cancelled");
      const e = listing.entries[i];
      job.progress(10 + Math.round((i / Math.max(1, listing.entries.length)) * 85), `Queuing ${i + 1}/${listing.entries.length}: ${e.title?.slice(0, 50) ?? e.id}`);
      if (ctx.videos.findByYouTubeId(e.id)) { skipped.push(e.id); continue; }
      const video = ctx.videos.createFromYouTube({ youtubeId: e.id, url: canonicalUrlFor(e.id), title: e.title, publishedAt: e.uploadDate });
      ctx.videos.setSourceList(video.id, url);
      enqueueImport(ctx, video.id, { title: !!e.title, publishedAt: !!e.uploadDate }, false, autoExtract);
      queued.push(video.id);
    }
    job.progress(100, `${queued.length} video(s) queued${skipped.length ? `, ${skipped.length} already in the ledger` : ""}`);
    return { listTitle: listing.title, found: listing.entries.length, queued: queued.length, skipped: skipped.length, videoIds: queued };
  };
}
