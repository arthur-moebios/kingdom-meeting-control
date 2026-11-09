import { afterEach, expect, it, vi } from 'vitest';
import path from 'node:path';
import { MeetingScheduleSchema, SettingsSchema } from '@kmc/shared-types';
import { MobileTimers, buildRemoteGateway } from './mobileTimers.js';
import { registerRoutes } from './routes.js';
import Fastify from 'fastify';
import type { AppContext } from './context.js';
import type { FastifyInstance } from 'fastify';

const apps:FastifyInstance[]=[];
afterEach(async()=> {vi.restoreAllMocks();await Promise.all(apps.splice(0).map(app=>app.close()));});
// Quarta-feira (meio de semana) e sábado, fictícios mas com o dia da semana real.
const WEDNESDAY=new Date('2026-11-04T20:00:00'),SATURDAY=new Date('2026-11-07T10:00:00');
const HAND={id:'p1',displayName:'Participante Fictício Um',handRaised:true,handRaisedAt:'2026-11-04T19:58:00.000Z',isHost:false,isCoHost:false,isMuted:true};
async function setup(options:{now?:Date;kind?:'weekend'|'midweek'|null}={}) {
  const kv=new Map<string,string>();
  const meeting=MeetingScheduleSchema.parse({kind:options.kind??null,activePartId:'one',parts:[{id:'one',order:0,title:'Parte de teste',section:'INÍCIO',allottedSec:60}]});
  const start=vi.fn();
  const ctx={cfg:{publicDir:path.resolve('apps/dashboard/dist')},cloudflare:{gatewayPort:4320,publicOrigin:'https://timers.example.test',instanceId:'test-instance'},
    db:{getKv:(key:string)=>kv.get(key) ?? null,setKv:(key:string,value:string)=>kv.set(key,value)},
    getSettings:()=>SettingsSchema.parse({meeting:{passcode:'must-not-be-public'},tablet:{announcements:'private'}}),
    meeting:{getState:()=>meeting,start,pause:vi.fn(),pauseAndAdvance:vi.fn(),reset:vi.fn(),setActive:vi.fn()},
    bus:{subscribe:()=>()=>{}},
    zoom:{getRaisedHands:()=>({order:[HAND],orderSource:'detection-time',partial:true})},
    obs:{getStatus:()=>({enabled:false,connected:false,currentScene:null,scenes:[],virtualCam:null,lastError:null,updatedAt:'2026-11-04T00:00:00.000Z'}),setScene:vi.fn(),setVirtualCam:vi.fn()},
    recordedAttendance:()=>({date:'2026-11-04',zoom:3,presencial:40,total:43}),
  } as unknown as AppContext;
  (ctx as {mobile:MobileTimers}).mobile=new MobileTimers(ctx,()=>options.now??WEDNESDAY);
  const app=await buildRemoteGateway(ctx);apps.push(app);await app.ready();
  const headers={host:'timers.example.test',origin:'https://timers.example.test'};
  async function pair() {
    const response=await app.inject({method:'POST',url:'/remote-api/pair',headers,payload:{name:"Celular teste"}});
    expect(response.statusCode).toBe(200);
    const raw=String(response.headers['set-cookie']);expect(raw).toContain('HttpOnly');expect(raw).toContain('Secure');
    return {cookie:raw.split(';')[0]!};
  }
  return {app,ctx,headers,pair,kv,start};
}
it('public gateway never exposes operator pages, snapshots, settings or Zoom controls',async()=> {
  const {app,headers}=await setup();
  for(const url of ['/index.html','/tablet.html','/ws','/api/v1/settings','/api/v1/remote/status','/assets/%2e%2e%2findex.html'])
    expect((await app.inject({url,headers})).statusCode).toBe(404);
  expect((await app.inject({method:'POST',url:'/api/v1/zoom/leave',headers,payload:{}})).statusCode).toBe(404);
  expect((await app.inject({url:'/remote-api/state',headers})).statusCode).toBe(401);
});
it('paired clients receive only timers and may issue only allowed timer commands',async()=> {
  const {app,pair,headers,start,kv,ctx}=await setup();const {cookie}=await pair();
  const response=await app.inject({url:'/remote-api/state',headers:{...headers,cookie}});
  expect(response.statusCode).toBe(200);expect(Object.keys(response.json()).sort()).toEqual(['access','canWrite','meeting','obs','roomBAvailable','serverNow','warnSeconds']);
  expect(response.json()).toMatchObject({access:'readonly',canWrite:false});
  ctx.mobile.setAccess(ctx.mobile.status().deviceList[0]!.id,'both');
  expect(response.body).not.toContain('must-not-be-public');expect(response.body).not.toContain('private');
  expect([...kv.values()].join('')).not.toContain(cookie.split('=')[1]);
  expect((await app.inject({method:'POST',url:'/remote-api/part/one/start',headers:{...headers,cookie},payload:{}})).statusCode).toBe(200);
  expect(start).toHaveBeenCalledWith('one');
  expect((await app.inject({method:'POST',url:'/remote-api/part/one/delete',headers:{...headers,cookie},payload:{}})).statusCode).toBe(404);
});
it('devices connect without codes; individual revocation preserves other devices',async()=> {
  const {app,pair,headers,ctx}=await setup();const first=await pair(),second=await pair();
  const list=ctx.mobile.status().deviceList;expect(list).toHaveLength(2);expect(list[0]!.label).toBe('Celular teste');
  expect(JSON.stringify(list)).not.toContain('digest');expect(JSON.stringify(list)).not.toContain(first.cookie.split('=')[1]);
  const again=await app.inject({method:'POST',url:'/remote-api/pair',headers:{...headers,cookie:first.cookie},payload:{}});
  expect(again.statusCode).toBe(200);expect(ctx.mobile.status().devices).toBe(2);
  ctx.mobile.revoke(list[0]!.id);
  expect((await app.inject({url:'/remote-api/state',headers:{...headers,cookie:first.cookie}})).statusCode).toBe(401);
  expect((await app.inject({url:'/remote-api/state',headers:{...headers,cookie:second.cookie}})).statusCode).toBe(200);
  ctx.mobile.revoke();expect((await app.inject({url:'/remote-api/state',headers:{...headers,cookie:second.cookie}})).statusCode).toBe(401);
});
it('timer actions and pairing reject a foreign origin or host',async()=> {
  const {app,pair,headers,start,ctx}=await setup();const {cookie}=await pair();ctx.mobile.setAccess(ctx.mobile.status().deviceList[0]!.id,'both');
  expect((await app.inject({method:'POST',url:'/remote-api/part/one/start',headers:{...headers,cookie,origin:'https://evil.example'},payload:{}})).statusCode).toBe(403);
  expect((await app.inject({url:'/remote-api/state',headers:{...headers,cookie,host:'other.example'}})).statusCode).toBe(403);
  expect(start).not.toHaveBeenCalled();
  expect((await app.inject({method:'POST',url:'/remote-api/pair',headers:{...headers,origin:'https://evil.example'},payload:{}})).statusCode).toBe(403);
});
it('upgrades existing device records without invalidating their sessions',async()=> {
  const {ctx,kv,pair}=await setup(),{cookie}=await pair();
  const old=JSON.parse(kv.get('remote.devices')!);kv.set('remote.devices',JSON.stringify(old.map(({digest,expires}:{digest:string;expires:number})=>({digest,expires}))));
  const restored=new MobileTimers(ctx);
  expect(restored.authorize({headers:{cookie}} as Parameters<MobileTimers['authorize']>[0])).toBe(true);
  expect(restored.status().deviceList[0]!.label).toBe('Celular já conectado');
  const again=new MobileTimers(ctx);expect(again.status().deviceList[0]!.id).toBe(restored.status().deviceList[0]!.id);
});
it('connection creation is rate limited and sessions expire',async()=> {
  const {ctx,app,headers,pair}=await setup();const {cookie}=await pair();
  for(let i=0;i<15;i++)expect((await app.inject({method:'POST',url:'/remote-api/pair',headers,payload:{name:'Teste'}})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:'/remote-api/pair',headers,payload:{name:'Teste'}})).statusCode).toBe(429);
  vi.spyOn(Date,'now').mockReturnValue(Date.now()+181*24*3600_000);
  expect((await app.inject({url:'/remote-api/state',headers:{...headers,cookie}})).statusCode).toBe(401);
});

it('requires a real identification and rejects absent, whitespace or oversized names',async()=> {
  const {app,headers,ctx}=await setup();
  for(const name of [undefined,null,42,'','   ','x'.repeat(81)]) {
    const response=await app.inject({method:'POST',url:'/remote-api/pair',headers,payload:{name}});
    expect(response.statusCode).toBe(400);expect(response.headers['set-cookie']).toBeUndefined();
  }
  expect(ctx.mobile.status().devices).toBe(0);
  const response=await app.inject({method:'POST',url:'/remote-api/pair',headers,payload:{name:'  João — Sala B  '}});
  expect(response.statusCode).toBe(200);expect(ctx.mobile.status().deviceList[0]!.label).toBe('João — Sala B');
});

it('new devices are read-only; access scopes writes per room and setAccess changes it',async()=> {
  const {app,pair,headers,ctx,start}=await setup();const {cookie}=await pair(),id=ctx.mobile.status().deviceList[0]!.id;
  const h={...headers,cookie},post=(url:string)=>app.inject({method:'POST',url,headers:h,payload:{}});
  expect(ctx.mobile.status().deviceList[0]!.access).toBe('readonly');
  expect((await app.inject({url:'/remote-api/state',headers:h})).statusCode).toBe(200);
  for(const url of ['/remote-api/part/one/start','/remote-api/part/one/reset?room=b','/remote-api/active','/remote-api/details','/remote-api/room-b/prepare']) {
    const response=await post(url);expect(response.statusCode).toBe(403);expect(response.json()).toEqual({error:'read_only'});
  }
  expect(start).not.toHaveBeenCalled();
  expect(ctx.mobile.setAccess(id,'main')).toBe(true);
  expect((await post('/remote-api/part/one/start')).statusCode).toBe(200);expect(start).toHaveBeenCalledTimes(1);
  expect((await post('/remote-api/part/one/start?room=b')).statusCode).toBe(403);
  expect((await post('/remote-api/room-b/finish')).statusCode).toBe(403);
  expect((await app.inject({url:'/remote-api/state?room=b',headers:h})).json()).toMatchObject({access:'main',canWrite:false});
  ctx.mobile.setAccess(id,'both');
  expect((await post('/remote-api/part/one/start')).statusCode).toBe(200);
  expect(ctx.mobile.setAccess('nope','b')).toBe(false);
});
it('access b writes only room B (ctx has no room-B service, so 403 on main is enough)',async()=> {
  const {app,pair,headers,ctx}=await setup();const {cookie}=await pair();ctx.mobile.setAccess(ctx.mobile.status().deviceList[0]!.id,'b');
  expect((await app.inject({method:'POST',url:'/remote-api/part/one/start',headers:{...headers,cookie},payload:{}})).statusCode).toBe(403);
});
it('migrates device records without access to both',async()=> {
  const {ctx,kv,pair}=await setup();await pair();
  kv.set('remote.devices',JSON.stringify(JSON.parse(kv.get('remote.devices')!).map(({access,...d}:{access:string})=>d)));
  expect(new MobileTimers(ctx).status().deviceList[0]!.access).toBe('both');
  kv.set('remote.devices',JSON.stringify(JSON.parse(kv.get('remote.devices')!).map((d:object)=>({...d,access:'main'}))));
  expect(new MobileTimers(ctx).status().deviceList[0]!.access).toBe('main');
});

// ---- Papel `painel` (mãos levantadas, anúncios, nomes) e Sala B no fim de semana ----
const SENSITIVE=['Participante Fictício Um','p1','"painel"','announcements','raisedHands'];
async function wsMessage(app:FastifyInstance,headers:Record<string,string>,query=''):Promise<string> {
  const socket=await app.injectWS('/remote-api/ws'+query,{headers});
  const text=await new Promise<string>(resolve=>socket.once('message',(data:unknown)=>resolve(String(data))));
  socket.terminate();return text;
}
it('new devices are born without painel; legacy records migrate as false; only setPainel grants it',async()=> {
  const {ctx,kv,pair}=await setup();await pair();const id=ctx.mobile.status().deviceList[0]!.id;
  expect(ctx.mobile.status().deviceList[0]!.painel).toBe(false);
  kv.set('remote.devices',JSON.stringify(JSON.parse(kv.get('remote.devices')!).map(({painel,...d}:{painel:boolean})=>d)));
  expect(new MobileTimers(ctx).status().deviceList[0]!.painel).toBe(false);
  kv.set('remote.devices',JSON.stringify(JSON.parse(kv.get('remote.devices')!).map((d:object)=>({...d,painel:'true'}))));
  expect(new MobileTimers(ctx).status().deviceList[0]!.painel).toBe(false);
  expect(ctx.mobile.setPainel(id,true)).toBe(true);expect(ctx.mobile.status().deviceList[0]!.painel).toBe(true);
  expect(new MobileTimers(ctx).status().deviceList[0]!.painel).toBe(true);
  expect(ctx.mobile.setPainel('nope',true)).toBe(false);
  ctx.mobile.setAccess(id,'both');expect(ctx.mobile.status().deviceList[0]!.painel).toBe(true);
});
it('a device without painel never receives hands, announcements or participant names (HTTP and WebSocket payloads)',async()=> {
  const {app,pair,headers}=await setup();const {cookie}=await pair(),h={...headers,cookie};
  const http=await app.inject({url:'/remote-api/state',headers:h});
  const ws=await wsMessage(app,h);
  for(const body of [http.body,ws]) {
    for(const word of SENSITIVE)expect(body).not.toContain(word);
    expect(body).not.toContain('private');
    expect(JSON.parse(body)).toMatchObject({roomBAvailable:true});expect(JSON.parse(body).painel).toBeUndefined();
  }
});
it('a device with painel receives hands, announcements and today attendance, and loses them when revoked',async()=> {
  const {app,pair,headers,ctx}=await setup();const {cookie}=await pair(),h={...headers,cookie},id=ctx.mobile.status().deviceList[0]!.id;
  ctx.mobile.setPainel(id,true);
  for(const body of [(await app.inject({url:'/remote-api/state',headers:h})).body,await wsMessage(app,h)]) {
    const painel=JSON.parse(body).painel;
    expect(painel.raisedHands).toEqual({order:[{id:'p1',displayName:'Participante Fictício Um',handRaisedAt:HAND.handRaisedAt}],orderSource:'detection-time',partial:true});
    expect(painel.announcements).toBe('private');expect(painel.attendance).toMatchObject({total:43});
    expect(JSON.stringify(painel)).not.toContain('isMuted');
  }
  ctx.mobile.setPainel(id,false);
  expect((await app.inject({url:'/remote-api/state',headers:h})).body).not.toContain('Participante Fictício Um');
});
it('the painel flag is per connection: another paired device keeps getting the filtered payload',async()=> {
  const {app,pair,headers,ctx}=await setup();const first=await pair(),second=await pair();
  ctx.mobile.setPainel(ctx.mobile.status().deviceList[0]!.id,true);
  expect((await app.inject({url:'/remote-api/state',headers:{...headers,cookie:first.cookie}})).body).toContain('Participante Fictício Um');
  expect((await app.inject({url:'/remote-api/state',headers:{...headers,cookie:second.cookie}})).body).not.toContain('Participante Fictício Um');
});
it('POST /api/v1/remote/devices/:id/painel requires admin and a same-origin request',async()=> {
  const {ctx,pair}=await setup();await pair();const id=ctx.mobile.status().deviceList[0]!.id;
  (ctx as unknown as {cfg:object}).cfg={authEnabled:true,adminToken:'admin-test',viewerToken:'viewer-test',publicDir:path.resolve('apps/dashboard/dist')};
  const app=Fastify({logger:false});apps.push(app);registerRoutes(app,ctx);await app.ready();
  const url=`/api/v1/remote/devices/${id}/painel`,origin={host:'op.example.test',origin:'http://op.example.test'};
  const post=async(headers:Record<string,string>,payload:object={painel:true})=>await app.inject({method:'POST',url,headers,payload});
  expect((await post(origin)).statusCode).toBe(401);
  expect((await post({...origin,authorization:'Bearer viewer-test'})).statusCode).toBe(403);
  expect((await post({...origin,authorization:'Bearer admin-test',origin:'http://evil.example'})).statusCode).toBe(403);
  expect((await post({host:origin.host,authorization:'Bearer admin-test'})).statusCode).toBe(403);
  expect(ctx.mobile.status().deviceList[0]!.painel).toBe(false);
  const admin={...origin,authorization:'Bearer admin-test'};
  expect((await post(admin,{painel:'yes'})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:'/api/v1/remote/devices/nope/painel',headers:admin,payload:{painel:true}})).statusCode).toBe(404);
  const ok=await post(admin);expect(ok.statusCode).toBe(200);expect(ok.json().deviceList[0].painel).toBe(true);
  expect((await post(admin,{painel:false})).json().deviceList[0].painel).toBe(false);
});
it('weekend: Room B is not offered, its state has no parts and writes are refused (kind weekend)',async()=> {
  const {app,pair,headers,ctx,start}=await setup({now:SATURDAY,kind:'weekend'});const {cookie}=await pair(),h={...headers,cookie};
  ctx.mobile.setAccess(ctx.mobile.status().deviceList[0]!.id,'both');
  expect(ctx.mobile.roomBAvailable()).toBe(false);
  const main=(await app.inject({url:'/remote-api/state',headers:h})).json();
  expect(main).toMatchObject({roomBAvailable:false,canWrite:true});expect(main.meeting.parts).toHaveLength(1);
  const b=(await app.inject({url:'/remote-api/state?room=b',headers:h})).json();
  expect(b).toMatchObject({room:'b',roomBAvailable:false,canWrite:false});expect(b.meeting.parts).toEqual([]);expect(b.meeting.activePartId).toBeNull();
  const refused=await app.inject({method:'POST',url:'/remote-api/part/one/start?room=b',headers:h,payload:{}});
  expect(refused.statusCode).toBe(403);expect(refused.json()).toEqual({error:'room_b_weekend'});
  expect((await app.inject({method:'POST',url:'/remote-api/room-b/prepare',headers:h,payload:{}})).statusCode).toBe(403);
  expect(JSON.parse(await wsMessage(app,h,'?room=b'))).toMatchObject({roomBAvailable:false,meeting:{parts:[]}});
  expect((await app.inject({method:'POST',url:'/remote-api/part/one/start',headers:h,payload:{}})).statusCode).toBe(200);expect(start).toHaveBeenCalledTimes(1);
});
it('weekend: a device with access only B gets the state that explains Room B is unavailable',async()=> {
  const {app,pair,headers,ctx}=await setup({now:SATURDAY,kind:'weekend'});const {cookie}=await pair(),h={...headers,cookie};
  ctx.mobile.setAccess(ctx.mobile.status().deviceList[0]!.id,'b');
  for(const url of ['/remote-api/state','/remote-api/state?room=b'])
    expect((await app.inject({url,headers:h})).json()).toMatchObject({access:'b',roomBAvailable:false,canWrite:false});
});
it('Room B rule: kind midweek on a weekday offers it; without a loaded meeting or on conflict the weekday decides',async()=> {
  const check=async(now:Date,kind:'weekend'|'midweek'|null)=>(await setup({now,kind})).ctx.mobile.roomBAvailable();
  expect(await check(WEDNESDAY,'midweek')).toBe(true);
  expect(await check(SATURDAY,'weekend')).toBe(false);
  expect(await check(WEDNESDAY,null)).toBe(true);
  expect(await check(SATURDAY,null)).toBe(false);
  expect(await check(SATURDAY,'midweek')).toBe(false);
  expect(await check(WEDNESDAY,'weekend')).toBe(true);
});
it('old clients keep reading RemoteTimerState: every previous field is still present and typed the same',async()=> {
  const {app,pair,headers,ctx}=await setup();const {cookie}=await pair(),h={...headers,cookie};
  const before=(await app.inject({url:'/remote-api/state',headers:h})).json();
  ctx.mobile.setPainel(ctx.mobile.status().deviceList[0]!.id,true);
  const after=(await app.inject({url:'/remote-api/state',headers:h})).json();
  for(const state of [before,after]) {
    expect(typeof state.meeting.activePartId).toBe('string');expect(Array.isArray(state.meeting.parts)).toBe(true);
    expect(typeof state.warnSeconds).toBe('number');expect(typeof state.serverNow).toBe('string');
    expect(state.access).toBe('readonly');expect(state.canWrite).toBe(false);
  }
  expect({...after,painel:undefined,serverNow:0}).toEqual({...before,painel:undefined,serverNow:0});
});
