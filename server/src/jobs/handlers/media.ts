/**
 * Prediction Ledger — job handlers: audio.extract and transcript.generate (Release 0.4).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * audio.extract     media file → artifacts/audio/<hash>.wav (16 kHz mono) → silence check → enqueue transcript.generate
 * transcript.generate
 *                   plan chunks (chunkSeconds/overlapSeconds) → for each chunk not yet 'done':
 *                   cut WAV → engine.transcribeChunk → stitch to absolute time (dropping the overlap
 *                   already committed) → commit segments + chunk state in one transaction.
 *                   A restart resumes at the first chunk that is not 'done' (IN-04). Chunk state and
 *                   segments are keyed by video, so re-running never duplicates segments.
 */

import fs from "node:fs";
import path from "node:path";
import type { JobContext } from "../queue.js";
import type { AppContext } from "../../context.js";
import { cutWav, extractWav, locateTools, meanVolumeDb, MediaError, planChunks, stitchChunk, SILENCE_THRESHOLD_DB } from "../../media/ffmpeg.js";
import { TranscriptionError } from "../../media/transcription.js";

export function makeAudioExtractHandler(ctx: AppContext) {
  return async (job: JobContext): Promise<Record<string, unknown>> => {
    const videoId = String(job.payload.videoId ?? "");
    const video = ctx.videos.get(videoId);
    const info = ctx.videos.mediaInfo(videoId);
    if (!video || !info?.mediaPath) throw new Error("Video or media file no longer exists.");
    const tools = await locateTools();
    const input = path.join(ctx.paths.root, info.mediaPath);
    if (!fs.existsSync(input)) throw new Error(`Media file is missing on disk: ${info.mediaPath}`);

    ctx.videos.setStatus(videoId, "importing");
    ctx.videos.setError(videoId, null);
    const audioDir = path.join(ctx.paths.artifacts, "audio");
    fs.mkdirSync(audioDir, { recursive: true });
    const hash = path.basename(info.mediaPath).split(".")[0];
    const wavRel = path.join("artifacts", "audio", `${hash}.wav`);
    const wavAbs = path.join(ctx.paths.root, wavRel);

    try {
      job.progress(10, "Extracting audio");
      await extractWav(tools, input, wavAbs, job.signal);
      job.progress(70, "Checking audio level");
      const db = await meanVolumeDb(tools, wavAbs, job.signal);
      if (db < SILENCE_THRESHOLD_DB) {
        throw new MediaError(`The audio track is silent (mean level ${db.toFixed(1)} dB). Nothing to transcribe — check the file or import a transcript.`, "silent");
      }
      ctx.videos.setAudioPath(videoId, wavRel);
      ctx.videos.setStatus(videoId, "transcribing");
      ctx.jobs.enqueue({ kind: "transcript.generate", subjectType: "video", subjectId: videoId, payload: { videoId }, dedupeKey: `transcript.generate:${videoId}`, maxAttempts: 2 });
      job.progress(100, "Audio ready; transcribing…");
      return { audioPath: wavRel, meanVolumeDb: db };
    } catch (err) {
      const msg = (err as Error).message;
      ctx.videos.setStatus(videoId, "failed");
      ctx.videos.setError(videoId, msg);
      throw err;
    }
  };
}

export function makeTranscribeHandler(ctx: AppContext) {
  return async (job: JobContext): Promise<Record<string, unknown>> => {
    const videoId = String(job.payload.videoId ?? "");
    const video = ctx.videos.get(videoId);
    const info = ctx.videos.mediaInfo(videoId);
    if (!video || !info?.audioPath || !info.durationS) throw new Error("Audio for this video is not available; run audio extraction first.");
    const settings = ctx.settings.getPersisted();
    const engine = ctx.transcription();
    const tools = await locateTools();
    const wav = path.join(ctx.paths.root, info.audioPath);
    if (!fs.existsSync(wav)) throw new Error("Extracted audio is missing; re-import the video.");

    const readiness = await engine.check();
    if (!readiness.ok) {
      ctx.videos.setStatus(videoId, "failed");
      ctx.videos.setError(videoId, readiness.message);
      throw new TranscriptionError(readiness.message, "engine_missing");
    }
    const modelLabel = engine.id === "local-whisper" ? settings.transcription.localModel : settings.transcription.openaiModel;
    ctx.videos.setTranscriptionEngine(videoId, engine.id, modelLabel);
    ctx.videos.setStatus(videoId, "transcribing");
    ctx.videos.setError(videoId, null);

    // Plan (idempotent) and resume.
    const plan = planChunks(info.durationS, settings.transcription.chunkSeconds, settings.transcription.overlapSeconds);
    ctx.videos.planChunks(videoId, plan);
    const states = ctx.videos.chunkStates(videoId);
    const chunkDir = path.join(ctx.paths.artifacts, "chunks", videoId);
    fs.mkdirSync(chunkDir, { recursive: true });

    let done = states.filter((s) => s.status === "done").length;
    const total = states.length;
    let transcribed = 0;
    try {
      for (const chunk of states) {
        if (job.signal.aborted) throw new Error("Cancelled");
        if (chunk.status === "done") continue;
        job.progress(Math.round((done / total) * 100), `Transcribing chunk ${chunk.index + 1} of ${total}`);
        const chunkWav = path.join(chunkDir, `c${chunk.index}.wav`);
        try {
          await cutWav(tools, wav, chunk.startS, chunk.endS - chunk.startS, chunkWav, job.signal);
          const local = await engine.transcribeChunk(chunkWav, {
            language: settings.transcription.language,
            signal: job.signal,
            onProgress: (f, note) => job.progress(Math.round(((done + f) / total) * 100), note ?? `Transcribing chunk ${chunk.index + 1} of ${total}`),
          });
          const committedEnd = ctx.videos.transcriptEnd(videoId);
          const segments = stitchChunk(chunk, local, committedEnd);
          ctx.videos.commitChunk(videoId, chunk.index, `${engine.id}:${modelLabel}`, segments);
          transcribed += segments.length;
          done++;
        } catch (err) {
          if (job.signal.aborted) throw err;
          ctx.videos.failChunk(videoId, chunk.index, (err as Error).message);
          throw err;
        } finally {
          fs.rmSync(chunkWav, { force: true });
        }
      }
      const finalStates = ctx.videos.chunkStates(videoId);
      const segmentCount = ctx.videos.get(videoId)?.segmentCount ?? 0;
      ctx.videos.setStatus(videoId, "ready");
      if (segmentCount === 0) ctx.videos.setError(videoId, "Transcription produced no text. The audio may be music, noise, or in an unsupported language.");
      job.progress(100, segmentCount === 0 ? "No speech recognised" : `${segmentCount} segments`);
      return { chunks: finalStates.length, newSegments: transcribed, segmentCount };
    } catch (err) {
      if (!job.signal.aborted) {
        ctx.videos.setStatus(videoId, "failed");
        ctx.videos.setError(videoId, (err as Error).message);
      }
      throw err;
    }
  };
}
