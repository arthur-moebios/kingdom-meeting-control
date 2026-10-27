import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "@kmc/config";

export type Role = "admin" | "viewer";

/** Resolve the role from a bearer token (or ?token= for the WS handshake). */
export function resolveRole(cfg: AppConfig, token: string | undefined): Role | null {
  // Local personal project: unless env tokens are explicitly configured
  // (KMC_ADMIN_TOKEN + KMC_VIEWER_TOKEN), auth is disabled and every client
  // gets full admin access — no token required.
  if (!cfg.authEnabled) return "admin";
  if (!token) return null;
  if (token === cfg.adminToken) return "admin";
  if (token === cfg.viewerToken) return "viewer";
  return null;
}

function extractToken(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  const q = (req.query as Record<string, unknown> | undefined)?.token;
  return typeof q === "string" ? q : undefined;
}

declare module "fastify" {
  interface FastifyRequest {
    role?: Role;
  }
}

/** Require at least a viewer token (read access). */
export function requireViewer(cfg: AppConfig) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const role = resolveRole(cfg, extractToken(req));
    if (!role) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    req.role = role;
  };
}

/** Require an admin token (control access). */
export function requireAdmin(cfg: AppConfig) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const role = resolveRole(cfg, extractToken(req));
    if (role !== "admin") {
      await reply.code(role ? 403 : 401).send({ error: role ? "forbidden" : "unauthorized" });
      return;
    }
    req.role = role;
  };
}
