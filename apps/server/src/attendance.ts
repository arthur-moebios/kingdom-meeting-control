import { isWeekendDay } from '@kmc/meeting';
import type { AttendanceSummary, MeetingSchedule, PollResult } from '@kmc/shared-types';
import { dateWeek, meetingWeek, weekKey } from './meetingPeriod.js';

/** Mesma regra do PollResultView: enquete numérica => Σ(rótulo×votos) + ausentes; senão null. */
export function zoomAttendance(polls: PollResult[]): number | null {
  const p = polls.find(x => x.options.length > 0 && x.options.every(o => /^\d+$/.test(o.label.trim())));
  if (!p) return null;
  const count = p.options.reduce((s, o) => s + Number(o.label) * o.votes, 0);
  const missing = p.totalParticipants === null ? 0 : Math.max(0, p.totalParticipants - p.totalVoted);
  return count + missing;
}

// ---------------------------------------------------------------------------
// Consolidação da assistência (presencial + Zoom) e tipo da reunião
// ---------------------------------------------------------------------------

/** Parte do Db de que a consolidação precisa (facilita testar sem SQLite). */
export interface AttendanceSource {
  pollResultsForDate(date: string): PollResult[];
  getPresencial(date: string): number;
}

/** Data local no formato YYYY-MM-DD (a mesma chave usada em kv/poll_results). */
export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Objeto canônico {date, zoom, presencial, total} — única regra de total do projeto. */
export function consolidateAttendance(src: AttendanceSource, date: string): AttendanceSummary {
  const zoom = zoomAttendance(src.pollResultsForDate(date));
  const presencial = src.getPresencial(date);
  return { date, zoom, presencial, total: (zoom ?? 0) + presencial };
}

export type AttendanceTipo = "meio_semana" | "fim_de_semana" | "outra";

/**
 * Deriva o tipo da reunião a partir da reunião CARREGADA (`meeting.kind`).
 *  - sem reunião carregada (kind nulo) => "outra";
 *  - a reunião carregada tem de ser da mesma semana ISO de `date` (quando a semana
 *    é identificável por wolUrl/weekLabel); senão está velha => "outra";
 *  - o dia da semana só serve de verificação: kind "weekend" exige sábado/domingo e
 *    "midweek" exige dia útil; conflito => "outra" (não adivinhamos).
 */
export function deriveTipo(meeting: MeetingSchedule | null | undefined, date: string): AttendanceTipo {
  const kind = meeting?.kind;
  if (!meeting || !kind) return "outra";
  const week = meetingWeek(meeting);
  if (week && weekKey(week) !== weekKey(dateWeek(date))) return "outra";
  const weekend = isWeekendDay(new Date(`${date}T12:00:00`));
  if (kind === "weekend") return weekend ? "fim_de_semana" : "outra";
  return weekend ? "outra" : "meio_semana";
}

/**
 * Regra "a Sala B não existe no fim de semana". Usa `deriveTipo` (meeting.kind validado contra a
 * semana ISO e o dia): "fim_de_semana" => true, "meio_semana" => false. Sem reunião carregada ou
 * em conflito ("outra"), cai no dia da semana (sábado/domingo).
 */
export function isWeekendMeeting(meeting: MeetingSchedule | null | undefined, now: Date = new Date()): boolean {
  const tipo = deriveTipo(meeting, localDate(now));
  if (tipo === "fim_de_semana") return true;
  if (tipo === "meio_semana") return false;
  return isWeekendDay(now);
}

/** ISO-8601 em horário local com offset, ex. 2026-11-07T20:15:03-03:00. */
export function isoWithOffset(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${localDate(d)}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}
