import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import type { AppContext } from "./context.js";
import { registerRoutes } from "./routes.js";
import { registerWebSocket } from "./ws.js";

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  // Fastify uses its own logging off; we rely on the shared pino logger.
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

  // Control endpoints (join/leave/share) are POSTs with NO body. Without this,
  // Fastify replies 415 before auth runs. The default application/json parser
  // still handles PUT /settings; this catch-all covers empty / other bodies.
  app.addContentTypeParser("*", (_req, payload, done) => {
    let data = "";
    payload.on("data", (chunk) => (data += chunk));
    payload.on("end", () => done(null, data.length ? data : undefined));
  });

  await app.register(fastifyWebsocket);

  // Register WS + REST (WS plugin must be registered before the /ws route).
  await app.register(async (instance) => {
    registerWebSocket(instance, ctx);
    registerRoutes(instance, ctx);
  });

  // Production: serve the built operator dashboard + tablet view from one
  // process (no Vite). In dev the dist folder is absent, so this is skipped and
  // Vite serves on :5173. Declared /api and /ws routes take precedence.
  const distDir = ctx.cfg.publicDir;
  if (fs.existsSync(path.join(distDir, "index.html"))) {
    await app.register(fastifyStatic, { root: distDir, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/ws")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not_found" });
    });
    ctx.logger.info({ distDir }, "Serving built dashboard + tablet view");
  }

  app.setErrorHandler((err: unknown, _req, reply) => {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error({ err: message }, "Unhandled request error");
    void reply.code(500).send({ error: "internal_error" });
  });

  return app;
}
