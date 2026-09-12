/**
 * Prediction Ledger — HTTP API routes for local media upload and media tooling status (Release 0.4).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Upload is a raw `application/octet-stream` body (the browser sends the File directly), so no
 * multipart parser dependency is needed. Metadata travels in headers:
 *   x-file-name (percent-encoded), x-file-size, x-published-at (YYYY-MM-DD), x-language, x-title (percent-encoded).
 * The stream is written to disk under a hash name with a hard size cap and validated with ffprobe.
 */

import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import type { MediaStatus } from "@prediction-ledger/shared";
import type { AppContext } from "../context.js";
import { importMediaStream, MAX_UPLOAD_BYTES, removeMediaFiles, UploadError } from "../media/importer.js";
import { locateTools } from "../media/ffmpeg.js";

export function registerMediaRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Raw stream parser for uploads only; JSON routes are unaffected.
  app.addContentTypeParser("application/octet-stream", (_req: unknown, payload: Readable, done: (err: Error | null, body?: unknown) => void) => done(null, payload));

  app.post("/api/videos/upload", { bodyLimit: MAX_UPLOAD_BYTES }, async (req, reply) => {
    const h = req.headers as Record<string, string | undefined>;
    const fileName = decodeURIComponent(h["x-file-name"] ?? "");
    if (!fileName) return reply.code(400).send({ error: "invalid_request", message: "Missing x-file-name header." });
    const publishedAt = h["x-published-at"];
    if (publishedAt && !/^\d{4}-\d{2}-\d{2}$/.test(publishedAt)) return reply.code(400).send({ error: "invalid_request", message: "x-published-at must be YYYY-MM-DD." });
    try {
      const result = await importMediaStream(ctx, req.body as Readable, {
        fileName,
        declaredSize: h["x-file-size"] ? Number(h["x-file-size"]) : undefined,
        publishedAt: publishedAt || undefined,
        language: h["x-language"] || undefined,
        title: h["x-title"] ? decodeURIComponent(h["x-title"]) : undefined,
      });
      return reply.code(result.duplicate ? 200 : 201).send(result);
    } catch (err) {
      if (err instanceof UploadError) return reply.code(err.status).send({ error: "upload_failed", message: err.message });
      throw err;
    }
  });

  /** Re-run transcription (resumes unfinished chunks; use `restart` to discard existing segments). */
  app.post<{ Params: { id: string }; Body: { restart?: boolean } }>("/api/videos/:id/transcribe", async (req, reply) => {
    const v = ctx.videos.get(req.params.id);
    const info = ctx.videos.mediaInfo(req.params.id);
    if (!v || !info?.mediaPath) return reply.code(404).send({ error: "not_found", message: "No local media for this video." });
    if ((req.body as { restart?: boolean } | undefined)?.restart) {
      ctx.db.transaction(() => {
        ctx.db.run("DELETE FROM transcript_segments WHERE video_id = ?", v.id);
        ctx.db.run("DELETE FROM transcription_chunks WHERE video_id = ?", v.id);
      });
    }
    const kind = info.audioPath ? "transcript.generate" : "audio.extract";
    const jobId = ctx.jobs.enqueue({ kind, subjectType: "video", subjectId: v.id, payload: { videoId: v.id }, dedupeKey: `${kind}:${v.id}`, maxAttempts: 2 });
    return reply.code(202).send({ jobId, stage: kind });
  });

  app.get("/api/media/status", async (): Promise<MediaStatus> => {
    let ffmpeg: MediaStatus["ffmpeg"];
    try {
      const t = await locateTools();
      ffmpeg = { ok: true, message: `ffmpeg found (${t.source === "path" ? "on PATH" : t.source})`, source: t.source };
    } catch (err) {
      ffmpeg = { ok: false, message: (err as Error).message };
    }
    const engine = ctx.transcription();
    const check = await engine.check();
    return { ffmpeg, engine: { id: engine.id, ...check } };
  });

  // Hook media cleanup into video deletion (files first, then the row cascades).
  app.addHook("preHandler", async (req) => {
    if (req.method === "DELETE" && /^\/api\/videos\/[^/]+$/.test(req.url)) {
      const id = req.url.split("/")[3];
      removeMediaFiles(ctx, id);
    }
  });
}
