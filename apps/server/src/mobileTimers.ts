import fs from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import type { WebSocket } from '@fastify/websocket';
import type { DeviceAccess, RemotePainel, RemoteTimerState, TimerRoom } from '@kmc/shared-types';
import type { AppContext } from './context.js';
import { isWeekendMeeting } from './attendance.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ACCESS: readonly DeviceAccess[] = ['readonly','main','b','both'];
export const isDeviceAccess = (value: unknown): value is DeviceAccess => ACCESS.includes(value as DeviceAccess);
interface Device { id:string; label:string; createdAt:string; digest: string; expires: number; access: DeviceAccess; painel: boolean; }
export class MobileTimers {
  private devices: Device[] = [];
  private attempts = new Map<string,{ count: number; expires: number }>();
  constructor(private readonly ctx: AppContext, private readonly clock: () => Date = () => new Date()) {
    try { const value=JSON.parse(ctx.db.getKv('remote.devices') || '[]');
      if(Array.isArray(value))this.devices=value.filter(d=>typeof d.digest==='string' && /^[a-f0-9]{64}$/.test(d.digest) && d.expires>Date.now()).slice(0,64)
        .map(d=>({...d,id:typeof d.id==='string'?d.id:randomBytes(12).toString('hex'),label:typeof d.label==='string'?d.label:'Celular já conectado',createdAt:typeof d.createdAt==='string'?d.createdAt:new Date(d.expires-180*24*3600_000).toISOString(),
          // Migração: aparelhos já pareados sem papel mantêm escrita total; o operador restringe depois.
          access:isDeviceAccess(d.access)?d.access:'both',
          // Nenhum aparelho antigo ganha o painel: só o operador concede.
          painel:d.painel===true}));
    } catch {}
    this.save();
  }
  private save() {this.ctx.db.setKv('remote.devices',JSON.stringify(this.devices));}
  status() {const active=this.devices.filter(d=>d.expires>Date.now());return {devices:active.length,
    deviceList:active.map(({id,label,createdAt,access,painel})=>({id,label,createdAt,access,painel}))};}
  setAccess(id:string,access:DeviceAccess) {const device=this.devices.find(d=>d.id===id);if(!device)return false;device.access=access;this.save();return true;}
  setPainel(id:string,painel:boolean) {const device=this.devices.find(d=>d.id===id);if(!device)return false;device.painel=painel;this.save();return true;}
  revoke(id?:string) {this.devices=id?this.devices.filter(d=>d.id!==id):[];this.save();}
  private deviceOf(req: Pick<FastifyRequest,'headers'>): Device|undefined {
    const token=String(req.headers.cookie || '').match(/(?:^|;\s*)kmc_remote=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
    return token?this.devices.find(d=>d.expires>Date.now() && d.digest===hash(token)):undefined;
  }
  authorize(req: FastifyRequest): boolean {return !!this.deviceOf(req);}
  /** Papel `painel`: também libera o envio de mídias para a playlist do JW Library. */
  hasPainel(req: Pick<FastifyRequest,'headers'>): boolean {return this.deviceOf(req)?.painel===true;}
  /** Lista para quem tem o papel Painel administrar os outros aparelhos pelo celular. */
  devicesFor(req: Pick<FastifyRequest,'headers'>) {const own=this.deviceOf(req)?.id;return this.status().deviceList.map(d=>({...d,self:d.id===own}));}
  accessFor(req: Pick<FastifyRequest,'headers'>): DeviceAccess {return this.deviceOf(req)?.access ?? 'readonly';}
  /** Fim de semana não tem Sala B (regra em attendance.isWeekendMeeting). */
  roomBAvailable(): boolean {return !isWeekendMeeting(this.ctx.meeting.getState(),this.clock());}
  canWrite(req: Pick<FastifyRequest,'headers'>, room: TimerRoom): boolean {if(room==='b' && !this.roomBAvailable())return false;const access=this.accessFor(req);return access==='both' || access===room;}
  pair(label: unknown, address: string): string {
    const name=typeof label==='string'?label.trim():'';
    if(!name || name.length>80)throw Object.assign(new Error('Informe um nome para identificar quem está utilizando (até 80 caracteres).'),{statusCode:400});
    const now=Date.now();for(const [key,value] of this.attempts)if(value.expires<now)this.attempts.delete(key);
    const attempt=this.attempts.get(address) || {count:0,expires:now+10*60_000};
    if(attempt.count>=16 || this.attempts.size>1024)throw Object.assign(new Error('Muitas conexões. Aguarde dez minutos.'),{statusCode:429});
    attempt.count++;this.attempts.set(address,attempt);
    this.devices=this.devices.filter(d=>d.expires>now);
    if(this.devices.length>=64)throw Object.assign(new Error('Limite de dispositivos. Revogue os pareamentos no painel.'),{statusCode:409});
    const token=randomBytes(32).toString('base64url');this.devices.push({id:randomBytes(12).toString('hex'),label:name,createdAt:new Date(now).toISOString(),digest:hash(token),expires:now+180*24*3600_000,access:'readonly',painel:false});
    this.save();return token;
  }
  /** Dados do painel (nomes, anúncios, assistência). Só chamado para aparelhos com `painel: true`. */
  private painelData(): RemotePainel {
    const hands=this.ctx.zoom.getRaisedHands();
    return {raisedHands:{order:hands.order.map(({id,displayName,handRaisedAt})=>({id,displayName,handRaisedAt})),orderSource:hands.orderSource,partial:hands.partial},
      announcements:this.ctx.getSettings().tablet.announcements,attendance:this.ctx.recordedAttendance()};
  }
  state(room:TimerRoom='main', req?: Pick<FastifyRequest,'headers'>): RemoteTimerState {
    const roomB=this.roomBAvailable(),noRoomB=room==='b' && !roomB;
    // Fim de semana: nenhuma parte da Sala B sai do servidor (o cliente mostra o aviso).
    const source:RemoteTimerState=this.ctx.programmes?this.ctx.programmes.state(noRoomB?'main':room):{meeting:this.ctx.meeting.getState(),warnSeconds:this.ctx.getSettings().meetingSchedule.warnSeconds,serverNow:new Date().toISOString()};
    const base:RemoteTimerState=noRoomB?{...source,room:'b',meeting:{...source.meeting,parts:[],activePartId:null},details:undefined,period:undefined}:source;
    if(!req)return base;
    const out:RemoteTimerState={...base,access:this.accessFor(req),canWrite:this.canWrite(req,room),roomBAvailable:roomB};
    // Filtragem por conexão: sem o papel `painel`, nomes/anúncios/assistência nem entram no payload.
    return this.deviceOf(req)?.painel?{...out,painel:this.painelData()}:out;
  }
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
    const denied=await auth(req,reply);if(denied)return denied;
    // Escrita exige papel na sala do comando (room-b/* é sempre a Sala B); leitura só exige pareamento.
    const room=req.url.split('?')[0]!.startsWith('/remote-api/room-b/')?'b':roomOf(req);
    if(room==='b' && !service.roomBAvailable())return reply.code(403).send({error:'room_b_weekend'});
    if(!service.canWrite(req,room))return reply.code(403).send({error:'read_only'});
  };
  const writeAuth=async(req:FastifyRequest,reply:FastifyReply)=> {
    if(!sameOrigin(req))return reply.code(403).send({error:'invalid_origin'});
    const denied=await auth(req,reply);if(denied)return denied;
    if(service.accessFor(req)==='readonly')return reply.code(403).send({error:'read_only'});
  };
  const today=()=> {const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
  const attendance=()=>ctx.todayAttendance();
  app.get('/remote-api/attendance',{preHandler:auth},async()=>attendance());
  app.post('/remote-api/attendance',{preHandler:writeAuth,bodyLimit:1024},async(req,reply)=> {
    const n=(req.body as {presencial?:unknown}|null)?.presencial;
    if(typeof n!=='number' || !Number.isInteger(n) || n<0 || n>100000)return reply.code(400).send({error:'invalid_presencial'});
    ctx.recordPresencial(today(),n,'remote');
    return attendance();
  });
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
  app.get('/remote-api/state',{preHandler:auth},async(req)=>service.state(roomOf(req),req));
  app.post('/remote-api/active',{preHandler:commandAuth,bodyLimit:1024},async(req,reply)=> {
    const room=roomOf(req),meeting=meetingOf(room),id=(req.body as {partId?:unknown})?.partId;
    if(typeof id!=='string' || !meeting.getState().parts.some(p=>p.id===id))return reply.code(400).send({error:'invalid_part'});
    meeting.setActive(id);return service.state(room,req);
  });
  app.post('/remote-api/part/:id/:action',{preHandler:commandAuth,bodyLimit:1024},async(req,reply)=> {
    const room=roomOf(req),meeting=meetingOf(room),{id,action}=req.params as {id:string;action:string};
    if(!meeting.getState().parts.some(p=>p.id===id))return reply.code(400).send({error:'invalid_part'});
    if(action==='start')meeting.start(id);
    else if(action==='pause')meeting.pause(id);
    else if(action==='pause-next')meeting.pauseAndAdvance(id);
    else if(action==='reset')meeting.reset(id);
    else return reply.code(404).send({error:'not_found'});
    return service.state(room,req);
  });
  app.get('/remote-api/programmes',{preHandler:auth},async()=>ctx.programmes?.list() ?? []);
  // O celular não importa mais PDF: a programação vem do Mapas JW (ou é ajustada à mão).
  app.post('/remote-api/programmes/sync',{preHandler:commandAuth},async(req,reply)=> {
    const result=await ctx.programmeSync.sync(),status=ctx.programmeSync.status();
    if(result==='inactive')return reply.code(409).send({error:'Este computador ainda não está pareado com o Mapas JW. Peça ao operador para parear.'});
    if(result==='paused')return reply.code(409).send({error:'O Mapas JW recusou o acesso deste computador. Peça ao operador para parear de novo.'});
    if(result==='error')return reply.code(502).send({error:'Não foi possível ler o Mapas JW agora. Confira a internet do computador e tente de novo.'});
    ctx.programmes.activateAutomatic(roomOf(req));
    return {programmes:status.programmes,weeks:status.weeks,lastAt:status.lastAt};
  });
  app.post('/remote-api/programmes/load',{preHandler:commandAuth,bodyLimit:100_000},async(req)=> {
    const body=req.body as {programmeId?:unknown;includeNames?:unknown;edits?:unknown};
    return ctx.programmes.load({...body,room:roomOf(req)});
  });
  app.post('/remote-api/room-b/prepare',{preHandler:commandAuth},async()=>ctx.programmes.prepareB());
  app.post('/remote-api/details',{preHandler:commandAuth,bodyLimit:64_000},async(req)=>ctx.programmes.saveDetails(roomOf(req),req.body));
  app.post('/remote-api/room-b/finish',{preHandler:commandAuth},async(req)=> {
    const meeting=ctx.programmes.service('b');for(const part of meeting.getState().parts)if(part.running)meeting.pause(part.id);
    return service.state('b',req);
  });
  // ---- Mídias → playlist do JW Library. Tudo atrás do papel `painel`, o mesmo bloqueio do Painel. ----
  const mediaAuth=async(req:FastifyRequest,reply:FastifyReply)=> {
    const denied=await auth(req,reply);if(denied)return denied;
    if(!service.hasPainel(req))return reply.code(403).send({error:'painel_required'});
  };
  const mediaWrite=async(req:FastifyRequest,reply:FastifyReply)=> {
    if(!sameOrigin(req))return reply.code(403).send({error:'invalid_origin'});
    return mediaAuth(req,reply);
  };
  const media=(fn:(body:Record<string,unknown>)=>unknown)=>async(req:FastifyRequest,reply:FastifyReply)=> {
    try {return await fn((req.body && typeof req.body==='object'?req.body:{}) as Record<string,unknown>);}
    catch(error) {
      const known=(error as {statusCode?:number}).statusCode===400;
      if(!known)ctx.logger?.warn({err:String(error)},'Falha ao montar a playlist de mídias');
      return reply.code(known?400:500).send({error:known?(error as Error).message:'Não foi possível montar a playlist no computador.'});
    }
  };
  app.get('/remote-api/media',{preHandler:mediaAuth},async()=>ctx.media.state());
  app.get('/remote-api/media/thumb/:id',{preHandler:mediaAuth},async(req,reply)=> {
    const bytes=ctx.media.thumb((req.params as {id:string}).id);
    return bytes?reply.header('Content-Type','image/jpeg').send(bytes):reply.code(404).send({error:'not_found'});
  });
  app.post('/remote-api/media/image',{preHandler:mediaWrite,bodyLimit:12_000_000},media(body=>ctx.media.addImage(body)));
  app.post('/remote-api/media/song',{preHandler:mediaWrite,bodyLimit:500_000},media(body=>ctx.media.addSong(body)));
  app.post('/remote-api/media/video',{preHandler:mediaWrite,bodyLimit:500_000},media(body=>ctx.media.addVideo(body)));
  // Quem tem o papel Painel administra os aparelhos pelo celular (mesmo poder do operador no computador,
  // menos tirar o próprio papel — para ninguém se trancar do lado de fora sem querer).
  app.get('/remote-api/devices',{preHandler:mediaAuth},async req=>service.devicesFor(req));
  app.post('/remote-api/devices/update',{preHandler:mediaWrite,bodyLimit:1024},async(req,reply)=> {
    const {id,painel,access}=(req.body && typeof req.body==='object'?req.body:{}) as {id?:unknown;painel?:unknown;access?:unknown};
    const target=service.devicesFor(req).find(d=>d.id===id);
    if(!target)return reply.code(404).send({error:'Aparelho não encontrado.'});
    if(painel!==undefined && typeof painel!=='boolean' || access!==undefined && !isDeviceAccess(access))return reply.code(400).send({error:'Pedido inválido.'});
    if(target.self && painel===false)return reply.code(400).send({error:'Você não pode tirar o Painel do próprio aparelho. Peça a outro administrador ou ao operador.'});
    if(typeof painel==='boolean')service.setPainel(target.id,painel);
    if(isDeviceAccess(access))service.setAccess(target.id,access);
    return service.devicesFor(req);
  });
  app.post('/remote-api/media/update',{preHandler:mediaWrite,bodyLimit:64_000},media(body=>ctx.media.update(body)));
  app.post('/remote-api/media/clear',{preHandler:mediaWrite,bodyLimit:1024},media(()=>ctx.media.clear()));
  app.post('/remote-api/media/send',{preHandler:mediaWrite,bodyLimit:1024},media(()=> {const {file:_file,...sent}=ctx.media.send();return sent;}));
  const clients=new Map<WebSocket,{req:FastifyRequest;room:TimerRoom}>();
  const send=(socket:WebSocket,client:{req:FastifyRequest;room:TimerRoom})=> {
    if(!service.authorize(client.req)) {socket.close(4401,'pairing_required');return;}
    if(socket.readyState===socket.OPEN)socket.send(JSON.stringify(service.state(client.room,client.req)));
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
