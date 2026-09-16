/**
 * Prediction Ledger — HTTP API routes for YouTube import and helper-tool management (Release 0.5).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { OFFLINE_MESSAGE, startYouTubeImport, toolsStatus, YouTubeImportError } from "../youtube/importer.js";
import { precheckListImport } from "../youtube/playlist.js";

const listBody = z.object({ url: z.string().min(1).max(2000), limit: z.number().int().min(1).max(200).default(20), autoExtract: z.boolean().default(false) });

const importBody = z.object({
  url: z.string().min(1).max(2000),
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  language: z.string().max(10).optional(),
  title: z.string().max(200).optional(),
});

export function registerYouTubeRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/api/videos/import-youtube", async (req, reply) => {
    const parsed = importBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    try {
      const result = await startYouTubeImport(ctx, parsed.data);
      return reply.code(result.duplicate ? 200 : 202).send(result);
    } catch (err) {
      if (err instanceof YouTubeImportError) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  /** 1.8 — bulk import: list a playlist / channel and queue each video. */
  app.post("/api/videos/import-youtube-list", async (req, reply) => {
    const parsed = listBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    try {
      const { url, kind } = await precheckListImport(ctx, parsed.data.url);
      const jobId = ctx.jobs.enqueue({ kind: "playlist.import", subjectType: "list", subjectId: url.slice(0, 200), payload: { url, limit: parsed.data.limit, autoExtract: parsed.data.autoExtract }, dedupeKey: `playlist.import:${url}`, maxAttempts: 1 });
      return reply.code(202).send({ jobId, url, kind });
    } catch (err) {
      if (err instanceof YouTubeImportError) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.get("/api/tools/status", async () => toolsStatus(ctx));

  /** Explicit, user-initiated download of yt-dlp into the data directory (also used for "update"). */
  app.post("/api/tools/ytdlp/install", async (_req, reply) => {
    if (!ctx.settings.getPersisted().privacy.allowInternet) return reply.code(409).send({ error: "offline", message: OFFLINE_MESSAGE });
    const jobId = ctx.jobs.enqueue({ kind: "tool.install", subjectType: "tool", subjectId: "yt-dlp", payload: { tool: "yt-dlp" }, dedupeKey: "tool.install:yt-dlp", maxAttempts: 1 });
    return reply.code(202).send({ jobId });
  });
}
