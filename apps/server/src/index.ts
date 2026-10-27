import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig, repoRoot } from "@kmc/config";
import { createLogger } from "./logger.js";
import { AppContext } from "./context.js";
import { buildApp } from "./app.js";
import { DiscoveryService } from "./discovery.js";
import { BeaconService } from "./beacon.js";

const VERSION = "0.1.0";

/** Load .env (repo root) into process.env if present — no extra dependency. */
function loadEnvFile(): void {
  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) return;
  const loader = (process as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof loader === "function") {
    try {
      loader(envPath);
    } catch {
      /* ignore malformed .env */
    }
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const cfg = loadConfig();
  const { logger, ring } = createLogger(cfg.logLevel);

  logger.info(
    { host: cfg.host, port: cfg.port, headless: cfg.chromiumHeadless, authEnabled: cfg.authEnabled },
    "Kingdom Meeting Control server starting",
  );
  if (!cfg.authEnabled) {
    logger.info({}, "Auth disabled (local mode) — no token required. Set KMC_ADMIN_TOKEN + KMC_VIEWER_TOKEN to enable.");
  }

  const ctx = new AppContext(cfg, logger, ring);
  const app = await buildApp(ctx);

  await app.listen({ host: cfg.host, port: cfg.port });
  logger.info({ url: `http://${cfg.host}:${cfg.port}` }, "HTTP + WebSocket listening");

  // LAN auto-discovery (mDNS) so the tablet finds this PC with no hardcoded IP.
  if (cfg.host === "127.0.0.1" || cfg.host === "localhost") {
    logger.warn(
      {},
      "Bound to loopback — the tablet cannot reach this PC over the LAN. Set KMC_HOST=0.0.0.0 for tablet/LAN use.",
    );
  }
  const discovery = new DiscoveryService(logger, { port: cfg.port, version: VERSION });
  discovery.start();

  // DHCP-proof zero-config discovery via UDP broadcast (primary; survives IP
  // changes and works where mDNS multicast is filtered by the router).
  const beacon = new BeaconService(logger, {
    apiPort: cfg.port,
    name: `Kingdom Meeting Control @ ${os.hostname()}`,
    version: VERSION,
  });
  beacon.start();

  // Kick off browser launch / monitoring AFTER the server is accepting requests,
  // so the dashboard can connect and watch the real state as it comes up.
  void ctx.bootstrap();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down");
    try {
      await discovery.stop();
      await beacon.stop();
      await app.close();
      await ctx.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error:", err);
  process.exit(1);
});
