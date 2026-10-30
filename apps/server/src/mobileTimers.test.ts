import { afterEach, expect, it, vi } from 'vitest';
import path from 'node:path';
import { MeetingScheduleSchema, SettingsSchema } from '@kmc/shared-types';
import { MobileTimers, buildRemoteGateway } from './mobileTimers.js';
import type { AppContext } from './context.js';
import type { FastifyInstance } from 'fastify';

const apps:FastifyInstance[]=[];
afterEach(async()=> {vi.restoreAllMocks();await Promise.all(apps.splice(0).map(app=>app.close()));});
async function setup() {
  const kv=new Map<string,string>();
  const meeting=MeetingScheduleSchema.parse({activePartId:'one',parts:[{id:'one',order:0,title:'Parte de teste',section:'INÍCIO',allottedSec:60}]});
  const start=vi.fn();
  const ctx={cfg:{publicDir:path.resolve('apps/dashboard/dist')},cloudflare:{gatewayPort:4320,publicOrigin:'https://timers.example.test',instanceId:'test-instance'},
    db:{getKv:(key:string)=>kv.get(key) ?? null,setKv:(key:string,value:string)=>kv.set(key,value)},
    getSettings:()=>SettingsSchema.parse({meeting:{passcode:'must-not-be-public'},tablet:{announcements:'private'}}),
    meeting:{getState:()=>meeting,start,pause:vi.fn(),pauseAndAdvance:vi.fn(),reset:vi.fn(),setActive:vi.fn()},
    bus:{subscribe:()=>()=>{}},
  } as unknown as AppContext;
  (ctx as {mobile:MobileTimers}).mobile=new MobileTimers(ctx);
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
  const {app,pair,headers,start,kv}=await setup();const {cookie}=await pair();
  const response=await app.inject({url:'/remote-api/state',headers:{...headers,cookie}});
  expect(response.statusCode).toBe(200);expect(Object.keys(response.json()).sort()).toEqual(['meeting','serverNow','warnSeconds']);
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
  const {app,pair,headers,start}=await setup();const {cookie}=await pair();
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
