import { z } from "zod";

/**
 * Shared contract between server and dashboard (and the future tablet UI).
 * Everything here is validated with Zod so both sides agree on shape.
 *
 * Honesty rule: optional/nullable fields are nullable *because the data may
 * genuinely be unavailable* from Zoom Web — never fill them with invented data.
 */

// ---------------------------------------------------------------------------
// Zoom lifecycle state machine
// ---------------------------------------------------------------------------
export const ZoomStateSchema = z.enum([
  "STOPPED",
  "INITIALIZING",
  "AUTH_REQUIRED",
  "AUTHENTICATED",
  "JOINING",
  "IN_MEETING",
  "SHARING",
  "RECONNECTING",
  "ERROR",
]);
export type ZoomState = z.infer<typeof ZoomStateSchema>;

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------
export const ZoomParticipantSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  handRaised: z.boolean(),
  /** ISO timestamp of when WE detected the hand; null if not raised. */
  handRaisedAt: z.string().datetime().nullable(),
  isHost: z.boolean(),
  isCoHost: z.boolean(),
  /** null when Zoom Web does not expose mute state for this row. */
  isMuted: z.boolean().nullable(),
});
export type ZoomParticipant = z.infer<typeof ZoomParticipantSchema>;

/** How the raised-hand ordering was derived. Zoom Web rarely exposes the true order. */
export const HandOrderSourceSchema = z.enum(["zoom-native", "detection-time", "unknown"]);
export type HandOrderSource = z.infer<typeof HandOrderSourceSchema>;

export const RaisedHandsSchema = z.object({
  order: z.array(ZoomParticipantSchema),
  orderSource: HandOrderSourceSchema,
  /** true when the participant list was virtualized/partial when read. */
  partial: z.boolean(),
});
export type RaisedHands = z.infer<typeof RaisedHandsSchema>;

// ---------------------------------------------------------------------------
// Meeting / Zoom status snapshot
// ---------------------------------------------------------------------------
export const ZoomStatusSchema = z.object({
  state: ZoomStateSchema,
  authenticated: z.boolean(),
  browserRunning: z.boolean(),
  meetingId: z.string().nullable(),
  /** host | participant | null (unknown yet) */
  role: z.enum(["host", "participant"]).nullable(),
  joinedAt: z.string().datetime().nullable(),
  micOn: z.boolean().nullable(),
  cameraOn: z.boolean().nullable(),
  sharing: z.boolean(),
  participantCount: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  updatedAt: z.string().datetime(),
});
export type ZoomStatus = z.infer<typeof ZoomStatusSchema>;

// ---------------------------------------------------------------------------
// Capabilities (what the adapter actually proved it can do)
// ---------------------------------------------------------------------------
export const CapabilityStatusSchema = z.enum([
  "supported",
  "experimental",
  "assisted-only",
  "unsupported",
  "unknown",
]);
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export const CapabilitiesSchema = z.record(z.string(), CapabilityStatusSchema);
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

// ---------------------------------------------------------------------------
// Displays / presentation (Windows)
// ---------------------------------------------------------------------------
export const DisplaySchema = z.object({
  id: z.string(),
  label: z.string(),
  primary: z.boolean(),
  bounds: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
  /** Operator-confirmed "this is the projector". */
  isProjector: z.boolean(),
});
export type Display = z.infer<typeof DisplaySchema>;

export const PresentationStatusSchema = z.object({
  jwLibraryDetected: z.boolean(),
  presentationActive: z.boolean(),
  /** Window title we matched, if any (diagnostic only). null otherwise. */
  matchedWindowTitle: z.string().nullable(),
  updatedAt: z.string().datetime(),
});
export type PresentationStatus = z.infer<typeof PresentationStatusSchema>;

// ---------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------
export const ShareModeSchema = z.enum(["manual", "assisted", "automatic"]);
export type ShareMode = z.infer<typeof ShareModeSchema>;

// ---------------------------------------------------------------------------
// Meeting schedule + per-part timers
//
// Parts are extracted from wol.jw.org (midweek Vida e Ministério, or the two
// weekend parts). Each part carries its own timer. The timer is stored as
// base-elapsed + startedAt so clients compute the live value with no drift and
// the server does not need to tick every second.
// ---------------------------------------------------------------------------
export const MeetingKindSchema = z.enum(["midweek", "weekend"]);
export type MeetingKind = z.infer<typeof MeetingKindSchema>;

export const MeetingPartSchema = z.object({
  id: z.string(),
  /** Section label as shown (e.g. "TESOUROS DA PALAVRA DE DEUS", "Início"). */
  section: z.string(),
  order: z.number().int(),
  title: z.string(),
  /** Allotted time in seconds (0 = untimed). Editable by the operator. */
  allottedSec: z.number().int().nonnegative(),
  // -- timer runtime --
  running: z.boolean().default(false),
  /** ISO time the current run started; null when paused/idle. */
  startedAt: z.string().datetime().nullable().default(null),
  /** Elapsed seconds accumulated before the current run. */
  baseElapsedSec: z.number().nonnegative().default(0),
  /** Where the part came from: parsed from WOL or added by the operator. */
  source: z.enum(["wol", "manual"]).default("wol"),
});
export type MeetingPart = z.infer<typeof MeetingPartSchema>;

export const MeetingScheduleSchema = z.object({
  source: z.enum(["wol", "manual", "none"]).default("none"),
  kind: MeetingKindSchema.nullable().default(null),
  /** Human week label, e.g. "26 de outubro–1.º de novembro". */
  weekLabel: z.string().default(""),
  /** Meeting theme/title line (e.g. the Watchtower study title). */
  title: z.string().default(""),
  wolUrl: z.string().nullable().default(null),
  fetchedAt: z.string().datetime().nullable().default(null),
  activePartId: z.string().nullable().default(null),
  parts: z.array(MeetingPartSchema).default([]),
  loading: z.boolean().default(false),
  error: z.string().nullable().default(null),
});
export type MeetingSchedule = z.infer<typeof MeetingScheduleSchema>;

// ---------------------------------------------------------------------------
// Settings (persisted)
// ---------------------------------------------------------------------------
export const SettingsSchema = z.object({
  meeting: z
    .object({
      meetingId: z.string().default(""),
      passcode: z.string().default(""),
      displayName: z.string().default("Salão do Reino"),
      autoJoin: z.boolean().default(false),
      /** "join" an existing meeting or attempt to "start" as host (experimental). */
      joinMode: z.enum(["join", "start"]).default("join"),
      scheduledTime: z.string().nullable().default(null),
      autoStartMeeting: z.boolean().default(false),
      micOnJoin: z.boolean().default(false),
      cameraOnJoin: z.boolean().default(false),
    })
    .default({}),
  reconnect: z
    .object({
      enabled: z.boolean().default(true),
      maxAttempts: z.number().int().positive().default(5),
      baseDelayMs: z.number().int().positive().default(2000),
      maxDelayMs: z.number().int().positive().default(60000),
    })
    .default({}),
  share: z
    .object({
      mode: ShareModeSchema.default("manual"),
      projectorDisplayId: z.string().nullable().default(null),
      shareAudio: z.boolean().default(false),
      /** Substring that identifies the projector screen in the OS capture picker
       *  (localized, e.g. "Tela 2" / "Screen 2"). Used by the experimental
       *  auto-share Chromium flag. */
      autoSourceTitle: z.string().default(""),
    })
    .default({}),
  automations: z
    .object({
      /** Automatically admit anyone who appears in the waiting room. */
      autoAdmit: z.boolean().default(false),
      /** Turn off "allow participants to unmute themselves" on join. */
      lockUnmute: z.boolean().default(false),
    })
    .default({}),
  browser: z
    .object({
      /** Keep the Chromium window off-screen (hidden) once authenticated.
       *  Shown automatically while login is required. NOT headless, so screen
       *  capture keeps working. */
      hidden: z.boolean().default(false),
    })
    .default({}),
  meetingSchedule: z
    .object({
      /** Base URL for the WOL meetings page (language-specific). */
      wolBase: z.string().default("https://wol.jw.org/pt/wol/meetings/r5/lp-t"),
      /** Auto-detect and load the current week's meeting on startup. */
      autoLoad: z.boolean().default(true),
      /** Default minutes for the weekend parts (not timed on WOL). */
      publicTalkMinutes: z.number().int().positive().default(30),
      watchtowerMinutes: z.number().int().positive().default(60),
      /** Seconds-remaining threshold where the timer turns amber. */
      warnSeconds: z.number().int().nonnegative().default(60),
    })
    .default({}),
  retention: z
    .object({
      eventDays: z.number().int().positive().default(30),
    })
    .default({}),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Partial update accepted by PUT /settings. */
export const SettingsUpdateSchema = SettingsSchema.deepPartial();
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;

// ---------------------------------------------------------------------------
// WebSocket / domain events
// ---------------------------------------------------------------------------
export const EventTypeSchema = z.enum([
  "zoom.connected",
  "zoom.disconnected",
  "zoom.meeting.started",
  "zoom.meeting.ended",
  "zoom.state.changed",
  "zoom.participant.joined",
  "zoom.participant.left",
  "zoom.hand.raised",
  "zoom.hand.lowered",
  "zoom.share.started",
  "zoom.share.stopped",
  "presentation.started",
  "presentation.ended",
  "meeting.loaded",
  "meeting.updated",
  "system.warning",
  "system.error",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const DomainEventSchema = z.object({
  id: z.string(),
  type: EventTypeSchema,
  ts: z.string().datetime(),
  /** Free-form, event-specific payload. Shape documented per type in code. */
  data: z.record(z.string(), z.unknown()).default({}),
});
export type DomainEvent = z.infer<typeof DomainEventSchema>;

// ---------------------------------------------------------------------------
// WebSocket frames (server → client)
// ---------------------------------------------------------------------------
export const SnapshotSchema = z.object({
  status: ZoomStatusSchema,
  participants: z.array(ZoomParticipantSchema),
  raisedHands: RaisedHandsSchema,
  displays: z.array(DisplaySchema),
  presentation: PresentationStatusSchema,
  capabilities: CapabilitiesSchema,
  meeting: MeetingScheduleSchema,
  settings: SettingsSchema,
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const ServerFrameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), snapshot: SnapshotSchema }),
  z.object({ kind: z.literal("event"), event: DomainEventSchema }),
  z.object({ kind: z.literal("heartbeat"), ts: z.string().datetime() }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

// ---------------------------------------------------------------------------
// System / health
// ---------------------------------------------------------------------------
export const HealthSchema = z.object({
  status: z.literal("ok"),
  uptimeSeconds: z.number(),
  version: z.string(),
  ts: z.string().datetime(),
});
export type Health = z.infer<typeof HealthSchema>;

export const SystemInfoSchema = z.object({
  platform: z.string(),
  nodeVersion: z.string(),
  chromiumRunning: z.boolean(),
  authenticated: z.boolean(),
  zoomState: ZoomStateSchema,
  lastUpdate: z.string().datetime(),
  recentLogCount: z.number().int().nonnegative(),
});
export type SystemInfo = z.infer<typeof SystemInfoSchema>;
