import { useEffect, useState } from 'react';
import type { RemoteTimerState } from '@kmc/shared-types';
import { elapsedSec, fmtClock } from './timer.js';

function sectionColor(section:string) {
  const text=section.normalize('NFD').replace(/\p{M}/gu,'').toUpperCase();
  return text.includes('MINISTERIO')?'#947126':text.includes('TESOUROS')?'#386673':text.includes('VIDA CRISTA')?'#8b302c':'#465a65';
}
export async function programmeImage(state:RemoteTimerState,now:number):Promise<Blob> {
  await document.fonts.ready;
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');if(!ctx)throw new Error('Imagem indisponível neste navegador.');
  const width=1500,margin=70,content=width-margin*2;
  const wrap=(text:string,maxWidth:number,font:string)=> {
    ctx.font=font;const lines:string[]=[];let line='';
    for(const word of text.split(/\s+/)) {
      if(line && ctx.measureText(line+' '+word).width>maxWidth){lines.push(line);line='';}
      for(const char of (line?' ':'')+word){if(ctx.measureText(line+char).width>maxWidth){lines.push(line);line='';}line+=char;}
    }
    if(line)lines.push(line);return lines;
  };
  const blocks:{draw:()=>void;height:number}[]=[];let y=190;
  const row=(left:string,right:string,font='22px Arial',color='#171717',rightFont=font)=> {
    const l=wrap(left,640,font),r=wrap(right,625,rightFont),top=y,height=Math.max(l.length,r.length,1)*32+16;
    blocks.push({height,draw:()=>{ctx.fillStyle=color;ctx.font=font;l.forEach((text,i)=>ctx.fillText(text,margin+10,top+i*32));ctx.font=rightFont;r.forEach((text,i)=>ctx.fillText(text,margin+735,top+i*32));}});y+=height;
  };
  if(state.details?.conductor)row('','Dirigente: '+state.details.conductor,'20px Arial');
  if(state.details?.helper)row('','Ajudante: '+state.details.helper,'20px Arial');
  let section='';
  state.meeting.parts.forEach((part,index)=> {
    if(part.section!==section){section=part.section;const top=y+14,label=section,color=sectionColor(section);blocks.push({height:64,draw:()=>{ctx.fillStyle=color;ctx.fillRect(margin,top,content,38);ctx.font='bold 20px Arial';ctx.fillStyle='#fff';ctx.fillText(label.toUpperCase(),margin+10,top+8);}});y+=64;}
    const assignment=state.details?.assignments[part.id],names=[assignment?.name,assignment?.secondName].filter(Boolean).join(' / ');
    const number=state.details?.numbers?.[part.id] || String(index+1);
    const minutes=part.allottedSec/60,duration=Number.isInteger(minutes)?`${minutes} min`:fmtClock(part.allottedSec);
    row(`${number}. ${part.title} (${duration})`,names,'22px Arial');
    const elapsed=elapsedSec(part,now);
    row(elapsed>0?`Realizado: ${fmtClock(elapsed)}${part.running?' · em andamento':''}`:'Realizado: —','','18px Arial','#666');
    y+=14;
  });
  canvas.width=width;canvas.height=Math.max(420,y+60);ctx.fillStyle='#fff';ctx.fillRect(0,0,width,canvas.height);ctx.textBaseline='top';
  ctx.fillStyle='#111';ctx.font='bold 29px Arial';ctx.fillText(state.meeting.kind==='weekend'?'Reunião do fim de semana':'Reunião do meio de semana',margin,55);
  ctx.textAlign='right';ctx.fillText(state.room==='b'?'Sala B':'Salão principal',width-margin,55);ctx.textAlign='left';
  ctx.fillRect(margin,98,content,2);ctx.font='bold 23px Arial';
  const date=state.details?.date?new Date(state.details.date+'T12:00:00').toLocaleDateString('pt-BR',{day:'numeric',month:'long',year:'numeric'}):state.meeting.weekLabel;
  ctx.fillText(date || 'Programação',margin+10,119);
  for(const block of blocks)block.draw();
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Não foi possível gerar a imagem.')),'image/png'));
}
export function ShareTimerImage({state,now,disabled,onError}:{state:RemoteTimerState;now:number;disabled:boolean;onError:(message:string)=>void}) {
  const [ready,setReady]=useState<{identity:string;file:File}|null>(null);
  const identity=JSON.stringify([state.room,state.meeting,state.details]),second=state.meeting.parts.some(p=>p.running)?Math.floor(now/1000):0;
  useEffect(()=> {
    let stopped=false;
    void programmeImage(state,now).then(blob=>{if(!stopped)setReady({identity,file:new File([blob],`programacao-${state.room==='b'?'sala-b':'principal'}-${state.details?.date || 'reuniao'}.png`,{type:'image/png'})});}).catch(e=>{if(!stopped)onError(String(e.message));});
    return()=>{stopped=true;};
  },[identity,second]);
  function share() {
    if(!ready || ready.identity!==identity)return;
    const file=ready.file;onError('');
    // File already exists before this gesture: native share opens immediately.
    if(navigator.share && navigator.canShare?.({files:[file]})) {
      void navigator.share({files:[file]}).catch(e=>{if(e?.name!=='AbortError')onError(String(e.message || 'Não foi possível compartilhar.'));});
    }else{
      const url=URL.createObjectURL(file),link=document.createElement('a');link.href=url;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
    }
  }
  return <button className="secondary" disabled={disabled || !state.meeting.parts.length || ready?.identity!==identity} onClick={share}>Compartilhar imagem</button>;
}
