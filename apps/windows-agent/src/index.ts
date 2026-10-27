import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import process from "node:process";

/**
 * Watchdog agent. Launched by Task Scheduler AT LOGON (interactive session) so
 * Chromium has a desktop to draw on and capture from — a Session-0 Windows
 * service cannot do that (see docs/limitations.md).
 *
 * It keeps the backend server alive, restarting it with backoff on crash.
 */

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const MAX_BACKOFF_MS = 30_000;
let backoff = 1000;
let child: ChildProcess | null = null;
let stopping = false;

function log(msg: string): void {
  process.stdout.write(`[agent ${new Date().toISOString()}] ${msg}\n`);
}

function startServer(): void {
  if (stopping) return;
  log("Starting backend server…");
  // Use the workspace script so dependencies resolve correctly.
  child = spawn("npm", ["run", "start", "--workspace", "@kmc/server"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32", // npm.cmd on Windows
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return;
    log(`Server exited (code=${code} signal=${signal}); restarting in ${backoff}ms`);
    setTimeout(startServer, backoff);
    backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
  });

  // Reset backoff once the server has survived a while.
  setTimeout(() => {
    if (child) backoff = 1000;
  }, 60_000);
}

function shutdown(sig: string): void {
  stopping = true;
  log(`Received ${sig}; stopping server`);
  if (child) child.kill();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log(`Watchdog starting (repo: ${repoRoot})`);
startServer();
