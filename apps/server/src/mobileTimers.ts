import fs from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import type { WebSocket } from '@fastify/websocket';
import type { RemoteTimerState, TimerRoom } from '@kmc/shared-types';
import type { AppContext } from './context.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
interface Device { id:string; label:string; createdAt:string; digest: string; expires: number; }
export class MobileTimers {
  private devices: Device[] = [];
  private attempts = new Map<string,{ count: number; expires: number }>();
  constructor(private readonly ctx: AppContext) {
    try { const value=JSON.parse(ctx.db.getKv('remote.devices') || '[]');
      if(Array.isArray(value))this.devices=value.filter(d=>typeof d.digest==='string' && /^[a-f0-9]{64}$/.test(d.digest) && d.expires>Date.now()).slice(0,64)
        .map(d=>({...d,id:typeof d.id==='string'?d.id:randomBytes(12).toString('hex'),label:typeof d.label==='string'?d.label:'Celular já conectado',createdAt:typeof d.createdAt==='string'?d.createdAt:new Date(d.expires-180*24*3600_000).toISOString()}));
    } catch {}
    this.save();
  }
  private save() {this.ctx.db.setKv('remote.devices',JSON.stringify(this.devices));}
  status() {const active=this.devices.filter(d=>d.expires>Date.now());return {devices:active.length,
    deviceList:active.map(({id,label,createdAt})=>({id,label,createdAt}))};}
  revoke(id?:string) {this.devices=id?this.devices.filter(d=>d.id!==id):[];this.save();}
  authorize(req: FastifyRequest): boolean {
    const token=String(req.headers.cookie || '').match(/(?:^|;\s*)kmc_remote=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
    return !!token && this.devices.some(d=>d.expires>Date.now() && d.digest===hash(token));
  }
  pair(label: unknown, address: string): string {
    const name=typeof label==='string'?label.trim():'';
    if(!name || name.length>80)throw Object.assign(new Error('Informe um nome para identificar quem está utilizando (até 80 caracteres).'),{statusCode:400});
    const now=Date.now();for(const [key,value] of this.attempts)if(value.expires<now)this.attempts.delete(key);
    const attempt=this.attempts.get(address) || {count:0,expires:now+10*60_000};
    if(attempt.count>=16 || this.attempts.size>1024)throw Object.assign(new Error('Muitas conexões. Aguarde dez minutos.'),{statusCode:429});
    attempt.count++;this.attempts.set(address,attempt);
    this.devices=this.devices.filter(d=>d.expires>now);
    if(this.devices.length>=64)throw Object.assign(new Error('Limite de dispositivos. Revogue os pareamentos no painel.'),{statusCode:409});
    const token=randomBytes(32).toString('base64url');this.devices.push({id:randomBytes(12).toString('hex'),label:name,createdAt:new Date(now).toISOString(),digest:hash(token),expires:now+180*24*3600_000});
    this.save();return token;
  }
  state(room:TimerRoom='main'): RemoteTimerState {if(this.ctx.programmes)return this.ctx.programmes.state(room);return {meeting:this.ctx.meeting.getState(),warnSeconds:this.ctx.getSettings().meetingSchedule.warnSeconds,serverNow:new Date().toISOString()};}
}

function sameOrigin(req: FastifyRequest): boolean {
  const origin=req.headers.origin;
  if(!origin)return false;
  try {const value=new URL(origin);return ['https:','http:'].includes(value.protocol) && value.host===req.headers.host;} catch{return false;}
}
export function registerTimerRemote(app: FastifyInstance, ctx: AppContext, gateway = false): void {
  const service=ctx.mobile;
  const auth=async(req:FastifyRequest,reply:FastifyReply)=> {
    reply.header('Cache-Control','no-store');
    if(!service.authorize(req))return reply.code(401).send({error:'pairing_required'});
  };
  const commandAuth=async(req:FastifyRequest,reply:FastifyReply)=> {
    if(!sameOrigin(req))return reply.code(403).send({error:'invalid_origin'});
    return auth(req,reply);
  };
  app.post('/remote-api/pair',{bodyLimit:1024},async(req,reply)=> {
    reply.header('Cache-Control','no-store');
    if(!sameOrigin(req))return reply.code(403).send({error:'invalid_origin'});
    if(service.authorize(req))return {ok:true};
    const address=gateway?String(req.headers['cf-connecting-ip'] || req.ip).slice(0,80):req.ip;
    try {
      const token=service.pair((req.body as {name?:unknown}|null)?.name,address);
      const secure=gateway && !!ctx.cloudflare.publicOrigin && req.headers.host===new URL(ctx.cloudflare.publicOrigin).host;
      reply.header('Set-Cookie',`kmc_remote=${token}; HttpOnly; SameSite=Strict; Path=/remote-api; Max-Age=15552000${secure?'; Secure':''}`);
      return {ok:true};
    } catch(error) {return reply.code((error as {statusCode?:number}).statusCode || 400).send({error:error instanceof Error?error.message:'Pareamento falhou'});}
  });
  const roomOf=(req:FastifyRequest):TimerRoom=> {
    const value=(req.query as {room?:unknown}).room ?? 'main';
    if(value!=='main' && value!=='b')throw Object.assign(new Error('Sala inválida.'),{statusCode:400});
    return value;
  };
  const meetingOf=(room:TimerRoom)=>ctx.programmes?ctx.programmes.service(room):ctx.meeting;
  app.get('/remote-api/state',{preHandler:auth},async(req)=>service.state(roomOf(req)));
  app.post('/remote-api/active',{preHandler:commandAuth,bodyLimit:1024},async(req,reply)=> {
    const room=roomOf(req),meeting=meetingOf(room),id=(req.body as {partId?:unknown})?.partId;
    if(typeof id!=='string' || !meeting.getState().parts.some(p=>p.id===id))return reply.code(400).send({error:'invalid_part'});
    meeting.setActive(id);return service.state(room);
  });
  app.post('/remote-api/part/:id/:action',{preHandler:commandAuth,bodyLimit:1024},async(req,reply)=> {
    const room=roomOf(req),meeting=meetingOf(room),{id,action}=req.params as {id:string;action:string};
    if(!meeting.getState().parts.some(p=>p.id===id))return reply.code(400).send({error:'invalid_part'});
    if(action==='start')meeting.start(id);
    else if(action==='pause')meeting.pause(id);
    else if(action==='pause-next')meeting.pauseAndAdvance(id);
    else if(action==='reset')meeting.reset(id);
    else return reply.code(404).send({error:'not_found'});
    return service.state(room);
  });
  app.get('/remote-api/programmes',{preHandler:auth},async()=>ctx.programmes?.list() ?? []);
  app.post('/remote-api/programmes/import',{onRequest:commandAuth,bodyLimit:11_000_000},async(req)=> {
    const body=req.body as {filename?:unknown;data?:unknown};const imported=await ctx.programmes.importPdf(body?.filename,body?.data);
    ctx.programmes.activateAutomatic(roomOf(req));return imported;
  });
  app.post('/remote-api/programmes/load',{preHandler:commandAuth,bodyLimit:100_000},async(req)=> {
    const body=req.body as {programmeId?:unknown;includeNames?:unknown;edits?:unknown};
    return ctx.programmes.load({...body,room:roomOf(req)});
  });
  app.post('/remote-api/room-b/prepare',{preHandler:commandAuth},async()=>ctx.programmes.prepareB());
  app.post('/remote-api/details',{preHandler:commandAuth,bodyLimit:64_000},async(req)=>ctx.programmes.saveDetails(roomOf(req),req.body));
  app.post('/remote-api/room-b/finish',{preHandler:commandAuth},async()=> {
    const meeting=ctx.programmes.service('b');for(const part of meeting.getState().parts)if(part.running)meeting.pause(part.id);
    return service.state('b');
  });
  const clients=new Map<WebSocket,{req:FastifyRequest;room:TimerRoom}>();
  const send=(socket:WebSocket,client:{req:FastifyRequest;room:TimerRoom})=> {
    if(!service.authorize(client.req)) {socket.close(4401,'pairing_required');return;}
    if(socket.readyState===socket.OPEN)socket.send(JSON.stringify(service.state(client.room)));
  };
  app.get('/remote-api/ws',{websocket:true},(socket,req)=> {
    if(!sameOrigin(req) || !service.authorize(req)) {socket.close(4401,'pairing_required');return;}
    let room:TimerRoom;try{room=roomOf(req);}catch{socket.close(4400,'invalid_room');return;}
    const client={req,room};clients.set(socket,client);send(socket,client);socket.on('close',()=>clients.delete(socket));socket.on('error',()=>clients.delete(socket));
  });
  const push=(room:TimerRoom)=>{if(ctx.programmes?.isUpdating(room))return;for(const [socket,client] of clients)if(client.room===room)send(socket,client);};
  const off=ctx.bus.subscribe(event=> {if(event.type.startsWith('meeting.'))push('main');});
  const offPrivate=ctx.programmes?.subscribe(push);
  const heartbeat=setInterval(()=> {for(const [socket,client] of clients)send(socket,client);},1000);heartbeat.unref();
  app.addHook('onClose',async()=> {clearInterval(heartbeat);off();offPrivate?.();for(const socket of clients.keys())socket.close(1001,'shutdown');});
}

export async function buildRemoteGateway(ctx: AppContext): Promise<FastifyInstance> {
  const app=Fastify({logger:false,bodyLimit:4096});
  app.addHook('onRequest',async(req,reply)=> {
    reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');
    reply.header('X-KMC-Instance',ctx.cloudflare.instanceId);
    const allowed=new Set([`127.0.0.1:${ctx.cloudflare.gatewayPort}`,`localhost:${ctx.cloudflare.gatewayPort}`]);
    if(ctx.cloudflare.publicOrigin)allowed.add(new URL(ctx.cloudflare.publicOrigin).host);
    if(!allowed.has(req.headers.host || ''))return reply.code(403).send({error:'invalid_host'});
    let pathname='';try {pathname=new URL(decodeURI(req.url),'http://localhost').pathname;}catch{return reply.code(400).send({error:'invalid_path'});}
    const readable=pathname==='/' || pathname==='/remote.html' || pathname==='/remote.webmanifest' || pathname==='/remote-sw.js' || /^\/remote-icons\/icon-(192|512)\.png$/.test(pathname) || /^\/assets\/[A-Za-z0-9_.-]+\.(js|css|woff2?)$/.test(pathname);
    if(!pathname.startsWith('/remote-api/') && !(req.method==='GET' && readable))return reply.code(404).send({error:'not_found'});
  });
  await app.register(websocket);
  registerTimerRemote(app,ctx,true);
  app.get('/',async(_req,reply)=>reply.redirect('/remote.html'));
  fs.mkdirSync(ctx.cfg.publicDir,{recursive:true});
  await app.register(staticFiles,{root:ctx.cfg.publicDir,prefix:'/'});
  app.setErrorHandler((error,_req,reply)=>reply.code((error as {statusCode?:number}).statusCode || 500).send({error:'remote_request_failed'}));
  return app;
}
