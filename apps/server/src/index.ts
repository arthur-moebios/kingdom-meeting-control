import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig, isUsingDefaultTokens, repoRoot, type AppConfig } from "@kmc/config";
import { createLogger } from "./logger.js";
import { AppContext } from "./context.js";
import { buildApp } from "./app.js";
import { DiscoveryService } from "./discovery.js";

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

/**
 * Packaged app: if no real tokens were provided via env, persist random ones to
 * runtime/tokens.json and write a human-readable runtime/tokens.txt so the
 * operator can find the admin (dashboard) and viewer (tablet) tokens.
 */
function ensureTokens(cfg: AppConfig): void {
  if (!isUsingDefaultTokens(cfg)) return;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const file = path.join(cfg.dataDir, "tokens.json");
  let toks: { admin: string; viewer: string };
  if (fs.existsSync(file)) {
    toks = JSON.parse(fs.readFileSync(file, "utf8")) as { admin: string; viewer: string };
  } else {
    const gen = (): string => randomBytes(18).toString("base64url");
    toks = { admin: gen(), viewer: gen() };
    fs.writeFileSync(file, JSON.stringify(toks, null, 2));
    fs.writeFileSync(
      path.join(cfg.dataDir, "tokens.txt"),
      `ADMIN (painel do operador): ${toks.admin}\nVIEWER (tablet da tribuna): ${toks.viewer}\n`,
    );
  }
  cfg.adminToken = toks.admin;
  cfg.viewerToken = toks.viewer;
}

async function main(): Promise<void> {
  loadEnvFile();
  const cfg = loadConfig();
  ensureTokens(cfg);
  const { logger, ring } = createLogger(cfg.logLevel);

  logger.info(
    { host: cfg.host, port: cfg.port, headless: cfg.chromiumHeadless },
    "Kingdom Meeting Control server starting",
  );
  if (isUsingDefaultTokens(cfg)) {
    logger.warn(
      {},
      "Using DEFAULT auth tokens — set KMC_ADMIN_TOKEN / KMC_VIEWER_TOKEN before real use.",
    );
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

  // Kick off browser launch / monitoring AFTER the server is accepting requests,
  // so the dashboard can connect and watch the real state as it comes up.
  void ctx.bootstrap();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down");
    try {
      await discovery.stop();
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
