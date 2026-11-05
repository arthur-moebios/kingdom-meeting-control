import { expect, it } from 'vitest';
import type { PollResult } from '@kmc/shared-types';
import { compareVersions, extractVersion, parseVersion } from './update.js';
import { zoomAttendance } from './attendance.js';

it('parseVersion e compareVersions', () => {
  expect(parseVersion('0.3.0')).toEqual([0, 3, 0]);
  expect(parseVersion('v1.10.2')).toEqual([1, 10, 2]);
  expect(parseVersion('abc')).toBeNull();
  expect(compareVersions('0.3.0', '0.3.0')).toBe(0);
  expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
  expect(compareVersions('0.2.9', '0.3.0')).toBeLessThan(0);
  expect(compareVersions('lixo', '0.0.0')).toBe(0);
});
it('extractVersion usa name e depois body', () => {
  expect(extractVersion('Windows 0.3.0 — Zoom nativo', '')).toBe('0.3.0');
  expect(extractVersion('Windows', 'Versão 1.2.3. Substitui')).toBe('1.2.3');
  expect(extractVersion('x', 'y')).toBeNull();
});
const poll = (labels: [string, number][], voted: number, total: number | null): PollResult => ({
  date: '2026-11-04', pollName: 'p', question: '', totalVoted: voted, totalParticipants: total,
  options: labels.map(([label, votes]) => ({ label, votes })), capturedAt: '2026-11-04T00:00:00Z',
} as PollResult);
it('zoomAttendance', () => {
  expect(zoomAttendance([poll([['1', 10], ['2', 5]], 15, 18)])).toBe(20 + 3);
  expect(zoomAttendance([poll([['Sim', 3]], 3, 3)])).toBeNull();
  expect(zoomAttendance([])).toBeNull();
});
