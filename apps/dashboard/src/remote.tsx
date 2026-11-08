import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import type { TimerRoom } from '@kmc/shared-types';
import { ActivePart } from './MeetingPanel.js';
import { useClock, elapsedSec, fmtClock } from './timer.js';
import { remoteApi, roomApi, useRemoteTimers } from './remoteApi.js';
import { RemoteProgrammePanel } from './RemoteProgrammePanel.js';
import { RemoteAttendance } from './RemoteAttendance.js';
import { ShareTimerImage } from './TimerShare.js';
import { RemoteBottomNav, TAB_LABELS, type RemoteTab } from './RemoteBottomNav.js';
import { RemotePainelTab } from './RemotePainelTab.js';
import './styles.css';

interface InstallPrompt extends Event { prompt:()=>Promise<void>;userChoice:Promise<{outcome:string}>; }
function RemoteTimer() {
  const [revision,setRevision]=useState(0);
  const [room,setRoom]=useState<TimerRoom>(()=>localStorage.getItem('kmc.timer-room')==='b'?'b':'main');
  const TABS:RemoteTab[]=['painel','cronometro','programacao','assistencia','mais'];
  const [tab,setTab]=useState<RemoteTab>(()=>{try{const v=localStorage.getItem('kmc.remote-tab') as RemoteTab;return TABS.includes(v)?v:'cronometro';}catch{return 'cronometro';}});
  // Fim de semana: a Sala B não existe. O servidor avisa em `roomBAvailable`; enquanto for false, tudo roda na sala principal.
  const [noRoomB,setNoRoomB]=useState(false);
  // Painel, Assistência e Mais usam sempre a sala principal; a escolha de sala vale só para Cronômetro e Programação.
  const roomNow:TimerRoom=noRoomB || (tab!=='cronometro' && tab!=='programacao')?'main':room;
  const {state,connected,pairing,offset,unavailable}=useRemoteTimers(revision,roomNow);
  const api=roomApi(roomNow);
  const hasPainel=!!state?.painel,weekendNoB=state?.roomBAvailable===false,onlyB=state?.access==='b';
  useEffect(()=>{if(state?.roomBAvailable!==undefined)setNoRoomB(state.roomBAvailable===false);},[state]);
  useEffect(()=>{if(state && tab==='painel' && !state.painel)setTab('cronometro');},[state,tab]);
  function selectTab(next:RemoteTab) {setTab(next);setError(null);try{localStorage.setItem('kmc.remote-tab',next);}catch{}}
  const [programme,setProgramme]=useState(false);
  const [deviceName,setDeviceName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const [install,setInstall]=useState<InstallPrompt|null>(null),[standalone,setStandalone]=useState(matchMedia('(display-mode: standalone)').matches);
  const meeting=state?.meeting,now=useClock(!!meeting?.parts.some(p=>p.running))+offset;
  const canWrite=state?.canWrite!==false;
  // Confirma só ações que alteram uma parte já iniciada (rodando ou com tempo decorrido); pausar nunca confirma.
  const started=(p?:{running:boolean;baseElapsedSec:number})=>!!p && (p.running || p.baseElapsedSec>0);
  const confirmThen=(cond:boolean,message:string,fn:()=>Promise<unknown>)=>cond && !window.confirm(message)?Promise.resolve():fn();
  const commands={...api,
    active:(id:string)=>confirmThen(id!==meeting?.activePartId && (!!meeting?.parts.some(p=>p.running) || started(meeting?.parts.find(p=>p.id===meeting.activePartId))),'Trocar a parte ativa? Há um cronômetro em andamento ou com tempo já registrado.',()=>api.active(id)),
    start:(id:string)=>confirmThen(!!meeting?.parts.some(p=>p.running && p.id!==id),'Iniciar esta parte? Outra parte está em andamento e será pausada.',()=>api.start(id)),
    reset:(id:string)=>confirmThen(started(meeting?.parts.find(p=>p.id===id)),'Zerar esta parte? O tempo já registrado será perdido.',()=>api.reset(id))};
  useEffect(()=> {
    const prompt=(event:Event)=> {event.preventDefault();setInstall(event as InstallPrompt);};
    const installed=()=> {setStandalone(true);setInstall(null);};
    window.addEventListener('beforeinstallprompt',prompt);window.addEventListener('appinstalled',installed);
    if('serviceWorker' in navigator && window.isSecureContext)void navigator.serviceWorker.register('/remote-sw.js').catch(()=>{});
    if(location.hash)history.replaceState(null,'',location.pathname);
    return ()=> {window.removeEventListener('beforeinstallprompt',prompt);window.removeEventListener('appinstalled',installed);};
  },[]);
  async function run(fn:()=>Promise<unknown>) {
    if(!connected)return;setBusy(true);setError(null);
    try {await fn();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  async function pair(event:React.FormEvent) {
    event.preventDefault();if(!deviceName.trim()){setError('Informe um nome para identificar quem está utilizando.');return;}setBusy(true);setError(null);
    try {await remoteApi.pair(deviceName.trim());setRevision(n=>n+1);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  const active=meeting?.parts.find(p=>p.id===meeting.activePartId);
  const roomSelector=!weekendNoB && <nav className="rc-rooms" aria-label="Sala dos cronômetros">{(['main','b'] as const).map(value=><button key={value} aria-pressed={room===value} className={room===value?'':'secondary'} disabled={busy || programme} onClick={()=>{setRoom(value);localStorage.setItem('kmc.timer-room',value);setError(null);}}>{value==='b'?'Sala B':'Salão principal'}</button>)}</nav>;
  const weekendNotice=weekendNoB && onlyB && <div className="rc-err" role="status"><b>Sala B indisponível no fim de semana.</b> A Sala B só funciona na reunião de meio de semana. Este aparelho tem acesso apenas à Sala B, então não há cronômetro para controlar agora. Abaixo você vê o cronômetro do salão principal somente para consulta; para controlá-lo, peça liberação ao operador.</div>;
  const accessLabel:Record<string,string>={readonly:'Somente leitura',main:'Salão principal',b:'Sala B',both:'Ambas as salas'};
  const weekInfo=(state?.period?.weekLabel || meeting?.weekLabel) && <div className="rc-week"><b>{state?.period?.weekLabel || meeting?.weekLabel}</b>{state?.period?.dateLabel && <div>{meeting?.kind==='weekend'?'Fim de semana':'Meio de semana'} · {state.period.dateLabel}</div>}</div>;
  return <div className="rc rc-app">
    <header className="rc-head"><span className="rc-title-top">{tab==='cronometro'?'⏱ Cronômetros':TAB_LABELS[tab]}</span><span className={`rc-dot ${connected?'on':''}`} title={connected?'Conectado':'Sem conexão'} /></header>
    {error && <div className="rc-err" role="alert">{error}</div>}
    {pairing ? <form className="rc-pair" onSubmit={pair}><h2>Conectar este aparelho</h2><p>Acesse os cronômetros sem código. O painel do operador permite revogar os aparelhos conectados.</p>
      <label>Nome do aparelho (obrigatório)<input aria-label="Nome do aparelho" required autoComplete="off" maxLength={80} placeholder="Ex.: João — Sala B" value={deviceName} onChange={e=>setDeviceName(e.target.value)} /></label>
      <span className="small muted">Informe quem está utilizando para identificar o acesso no painel.</span>
      <button disabled={busy || !deviceName.trim()}>{busy?'Conectando…':'Conectar este aparelho'}</button></form>
      : !state ? <div className="rc-wait"><p>{!unavailable && navigator.onLine?'Conectando ao computador do Salão…':'Sem conexão. Conecte-se à internet para controlar os cronômetros.'}</p><button className="secondary" onClick={()=>setRevision(n=>n+1)}>Tentar novamente</button></div>
      : <>
        {!connected && tab!=='painel' && <div className="rc-err" role="status">Sem conexão. Comandos desativados até reconectar.</div>}
        {tab==='painel' && hasPainel && <RemotePainelTab state={state} now={now} connected={connected} />}
        {tab==='cronometro' && <>
          {!canWrite && !weekendNotice && <div className="rc-err" role="status">Somente leitura — peça liberação ao operador.</div>}
          {weekendNotice}
          {roomSelector}
          <div className="rc-tools"><ShareTimerImage key={roomNow} state={state} now={now} disabled={!connected || busy} onError={setError} /></div>
          {roomNow==='b' && <p className="small muted">Controle interno · dirigente e ajudante · independente do salão principal</p>}
          {weekInfo}
          {state.period?.matchesMainWeek===false && <div className="rc-err" role="status">A Sala B está em outra semana. Se houver um cronômetro em execução, pause-o para carregar a semana do salão principal.</div>}
          {active && <div className="rc-active"><ActivePart part={active} now={now} warnSeconds={state.warnSeconds} busy={busy || !connected || !canWrite} run={run} commands={commands} /></div>}
          <ul className="rc-list">{meeting?.parts.map(part=> {
            const elapsed=elapsedSec(part,now),remaining=part.allottedSec-elapsed;
            return <li key={part.id} className={`rc-row ${part.id===meeting.activePartId?'active':''}`}>
              <button className="rc-rowmain" disabled={busy || !connected || !canWrite} onClick={()=>void run(()=>commands.active(part.id))}><span className="rc-sec">{part.section}</span><span className="rc-rowtitle">{part.title}</span><span className="small muted">{[state.details?.assignments[part.id]?.name,state.details?.assignments[part.id]?.secondName].filter(Boolean).join(' / ')}</span></button>
              <span className={`rc-rem ${remaining<0?'over':''}`}>{fmtClock(part.allottedSec>0?remaining:elapsed)}</span>
              <button className={`rc-btn ${part.running?'pause':'play'}`} aria-label={part.running?'Pausar':'Iniciar'} disabled={busy || !connected || !canWrite} onClick={()=>void run(()=>part.running?commands.pause(part.id):commands.start(part.id))}>{part.running?'❚❚':'▶'}</button>
              <button className="rc-btn reset" aria-label="Zerar" disabled={busy || !connected || !canWrite} onClick={()=>void run(()=>commands.reset(part.id))}>↺</button>
            </li>;
          })}</ul>
          {!meeting?.parts.length && <p className="rc-empty">{roomNow==='b'?'Importe o PDF na aba Programação. Todas as datas serão preparadas automaticamente.':'O operador ainda não carregou a reunião.'}</p>}
        </>}
        {tab==='programacao' && <section className="rc-tab-section">
          {weekendNotice}
          {roomSelector}
          {weekInfo}
          <div className="rc-tools"><button className="secondary" disabled={!connected || busy || !canWrite} onClick={()=>setProgramme(true)}>Editar programação e nomes</button></div>
          {!canWrite && <p className="small muted">Somente leitura — a edição exige liberação do operador para esta sala.</p>}
          <ul className="rc-list">{meeting?.parts.map(part=><li key={part.id} className="rc-row rc-row-plain"><div className="rc-rowmain"><span className="rc-sec">{part.section}</span><span className="rc-rowtitle rc-wrap">{part.title}</span><span className="small muted">{[state.details?.assignments[part.id]?.name,state.details?.assignments[part.id]?.secondName].filter(Boolean).join(' / ')}</span></div><span className="rc-rem">{fmtClock(part.allottedSec)}</span></li>)}</ul>
          {!meeting?.parts.length && <p className="rc-empty">{roomNow==='b'?'Importe o PDF em “Editar programação e nomes”. Todas as datas serão preparadas automaticamente.':'O operador ainda não carregou a reunião.'}</p>}
          {programme && connected && canWrite && <RemoteProgrammePanel key={roomNow} room={roomNow} state={state} close={()=>setProgramme(false)} changed={()=>{}} />}
        </section>}
        {tab==='assistencia' && <RemoteAttendance standalone connected={connected} canWrite={state.access!=='readonly'} onError={setError} />}
        {tab==='mais' && <section className="rc-tab-section">
          <h2>Este aparelho</h2>
          <p>Permissão nos cronômetros: <b>{accessLabel[state.access ?? 'readonly']}</b></p>
          <p>Painel (mãos levantadas e anúncios): <b>{hasPainel?'liberado':'não liberado'}</b></p>
          {!hasPainel && <p className="small muted">O Painel mostra nomes de participantes e só é liberado pelo operador, aparelho por aparelho.</p>}
          <p className="small muted">{weekendNoB?'Fim de semana: a Sala B não funciona nesta reunião.':'A Sala B existe apenas na reunião de meio de semana.'}</p>
          {!standalone && (install?<button className="secondary rc-install" onClick={async()=>{await install.prompt();await install.userChoice;setInstall(null);}}>Instalar no celular</button>
            :<details className="rc-install"><summary>Instalar como aplicativo</summary><p className="small muted">Android: menu do navegador → Instalar aplicativo. iPhone: Compartilhar → Adicionar à Tela de Início. Use o link HTTPS fixo configurado no computador.</p></details>)}
        </section>}
      </>}
    {state && !pairing && <RemoteBottomNav withPainel={hasPainel} active={tab} onSelect={selectTab} />}
  </div>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><RemoteTimer /></React.StrictMode>);
