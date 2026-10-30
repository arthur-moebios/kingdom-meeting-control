import { expect, it, vi } from 'vitest';
import { MeetingService } from '@kmc/meeting';
import { SettingsSchema } from '@kmc/shared-types';
import { MobileProgrammes } from './mobileProgrammes.js';
import { MobileTimers, buildRemoteGateway } from './mobileTimers.js';
import { MINISTRY, parseProgrammePages } from './programmeImport.js';
import type { AppContext } from './context.js';
import path from 'node:path';
import type { Db } from './db.js';

const fixture=`Reunião do meio de semana
14 de outubro de 2026 | LEITURA
Dirigente (Sala B) DIRIGENTE B
TESOUROS DA PALAVRA DE DEUS
3. Leitura da Bíblia (4 min) Salão Principal LEITOR A
Sala B LEITOR B
FAÇA SEU MELHOR NO MINISTÉRIO
4. Iniciando conversas (3 min) Salão Principal NOME A / AJUDANTE A
Sala B NOME B / AJUDANTE B
5. Cultivando interesse (4 min) Salão Principal OUTRO A
Sala B OUTRO B
6. Discurso especial (6 min) Salão Principal SÓ PRINCIPAL
NOSSA VIDA CRISTÃ
7. Necessidades locais (15 min) Salão Principal ANCIÃO
21 de outubro de 2026 | LEITURA
FAÇA SEU MELHOR NO MINISTÉRIO
4. Conversas (3 min) Salão Principal OUTRO`;
function setup(options:{db?:Pick<Db,'getKv'|'setKv'>;seed?:boolean}={}) {
  const kv=new Map<string,string>(),globalEmit=vi.fn();
  const ctx={cfg:{publicDir:path.resolve('apps/dashboard/dist')},cloudflare:{gatewayPort:4320,publicOrigin:'https://timers.example.test',instanceId:'test'},
    logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()},db:options.db ?? {getKv:(key:string)=>kv.get(key) ?? null,setKv:(key:string,value:string)=>kv.set(key,value)},
    getSettings:()=>SettingsSchema.parse({}),bus:{subscribe:()=>()=>{}},
  } as unknown as AppContext;
  Object.assign(ctx,{meeting:new MeetingService({log:ctx.logger,getSettings:()=>ctx.getSettings(),emit:globalEmit,loadState:()=>ctx.db.getKv('main'),saveState:json=>ctx.db.setKv('main',json)})});
  Object.assign(ctx,{programmes:new MobileProgrammes(ctx),mobile:new MobileTimers(ctx)});
  if(options.seed!==false)ctx.programmes.store(parseProgrammePages([fixture],'fixture.pdf'));
  return {ctx,kv,globalEmit};
}
it('imports only explicitly assigned ministry parts for B, keeping names and dates distinct',()=> {
  const [first,second]=parseProgrammePages([fixture],'fixture.pdf');
  expect(first!.roomBParts.map(p=>p.number)).toEqual(['4','5']);
  expect(first!.roomBParts[0]).toMatchObject({section:MINISTRY,name:'NOME B',secondName:'AJUDANTE B',allottedSec:180});
  expect(first!.mainParts.find(p=>p.number==='4')!.name).toBe('NOME A');
  expect(first!.conductorB).toBe('DIRIGENTE B');expect(second!.date).toBe('2026-10-21');expect(second!.roomBParts).toEqual([]);
});
it('reimport updates active names without resetting a running timer or publishing incomplete details',()=> {
  const {ctx}=setup(),programme=ctx.programmes.list().find(p=>p.roomBParts.length)!;
  const events:ReturnType<MobileProgrammes['state']>[]=[];ctx.programmes.subscribe(room=>{if(room==='b')events.push(ctx.programmes.state(room));});
  const loaded=ctx.programmes.load({programmeId:programme.id,room:'b',includeNames:true});
  expect(events).toHaveLength(1);expect(Object.keys(events[0]!.details!.assignments)).toHaveLength(2);
  ctx.programmes.roomB.start(loaded.meeting.parts[0]!.id);const before=ctx.programmes.roomB.getState();
  programme.roomBParts[0]!.name='NOVO NOME DO PDF';ctx.programmes.store([programme]);ctx.programmes.activateAutomatic('b');
  expect(ctx.programmes.roomB.getState()).toEqual(before);expect(ctx.programmes.state('b').details!.assignments[before.parts[0]!.id]!.name).toBe('NOVO NOME DO PDF');
});
it('rebinds imported names when the same programme regenerates IDs and rejects stale saves',()=> {
  const {ctx}=setup(),programme=ctx.programmes.list().find(p=>p.roomBParts.length)!;
  const loaded=ctx.programmes.load({programmeId:programme.id,room:'b',includeNames:true});
  ctx.programmes.roomB.replaceProgramme({weekLabel:programme.label,title:MINISTRY,kind:'midweek',parts:programme.roomBParts});
  const rebound=ctx.programmes.state('b');expect(rebound.details!.assignments[rebound.meeting.parts[0]!.id]!.name).toBe('NOME B');
  expect(()=>ctx.programmes.saveDetails('b',{...loaded.details,partIds:loaded.meeting.parts.map(p=>p.id)})).toThrow('A programação mudou');
  ctx.programmes.saveDetails('b',{assignments:{}});expect(ctx.programmes.state('b').details!.assignments[rebound.meeting.parts[0]!.id]!.name).toBe('NOME B');
});
it('recognizes the two circuit-visit talks and does not invent a Watchtower study',()=> {
  const [day]=parseProgrammePages([`Reunião do fim de semana
10 de outubro de 2026
A História e o Ministério de Jesus – Episódio 2 –
Parte I                    Presidente     PRESIDENTE
VISITANTE — Superintendente de circuito
Quem realmente governa o mundo?
VISITANTE — Superintendente de circuito
29/10/2026, 13:28:35`],'weekend.pdf');
  expect(day!.mainParts.map(p=>p.title)).toEqual(['A História e o Ministério de Jesus – Episódio 2 – Parte I','Quem realmente governa o mundo?']);
  expect(day!.warnings.join(' ')).toContain('sugestões editáveis');
});
it('B runs, persists and finishes independently; private names never enter primary state or bus',()=> {
  const {ctx,kv,globalEmit}=setup(),programme=ctx.programmes.list().find(p=>p.roomBParts.length)!;
  ctx.programmes.load({programmeId:programme.id,room:'main',includeNames:false});
  const main=ctx.meeting.getState().parts[0]!;ctx.meeting.start(main.id);const primary=ctx.meeting.getState();globalEmit.mockClear();
  const b=ctx.programmes.load({programmeId:programme.id,room:'b',includeNames:true});
  ctx.programmes.roomB.start(b.meeting.parts[0]!.id);
  expect(ctx.programmes.state('b').meeting.parts[0]!.running).toBe(true);expect(ctx.meeting.getState()).toEqual(primary);
  expect(globalEmit).not.toHaveBeenCalled();expect(JSON.stringify(primary)).not.toContain('NOME B');
  expect(JSON.stringify(ctx.programmes.state('main'))).not.toContain('NOME B');expect(kv.has('meeting.room-b')).toBe(true);
  const restored=new MobileProgrammes(ctx);expect(restored.state('b').details!.assignments).toEqual(b.details!.assignments);
  expect(restored.state('b').meeting.parts[0]!.running).toBe(true);
});
it('one pairing controls both rooms and rejects cross-room IDs and invalid rooms',async()=> {
  const {ctx}=setup(),programme=ctx.programmes.list().find(p=>p.roomBParts.length)!;
  ctx.programmes.load({programmeId:programme.id,room:'main'});ctx.programmes.load({programmeId:programme.id,room:'b',includeNames:true});
  const app=await buildRemoteGateway(ctx);
  try {
    const headers={host:'timers.example.test',origin:'https://timers.example.test'};
    const pair=await app.inject({method:'POST',url:'/remote-api/pair',headers,payload:{name:'Teste Sala B'}});
    const cookie=String(pair.headers['set-cookie']).split(';')[0]!,authorized={...headers,cookie};
    const b=await app.inject({url:'/remote-api/state?room=b',headers:authorized});expect(b.statusCode).toBe(200);expect(b.json().room).toBe('b');
    const id=b.json().meeting.parts[0].id;
    expect((await app.inject({method:'POST',url:`/remote-api/part/${id}/start?room=main`,headers:authorized,payload:{}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:`/remote-api/part/${id}/start?room=wrong`,headers:authorized,payload:{}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:`/remote-api/part/${id}/start?room=b`,headers:authorized,payload:{}})).statusCode).toBe(200);
    const started=ctx.programmes.roomB.getState().parts[0]!.startedAt;
    await app.inject({method:'POST',url:`/remote-api/part/${id}/start?room=b`,headers:authorized,payload:{}});
    expect(ctx.programmes.roomB.getState().parts[0]!.startedAt).toBe(started);
    const finish=await app.inject({method:'POST',url:'/remote-api/room-b/finish',headers:authorized,payload:{}});expect(finish.json().meeting.parts[0].running).toBe(false);
    expect(ctx.meeting.getState().parts.some(p=>p.running)).toBe(false);
    const main=await app.inject({url:'/remote-api/state',headers:authorized});expect(main.body).not.toContain('NOME B');
  }finally{await app.close();}
});
it('prepares all dates and automatically advances B with names, preserving running timers',()=> {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-10-14T12:00:00'));
    const {ctx}=setup(),current=ctx.programmes.list().find(p=>p.roomBParts.length)!;
    ctx.programmes.store([{...structuredClone(current),id:'future',date:'2026-10-21',label:'21 de outubro de 2026'}]);
    const first=ctx.programmes.state('b');expect(first.details!.date).toBe('2026-10-14');
    expect(first.details!.assignments[first.meeting.parts[0]!.id]!.name).toBe('NOME B');
    expect(first.details!.numbers![first.meeting.parts[0]!.id]).toBe('4');
    ctx.programmes.roomB.start(first.meeting.parts[0]!.id);
    vi.setSystemTime(new Date('2026-10-21T12:00:00'));
    expect(ctx.programmes.state('b').details!.date).toBe('2026-10-14');
    ctx.programmes.roomB.pause(first.meeting.parts[0]!.id);
    expect(ctx.programmes.state('b').details!.date).toBe('2026-10-21');
    expect(ctx.meeting.getState().parts).toEqual([]);
    expect(ctx.programmes.list()).toHaveLength(2);
  }finally{vi.useRealTimers();}
});
it('uses the main WOL week for both rooms without replacing its timers',()=> {
  const {ctx}=setup(),source=ctx.programmes.list().find(p=>p.roomBParts.length)!;
  ctx.programmes.store([{...structuredClone(source),id:'nov4',date:'2026-11-04',label:'4 de novembro de 2026'},
    {...structuredClone(source),id:'nov11',date:'2026-11-11',label:'11 de novembro de 2026'}]);
  const parts=ctx.meeting.replaceProgramme({weekLabel:'2-8 de novembro',title:'Reunião WOL',kind:'midweek',parts:source.mainParts});
  let active={...parts,source:'wol' as const,wolUrl:'https://wol.jw.org/pt/wol/meetings/r5/lp-t/2026/45'};
  vi.spyOn(ctx.meeting,'getState').mockImplementation(()=>structuredClone(active));
  const replace=vi.spyOn(ctx.meeting,'replaceProgramme');
  const main=ctx.programmes.state('main'),b=ctx.programmes.state('b');
  expect(main.details!.date).toBe('2026-11-04');expect(b.details!.date).toBe('2026-11-04');
  expect(main.period!.weekLabel).toBe('Semana de 2 a 8 de novembro de 2026');expect(b.period!.weekLabel).toBe(main.period!.weekLabel);
  expect(Object.keys(main.details!.assignments)).toHaveLength(source.mainParts.length);
  expect(replace).not.toHaveBeenCalled();expect(ctx.meeting.getState()).toEqual(active);
  ctx.programmes.roomB.start(b.meeting.parts[0]!.id);
  active={...active,weekLabel:'9-15 de novembro',wolUrl:'https://wol.jw.org/pt/wol/meetings/r5/lp-t/2026/46'};
  expect(ctx.programmes.state('b').period!.matchesMainWeek).toBe(false);
  expect(ctx.programmes.state('b').details!.date).toBe('2026-11-04');
  ctx.programmes.roomB.pause(b.meeting.parts[0]!.id);
  const next=ctx.programmes.state('b');expect(next.details!.date).toBe('2026-11-11');expect(next.period!.matchesMainWeek).toBe(true);
  expect(replace).not.toHaveBeenCalled();
});
it('keeps weekend names in PWA and Windows after switching meeting kind and regenerating IDs',()=> {
  const {ctx}=setup(),midweek=ctx.programmes.list().find(p=>p.roomBParts.length)!;
  ctx.programmes.store([{...midweek,id:'oct28',date:'2026-10-28',label:'28 de outubro de 2026'},
    ...parseProgrammePages([`Reunião do fim de semana
31 de outubro de 2026
Um tema específico do discurso
ORADOR TESTE — Congregação visitante
Dirigente de A Sentinela     DIRIGENTE TESTE
Leitor de A Sentinela     LEITOR TESTE`],'weekend.pdf')]);
  const initial=ctx.meeting.replaceProgramme({weekLabel:'26 de outubro–1.º de novembro',title:'WOL',kind:'weekend',parts:[
    {section:'Fim de Semana',title:'Discurso público',allottedSec:1800},{section:'Fim de Semana',title:'A Sentinela: Um tema diferente',allottedSec:3600}]});
  let current={...initial,source:'wol' as const,wolUrl:'https://wol.jw.org/pt/wol/meetings/r5/lp-t/2026/44'};
  vi.spyOn(ctx.meeting,'getState').mockImplementation(()=>structuredClone(current));
  const weekend=ctx.programmes.state('main');
  expect(weekend.meeting.kind).toBe('weekend');expect(weekend.details!.date).toBe('2026-10-31');
  expect(weekend.details!.assignments[current.parts[0]!.id]!.name).toBe('ORADOR TESTE');
  expect(weekend.details!.assignments[current.parts[1]!.id]).toEqual({name:'DIRIGENTE TESTE',secondName:'LEITOR TESTE'});
  expect(ctx.programmes.mainAssignments()).toEqual(weekend.details!.assignments);
  vi.mocked(ctx.meeting.getState).mockRestore();
  const weekday=ctx.meeting.replaceProgramme({weekLabel:initial.weekLabel,title:'WOL',kind:'midweek',parts:midweek.mainParts});
  current={...weekday,source:'wol',wolUrl:current.wolUrl};
  vi.spyOn(ctx.meeting,'getState').mockImplementation(()=>structuredClone(current));
  expect(ctx.programmes.state('main').details!.date).toBe('2026-10-28');
  expect(JSON.stringify(ctx.programmes.mainAssignments())).not.toContain('ORADOR TESTE');
  current={...initial,parts:initial.parts.map(p=>({...p,id:'new-'+p.id})),source:'wol',wolUrl:current.wolUrl};
  expect(ctx.programmes.state('main').details!.assignments[current.parts[0]!.id]!.name).toBe('ORADOR TESTE');
  expect(JSON.stringify(ctx.programmes.mainAssignments())).not.toContain('NOME B');
});
