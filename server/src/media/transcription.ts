/**
 * Prediction Ledger — TranscriptionProvider interface and engines.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Engines:
 *  - local-whisper     Whisper ONNX inside Node via @huggingface/transformers (Transformers.js).
 *                      Loaded dynamically: the package is an OPTIONAL dependency because it pulls
 *                      onnxruntime-node native binaries; when it is not installed the engine reports
 *                      an actionable error instead of crashing the server. Model weights download
 *                      once into <dataDir>/models (only when internet is allowed).
 *  - openai-transcribe OpenAI audio transcription API. `whisper-1` returns segment timestamps
 *                      (verbose_json); the gpt-4o-*-transcribe models return text only, so the app
 *                      falls back to one segment per chunk for those (timestamps = chunk bounds).
 * Both take a WAV chunk (16 kHz mono) and return segments local to that chunk.
 */

import fs from "node:fs";
import path from "node:path";
import type { RawSegment } from "./ffmpeg.js";

export interface TranscribeOptions {
  language?: string; // "auto" or ISO-639-1
  signal?: AbortSignal;
  /** Called with 0–1 progress inside a chunk when the engine supports it (model download, decoding). */
  onProgress?: (fraction: number, note?: string) => void;
}

export interface TranscriptionProvider {
  readonly id: "local-whisper" | "openai-transcribe";
  readonly isLocal: boolean;
  /** Cheap readiness check with an actionable message (engine installed, model cached, key present). */
  check(): Promise<{ ok: boolean; message: string; needsDownload?: boolean }>;
  transcribeChunk(wavPath: string, opts: TranscribeOptions): Promise<RawSegment[]>;
  /** Engines with a downloadable model implement this so Setup can fetch it ahead of the first import. */
  preload?(onProgress?: TranscribeOptions["onProgress"]): Promise<{ modelId: string; cached: boolean }>;
}

export class TranscriptionError extends Error {
  constructor(
    message: string,
    public readonly code: "engine_missing" | "model_missing" | "unauthorized" | "offline" | "failed",
  ) {
    super(message);
    this.name = "TranscriptionError";
  }
}

// ---- local whisper --------------------------------------------------------------------

interface TransformersModule {
  pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<(audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string; chunks?: { timestamp: [number, number | null]; text: string }[] }>>;
  env: { cacheDir?: string; allowRemoteModels?: boolean; allowLocalModels?: boolean };
}

export class LocalWhisperProvider implements TranscriptionProvider {
  readonly id = "local-whisper" as const;
  readonly isLocal = true;
  private pipe?: Awaited<ReturnType<TransformersModule["pipeline"]>>;
  private loadedModel?: string;

  constructor(
    private readonly modelId: string,
    private readonly modelsDir: string,
    private readonly allowInternet: () => boolean,
    /** Test seam: supply a fake Transformers.js module instead of importing the optional dependency. */
    private readonly moduleLoader?: () => Promise<TransformersModule>,
  ) {}

  private async loadModule(): Promise<TransformersModule> {
    try {
      // Dynamic import so a missing optional dependency is a runtime message, not a startup crash.
      const mod = this.moduleLoader ? await this.moduleLoader() : ((await import("@huggingface/transformers" as string)) as unknown as TransformersModule);
      return mod;
    } catch {
      throw new TranscriptionError(
        "The local Whisper engine (@huggingface/transformers) is not installed. Run `npm install` again (it is an optional dependency), choose OpenAI transcription in Setup, or import a transcript.",
        "engine_missing",
      );
    }
  }

  private modelCached(): boolean {
    // Transformers.js caches under <cacheDir>/<org>/<model>/…; presence of the folder with an onnx dir is good enough.
    const dir = path.join(this.modelsDir, ...this.modelId.split("/"));
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  }

  async check(): Promise<{ ok: boolean; message: string; needsDownload?: boolean }> {
    try {
      await this.loadModule();
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    if (this.modelCached()) return { ok: true, message: `Local Whisper ready (${this.modelId}, cached).` };
    if (!this.allowInternet()) return { ok: false, message: `Model ${this.modelId} is not downloaded and internet access is disabled. Enable internet once to download it (~150 MB–1 GB), then it works offline.`, needsDownload: true };
    return { ok: true, message: `Local Whisper will download ${this.modelId} on first use (~150 MB–1 GB) into ${this.modelsDir}.`, needsDownload: true };
  }

  private async getPipeline(onProgress?: TranscribeOptions["onProgress"]) {
    if (this.pipe && this.loadedModel === this.modelId) return this.pipe;
    const mod = await this.loadModule();
    mod.env.cacheDir = this.modelsDir;
    mod.env.allowLocalModels = true;
    mod.env.allowRemoteModels = this.allowInternet();
    if (!this.modelCached() && !this.allowInternet()) {
      throw new TranscriptionError(`Whisper model ${this.modelId} is not downloaded and internet is disabled.`, "model_missing");
    }
    try {
      this.pipe = await mod.pipeline("automatic-speech-recognition", this.modelId, {
        progress_callback: (p: { status?: string; progress?: number; file?: string }) => {
          if (p.status === "progress" && typeof p.progress === "number") onProgress?.(p.progress / 100, `Downloading model ${p.file ?? ""}`);
        },
      });
      this.loadedModel = this.modelId;
      return this.pipe;
    } catch (err) {
      throw new TranscriptionError(`Could not load Whisper model ${this.modelId}: ${(err as Error).message}`, "failed");
    }
  }

  /** Download (if needed) and load the model ahead of time, reporting progress (Release 1.0 model.download job). */
  async preload(onProgress?: TranscribeOptions["onProgress"]): Promise<{ modelId: string; cached: boolean }> {
    await this.getPipeline(onProgress);
    return { modelId: this.modelId, cached: this.modelCached() };
  }

  async transcribeChunk(wavPath: string, opts: TranscribeOptions): Promise<RawSegment[]> {
    const pipe = await this.getPipeline(opts.onProgress);
    const audio = readWavMono16k(wavPath);
    const result = await pipe(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      ...(opts.language && opts.language !== "auto" ? { language: opts.language, task: "transcribe" } : {}),
    });
    const chunks = result.chunks ?? [];
    if (chunks.length === 0) return result.text.trim() ? [{ startS: 0, endS: audio.length / 16000, text: result.text }] : [];
    return chunks.map((c, i) => ({
      startS: c.timestamp[0] ?? 0,
      endS: c.timestamp[1] ?? chunks[i + 1]?.timestamp[0] ?? audio.length / 16000,
      text: c.text,
    }));
  }
}

/** Minimal 16-bit PCM WAV reader (the app always produces this exact format via ffmpeg). */
export function readWavMono16k(file: string): Float32Array {
  const buf = fs.readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new TranscriptionError("Not a WAV file.", "failed");
  let offset = 12;
  let dataStart = -1;
  let dataLen = 0;
  let channels = 1;
  let bits = 16;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(offset + 10);
      bits = buf.readUInt16LE(offset + 22);
    } else if (id === "data") {
      dataStart = offset + 8;
      dataLen = Math.min(size, buf.length - dataStart);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataStart < 0 || bits !== 16) throw new TranscriptionError("Unexpected WAV layout (expected 16-bit PCM).", "failed");
  const samples = Math.floor(dataLen / 2 / channels);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += buf.readInt16LE(dataStart + (i * channels + c) * 2);
    out[i] = sum / channels / 32768;
  }
  return out;
}

// ---- OpenAI transcription -----------------------------------------------------------------

export class OpenAiTranscriptionProvider implements TranscriptionProvider {
  readonly id = "openai-transcribe" as const;
  readonly isLocal = false;

  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly model: string,
    private readonly allowInternet: () => boolean,
  ) {}

  async check(): Promise<{ ok: boolean; message: string }> {
    if (!this.allowInternet()) return { ok: false, message: "Internet access is disabled in Setup → Privacy; OpenAI transcription needs it." };
    if (!this.apiKey()) return { ok: false, message: "OpenAI transcription needs the OpenAI API key (Setup → OpenAI)." };
    return { ok: true, message: `OpenAI transcription ready (${this.model}). Audio is sent to OpenAI.` };
  }

  async transcribeChunk(wavPath: string, opts: TranscribeOptions): Promise<RawSegment[]> {
    if (!this.allowInternet()) throw new TranscriptionError("Internet access is disabled in Setup → Privacy.", "offline");
    const key = this.apiKey();
    if (!key) throw new TranscriptionError("OpenAI API key is not saved (Setup → OpenAI).", "unauthorized");
    const timestamps = this.model === "whisper-1";
    const form = new FormData();
    form.append("file", new Blob([fs.readFileSync(wavPath)], { type: "audio/wav" }), path.basename(wavPath));
    form.append("model", this.model);
    form.append("response_format", timestamps ? "verbose_json" : "json");
    if (timestamps) form.append("timestamp_granularities[]", "segment");
    if (opts.language && opts.language !== "auto") form.append("language", opts.language);
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal: opts.signal });
    if (res.status === 401 || res.status === 403) throw new TranscriptionError("OpenAI rejected the API key.", "unauthorized");
    if (!res.ok) throw new TranscriptionError(`OpenAI transcription failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`, "failed");
    const json = (await res.json()) as { text?: string; duration?: number; segments?: { start: number; end: number; text: string }[] };
    if (json.segments?.length) return json.segments.map((s) => ({ startS: s.start, endS: s.end, text: s.text }));
    const text = json.text?.trim() ?? "";
    return text ? [{ startS: 0, endS: json.duration ?? wavDurationS(wavPath), text }] : [];
  }
}

function wavDurationS(file: string): number {
  try {
    return readWavMono16k(file).length / 16000;
  } catch {
    return 0;
  }
}
