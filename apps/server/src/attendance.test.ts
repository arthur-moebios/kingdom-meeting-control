import { expect, it } from 'vitest';
import { MeetingScheduleSchema, type PollResult } from '@kmc/shared-types';
import { consolidateAttendance, deriveTipo, isoWithOffset } from './attendance.js';

const meeting = (o: Record<string, unknown>) => MeetingScheduleSchema.parse(o);
// 2026-11-04 é quarta; 2026-11-07 sábado; 2026-11-08 domingo. Semana ISO 45 (WOL 2026/45).
const midweek = meeting({ source: 'wol', kind: 'midweek', wolUrl: 'https://wol.exemplo.invalid/pt/wol/meetings/r5/lp-t/2026/45' });
const weekend = meeting({ source: 'wol', kind: 'weekend', wolUrl: 'https://wol.exemplo.invalid/pt/wol/meetings/r5/lp-t/2026/45' });

it('deriva o tipo de meeting.kind', () => {
  expect(deriveTipo(midweek, '2026-11-04')).toBe('meio_semana');
  expect(deriveTipo(weekend, '2026-11-07')).toBe('fim_de_semana');
  expect(deriveTipo(weekend, '2026-11-08')).toBe('fim_de_semana');
});

it('sem reunião carregada cai para "outra"', () => {
  expect(deriveTipo(meeting({}), '2026-11-04')).toBe('outra');
  expect(deriveTipo(null, '2026-11-04')).toBe('outra');
});

it('reunião de outra semana ou kind em conflito com o dia vira "outra"', () => {
  expect(deriveTipo(midweek, '2026-11-11')).toBe('outra'); // semana 46
  expect(deriveTipo(midweek, '2026-11-07')).toBe('outra'); // midweek carregada, mas é sábado
  expect(deriveTipo(weekend, '2026-11-04')).toBe('outra'); // weekend carregada, mas é quarta
});

it('sem semana identificável usa só kind + verificação do dia', () => {
  expect(deriveTipo(meeting({ kind: 'midweek' }), '2026-11-04')).toBe('meio_semana');
});

it('consolida zoom + presencial com a regra única', () => {
  const poll = { date: '2026-11-07', pollName: 'p', question: '', totalVoted: 2, totalParticipants: 5,
    options: [{ label: '1', votes: 1 }, { label: '2', votes: 1 }], capturedAt: '2026-11-07T20:00:00.000Z' } as unknown as PollResult;
  const src = { pollResultsForDate: () => [poll], getPresencial: () => 40 };
  // 1*1 + 2*1 + ausentes (5-2) = 6
  expect(consolidateAttendance(src, '2026-11-07')).toEqual({ date: '2026-11-07', zoom: 6, presencial: 40, total: 46 });
  expect(consolidateAttendance({ pollResultsForDate: () => [], getPresencial: () => 0 }, 'x')).toEqual({ date: 'x', zoom: null, presencial: 0, total: 0 });
});

it('formata o instante com offset local', () => {
  expect(isoWithOffset(new Date(2026, 10, 7, 20, 15, 3))).toMatch(/^2026-11-07T20:15:03[+-]\d\d:\d\d$/);
});
