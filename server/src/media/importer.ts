/**
 * Prediction Ledger — local media import: stream to disk, hash, validate with ffprobe, register.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Security (docs/ARCHITECTURE.md §7.5): the client-supplied file name is used only to check the
 * extension and to derive a title; the stored file is named by content hash under media/. Size is
 * capped while streaming. The file is validated with ffprobe before any job is queued. Duplicate
 * uploads (same hash) return the existing video rather than a second copy.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { VideoDetail } from "@prediction-ledger/shared";
import type { AppContext } from "../context.js";
import { locateTools, MediaError, probe } from "./ffmpeg.js";

export const ALLOWED_EXTENSIONS = new Set([".mp4", ".m4v", ".mpg", ".mpeg", ".mov", ".mkv", ".webm", ".m4a", ".mp3", ".wav", ".aac", ".ogg", ".flac"]);
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB

export class UploadError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 409 | 413 | 422 | 503,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

/** Pure: validate the client-supplied name and derive a clean title + extension. */
export function checkUploadName(rawName: string): { ext: string; title: string } {
  const base = path.basename(rawName.replace(/\\/g, "/")).trim();
  const ext = path.extname(base).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new UploadError(`Unsupported file type "${ext || "(none)"}". Supported: ${[...ALLOWED_EXTENSIONS].join(", ")}.`, 400);
  }
  const title = base.slice(0, -ext.length).replace(/[_.]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || "Untitled video";
  return { ext, title };
}

export async function importMediaStream(ctx: AppContext, stream: Readable, opts: { fileName: string; declaredSize?: number; publishedAt?: string; language?: string; title?: string }): Promise<{ video: VideoDetail; duplicate: boolean; jobId?: string }> {
  const { ext, title } = checkUploadName(opts.fileName);
  if (opts.declaredSize !== undefined && opts.declaredSize > MAX_UPLOAD_BYTES) throw new UploadError(`File exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024 / 1024} GiB upload limit.`, 413);

  let tools;
  try {
    tools = await locateTools();
  } catch (err) {
    throw new UploadError((err as Error).message, 503);
  }

  // 1. stream to a temp file under media/ while hashing and enforcing the size cap
  const tmp = path.join(ctx.paths.media, `upload-${crypto.randomUUID()}.tmp`);
  const hash = crypto.createHash("sha256");
  let received = 0;
  try {
    await pipeline(
      stream,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          received += chunk.length;
          if (received > MAX_UPLOAD_BYTES) throw new UploadError("Upload exceeded the size limit.", 413);
          hash.update(chunk);
          yield chunk;
        }
      },
      fs.createWriteStream(tmp),
    );
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (err instanceof UploadError) throw err;
    throw new UploadError(`Upload failed: ${(err as Error).message}`, 400);
  }
  if (received === 0) {
    fs.rmSync(tmp, { force: true });
    throw new UploadError("The uploaded file was empty.", 400);
  }
  const digest = hash.digest("hex");

  // 2. duplicate?
  const existing = ctx.videos.findByMediaHash(digest);
  if (existing) {
    fs.rmSync(tmp, { force: true });
    return { video: ctx.videos.get(existing.id)!, duplicate: true };
  }

  // 3. validate with ffprobe BEFORE registering anything
  let info;
  try {
    info = await probe(tools, tmp);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw new UploadError(err instanceof MediaError ? err.message : `Could not read the media file: ${(err as Error).message}`, 422);
  }
  if (!info.hasAudio) {
    fs.rmSync(tmp, { force: true });
    throw new UploadError("The file has no audio track, so there is nothing to transcribe. Import a transcript instead.", 422);
  }

  // 4. move into place under a hash name, register, enqueue extraction
  const finalRel = path.join("media", `${digest}${ext}`);
  const finalAbs = path.join(ctx.paths.root, finalRel);
  fs.renameSync(tmp, finalAbs);
  const video = ctx.videos.createFromMedia({
    title: opts.title?.trim() || title,
    mediaPath: finalRel,
    mediaHash: digest,
    mediaSize: received,
    durationS: info.durationS,
    publishedAt: opts.publishedAt,
    language: opts.language,
    notes: `${info.container ?? "media"} · audio ${info.audioCodec ?? "?"}${info.videoCodec ? ` · video ${info.videoCodec}` : ""}`,
  });
  const jobId = ctx.jobs.enqueue({ kind: "audio.extract", subjectType: "video", subjectId: video.id, payload: { videoId: video.id }, dedupeKey: `audio.extract:${video.id}`, maxAttempts: 2 });
  return { video, duplicate: false, jobId };
}

/** Remove media/audio files for a video (called before the row is deleted). */
export function removeMediaFiles(ctx: AppContext, videoId: string): void {
  const info = ctx.videos.mediaInfo(videoId);
  for (const rel of [info?.mediaPath, info?.audioPath]) {
    if (!rel) continue;
    const abs = path.join(ctx.paths.root, rel);
    if (abs.startsWith(ctx.paths.root)) fs.rmSync(abs, { force: true });
  }
  fs.rmSync(path.join(ctx.paths.artifacts, "chunks", videoId), { recursive: true, force: true });
}
