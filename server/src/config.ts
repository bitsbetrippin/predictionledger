/**
 * Prediction Ledger — runtime configuration and platform-aware data locations.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Rules (from docs/ARCHITECTURE.md §6):
 *  - Bind to loopback only. The app never listens on 0.0.0.0.
 *  - User data lives OUTSIDE the repository in the OS-appropriate app-data folder,
 *    overridable with PL_DATA_DIR. Nothing is hard-coded to a user directory.
 *  - All paths go through node:path so spaces/Unicode/case differences are handled.
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const APP_NAME = "PredictionLedger";
export const APP_VERSION: string = pkg.version;

/** Loopback only. Deliberately not configurable — exposing the service is a separate scope decision. */
export const BIND_HOST = "127.0.0.1";

/** Default port. "7317" was chosen as an uncommon port unlikely to collide with dev servers. */
export const DEFAULT_PORT = 7317;

/** How many consecutive ports to try if the default is occupied. */
export const PORT_SEARCH_RANGE = 10;

export function resolvePort(): number {
  const raw = process.env.PL_PORT;
  if (!raw) return DEFAULT_PORT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error(`PL_PORT must be an integer between 1024 and 65535 (got "${raw}")`);
  }
  return n;
}

/**
 * Platform-appropriate application data directory:
 *   Windows: %LOCALAPPDATA%\PredictionLedger
 *   macOS:   ~/Library/Application Support/PredictionLedger
 *   Linux:   $XDG_DATA_HOME/prediction-ledger or ~/.local/share/prediction-ledger
 */
export function defaultDataDir(): string {
  const home = os.homedir();
  switch (process.platform) {
    case "win32": {
      const base = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
      return path.join(base, APP_NAME);
    }
    case "darwin":
      return path.join(home, "Library", "Application Support", APP_NAME);
    default: {
      const base = process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
      return path.join(base, "prediction-ledger");
    }
  }
}

export interface DataPaths {
  root: string;
  /** SQLite database file. */
  database: string;
  /** AES-256-GCM key used to encrypt provider secrets at rest. */
  secretKey: string;
  /** Imported/copied media files. */
  media: string;
  /** Extracted audio, transcript chunks, and other derived artifacts. */
  artifacts: string;
  /** Downloaded helper binaries (yt-dlp) — Release 0.3. */
  tools: string;
  /** Downloaded local ML models (Whisper ONNX) — Release 0.2. */
  models: string;
  /** Rolling log files. */
  logs: string;
  /** Pre-migration database copies. */
  backups: string;
}

export function resolveDataPaths(): DataPaths {
  const root = path.resolve(process.env.PL_DATA_DIR ?? defaultDataDir());
  return {
    root,
    database: path.join(root, "prediction-ledger.db"),
    secretKey: path.join(root, "secret.key"),
    media: path.join(root, "media"),
    artifacts: path.join(root, "artifacts"),
    tools: path.join(root, "tools"),
    models: path.join(root, "models"),
    logs: path.join(root, "logs"),
    backups: path.join(root, "backups"),
  };
}

/** Create the data directory tree if missing. Idempotent. */
export function ensureDataDirs(paths: DataPaths): void {
  for (const dir of [paths.root, paths.media, paths.artifacts, paths.tools, paths.models, paths.logs, paths.backups]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** True when running from a packaged build (dist/) rather than tsx in dev mode. */
export function isDevMode(): boolean {
  return process.env.PL_DEV === "1";
}
