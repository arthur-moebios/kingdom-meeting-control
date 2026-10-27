import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { ServerFrame } from "@kmc/shared-types";
import type { AppContext } from "./context.js";
import { resolveRole } from "./auth.js";

/**
 * WebSocket at /ws. On connect: authenticate (token query), send a full
 * snapshot, then stream incremental events + periodic heartbeats.
 */
export function registerWebSocket(app: FastifyInstance, ctx: AppContext): void {
  const clients = new Set<WebSocket>();

  const send = (socket: WebSocket, frame: ServerFrame): void => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  };

  // Broadcast every domain event to all connected clients, followed by a fresh
  // snapshot so panels and the tablet reflect live state (timers, participants,
  // raised hands) without waiting for a reconnect.
  ctx.bus.subscribe((event) => {
    const snapshot = ctx.getSnapshot();
    for (const socket of clients) {
      send(socket, { kind: "event", event });
      send(socket, { kind: "snapshot", snapshot });
    }
  });

  // Heartbeat so clients can detect a dead connection.
  const heartbeat = setInterval(() => {
    const frame: ServerFrame = { kind: "heartbeat", ts: new Date().toISOString() };
    for (const socket of clients) send(socket, frame);
  }, 15_000);
  heartbeat.unref();

  app.get("/ws", { websocket: true }, (socket, req) => {
    const token = (req.query as { token?: string } | undefined)?.token;
    const role = resolveRole(ctx.cfg, token);
    if (!role) {
      send(socket, { kind: "event", event: ctx.bus.publish("system.error", { message: "ws unauthorized" }) });
      socket.close(4401, "unauthorized");
      return;
    }

    clients.add(socket);
    // Initial full sync.
    send(socket, { kind: "snapshot", snapshot: ctx.getSnapshot() });

    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });
}
