import { expect, it } from 'vitest';
import { MeetingScheduleSchema } from '@kmc/shared-types';
import { dateWeek, meetingWeek, weekKey, weekLabel } from './meetingPeriod.js';
it('formats the same ISO week from a meeting URL and its actual meeting date',()=> {
  const week=meetingWeek(MeetingScheduleSchema.parse({wolUrl:'https://wol.jw.org/pt/wol/meetings/r5/lp-t/2026/45'}))!;
  expect(weekKey(week)).toBe(weekKey(dateWeek('2026-11-04')));
  expect(weekLabel(week)).toBe('Semana de 2 a 8 de novembro de 2026');
  expect(weekLabel(dateWeek('2026-10-28'))).toBe('Semana de 26 de outubro a 1 de novembro de 2026');
});
it('keeps week and date aligned across the year boundary',()=> {
  const week=meetingWeek(MeetingScheduleSchema.parse({weekLabel:'1 de janeiro de 2027'}))!;
  expect(weekKey(week)).toBe('2026/53');
  expect(weekLabel(week)).toBe('Semana de 28 de dezembro de 2026 a 3 de janeiro de 2027');
});
