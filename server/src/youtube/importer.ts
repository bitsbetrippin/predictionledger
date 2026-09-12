/**
 * Prediction Ledger — YouTube import: precheck, video.import job, tool.install job (Release 0.5).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * video.import (YouTube) — every step names what leaves the machine:
 *   1. precheck: privacy switch on, yt-dlp present, URL valid, not already imported
 *   2. metadata (yt-dlp --dump-single-json)        → title, channel, duration, upload date, caption tracks
 *   3. captions (policy: manual → auto → never)    → parsed, cleaned, stored as segments; status ready
 *   4. else audio download (if allowed)            → stored under media/<hash>.<ext>; chains 0.4's audio.extract
 *   5. else fail with the transcript-import fallback named in the message
 * A failure at any step marks the video 'failed' with a distinct message; no job is left running (E3).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { YouTubeImportRequest, ToolsStatus, VideoDetail } from "@prediction-ledger/shared";
import type { AppContext } from "../context.js";
import type { JobContext } from "../jobs/queue.js";
import { locateTools, probe } from "../media/ffmpeg.js";
import { chooseCaptionTrack, downloadAudio, downloadCaptions, fetchInfo, installYtDlp, locateYtDlp, parseYouTubeUrl, parseYouTubeVtt, YtError, ytDlpVersion } from "./ytdlp.js";

export class YouTubeImportError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 409,
    public readonly code: "invalid_url" | "offline" | "tool_missing",
  ) {
    super(message);
    this.name = "YouTubeImportError";
  }
}

export const OFFLINE_MESSAGE = "Internet access is disabled in Setup → Privacy, so nothing can be fetched from YouTube. Enable it there, or import a transcript file instead.";

/** Up-front checks for pasting a URL (E4: refused before anything is queued). */
export async function precheckYouTubeImport(ctx: AppContext, url: string): Promise<{ videoId: string; canonicalUrl: string }> {
  const parsed = parseYouTubeUrl(url);
  if (!parsed) throw new YouTubeImportError("That does not look like a YouTube video link. Paste a youtube.com/watch?v=… or youtu.be/… URL.", 400, "invalid_url");
  if (!ctx.settings.getPersisted().privacy.allowInternet) throw new YouTubeImportError(OFFLINE_MESSAGE, 409, "offline");
  try {
    await locateYtDlp(ctx.paths.tools);
  } catch (err) {
    throw new YouTubeImportError((err as Error).message, 409, "tool_missing");
  }
  return parsed;
}

export async function startYouTubeImport(ctx: AppContext, req: YouTubeImportRequest): Promise<{ video: VideoDetail; duplicate: boolean; jobId?: string }> {
  const { videoId, canonicalUrl } = await precheckYouTubeImport(ctx, req.url);
  const existing = ctx.videos.findByYouTubeId(videoId);
  if (existing) return { video: ctx.videos.get(existing.id)!, duplicate: true };
  const video = ctx.videos.createFromYouTube({ youtubeId: videoId, url: canonicalUrl, title: req.title, publishedAt: req.publishedAt, language: req.language });
  const jobId = enqueueImport(ctx, video.id, { title: !!req.title?.trim(), publishedAt: !!req.publishedAt, language: !!req.language });
  return { video, duplicate: false, jobId };
}

export function enqueueImport(ctx: AppContext, videoId: string, userSupplied: { title?: boolean; publishedAt?: boolean; language?: boolean } = {}, forceAudio = false): string {
  return ctx.jobs.enqueue({ kind: "video.import", subjectType: "video", subjectId: videoId, payload: { videoId, userSupplied, forceAudio }, dedupeKey: `video.import:${videoId}`, maxAttempts: 1 });
}

export function makeYouTubeImportHandler(ctx: AppContext) {
  return async (job: JobContext): Promise<Record<string, unknown>> => {
    const videoId = String(job.payload.videoId ?? "");
    const userSupplied = (job.payload.userSupplied ?? {}) as { title?: boolean; publishedAt?: boolean; language?: boolean };
    const forceAudio = job.payload.forceAudio === true; // "Re-transcribe" on a captions-based import
    const video = ctx.videos.get(videoId);
    if (!video?.youtubeId) throw new Error("Video no longer exists or is not a YouTube import.");
    const ytId = video.youtubeId;
    const fail = (msg: string) => {
      ctx.videos.setStatus(videoId, "failed");
      ctx.videos.setError(videoId, msg);
    };
    try {
      const settings = ctx.settings.getPersisted();
      if (!settings.privacy.allowInternet) throw new YtError(OFFLINE_MESSAGE, "offline");
      const tool = await locateYtDlp(ctx.paths.tools);
      ctx.videos.setStatus(videoId, "importing");
      ctx.videos.setError(videoId, null);

      // 2. metadata
      job.progress(5, "Reading video information from YouTube");
      const info = await fetchInfo(tool, ytId, job.signal);
      ctx.videos.applyYouTubeInfo(videoId, info, userSupplied);
      if (info.isLive) throw new YtError("This is a live stream or premiere; import it after the recording is available. You can import a transcript instead (Library → Import a transcript).", "live");

      // 3. captions
      const preferred = [settings.youtube.captionLanguage, settings.transcription.language, info.language, "en"].filter((l): l is string => !!l && l !== "auto");
      const track = forceAudio ? undefined : chooseCaptionTrack(info.captions, settings.youtube.captions, preferred);
      const scratch = path.join(ctx.paths.artifacts, "youtube", videoId);
      if (track) {
        job.progress(25, `Fetching ${track.kind === "manual" ? "creator" : "auto-generated"} captions (${track.lang})`);
        const vttPath = await downloadCaptions(tool, ytId, track, scratch, job.signal);
        const cues = parseYouTubeVtt(fs.readFileSync(vttPath, "utf8"));
        fs.rmSync(scratch, { recursive: true, force: true });
        if (cues.length > 0) {
          const engine = `youtube-captions:${track.kind}:${track.lang}`;
          ctx.videos.replaceSegments(videoId, engine, cues);
          ctx.videos.setTranscriptSource(videoId, track.kind === "manual" ? "captions-manual" : "captions-auto");
          ctx.videos.setTranscriptionEngine(videoId, "youtube-captions", `${track.kind}:${track.lang}`);
          ctx.videos.setStatus(videoId, "ready");
          ctx.videos.setError(videoId, null);
          ctx.videos.setNotes(videoId, `${info.channel ? `Channel: ${info.channel}. ` : ""}${track.kind === "auto" ? "Transcript comes from YouTube's auto-generated captions; wording and timestamps can be imprecise. Re-transcribe to use your own engine." : `Creator-provided captions (${track.lang}).`}`);
          job.progress(100, `${cues.length} caption segments`);
          return { source: track.kind === "manual" ? "captions-manual" : "captions-auto", lang: track.lang, segments: cues.length };
        }
        // listed but empty → fall through to audio
      }

      // 4. audio
      if (!settings.youtube.allowAudioDownload) {
        const why = forceAudio ? "Re-transcribing needs the audio" : info.captions.length === 0 ? "This video has no captions" : settings.youtube.captions === "never" ? "Captions are disabled in Setup → YouTube" : "This video has no acceptable captions (only auto-generated ones, or none in your language)";
        throw new YtError(`${why}, and audio download is turned off in Setup → YouTube. Turn it on to transcribe the audio, or import a transcript instead (Library → Import a transcript).`, "no_captions");
      }
      if (settings.transcription.engine === "import" || settings.transcription.engine === "youtube-captions") {
        throw new YtError("No usable captions, and the transcription engine in Setup is set to captions/import only. Choose Local Whisper or OpenAI transcription, or import a transcript instead (Library → Import a transcript).", "no_captions");
      }
      job.progress(30, "Downloading audio from YouTube");
      let ffmpegDir: string | undefined;
      const tools = await locateTools();
      if (tools.source !== "path") ffmpegDir = path.dirname(tools.ffmpeg);
      const audioFile = await downloadAudio(tool, ytId, scratch, { ffmpegLocation: ffmpegDir, signal: job.signal, onProgress: (f, note) => job.progress(30 + Math.round(f * 40), note) });
      job.progress(72, "Checking the downloaded audio");
      const hash = crypto.createHash("sha256").update(fs.readFileSync(audioFile)).digest("hex");
      const size = fs.statSync(audioFile).size;
      const ext = path.extname(audioFile).toLowerCase() || ".m4a";
      const probed = await probe(tools, audioFile);
      if (!probed.hasAudio) throw new YtError("The downloaded file has no audio track. Import a transcript instead (Library → Import a transcript).", "failed");
      const finalRel = path.join("media", `${hash}${ext}`);
      const finalAbs = path.join(ctx.paths.root, finalRel);
      fs.mkdirSync(ctx.paths.media, { recursive: true });
      fs.renameSync(audioFile, finalAbs);
      fs.rmSync(scratch, { recursive: true, force: true });
      ctx.videos.setMedia(videoId, { mediaPath: finalRel, mediaHash: hash, mediaSize: size, durationS: probed.durationS });
      ctx.videos.setNotes(videoId, `${info.channel ? `Channel: ${info.channel}. ` : ""}No usable captions; audio downloaded (${(size / 1048576).toFixed(1)} MB) and transcribed locally with the engine chosen in Setup.`);
      ctx.jobs.enqueue({ kind: "audio.extract", subjectType: "video", subjectId: videoId, payload: { videoId }, dedupeKey: `audio.extract:${videoId}`, maxAttempts: 2 });
      job.progress(100, "Audio saved; transcribing…");
      return { source: "audio", bytes: size, ext };
    } catch (err) {
      if (job.signal.aborted) {
        fail("Import cancelled.");
        throw err;
      }
      const msg = err instanceof YtError ? err.message : (err as Error).message;
      fail(msg);
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Tool status and install
// ---------------------------------------------------------------------------

export async function toolsStatus(ctx: AppContext): Promise<ToolsStatus> {
  const internet = ctx.settings.getPersisted().privacy.allowInternet;
  let ffmpeg: ToolsStatus["ffmpeg"];
  try {
    const t = await locateTools();
    ffmpeg = { ok: true, message: `found (${t.source})`, source: t.source };
  } catch (err) {
    ffmpeg = { ok: false, message: (err as Error).message };
  }
  let ytdlp: ToolsStatus["ytdlp"];
  try {
    const tool = await locateYtDlp(ctx.paths.tools);
    const version = await ytDlpVersion(tool).catch(() => undefined);
    let installedAt: string | undefined;
    if (tool.source === "tools") {
      try {
        installedAt = fs.statSync(tool.path).mtime.toISOString();
      } catch {
        /* ignore */
      }
    }
    ytdlp = { ok: !!version, message: version ? `yt-dlp ${version} (${tool.source})` : `found at ${tool.path} but it did not run`, version, source: tool.source, installedAt };
  } catch (err) {
    ytdlp = { ok: false, message: (err as Error).message };
  }
  return { ffmpeg, ytdlp, internet };
}

export function makeToolInstallHandler(ctx: AppContext) {
  return async (job: JobContext): Promise<Record<string, unknown>> => {
    const tool = String(job.payload.tool ?? "");
    if (tool !== "yt-dlp") throw new Error(`Unknown tool "${tool}".`);
    if (!ctx.settings.getPersisted().privacy.allowInternet) throw new Error(OFFLINE_MESSAGE);
    const result = await installYtDlp(ctx.paths.tools, { signal: job.signal, onProgress: (f, note) => job.progress(Math.round(f * 100), note) });
    job.progress(100, `yt-dlp ${result.version} installed`);
    return { path: result.path, version: result.version, bytes: result.bytes };
  };
}
