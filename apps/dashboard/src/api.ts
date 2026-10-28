const TOKEN_KEY = "kmc.token";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(t: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* ignore */
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

import type { MeetingKind, MeetingSchedule, PollResult, Settings, SettingsUpdate } from "@kmc/shared-types";

export const api = {
  health: () => req<unknown>("GET", "/health"),
  join: () => req<unknown>("POST", "/zoom/join"),
  leave: () => req<unknown>("POST", "/zoom/leave"),
  waitLogin: () => req<unknown>("POST", "/zoom/login/wait"),
  recover: () => req<unknown>("POST", "/zoom/recover"),
  admitAll: () => req<{ admitted: number }>("POST", "/zoom/admit-all"),
  lockUnmute: (lock: boolean) => req<unknown>("POST", "/zoom/lock-unmute", { lock }),
  unmuteParticipant: (name: string) => req<{ ok: boolean; name: string }>("POST", "/zoom/unmute", { name }),
  setBrowserHidden: (hidden: boolean) => req<unknown>("POST", "/zoom/browser/hidden", { hidden }),
  launchPoll: () => req<{ ok: boolean }>("POST", "/zoom/poll/launch"),
  reclaimHost: () => req<{ ok: boolean }>("POST", "/zoom/reclaim-host"),
  pollsHistory: () => req<{ results: PollResult[] }>("GET", "/polls/history"),
  pollsToday: () => req<{ date: string; results: PollResult[] }>("GET", "/polls/today"),
  capturePoll: () => req<{ ok: boolean; result: PollResult | null }>("POST", "/polls/capture"),
  shareMonitorStart: () => req<unknown>("POST", "/share/monitor/start"),
  shareMonitorStop: () => req<unknown>("POST", "/share/monitor/stop"),
  shareStart: () => req<unknown>("POST", "/share/start"),
  shareStop: () => req<unknown>("POST", "/share/stop"),
  displays: () => req<unknown>("GET", "/displays"),
  logs: () => req<{ logs: { time: string; levelLabel: string; msg: string }[] }>("GET", "/system/logs?n=50"),
  shutdown: () => req<unknown>("POST", "/system/shutdown"),
  getSettings: () => req<Settings>("GET", "/settings"),
  putSettings: (patch: SettingsUpdate) => req<Settings>("PUT", "/settings", patch),
  net: () => req<{ addresses: string[]; port: number; panelUrls: string[]; tabletUrls: string[] }>("GET", "/net"),

  // -- meeting schedule + timers --
  meeting: () => req<MeetingSchedule>("GET", "/meeting"),
  meetingLoad: (body: { url?: string; week?: string; kind?: MeetingKind }) =>
    req<MeetingSchedule>("POST", "/meeting/load", body),
  meetingActive: (partId: string) => req<MeetingSchedule>("POST", "/meeting/active", { partId }),
  meetingStart: (id: string) => req<MeetingSchedule>("POST", `/meeting/part/${id}/start`),
  meetingPause: (id: string) => req<MeetingSchedule>("POST", `/meeting/part/${id}/pause`),
  meetingPauseNext: (id: string) => req<MeetingSchedule>("POST", `/meeting/part/${id}/pause-next`),
  meetingReset: (id: string) => req<MeetingSchedule>("POST", `/meeting/part/${id}/reset`),
  meetingAdjust: (id: string, body: { elapsedSec?: number; allottedSec?: number; title?: string }) =>
    req<MeetingSchedule>("PATCH", `/meeting/part/${id}`, body),
  meetingAddPart: (body: { section?: string; title: string; minutes: number }) =>
    req<MeetingSchedule>("POST", "/meeting/part", body),
  meetingRemovePart: (id: string) => req<MeetingSchedule>("DELETE", `/meeting/part/${id}`),
  meetingResetAll: () => req<MeetingSchedule>("POST", "/meeting/reset-all"),
};
