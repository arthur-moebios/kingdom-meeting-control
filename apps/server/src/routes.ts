import type { FastifyInstance } from "fastify";
import {
  SettingsSchema,
  SettingsUpdateSchema,
  type Health,
  type SystemInfo,
} from "@kmc/shared-types";
import { hostInfo } from "@kmc/config";
import { NotSupportedError } from "@kmc/zoom-web-adapter";
import type { AppContext } from "./context.js";
import { requireAdmin, requireViewer } from "./auth.js";

const VERSION = "0.1.0";

/** Minimal recursive merge for partial settings updates. */
function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return (patch as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = (base as Record<string, unknown>)[k];
    out[k] = v !== null && typeof v === "object" && !Array.isArray(v) ? deepMerge(cur, v) : v;
  }
  return out as T;
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const viewer = { preHandler: requireViewer(ctx.cfg) };
  const admin = { preHandler: requireAdmin(ctx.cfg) };
  const startedAt = Date.now();

  // -- health (no auth) ------------------------------------------------------
  app.get("/api/v1/health", async (): Promise<Health> => ({
    status: "ok",
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    version: VERSION,
    ts: new Date().toISOString(),
  }));

  // -- discovery (no auth) — lets a client that found us via mDNS confirm the
  //    service and learn the API/WS paths before pairing (viewer token). -----
  app.get("/api/v1/discovery", async () => ({
    service: "kingdom-meeting-control",
    name: `Kingdom Meeting Control @ ${hostInfo.platform}`,
    version: VERSION,
    api: "/api/v1",
    ws: "/ws",
    requiresToken: true,
    roles: ["admin", "viewer"],
  }));

  // -- system ----------------------------------------------------------------
  app.get("/api/v1/system", viewer, async (): Promise<SystemInfo> => {
    const status = ctx.zoom.getStatus();
    return {
      platform: hostInfo.platform,
      nodeVersion: hostInfo.nodeVersion,
      chromiumRunning: status.browserRunning,
      authenticated: status.authenticated,
      zoomState: status.state,
      lastUpdate: status.updatedAt,
      recentLogCount: ctx.ring.size,
    };
  });

  app.get("/api/v1/system/logs", viewer, async (req) => {
    const n = Number((req.query as { n?: string }).n ?? 50);
    return { logs: ctx.ring.recent(Number.isFinite(n) ? n : 50) };
  });

  app.get("/api/v1/capabilities", viewer, async () => ctx.zoom.getCapabilities());

  // -- zoom status / control -------------------------------------------------
  app.get("/api/v1/zoom/status", viewer, async () => ctx.zoom.getStatus());

  app.post("/api/v1/zoom/start", admin, async (_req, reply) => {
    // Host-start is unproven on Web client — report honestly, do not fake.
    ctx.db.audit("admin", "zoom.start.attempt", {});
    await reply.code(501).send({
      error: "not_supported",
      message:
        "Starting a meeting as host via Zoom Web is unproven in this phase. " +
        "Have the operator start the meeting, then call /zoom/join.",
    });
  });

  app.post("/api/v1/zoom/join", admin, async (_req, reply) => {
    ctx.db.audit("admin", "zoom.join", { meetingId: ctx.getSettings().meeting.meetingId });
    try {
      await ctx.zoom.join();
      return ctx.zoom.getStatus();
    } catch (err) {
      await reply.code(409).send({ error: "join_failed", message: String(err) });
    }
  });

  app.post("/api/v1/zoom/leave", admin, async () => {
    ctx.db.audit("admin", "zoom.leave", {});
    await ctx.zoom.leave();
    return ctx.zoom.getStatus();
  });

  app.get("/api/v1/zoom/diagnostics", admin, async () => ctx.zoom.diagnose());
  app.get("/api/v1/zoom/dump-participants", admin, async () => ctx.zoom.dumpParticipants());

  app.post("/api/v1/zoom/recover", admin, async () => {
    ctx.db.audit("admin", "zoom.recover", {});
    await ctx.zoom.recover();
    return ctx.zoom.getStatus();
  });

  // -- host automations (manual triggers) -----------------------------------
  app.post("/api/v1/zoom/admit-all", admin, async () => {
    ctx.db.audit("admin", "zoom.admit-all", {});
    const admitted = await ctx.zoom.admitAll();
    return { admitted };
  });

  app.post("/api/v1/zoom/lock-unmute", admin, async (req) => {
    const lock = (req.body as { lock?: boolean } | undefined)?.lock ?? true;
    ctx.db.audit("admin", "zoom.lock-unmute", { lock });
    const ok = await ctx.zoom.setLockUnmute(lock);
    return { ok, lock };
  });

  app.post("/api/v1/zoom/browser/hidden", admin, async (req) => {
    const hidden = (req.body as { hidden?: boolean } | undefined)?.hidden ?? true;
    ctx.db.audit("admin", "zoom.browser.hidden", { hidden });
    await ctx.zoom.setBrowserHidden(hidden);
    return { hidden };
  });

  app.post("/api/v1/share/monitor/start", admin, async (_req, reply) => {
    ctx.db.audit("admin", "share.monitor.start", {});
    const ok = await ctx.zoom.startMonitorShare();
    if (!ok) {
      await reply.code(409).send({ error: "share_unavailable", message: "Não foi possível iniciar o compartilhamento (está na reunião?)." });
      return;
    }
    return { ok: true, experimental: true };
  });

  app.post("/api/v1/share/monitor/stop", admin, async () => {
    ctx.db.audit("admin", "share.monitor.stop", {});
    await ctx.zoom.stopMonitorShare();
    return { ok: true };
  });

  app.post("/api/v1/zoom/login/wait", admin, async (req) => {
    const timeoutMs = Number((req.query as { timeoutMs?: string }).timeoutMs ?? 300000);
    const ok = await ctx.zoom.waitForLogin(Number.isFinite(timeoutMs) ? timeoutMs : 300000);
    return { authenticated: ok, status: ctx.zoom.getStatus() };
  });

  // -- participants ----------------------------------------------------------
  app.get("/api/v1/zoom/participants", viewer, async () => ({
    participants: ctx.zoom.listParticipants(),
  }));

  app.get("/api/v1/zoom/raised-hands", viewer, async () => ctx.zoom.getRaisedHands());

  // -- displays / presentation ----------------------------------------------
  app.get("/api/v1/displays", viewer, async () => ({
    displays: await ctx.presentation.enumerateDisplays(ctx.getSettings().share.projectorDisplayId),
  }));

  app.get("/api/v1/presentation/status", viewer, async () => ctx.presentation.getStatus());

  // -- share (assisted) ------------------------------------------------------
  app.post("/api/v1/share/start", admin, async (_req, reply) => {
    ctx.db.audit("admin", "share.start", { mode: ctx.getSettings().share.mode });
    try {
      const opened = await ctx.zoom.openSharePicker();
      if (!opened) {
        await reply.code(409).send({
          error: "share_unavailable",
          message: "Share button not found (are we in a meeting?).",
        });
        return;
      }
      ctx.bus.publish("zoom.share.started", { mode: ctx.getSettings().share.mode, assisted: true });
      return {
        ok: true,
        mode: "assisted",
        message:
          "Zoom share picker opened. The operator must select the projector monitor in the " +
          "native dialog — automatic monitor selection is not supported (see limitations.md).",
      };
    } catch (err) {
      if (err instanceof NotSupportedError) {
        await reply.code(501).send({ error: "not_supported", message: err.message });
        return;
      }
      await reply.code(500).send({ error: "share_error", message: String(err) });
    }
  });

  app.post("/api/v1/share/stop", admin, async () => {
    ctx.db.audit("admin", "share.stop", {});
    ctx.bus.publish("zoom.share.stopped", {});
    return { ok: true, message: "Stop requested; operator confirms in the browser/OS UI." };
  });

  // -- meeting schedule + per-part timers -----------------------------------
  app.get("/api/v1/meeting", viewer, async () => ctx.meeting.getState());

  app.post("/api/v1/meeting/load", admin, async (req) => {
    const b = (req.body ?? {}) as { url?: string; week?: string; kind?: "midweek" | "weekend" };
    ctx.db.audit("admin", "meeting.load", { kind: b.kind ?? null, week: b.week ?? null });
    return ctx.meeting.load({ url: b.url, week: b.week, kind: b.kind });
  });

  app.post("/api/v1/meeting/active", admin, async (req) => {
    const { partId } = (req.body ?? {}) as { partId?: string };
    return partId ? ctx.meeting.setActive(partId) : ctx.meeting.getState();
  });

  app.post("/api/v1/meeting/part/:id/start", admin, async (req) =>
    ctx.meeting.start((req.params as { id: string }).id),
  );
  app.post("/api/v1/meeting/part/:id/pause", admin, async (req) =>
    ctx.meeting.pause((req.params as { id: string }).id),
  );
  app.post("/api/v1/meeting/part/:id/reset", admin, async (req) =>
    ctx.meeting.reset((req.params as { id: string }).id),
  );

  // Adjust a part: elapsed (forgot to start/reset), allotted time, or title.
  app.patch("/api/v1/meeting/part/:id", admin, async (req) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { elapsedSec?: number; allottedSec?: number; title?: string };
    let st = ctx.meeting.getState();
    if (typeof b.allottedSec === "number") st = ctx.meeting.setAllotted(id, b.allottedSec);
    if (typeof b.title === "string") st = ctx.meeting.setTitle(id, b.title);
    if (typeof b.elapsedSec === "number") st = ctx.meeting.setElapsed(id, b.elapsedSec);
    return st;
  });

  app.post("/api/v1/meeting/part", admin, async (req, reply) => {
    const b = (req.body ?? {}) as { section?: string; title?: string; minutes?: number };
    if (!b.title || typeof b.minutes !== "number") {
      await reply.code(400).send({ error: "invalid_part", message: "title e minutes são obrigatórios." });
      return;
    }
    return ctx.meeting.addPart({ section: b.section, title: b.title, minutes: b.minutes });
  });

  app.delete("/api/v1/meeting/part/:id", admin, async (req) =>
    ctx.meeting.removePart((req.params as { id: string }).id),
  );

  app.post("/api/v1/meeting/reset-all", admin, async () => ctx.meeting.resetAll());

  // -- settings --------------------------------------------------------------
  app.get("/api/v1/settings", viewer, async () => ctx.getSettings());

  app.put("/api/v1/settings", admin, async (req, reply) => {
    const parsed = SettingsUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: "invalid_settings", issues: parsed.error.issues });
      return;
    }
    const merged = deepMerge(ctx.getSettings(), parsed.data);
    const validated = SettingsSchema.safeParse(merged);
    if (!validated.success) {
      await reply.code(400).send({ error: "invalid_settings", issues: validated.error.issues });
      return;
    }
    ctx.setSettings(validated.data);
    // Re-point presentation monitor if projector changed.
    ctx.presentation.start(validated.data.share.projectorDisplayId);
    return validated.data;
  });
}
