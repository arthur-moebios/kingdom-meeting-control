import fs from "node:fs";
import path from "node:path";
import { loadConfig, isUsingDefaultTokens, repoRoot } from "@kmc/config";
import { createLogger } from "./logger.js";
import { AppContext } from "./context.js";
import { buildApp } from "./app.js";

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

  // Kick off browser launch / monitoring AFTER the server is accepting requests,
  // so the dashboard can connect and watch the real state as it comes up.
  void ctx.bootstrap();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down");
    try {
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
