import { randomUUID } from 'node:crypto';
import type { ImportedProgramme, ProgrammePart } from '@kmc/shared-types';

export const MINISTRY='FAÇA SEU MELHOR NO MINISTÉRIO';
export const normalize=(value:string)=>value.normalize('NFD').replace(/\p{M}/gu,'').toUpperCase().replace(/\s+/g,' ').trim();
export const isMinistry=(value:string)=>normalize(value)===normalize(MINISTRY);
const months=['janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const names=(value:string)=> {const parts=value.trim().split(/\s+\/\s+/);return {name:(parts[0] || '').slice(0,160),secondName:parts.slice(1).join(' / ').slice(0,160)};};

export function parseProgrammePages(pages:string[],sourceFile:string):ImportedProgramme[] {
  const output:ImportedProgramme[]=[];
  const kind=pages.some(page=>normalize(page).includes('REUNIAO DO MEIO DE SEMANA'))?'midweek':
    pages.some(page=>normalize(page).includes('REUNIAO DO FIM DE SEMANA'))?'weekend':null;
  if(!kind)throw new Error('Formato não reconhecido. Use a exportação de programação de meio ou fim de semana.');
  let programme:ImportedProgramme|null=null,section='',last:ProgrammePart|null=null;
  let weekendLines:string[]=[];
  function finishWeekend() {
    if(!programme || kind!=='weekend')return;
    const content=weekendLines.map(line=>line.split(/\s{3,}/)[0]!.trim()).filter(Boolean);
    const talkLines:string[]=[];const talks:{title:string;speaker:string}[]=[];
    for(const line of content) {
      if(/^Discursos fora/i.test(line))break;
      if(/^(?:Cântico|Presidente|Dirigente|Leitor|Oração)/i.test(line))continue;
      if(/\s—\s/.test(line)) {talks.push({title:talkLines.splice(0).join(' '),speaker:line.split(/\s—\s/)[0]!.trim()});continue;}
      if(!/^(?:\d{1,2} de|\d{2}\/\d{2}\/\d{4}|Nogueira|Reunião)/i.test(line))talkLines.push(line);
    }
    const special=weekendLines.some(line=>normalize(line).includes('SUPERINTENDENTE DE CIRCUITO'));
    const reader=weekendLines.map(line=>line.match(/Leitor de A Sentinela\s+(.+)$/i)?.[1]).find(Boolean) || '';
    const conductor=weekendLines.map(line=>line.match(/Dirigente de A Sentinela\s+(.+)$/i)?.[1]).find(Boolean) || '';
    programme.mainParts=[
      {number:'1',section:'Fim de semana',title:talks[0]?.title || talkLines.join(' ').trim() || 'Discurso público',allottedSec:1800,...names(talks[0]?.speaker || '')},
      {number:'2',section:'Fim de semana',title:'Estudo de A Sentinela',allottedSec:3600,name:conductor,secondName:reader},
    ];
    if(special && talks.length>1)programme.mainParts=talks.map((talk,index)=>({number:String(index+1),section:'Visita do superintendente',title:talk.title || 'Discurso',allottedSec:1800,...names(talk.speaker)}));
    programme.warnings.push(special?'O PDF não informa durações. Os tempos de 30 minutos são sugestões editáveis.':'O PDF de fim de semana não informa durações. Os tempos de 30 e 60 minutos são sugestões editáveis.');
    if(special)programme.warnings.push('Programação especial de visita: confira e edite os temas e tempos antes de carregar.');
    if(!talks[0]?.title && !talkLines.length)programme.warnings.push('Tema do discurso não informado no PDF.');
    weekendLines=[];
  }
  for(const raw of pages.flatMap(page=>page.split(/\r?\n/))) {
    const line=raw.trim();if(!line)continue;
    const date=line.match(/^(\d{1,2}) de ([a-zç]+) de (\d{4})(?:\s*\||\s{2,}|$)/i);
    if(date) {
      finishWeekend();
      const month=months.indexOf(normalize(date[2]!).toLowerCase());if(month<0)continue;
      const iso=`${date[3]}-${String(month+1).padStart(2,'0')}-${date[1]!.padStart(2,'0')}`;
      programme={id:randomUUID(),date:iso,label:`${date[1]} de ${date[2]} de ${date[3]}`,kind,sourceFile:sourceFile.slice(0,120),mainParts:[],roomBParts:[],conductorB:'',warnings:[]};
      output.push(programme);section='';last=null;continue;
    }
    if(!programme)continue;
    if(kind==='weekend'){weekendLines.push(line);continue;}
    const leader=line.match(/Dirigente\s*\(Sala B\)\s+(.+)$/i);if(leader)programme.conductorB=leader[1]!.trim().slice(0,160);
    const heading=normalize(line);
    if(['TESOUROS DA PALAVRA DE DEUS',normalize(MINISTRY),'NOSSA VIDA CRISTA'].includes(heading)) {section=isMinistry(line)?MINISTRY:line;last=null;continue;}
    const part=line.match(/^(\d+)\.\s+(.+?)\s*\((\d+)\s*min\)\s*(.*)$/i);
    if(part) {
      const label=part[4]!.replace(/^Salão Principal\s*/i,'');
      last={number:part[1]!,section,title:part[2]!.trim(),allottedSec:Number(part[3])*60,...names(label)};
      programme.mainParts.push(last);continue;
    }
    const room=line.match(/^Sala B\s+(.+)$/i);
    if(room && last && isMinistry(last.section))programme.roomBParts.push({...last,...names(room[1]!)});
  }
  finishWeekend();
  if(!output.length)throw new Error('Nenhuma data de reunião reconhecida no PDF.');
  for(const item of output) {
    if(item.kind==='midweek' && !item.roomBParts.length)item.warnings.push('Não há designações explícitas de Sala B neste dia.');
    if(item.kind==='midweek')item.warnings.push('Itens sem duração explícita no PDF não foram convertidos em cronômetros.');
  }
  return output;
}
