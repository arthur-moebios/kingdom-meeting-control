import { useEffect, useState } from "react";
import type { MeetingPart } from "@kmc/shared-types";

/** Re-render every `ms` while `active`, so running timers tick live. */
export function useClock(active: boolean, ms = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

/** Live elapsed seconds for a part, computed from the server's timer fields. */
export function elapsedSec(p: MeetingPart, nowMs: number): number {
  const run = p.running && p.startedAt ? Math.max(0, (nowMs - Date.parse(p.startedAt)) / 1000) : 0;
  return p.baseElapsedSec + run;
}

/** Seconds → "m:ss" (negative values keep a leading minus). */
export function fmtClock(totalSec: number): string {
  const neg = totalSec < 0;
  const s = Math.round(Math.abs(totalSec));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${neg ? "-" : ""}${mm}:${String(ss).padStart(2, "0")}`;
}

/** "m:ss" | "m" → seconds (null when unparseable). */
export function parseClock(v: string): number | null {
  const m = v.trim().match(/^(-)?(\d+)(?::(\d{1,2}))?$/);
  if (!m) return null;
  const sign = m[1] ? -1 : 1;
  const mm = parseInt(m[2] ?? "0", 10);
  const ss = m[3] ? parseInt(m[3], 10) : 0;
  return sign * (mm * 60 + ss);
}
