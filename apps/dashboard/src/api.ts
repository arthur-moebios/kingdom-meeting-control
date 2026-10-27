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

import type { Settings, SettingsUpdate } from "@kmc/shared-types";

export const api = {
  health: () => req<unknown>("GET", "/health"),
  join: () => req<unknown>("POST", "/zoom/join"),
  leave: () => req<unknown>("POST", "/zoom/leave"),
  waitLogin: () => req<unknown>("POST", "/zoom/login/wait"),
  recover: () => req<unknown>("POST", "/zoom/recover"),
  admitAll: () => req<{ admitted: number }>("POST", "/zoom/admit-all"),
  lockUnmute: (lock: boolean) => req<unknown>("POST", "/zoom/lock-unmute", { lock }),
  setBrowserHidden: (hidden: boolean) => req<unknown>("POST", "/zoom/browser/hidden", { hidden }),
  shareMonitorStart: () => req<unknown>("POST", "/share/monitor/start"),
  shareMonitorStop: () => req<unknown>("POST", "/share/monitor/stop"),
  shareStart: () => req<unknown>("POST", "/share/start"),
  shareStop: () => req<unknown>("POST", "/share/stop"),
  displays: () => req<unknown>("GET", "/displays"),
  logs: () => req<{ logs: { time: string; levelLabel: string; msg: string }[] }>("GET", "/system/logs?n=50"),
  getSettings: () => req<Settings>("GET", "/settings"),
  putSettings: (patch: SettingsUpdate) => req<Settings>("PUT", "/settings", patch),
};
