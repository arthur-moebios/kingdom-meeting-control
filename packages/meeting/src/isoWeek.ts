/**
 * ISO-8601 week number helpers. WOL's meeting URLs use the ISO week of the
 * Monday-based meeting week (e.g. 2026/44 = week of 26 Oct–1 Nov 2026), so the
 * current meeting is found from today's date with plain ISO math.
 */

/** ISO week-numbering year + week for a given date (local time). */
export function isoWeek(date: Date): { year: number; week: number } {
  // Copy, shift to Thursday of the current ISO week (ISO weeks are Mon–Sun and
  // belong to the year containing their Thursday).
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7; // Sun=0 -> 7
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year, week };
}

/** Weekday helper: true on Saturday/Sunday (the weekend meeting days). */
export function isWeekendDay(date: Date): boolean {
  const d = date.getDay(); // 0=Sun, 6=Sat
  return d === 0 || d === 6;
}

/** Build the WOL meetings URL for a given ISO year/week. */
export function wolMeetingsUrl(base: string, year: number, week: number): string {
  return `${base.replace(/\/+$/, "")}/${year}/${week}`;
}
