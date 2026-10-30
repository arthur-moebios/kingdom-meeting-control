import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { MeetingService } from '@kmc/meeting';
import { repoRoot } from '@kmc/config';
import type { ImportedProgramme, ProgrammePart, RemoteTimerState, TimerDetails, TimerRoom } from '@kmc/shared-types';
import type { AppContext } from './context.js';
import { MINISTRY, isMinistry, normalize, parseProgrammePages } from './programmeImport.js';
import { dateWeek, meetingWeek, weekKey, weekLabel } from './meetingPeriod.js';

const emptyDetails=():TimerDetails=>({assignments:{},conductor:'',helper:'',date:null});
const clean=(value:unknown)=>typeof value==='string'?value.trim().slice(0,160):'';
const invalid=(message:string)=>Object.assign(new Error(message),{statusCode:400});
interface SavedDetails extends TimerDetails {partIds:string[];}
export class MobileProgrammes {
  readonly roomB:MeetingService;
  private library:ImportedProgramme[]=[];
  private listeners=new Set<(room:TimerRoom)=>void>();
  private updating=new Set<TimerRoom>();
  constructor(private readonly ctx:AppContext) {
    this.roomB=new MeetingService({log:ctx.logger,getSettings:()=>ctx.getSettings(),loadState:()=>ctx.db.getKv('meeting.room-b'),
      saveState:json=>ctx.db.setKv('meeting.room-b',json),emit:()=>this.notify('b')});
    try {const value=JSON.parse(ctx.db.getKv('mobile.programmes') || '[]');if(Array.isArray(value))this.library=value.slice(0,120);}catch{}
  }
  subscribe(listener:(room:TimerRoom)=>void) {this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  isUpdating(room:TimerRoom) {return this.updating.has(room);}
  private notify(room:TimerRoom) {if(!this.isUpdating(room))for(const listener of this.listeners)listener(room);}
  service(room:TimerRoom) {return room==='b'?this.roomB:this.ctx.meeting;}
  private team(room:TimerRoom,programme:ImportedProgramme):{conductor?:string;helper?:string} {
    try{return JSON.parse(this.ctx.db.getKv(`mobile.team.${room}.${programme.kind}.${programme.date}`) || '{}');}catch{return {};}
  }
  private importedDetails(room:TimerRoom,programme:ImportedProgramme,previous?:SavedDetails):SavedDetails {
    const current=this.service(room).getState(),parts=room==='b'?programme.roomBParts:programme.mainParts;
    const team=this.team(room,programme);
    const details:SavedDetails={...emptyDetails(),date:programme.date,conductor:room==='b'?programme.conductorB:team.conductor || previous?.conductor || '',helper:team.helper ?? previous?.helper ?? '',partIds:current.parts.map(p=>p.id),numbers:{}};
    const used=new Set<number>();
    for(const part of current.parts) {
      let index=parts.findIndex((candidate,i)=>!used.has(i) && normalize(candidate.title)===normalize(part.title) && normalize(candidate.section)===normalize(part.section));
      // WOL has generic role titles; the imported programme has the actual talk
      // theme and a generic Watchtower label. Bind their two fixed roles.
      if(index<0 && room==='main' && current.kind==='weekend' && current.source==='wol' && current.parts.length===2 && parts.length===2 &&
        (normalize(part.title)==='DISCURSO PUBLICO' || /^(A SENTINELA|ESTUDO DE A SENTINELA)/.test(normalize(part.title)))) {
        index=part.order;if(index<0 || index>=parts.length || used.has(index))index=-1;
      }
      if(index<0)continue;used.add(index);const source=parts[index]!;
      details.assignments[part.id]={name:source.name,secondName:source.secondName};details.numbers![part.id]=source.number;
    }
    return details;
  }
  private details(room:TimerRoom):SavedDetails {
    const meeting=this.service(room).getState(),ids=meeting.parts.map(part=>part.id);
    try {
      const value=JSON.parse(this.ctx.db.getKv('mobile.details.'+room) || '{}') as SavedDetails;
      const sameIds=Array.isArray(value.partIds) && JSON.stringify(value.partIds)===JSON.stringify(ids);
      const week=meetingWeek(meeting,sameIds?value.date:null);
      const programme=this.library.find(p=>p.kind===meeting.kind && (room==='main' || p.roomBParts.length>0) &&
        (p.label===meeting.weekLabel || (week && weekKey(dateWeek(p.date))===weekKey(week))));
      if(Array.isArray(value.partIds) && JSON.stringify(value.partIds)===JSON.stringify(ids)) {
        if(programme) {
          const before=JSON.stringify(value);
          const imported=this.importedDetails(room,programme,value);
          if(value.date!==programme.date){this.ctx.db.setKv('mobile.details.'+room,JSON.stringify(imported));return imported;}
          value.assignments={...imported.assignments,...value.assignments};value.numbers={...imported.numbers,...value.numbers};
          const after=JSON.stringify(value);if(before!==after)this.ctx.db.setKv('mobile.details.'+room,after);
        }
        return value;
      }
      if(programme){const restored=this.importedDetails(room,programme,value);this.ctx.db.setKv('mobile.details.'+room,JSON.stringify(restored));return restored;}
    }catch{}
    return {...emptyDetails(),partIds:ids};
  }
  state(room:TimerRoom):RemoteTimerState {
    this.ensureProgramme(room);
    const {partIds,...details}=this.details(room);
    const meeting=this.service(room).getState(),week=meetingWeek(meeting,details.date),mainWeek=meetingWeek(this.ctx.meeting.getState(),room==='main'?details.date:null);
    return {room,details,meeting,period:{weekLabel:week?weekLabel(week):mainWeek?weekLabel(mainWeek):meeting.weekLabel,
      dateLabel:details.date?new Date(details.date+'T12:00:00').toLocaleDateString('pt-BR',{day:'numeric',month:'long',year:'numeric'}):null,
      matchesMainWeek:!mainWeek || !week || weekKey(mainWeek)===weekKey(week)},warnSeconds:this.ctx.getSettings().meetingSchedule.warnSeconds,serverNow:new Date().toISOString()};
  }
  list() {return structuredClone(this.library);}
  mainAssignments() {return structuredClone(this.details('main').assignments);}
  private today() {const now=new Date();return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;}
  private ensureProgramme(room:TimerRoom,force=false) {
    if(this.isUpdating(room))return;
    const today=this.today(),key='mobile.auto.'+room,last=this.ctx.db.getKv(key);
    const main=this.ctx.meeting.getState(),anchor=room==='b'?meetingWeek(main):null;
    // The operator's WOL week is authoritative; enrich it instead of replacing it.
    if(room==='main' && main.source==='wol' && main.parts.length){this.details('main');return;}
    if(room==='main' && !force && last===today)return;
    if(this.service(room).getState().parts.some(p=>p.running))return;
    const available=this.library.filter(p=>(room==='main'?p.mainParts.length:p.roomBParts.length) && (!anchor || weekKey(dateWeek(p.date))===weekKey(anchor))).sort((a,b)=>a.date.localeCompare(b.date));
    const selected=available.find(p=>p.date>=today) || available.at(-1);
    if(!selected)return;
    this.ctx.db.setKv(key,today);
    const existing=this.details(room);
    if(existing.date===selected.date && this.service(room).getState().kind===selected.kind)return;
    this.load({room,programmeId:selected.id,includeNames:true});
  }
  activateAutomatic(room:TimerRoom) {if(!this.ctx.db.getKv('mobile.auto.'+room))this.ctx.db.setKv('mobile.auto.'+room,'enabled');this.ensureProgramme(room,true);}
  store(programmes:ImportedProgramme[]) {
    for(const programme of programmes) {
      this.library=this.library.filter(old=>!(old.date===programme.date && old.kind===programme.kind));
      this.library.push(programme);
    }
    this.library=this.library.sort((a,b)=>b.date.localeCompare(a.date)).slice(0,120);
    this.ctx.db.setKv('mobile.programmes',JSON.stringify(this.library));
    // Refresh names for the active date without rebuilding or resetting timers.
    for(const room of ['main','b'] as const) {
      const details=this.details(room),meeting=this.service(room).getState();
      const updated=programmes.find(p=>p.date===details.date && p.kind===meeting.kind);
      if(updated){this.ctx.db.setKv('mobile.details.'+room,JSON.stringify(this.importedDetails(room,updated,details)));this.notify(room);}
    }
    return programmes;
  }
  async importPdf(filename:unknown,encoded:unknown):Promise<ImportedProgramme[]> {
    if(typeof encoded!=='string' || encoded.length>10_700_000)throw invalid('Envie um PDF de até 8 MB.');
    const bytes=Buffer.from(encoded,'base64');if(bytes.length>8_000_000 || bytes.subarray(0,5).toString()!=='%PDF-')throw invalid('Arquivo PDF inválido.');
    const script=[path.join(repoRoot,'extract-programme.py'),path.join(repoRoot,'scripts','extract-programme.py')].find(file=>fs.existsSync(file));
    if(!script)throw invalid('Extrator PDF ausente. Atualize a instalação do app.');
    const embedded=path.join(repoRoot,'python','python.exe');
    const runtime=path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
    const python=process.env.KMC_PDF_PYTHON || (fs.existsSync(embedded)?embedded:fs.existsSync(runtime)?runtime:'python');
    const tools=fs.existsSync(path.join(repoRoot,'native-tools'))?path.join(repoRoot,'native-tools'):path.join(repoRoot,'runtime/data/zoom-native-tools');
    const output=await new Promise<string>((resolve,reject)=> {
      const child=spawn(python,[script],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,KMC_NATIVE_TOOLS:tools}});
      let text='';const timeout=setTimeout(()=>child.kill(),15000);
      child.stdout.on('data',chunk=>{text+=String(chunk);if(text.length>3_000_000)child.kill();});child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
      child.once('error',()=>{clearTimeout(timeout);reject(invalid('Não foi possível abrir o extrator PDF.'));});
      child.once('close',code=>{clearTimeout(timeout);if(code===0)resolve(text);else reject(invalid('Não foi possível ler o PDF. Use a exportação original, sem senha e com até 20 páginas.'));});
      child.stdin.end(bytes);
    });
    const {pages}=JSON.parse(output) as {pages:string[]};
    const safeName=String(filename || 'programacao.pdf').replace(/^.*[\\/]/,'').slice(0,120);
    return this.store(parseProgrammePages(pages,safeName));
  }
  load(input:{programmeId?:unknown;room:TimerRoom;includeNames?:unknown;edits?:unknown}) {
    const programme=this.library.find(item=>item.id===input.programmeId);if(!programme)throw invalid('Selecione uma programação importada.');
    const original=input.room==='b'?programme.roomBParts:programme.mainParts;
    if(!original.length)throw invalid('Não há designações de Sala B nesta data.');
    const edits=Array.isArray(input.edits)?input.edits:[];
    if(edits.length>64)throw invalid('Programação muito extensa.');
    const parts=original.map((part,index)=> {
      const edit=edits[index] as Partial<ProgrammePart>|undefined;
      const seconds=edit?.allottedSec ?? part.allottedSec;
      if(!Number.isInteger(seconds) || seconds<0 || seconds>14400)throw invalid('Duração inválida.');
      return {...part,title:clean(edit?.title ?? part.title),allottedSec:seconds,name:clean(edit?.name ?? part.name),secondName:clean(edit?.secondName ?? part.secondName)};
    });
    if(input.room==='b' && parts.some(part=>!isMinistry(part.section)))throw invalid('Sala B aceita somente Faça Seu Melhor no Ministério.');
    this.ctx.db.setKv('mobile.auto.'+input.room,this.today());
    this.updating.add(input.room);
    try {
    const loaded=this.service(input.room).replaceProgramme({weekLabel:programme.label,title:input.room==='b'?MINISTRY:'Programação importada',kind:programme.kind,parts});
    const team=this.team(input.room,programme);
    const details:SavedDetails={...emptyDetails(),date:programme.date,conductor:input.includeNames===true?(input.room==='b'?programme.conductorB:team.conductor || ''):'',helper:input.includeNames===true?team.helper || '':'',partIds:loaded.parts.map(part=>part.id),numbers:Object.fromEntries(loaded.parts.map((part,index)=>[part.id,parts[index]!.number]))};
    if(input.includeNames===true)loaded.parts.forEach((part,index)=>{details.assignments[part.id]={name:parts[index]!.name,secondName:parts[index]!.secondName};});
    this.ctx.db.setKv('mobile.details.'+input.room,JSON.stringify(details));this.ctx.db.setKv('mobile.auto.'+input.room,this.today());
    }finally{this.updating.delete(input.room);}
    this.notify(input.room);return this.state(input.room);
  }
  prepareB() {
    const source=this.ctx.meeting.getState();const parts=source.parts.filter(part=>isMinistry(part.section));
    if(source.kind!=='midweek' || !parts.length)throw invalid('A reunião principal não tem partes do ministério para copiar.');
    const mainDetails=this.details('main'),programme=this.library.find(p=>p.date===mainDetails.date && p.kind==='midweek' && p.roomBParts.length);
    if(programme)return this.load({room:'b',programmeId:programme.id,includeNames:true});
    this.roomB.replaceProgramme({weekLabel:source.weekLabel,title:MINISTRY,kind:'midweek',parts});
    this.ctx.db.setKv('mobile.details.b',JSON.stringify({...emptyDetails(),partIds:this.roomB.getState().parts.map(part=>part.id)}));
    this.notify('b');return this.state('b');
  }
  saveDetails(room:TimerRoom,input:unknown) {
    if(!input || typeof input!=='object')throw invalid('Nomes inválidos.');
    const data=input as Partial<TimerDetails> & {partIds?:unknown},details=this.details(room);
    if(data.partIds!==undefined && JSON.stringify(data.partIds)!==JSON.stringify(details.partIds))throw Object.assign(new Error('A programação mudou. Reabra os nomes antes de salvar.'),{statusCode:409});
    if(data.conductor!==undefined)details.conductor=clean(data.conductor);if(data.helper!==undefined)details.helper=clean(data.helper);
    const assignments=data.assignments && typeof data.assignments==='object'?data.assignments:{};
    if(Object.keys(assignments).some(id=>!details.partIds.includes(id)))throw Object.assign(new Error('A programação mudou. Reabra os nomes antes de salvar.'),{statusCode:409});
    for(const id of details.partIds) {const names=assignments[id];if(names)details.assignments[id]={name:clean(names.name),secondName:clean(names.secondName)};}
    const programme=this.library.find(p=>p.date===details.date && p.kind===this.service(room).getState().kind);
    if(programme) {
      const parts=room==='b'?programme.roomBParts:programme.mainParts;
      for(const id of details.partIds){const part=parts.find(p=>p.number===details.numbers?.[id]);if(part && details.assignments[id])Object.assign(part,details.assignments[id]);}
      if(room==='b')programme.conductorB=details.conductor;
      this.ctx.db.setKv(`mobile.team.${room}.${programme.kind}.${programme.date}`,JSON.stringify({conductor:details.conductor,helper:details.helper}));
      this.ctx.db.setKv('mobile.programmes',JSON.stringify(this.library));
    }
    this.ctx.db.setKv('mobile.details.'+room,JSON.stringify(details));this.notify(room);return this.state(room);
  }
}
