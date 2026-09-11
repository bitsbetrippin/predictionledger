#!/usr/bin/env node
/**
 * Prediction Ledger — development-mode launcher (`npm run dev`).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Runs the server with tsx --watch and the Vite dev server side by side. Vite proxies
 * /api to the Node server so the dashboard hot-reloads while sharing one data directory.
 * This is for contributors; end users run `npm start`.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const env = { ...process.env, PL_DEV: "1" };

const procs = [
  spawn(npm, ["run", "dev", "--workspace", "server"], { cwd: root, stdio: "inherit", env, shell: process.platform === "win32" }),
  spawn(npm, ["run", "dev", "--workspace", "web"], { cwd: root, stdio: "inherit", env, shell: process.platform === "win32" }),
];

const stop = () => {
  for (const p of procs) if (!p.killed) p.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", stop);
