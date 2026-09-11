#!/usr/bin/env node
/**
 * Prediction Ledger — normal-mode launcher (`npm start`).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Starts the built server, waits for its READY line, opens the dashboard in the default
 * browser (Windows / macOS / Linux, no extra dependency), and forwards Ctrl+C so the
 * server shuts down cleanly. Set PL_NO_OPEN=1 to skip opening the browser.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(root, "server", "dist", "index.js");
const webDist = path.join(root, "web", "dist", "index.html");

if (!fs.existsSync(serverEntry) || !fs.existsSync(webDist)) {
  console.error("Prediction Ledger is not built yet. Run:\n\n  npm run setup\n\n(or `npm run build` if dependencies are already installed).");
  process.exit(1);
}

const child = spawn(process.execPath, [serverEntry], {
  cwd: root,
  stdio: ["inherit", "pipe", "inherit"],
  env: process.env,
});

let opened = false;
child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  const m = /PREDICTION_LEDGER_READY (http:\/\/[^\s]+)/.exec(text);
  if (m && !opened) {
    opened = true;
    console.log(`\n  Prediction Ledger is running at ${m[1]}\n  Press Ctrl+C to stop.\n`);
    if (process.env.PL_NO_OPEN !== "1") openBrowser(m[1]);
  }
});

child.on("exit", (code) => process.exit(code ?? 0));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      // `start` is a cmd built-in; the empty "" is the window title argument.
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
}
