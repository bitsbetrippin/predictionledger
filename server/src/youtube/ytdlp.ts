/**
 * Prediction Ledger — yt-dlp wrapper: locate/install the binary, read video info, fetch captions, download audio.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Acquisition strategy (docs/ARCHITECTURE.md §5.3, ADR-017):
 *  - yt-dlp is a separate, user-approved download into <data>/tools/ (standalone binary from the
 *    official GitHub release, SHA-256 verified against the release's SHA2-256SUMS). It is never
 *    fetched implicitly by npm. `PL_YTDLP_PATH` or a PATH install are honoured first.
 *  - Every invocation uses argument arrays; the only user-controlled value passed is a canonical
 *    https://www.youtube.com/watch?v=<id> URL rebuilt from a validated 11-character id.
 *  - yt-dlp's own output is treated as untrusted data: JSON is parsed and validated field by field.
 *
 * Access limitations (stated, not hidden): YouTube has no official API for arbitrary public-video
 * captions or audio. yt-dlp scrapes the site, so it breaks whenever YouTube changes; the "Update
 * yt-dlp" button exists for that reason. Private, members-only, age-restricted, geo-blocked and
 * removed videos fail with a distinct message and the transcript-import fallback.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { run } from "../media/ffmpeg.js";

export type YtErrorCode = "invalid_url" | "tool_missing" | "offline" | "unavailable" | "private" | "age_restricted" | "geo_blocked" | "live" | "no_captions" | "network" | "failed";

export class YtError extends Error {
  constructor(
    message: string,
    public readonly code: YtErrorCode,
  ) {
    super(message);
    this.name = "YtError";
  }
}

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"]);

/** Pure: extract the video id from the URL forms people paste. Returns undefined for anything else. */
export function parseYouTubeUrl(input: string): { videoId: string; canonicalUrl: string } | undefined {
  const raw = input.trim();
  if (!raw) return undefined;
  if (ID_RE.test(raw)) return { videoId: raw, canonicalUrl: canonicalUrlFor(raw) };
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return undefined;
  }
  if (!HOSTS.has(u.hostname.toLowerCase())) return undefined;
  let id: string | null = null;
  if (u.hostname.endsWith("youtu.be")) {
    id = u.pathname.split("/").filter(Boolean)[0] ?? null;
  } else {
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "watch") id = u.searchParams.get("v");
    else if (["shorts", "live", "embed", "v"].includes(parts[0] ?? "")) id = parts[1] ?? null;
    else id = u.searchParams.get("v");
  }
  if (!id || !ID_RE.test(id)) return undefined;
  return { videoId: id, canonicalUrl: canonicalUrlFor(id) };
}

export const canonicalUrlFor = (id: string): string => `https://www.youtube.com/watch?v=${id}`;

/**
 * Common arguments. yt-dlp (2025.09+) solves YouTube's JavaScript challenges with an external JS runtime
 * and enables only Deno by default; pointing it at the Node binary running this app avoids a second
 * runtime install. Older yt-dlp builds reject the option — classifyYtDlpError turns that into an
 * "update yt-dlp" message. (Spike S-4: confirm on the first real run.)
 */
export function commonArgs(): string[] {
  return ["--no-playlist", "--no-warnings", "--js-runtimes", `node:${process.execPath}`];
}

// ---------------------------------------------------------------------------
// Locating and installing the binary
// ---------------------------------------------------------------------------

export interface YtDlpTool {
  path: string;
  source: "env" | "tools" | "path";
}

export function ytDlpFileName(): string {
  return process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

export async function locateYtDlp(toolsDir: string): Promise<YtDlpTool> {
  const env = process.env.PL_YTDLP_PATH;
  if (env) return { path: env, source: "env" };
  const local = path.join(toolsDir, ytDlpFileName());
  if (fs.existsSync(local)) return { path: local, source: "tools" };
  const onPath = await run("yt-dlp", ["--version"]).then(() => true).catch(() => false);
  if (onPath) return { path: "yt-dlp", source: "path" };
  throw new YtError("yt-dlp is not installed. Setup → YouTube → Install yt-dlp (downloads the official binary into the data directory after you approve it), or import a transcript instead.", "tool_missing");
}

export async function ytDlpVersion(tool: YtDlpTool): Promise<string> {
  const { stdout } = await run(tool.path, ["--version"]);
  return stdout.trim().split(/\r?\n/)[0] ?? "unknown";
}

/** Release asset name for this platform (official yt-dlp standalone builds; no Python needed). */
export function ytDlpAssetName(platform = process.platform, arch = process.arch): string {
  if (platform === "win32") return arch === "ia32" ? "yt-dlp_x86.exe" : "yt-dlp.exe";
  if (platform === "darwin") return "yt-dlp_macos"; // universal2 (Intel + Apple Silicon)
  if (arch === "arm64") return "yt-dlp_linux_aarch64";
  if (arch === "arm") return "yt-dlp_linux_armv7l";
  return "yt-dlp_linux";
}

export const YTDLP_RELEASE_BASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";

/** Pure: find the expected digest for `asset` in a SHA2-256SUMS file and compare. */
export function verifySha256Sums(sumsText: string, asset: string, data: Uint8Array): { ok: boolean; expected?: string; actual: string } {
  const actual = crypto.createHash("sha256").update(data).digest("hex");
  for (const line of sumsText.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m && m[2] === asset) return { ok: m[1].toLowerCase() === actual, expected: m[1].toLowerCase(), actual };
  }
  return { ok: false, actual };
}

/**
 * Download the official binary + checksum list, verify, and install atomically into toolsDir.
 * Callers must have obtained user consent and checked the privacy switch first.
 */
export async function installYtDlp(toolsDir: string, opts: { fetchImpl?: typeof fetch; onProgress?: (fraction: number, note: string) => void; signal?: AbortSignal } = {}): Promise<{ path: string; version: string; bytes: number }> {
  const f = opts.fetchImpl ?? fetch;
  const asset = ytDlpAssetName();
  opts.onProgress?.(0.05, `Downloading ${asset} from GitHub`);
  const res = await f(YTDLP_RELEASE_BASE + asset, { signal: opts.signal, redirect: "follow" });
  if (!res.ok || !res.body) throw new YtError(`Download failed: HTTP ${res.status} for ${asset}.`, "network");
  const total = Number(res.headers.get("content-length") ?? 0);
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (received > 200 * 1024 * 1024) throw new YtError("Download exceeded 200 MB; aborting.", "failed");
    if (total) opts.onProgress?.(0.05 + 0.8 * (received / total), `Downloading ${asset} (${(received / 1048576).toFixed(1)} MB)`);
  }
  const data = Buffer.concat(chunks);
  opts.onProgress?.(0.88, "Verifying checksum");
  const sumsRes = await f(YTDLP_RELEASE_BASE + "SHA2-256SUMS", { signal: opts.signal, redirect: "follow" });
  if (!sumsRes.ok) throw new YtError(`Could not download SHA2-256SUMS (HTTP ${sumsRes.status}); refusing to install an unverified binary.`, "network");
  const check = verifySha256Sums(await sumsRes.text(), asset, data);
  if (!check.ok) throw new YtError(`Checksum mismatch for ${asset} (expected ${check.expected ?? "unknown"}, got ${check.actual}). Nothing was installed.`, "failed");

  fs.mkdirSync(toolsDir, { recursive: true });
  const finalPath = path.join(toolsDir, ytDlpFileName());
  const tmp = `${finalPath}.download`;
  fs.writeFileSync(tmp, data);
  if (process.platform !== "win32") fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, finalPath);
  fs.writeFileSync(path.join(toolsDir, "yt-dlp.sha256"), `${check.actual}  ${asset}\n`);
  opts.onProgress?.(0.95, "Checking the installed binary");
  const version = await ytDlpVersion({ path: finalPath, source: "tools" }).catch((e: Error) => {
    throw new YtError(`Installed binary could not run: ${e.message}${process.platform === "darwin" ? " — on macOS run: xattr -d com.apple.quarantine \"" + finalPath + "\"" : ""}`, "failed");
  });
  return { path: finalPath, version, bytes: data.length };
}

// ---------------------------------------------------------------------------
// Video info
// ---------------------------------------------------------------------------

export interface CaptionTrack {
  lang: string;
  kind: "manual" | "auto";
  name?: string;
}

export interface YtInfo {
  id: string;
  title: string;
  channel?: string;
  durationS?: number;
  /** YYYY-MM-DD from upload_date / release_date. */
  publishedAt?: string;
  language?: string;
  isLive: boolean;
  captions: CaptionTrack[];
}

/** Pure: validate and normalise yt-dlp's --dump-single-json output. */
export function parseInfoJson(json: string): YtInfo {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new YtError("yt-dlp returned unreadable video information.", "failed");
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  const id = typeof o.id === "string" && ID_RE.test(o.id) ? o.id : undefined;
  if (!id) throw new YtError("yt-dlp returned no video id.", "failed");
  const str = (k: string) => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : undefined);
  const date = str("upload_date") ?? str("release_date");
  const publishedAt = date && /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : undefined;
  const captions: CaptionTrack[] = [];
  for (const [kind, key] of [["manual", "subtitles"], ["auto", "automatic_captions"]] as const) {
    const map = o[key];
    if (map && typeof map === "object") {
      for (const [lang, tracks] of Object.entries(map as Record<string, unknown>)) {
        if (!Array.isArray(tracks) || tracks.length === 0) continue;
        if (!/^[A-Za-z0-9-]{2,20}$/.test(lang)) continue;
        const first = tracks[0] as Record<string, unknown>;
        captions.push({ lang, kind, name: typeof first?.name === "string" ? first.name : undefined });
      }
    }
  }
  const liveStatus = str("live_status");
  return {
    id,
    title: str("title") ?? `YouTube video ${id}`,
    channel: str("channel") ?? str("uploader"),
    durationS: typeof o.duration === "number" && o.duration > 0 ? o.duration : undefined,
    publishedAt,
    language: str("language"),
    isLive: o.is_live === true || liveStatus === "is_live" || liveStatus === "is_upcoming",
    captions,
  };
}

export async function fetchInfo(tool: YtDlpTool, videoId: string, signal?: AbortSignal): Promise<YtInfo> {
  const url = canonicalUrlFor(videoId);
  try {
    const { stdout } = await run(tool.path, ["--dump-single-json", "--skip-download", "--no-progress", ...commonArgs(), "--", url], signal);
    return parseInfoJson(stdout);
  } catch (err) {
    throw classifyYtDlpError(err as Error);
  }
}

/** Map yt-dlp's stderr into the distinct, user-facing failure classes (E3). */
export function classifyYtDlpError(err: Error): YtError {
  if (err instanceof YtError) return err;
  const m = err.message;
  const has = (re: RegExp) => re.test(m);
  const fallback = " You can import a transcript for this video instead (Library → Import a transcript).";
  if (has(/private video/i)) return new YtError("This video is private; YouTube will not serve it without the owner's permission." + fallback, "private");
  if (has(/members-only|join this channel/i)) return new YtError("This video is members-only." + fallback, "private");
  if (has(/sign in to confirm your age|age-restricted|age restricted/i)) return new YtError("This video is age-restricted and cannot be fetched without a signed-in session." + fallback, "age_restricted");
  if (has(/available in your country|geo.?restricted|blocked it in your country|not available in your region/i)) return new YtError("This video is not available in your region." + fallback, "geo_blocked");
  if (has(/video unavailable|has been removed|no longer available|does not exist|is not a valid url|unsupported url|incomplete youtube id/i)) return new YtError("This video is unavailable (removed, mistyped, or never public)." + fallback, "unavailable");
  if (has(/is a live event|live stream|premieres in|this live event will begin/i)) return new YtError("Live streams and premieres are not supported yet; import the recording after it ends." + fallback, "live");
  if (has(/sign in to confirm you.re not a bot|HTTP Error 429|too many requests/i)) return new YtError("YouTube is rate-limiting or bot-checking this computer. Wait a while and retry, or update yt-dlp." + fallback, "network");
  if (has(/unable to download webpage|network is unreachable|getaddrinfo|ECONNRESET|ETIMEDOUT|EAI_AGAIN|timed out/i)) return new YtError("Could not reach YouTube (network error)." + fallback, "network");
  if (has(/no such option|unrecognized arguments/i)) return new YtError("The installed yt-dlp is too old for this app. Setup → YouTube → Update yt-dlp." + fallback, "tool_missing");
  if (has(/ENOENT|not recognized as an internal|No such file/i)) return new YtError("yt-dlp could not be started. Reinstall it from Setup → YouTube." + fallback, "tool_missing");
  return new YtError(`yt-dlp failed: ${m.split(/\r?\n/).filter((l) => l.trim()).slice(-1)[0] ?? m}`.slice(0, 400) + fallback, "failed");
}

// ---------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------

/** Pure: choose the caption track to use given the policy and language preference. */
export function chooseCaptionTrack(tracks: CaptionTrack[], policy: "manual-then-auto" | "manual-only" | "never", preferred: string[]): CaptionTrack | undefined {
  if (policy === "never") return undefined;
  const kinds: CaptionTrack["kind"][] = policy === "manual-only" ? ["manual"] : ["manual", "auto"];
  for (const kind of kinds) {
    const pool = tracks.filter((t) => t.kind === kind);
    if (pool.length === 0) continue;
    for (const pref of preferred) {
      const p = pref.toLowerCase();
      const exact = pool.find((t) => t.lang.toLowerCase() === p);
      if (exact) return exact;
      const prefix = pool.find((t) => t.lang.toLowerCase().startsWith(p + "-") || t.lang.toLowerCase() === p + "-orig");
      if (prefix) return prefix;
    }
    // no preferred language available: for manual captions take whatever exists; for auto, only if a preference matched
    if (kind === "manual") return pool[0];
  }
  return undefined;
}

/** Download one caption track as WebVTT into outDir; returns the file path. */
export async function downloadCaptions(tool: YtDlpTool, videoId: string, track: CaptionTrack, outDir: string, signal?: AbortSignal): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true });
  const url = canonicalUrlFor(videoId);
  const args = ["--skip-download", "--no-progress", ...commonArgs(), track.kind === "manual" ? "--write-subs" : "--write-auto-subs", "--sub-langs", track.lang, "--sub-format", "vtt/best", "--convert-subs", "vtt", "-o", path.join(outDir, "%(id)s.%(ext)s"), "--", url];
  try {
    await run(tool.path, args, signal);
  } catch (err) {
    throw classifyYtDlpError(err as Error);
  }
  const candidates = fs.readdirSync(outDir).filter((f) => f.startsWith(videoId + ".") && f.endsWith(".vtt"));
  const exact = candidates.find((f) => f.toLowerCase() === `${videoId}.${track.lang}.vtt`.toLowerCase()) ?? candidates[0];
  if (!exact) throw new YtError(`YouTube listed ${track.kind} captions (${track.lang}) but did not serve them.`, "no_captions");
  return path.join(outDir, exact);
}

/** Pure, line-preserving WebVTT cue reader (the shared parser joins lines, which hides YouTube's rolling duplicates). */
export function parseVttCues(text: string): { startS: number; endS: number; text: string }[] {
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const cues: { startS: number; endS: number; lines: string[] }[] = [];
  let inHeader = true;
  for (const line of lines) {
    if (inHeader) {
      // header ends at the first blank line (or the first timing line for header-less files)
      if (line.trim() === "") { inHeader = false; continue; }
      if (!line.includes("-->")) continue;
      inHeader = false;
    }
    const m = /^\s*(\S+)\s+-->\s+(\S+)/.exec(line);
    if (m && line.includes("-->")) {
      const startS = vttClock(m[1]);
      const endS = vttClock(m[2]);
      cues.push({ startS: startS ?? NaN, endS: endS ?? NaN, lines: [] });
      continue;
    }
    if (cues.length) cues[cues.length - 1].lines.push(line);
  }
  return cues
    .filter((c) => Number.isFinite(c.startS) && Number.isFinite(c.endS))
    .map((c, i, all) => {
      // Drop trailing blank lines and a cue identifier that belongs to the *next* cue (e.g. "2").
      const body = [...c.lines];
      while (body.length && body[body.length - 1].trim() === "") body.pop();
      if (i < all.length - 1 && body.length && /^[^\s]+$/.test(body[body.length - 1].trim()) && !/[a-z]{3,}/i.test(body[body.length - 1])) body.pop();
      if (/^(NOTE|STYLE|REGION)\b/.test(body[0] ?? "")) return { startS: c.startS, endS: c.endS, text: "" };
      return { startS: c.startS, endS: c.endS, text: body.join("\n") };
    });
}

function vttClock(v: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(v.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
}

/** Raw YouTube VTT → clean, monotonic segments. */
export function parseYouTubeVtt(text: string): { startS: number; endS: number; text: string }[] {
  return cleanCaptionCues(parseVttCues(text));
}

/**
 * Pure: clean caption cues from YouTube. Auto-generated tracks repeat each line across consecutive
 * cues (rolling display) and carry word-timing tags; both are removed so downstream quotes stay exact.
 */
export function cleanCaptionCues(cues: { startS: number; endS: number; text: string }[]): { startS: number; endS: number; text: string }[] {
  const out: { startS: number; endS: number; text: string }[] = [];
  let prevLines: string[] = [];
  for (const cue of cues) {
    const lines = cue.text
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const fresh = lines.filter((l) => !prevLines.includes(l));
    prevLines = lines;
    const text = fresh.join(" ").trim();
    if (!text) continue;
    if (cue.endS <= cue.startS) continue;
    const last = out[out.length - 1];
    if (last && last.text === text) {
      last.endS = Math.max(last.endS, cue.endS);
      continue;
    }
    out.push({ startS: cue.startS, endS: cue.endS, text });
  }
  // Rolling cues often overlap in time: clamp each start to the previous end so timestamps stay monotonic.
  for (let i = 1; i < out.length; i++) if (out[i].startS < out[i - 1].endS) out[i - 1].endS = Math.max(out[i - 1].startS + 0.05, out[i].startS);
  return out;
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

/** Download the best audio-only stream into outDir (no re-encoding; 0.4's audio.extract normalises it). */
export function downloadAudio(tool: YtDlpTool, videoId: string, outDir: string, opts: { ffmpegLocation?: string; signal?: AbortSignal; onProgress?: (fraction: number, note: string) => void } = {}): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true });
  const url = canonicalUrlFor(videoId);
  const args = ["-f", "bestaudio[ext=m4a]/bestaudio/best", "--newline", "--progress", ...commonArgs(), "-o", path.join(outDir, "%(id)s.%(ext)s")];
  if (opts.ffmpegLocation) args.push("--ffmpeg-location", opts.ffmpegLocation);
  args.push("--", url);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(tool.path, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) {
        const m = /\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*([\d.]+\w+))?/.exec(line);
        if (m) opts.onProgress?.(Number(m[1]) / 100, `Downloading audio ${m[1]}%${m[2] ? ` of ${m[2]}` : ""}`);
      }
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString().slice(0, 8000)));
    const onAbort = () => child.kill("SIGTERM");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(classifyYtDlpError(err));
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (code !== 0) return reject(classifyYtDlpError(new Error(stderr.trim() || `yt-dlp exited with code ${code}`)));
      const file = fs.readdirSync(outDir).find((f) => f.startsWith(videoId + ".") && !f.endsWith(".part") && !f.endsWith(".vtt") && !f.endsWith(".ytdl"));
      if (!file) return reject(new YtError("yt-dlp finished but no audio file was produced.", "failed"));
      resolve(path.join(outDir, file));
    });
  });
}
