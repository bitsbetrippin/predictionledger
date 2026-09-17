#!/usr/bin/env node
/**
 * Prediction Ledger — `npm run doctor`: one-shot environment report to paste into a bug report or
 * the first-run checklist (docs/FIRST_RUN.md). Reads only; never changes anything. Prints no secrets.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lines = [];
const say = (k, v) => lines.push(`${k.padEnd(28)} ${v}`);
const ver = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, ...opts }).toString().split(/\r?\n/)[0].trim().slice(0, 80);
  } catch {
    return "not found";
  }
};
const exists = (p) => (fs.existsSync(p) ? "yes" : "no");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
say("Prediction Ledger", pkg.version);
say("OS", `${os.type()} ${os.release()} (${process.platform}/${process.arch})`);
say("Node", process.versions.node + (Number(process.versions.node.split(".")[0]) < 22 ? "  ✕ need >= 22.13" : ""));
// npm is a .cmd shim on Windows; Node ≥ 20.12 refuses to spawn .cmd files without a shell (CVE-2024-27980).
say("npm", process.env.npm_config_user_agent?.match(/npm\/(\S+)/)?.[1] ?? ver("npm", ["--version"], { shell: process.platform === "win32" }));
say("node:sqlite available", (() => { try { process.getBuiltinModule?.("node:sqlite"); return "yes"; } catch { return "no (Node < 22.13?)"; } })());
say("Repo path", root + (/\s/.test(root) ? "  (contains spaces — fine, but quote it in shells)" : ""));
say("node_modules", exists(path.join(root, "node_modules")));
say("shared/dist", exists(path.join(root, "shared", "dist", "index.js")));
say("server/dist", exists(path.join(root, "server", "dist", "index.js")));
say("web/dist", exists(path.join(root, "web", "dist", "index.html")) + (fs.existsSync(path.join(root, "server", "dist", "index.js")) && !fs.existsSync(path.join(root, "web", "dist", "index.html")) ? "  ← dashboard build did not finish: run `npm run build --workspace web` and paste the output" : ""));
say("package-lock.json", exists(path.join(root, "package-lock.json")));
say("@huggingface/transformers", fs.existsSync(path.join(root, "node_modules", "@huggingface", "transformers", "package.json")) ? "installed (local Whisper available)" : "not installed (optional)");
say("ffmpeg", ver("ffmpeg", ["-version"]));
say("ffprobe", ver("ffprobe", ["-version"]));
say("PL_FFMPEG_PATH", process.env.PL_FFMPEG_PATH ?? "(unset)");
say("yt-dlp on PATH", ver("yt-dlp", ["--version"]));
say("PL_YTDLP_PATH", process.env.PL_YTDLP_PATH ?? "(unset)");

// data directory (same rules as server/src/config.ts, duplicated here so doctor works before a build)
const home = os.homedir();
const dataDir = process.env.PL_DATA_DIR
  ? path.resolve(process.env.PL_DATA_DIR)
  : process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "PredictionLedger")
    : process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "PredictionLedger")
      : path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "prediction-ledger");
say("Data directory", `${dataDir} (${exists(dataDir) === "yes" ? "exists" : "will be created on first start"})`);
if (fs.existsSync(path.join(dataDir, "prediction-ledger.db"))) {
  const st = fs.statSync(path.join(dataDir, "prediction-ledger.db"));
  say("Database", `${(st.size / 1024).toFixed(0)} KB, modified ${st.mtime.toISOString().slice(0, 19)}`);
  say("secret.key", exists(path.join(dataDir, "secret.key")));
  // 2.0 (OPS-01 / O01): verify the key file's protection from the platform's own ACL, never inferred from a POSIX mode.
  const keyFile = path.join(dataDir, "secret.key");
  if (fs.existsSync(keyFile)) {
    const aclModule = path.join(root, "server", "dist", "security", "keyFileAcl.js");
    if (fs.existsSync(aclModule)) {
      const { checkKeyFileProtection } = await import(aclModule);
      const r = checkKeyFileProtection(keyFile);
      say("secret.key protection", `${r.ok ? "OK" : "OPEN"} — ${r.method}: ${r.detail}${r.fix ? `  ← fix: ${r.fix}` : ""}`);
    } else {
      say("secret.key protection", "not checked (build the server first: npm run build)");
    }
  }
  say("tools/yt-dlp", exists(path.join(dataDir, "tools", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp")));
  const models = path.join(dataDir, "models");
  say("models/", fs.existsSync(models) ? fs.readdirSync(models).join(", ") || "(empty)" : "none");
  const backups = path.join(dataDir, "backups");
  say("backups/", fs.existsSync(backups) ? `${fs.readdirSync(backups).filter((f) => f.endsWith(".db")).length} file(s)` : "none");
}
const port = Number(process.env.PL_PORT ?? 7317);
await new Promise((resolve) => {
  const probe = net.createServer();
  probe.once("error", () => { say(`Port ${port}`, "in use (the app will walk to the next free port)"); resolve(); });
  probe.listen({ host: "127.0.0.1", port }, () => probe.close(() => { say(`Port ${port}`, "free"); resolve(); }));
});
say("Internet (registry)", await fetch("https://registry.npmjs.org/-/ping", { signal: AbortSignal.timeout(5000) }).then((r) => (r.ok ? "reachable" : `HTTP ${r.status}`)).catch(() => "unreachable"));

console.log("\nPrediction Ledger — environment report\n" + "-".repeat(40));
console.log(lines.join("\n"));
console.log("\nPaste this block into docs/FIRST_RUN.md step 1 or a GitHub issue. It contains no API keys.\n");
