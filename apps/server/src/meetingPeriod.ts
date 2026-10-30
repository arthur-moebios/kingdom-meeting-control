import { isoWeek } from '@kmc/meeting';
import type { MeetingSchedule } from '@kmc/shared-types';
export interface MeetingWeek {year:number;week:number;}
export const weekKey=(value:MeetingWeek)=>`${value.year}/${value.week}`;
export function dateWeek(date:string):MeetingWeek {return isoWeek(new Date(date+'T12:00:00'));}
export function meetingWeek(meeting:MeetingSchedule,date?:string|null):MeetingWeek|null {
  const wol=meeting.wolUrl?.match(/\/(\d{4})\/(\d{1,2})(?:[/?#]|$)/);
  if(wol && Number(wol[2])>=1 && Number(wol[2])<=53)return {year:Number(wol[1]),week:Number(wol[2])};
  const months=['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  const label=meeting.weekLabel.match(/^(\d{1,2}) de ([a-zç]+) de (\d{4})$/i);
  if(label){const month=months.indexOf(label[2]!.toLowerCase());if(month>=0)return dateWeek(`${label[3]}-${String(month+1).padStart(2,'0')}-${label[1]!.padStart(2,'0')}`);}
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date)?dateWeek(date):null;
}
export function weekLabel(value:MeetingWeek):string {
  const first=new Date(Date.UTC(value.year,0,4));first.setUTCDate(first.getUTCDate()-(first.getUTCDay() || 7)+1+(value.week-1)*7);
  const last=new Date(first);last.setUTCDate(last.getUTCDate()+6);
  const format=(date:Date)=>date.toLocaleDateString('pt-BR',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});
  const start=first.getUTCFullYear()!==last.getUTCFullYear()?format(first):first.getUTCMonth()!==last.getUTCMonth()?first.toLocaleDateString('pt-BR',{day:'numeric',month:'long',timeZone:'UTC'}):String(first.getUTCDate());
  return `Semana de ${start} a ${format(last)}`;
}
