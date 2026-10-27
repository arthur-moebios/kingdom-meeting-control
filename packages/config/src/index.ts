import { z } from "zod";
import path from "node:path";
import os from "node:os";

/**
 * Runtime configuration loaded from environment variables (see .env.example).
 * Secrets (tokens) live only in the environment, never in SQLite or logs.
 */

const boolFromEnv = (v: string | undefined, dflt: boolean): boolean => {
  if (v === undefined) return dflt;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
};

const RawConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().positive().default(4317),
  adminToken: z.string().min(1).default("change-me-admin"),
  viewerToken: z.string().min(1).default("change-me-viewer"),
  dataDir: z.string(),
  chromiumProfileDir: z.string(),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  zoomWebUrl: z.string().url().default("https://app.zoom.us/wc/home"),
  chromiumHeadless: z.boolean().default(false),
});

export type AppConfig = z.infer<typeof RawConfigSchema> & {
  dbPath: string;
  publicDir: string;
  /** Token auth is only enforced when BOTH tokens are set via env. */
  authEnabled: boolean;
};

/**
 * Base directory for runtime data + static assets. In the source tree it is the
 * repo root (derived from this file's location). In the packaged Windows app
 * the launcher sets KMC_BASE_DIR to the install dir (the bundle has a different
 * layout). Either way, paths are stable regardless of cwd.
 */
export const repoRoot = process.env.KMC_BASE_DIR
  ? path.resolve(process.env.KMC_BASE_DIR)
  : path.resolve(import.meta.dirname, "..", "..", "..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const repoRuntime = path.join(repoRoot, "runtime");
  // Built dashboard/tablet assets. Packaged app overrides with KMC_PUBLIC_DIR.
  const publicDir = env.KMC_PUBLIC_DIR
    ? path.resolve(repoRoot, env.KMC_PUBLIC_DIR)
    : path.join(repoRoot, "apps", "dashboard", "dist");
  // Relative env paths resolve against the repo root (not cwd).
  const dataDir = env.KMC_DATA_DIR
    ? path.resolve(repoRoot, env.KMC_DATA_DIR)
    : path.join(repoRuntime, "data");
  const chromiumProfileDir = env.KMC_CHROMIUM_PROFILE_DIR
    ? path.resolve(repoRoot, env.KMC_CHROMIUM_PROFILE_DIR)
    : path.join(repoRuntime, "chromium-profile");

  const parsed = RawConfigSchema.parse({
    host: env.KMC_HOST,
    port: env.KMC_PORT,
    adminToken: env.KMC_ADMIN_TOKEN,
    viewerToken: env.KMC_VIEWER_TOKEN,
    dataDir,
    chromiumProfileDir,
    logLevel: env.KMC_LOG_LEVEL,
    zoomWebUrl: env.KMC_ZOOM_WEB_URL,
    chromiumHeadless: boolFromEnv(env.KMC_CHROMIUM_HEADLESS, false),
  });

  return {
    ...parsed,
    dbPath: path.join(parsed.dataDir, "kmc.sqlite"),
    publicDir,
    authEnabled: Boolean(env.KMC_ADMIN_TOKEN && env.KMC_VIEWER_TOKEN),
  };
}

export function isUsingDefaultTokens(cfg: AppConfig): boolean {
  return cfg.adminToken === "change-me-admin" || cfg.viewerToken === "change-me-viewer";
}

export const hostInfo = {
  platform: `${os.type()} ${os.release()}`,
  nodeVersion: process.version,
};
