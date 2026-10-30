import { useEffect, useRef, useState } from 'react';
import type { ImportedProgramme, RemoteTimerState, TimerDetails, TimerRoom } from '@kmc/shared-types';
import { roomApi } from './remoteApi.js';

export function RemoteProgrammePanel({room,state,close,changed}:{room:TimerRoom;state:RemoteTimerState;close:()=>void;changed:()=>void}) {
  const api=roomApi(room);
  const [library,setLibrary]=useState<ImportedProgramme[]>([]);
  const [details,setDetails]=useState<TimerDetails>(()=>structuredClone(state.details ?? {assignments:{},conductor:'',helper:'',date:null}));
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const edit=useRef({ids:'',dirty:false});
  const ids=state.meeting.parts.map(p=>p.id).join(','),serverDetails=JSON.stringify(state.details);
  const available=library.filter(p=>room==='main' || p.roomBParts.length>0);
  useEffect(()=>{void api.list().then(setLibrary).catch(e=>setError(String(e.message)));},[room]);
  useEffect(()=>{
    if(edit.current.ids!==ids)edit.current={ids,dirty:false};
    if(!edit.current.dirty)setDetails(structuredClone(state.details ?? {assignments:{},conductor:'',helper:'',date:null}));
  },[ids,serverDetails]);
  function updateDetails(next:TimerDetails|((previous:TimerDetails)=>TimerDetails)) {edit.current.dirty=true;setDetails(next);}
  async function run(action:()=>Promise<unknown>,message?:string) {
    setBusy(true);setError('');setNotice('');
    try{await action();if(message)setNotice(message);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  async function importFile(file:File) {
    if(file.size>8_000_000)throw new Error('Envie um PDF de até 8 MB.');
    const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]!);reader.onerror=()=>reject(new Error('Não foi possível ler o arquivo.'));reader.readAsDataURL(file);});
    edit.current.dirty=false;const imported=await api.importPdf(file.name,data);setLibrary(await api.list());
    const latest=await api.state();setDetails(structuredClone(latest.details ?? {assignments:{},conductor:'',helper:'',date:null}));
    setNotice(`${imported.length} datas preparadas automaticamente, com todas as partes e nomes disponíveis.`);
  }
  return <div className="rc-modal-backdrop"><section className="rc-modal" role="dialog" aria-modal="true" aria-label="Programação e nomes">
    <div className="rc-modal-head"><h2>{room==='b'?'Sala B':'Salão principal'} · Programação</h2><button className="secondary" disabled={busy} onClick={close}>Fechar</button></div>
    {error && <p className="rc-err" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <label className="rc-file">Importar programação em PDF<input type="file" accept="application/pdf,.pdf" disabled={busy} onChange={e=>{const file=e.target.files?.[0];if(file)void run(()=>importFile(file));e.target.value='';}} /></label>
    <p className="small muted">O PDF inteiro é importado de uma vez. Todas as datas ficam prontas, com os nomes disponíveis. A programação da data é carregada automaticamente; cronômetros em execução são preservados.</p>
    <p className="small"><b>{available.length} {available.length===1?'data preparada':'datas preparadas'} automaticamente</b>{(state.period?.weekLabel || state.meeting.weekLabel) && <><br/>{state.period?.weekLabel || state.meeting.weekLabel}</>}{state.period?.dateLabel && <><br/>Reunião: {state.period.dateLabel}</>}</p>
    {room==='b' && <p className="small muted">Somente Faça Seu Melhor no Ministério com designações explícitas de Sala B é importado para esta sala.</p>}
    {library.find(p=>p.date===state.details?.date)?.warnings.filter(w=>!w.includes('Sala B')).map((warning,index)=><p className="small rc-warning" key={index}>{warning}</p>)}
    {room==='b' && <button className="secondary" disabled={busy || state.meeting.parts.some(p=>p.running)} onClick={()=>void run(async()=>{await api.prepareB();changed();close();})}>Copiar partes do ministério da reunião principal e zerar Sala B</button>}
    <details className="rc-name-editor"><summary>Ajustar nomes da programação atual</summary>
      <label>Dirigente<input disabled={busy} value={details.conductor} maxLength={160} onChange={e=>updateDetails({...details,conductor:e.target.value})} /></label>
      <label>Ajudante<input disabled={busy} value={details.helper} maxLength={160} onChange={e=>updateDetails({...details,helper:e.target.value})} /></label>
      {state.meeting.parts.map(part=><fieldset key={part.id} disabled={busy}><legend>{part.title}</legend>{(['name','secondName'] as const).map(key=><label key={key}>{key==='name'?'Participante':'Ajudante / segundo participante'}<input maxLength={160} value={details.assignments[part.id]?.[key] ?? ''} onChange={e=>updateDetails(old=>({...old,assignments:{...old.assignments,[part.id]:{...(old.assignments[part.id] ?? {name:'',secondName:''}),[key]:e.target.value}}}))} /></label>)}</fieldset>)}
      <button disabled={busy} onClick={()=>void run(async()=>{const saved=await api.details(details,state.meeting.parts.map(p=>p.id));edit.current.dirty=false;if(saved.details)setDetails(structuredClone(saved.details));changed();},'Nomes salvos no computador para esta sala e data.')}>Salvar nomes</button>
    </details>
  </section></div>;
}
