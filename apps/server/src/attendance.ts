import type { PollResult } from '@kmc/shared-types';

/** Mesma regra do PollResultView: enquete numérica => Σ(rótulo×votos) + ausentes; senão null. */
export function zoomAttendance(polls: PollResult[]): number | null {
  const p = polls.find(x => x.options.length > 0 && x.options.every(o => /^\d+$/.test(o.label.trim())));
  if (!p) return null;
  const count = p.options.reduce((s, o) => s + Number(o.label) * o.votes, 0);
  const missing = p.totalParticipants === null ? 0 : Math.max(0, p.totalParticipants - p.totalVoted);
  return count + missing;
}
