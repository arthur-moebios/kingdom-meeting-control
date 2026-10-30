import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import type { TimerRoom } from '@kmc/shared-types';
import { ActivePart } from './MeetingPanel.js';
import { useClock, elapsedSec, fmtClock } from './timer.js';
import { remoteApi, roomApi, useRemoteTimers } from './remoteApi.js';
import { RemoteProgrammePanel } from './RemoteProgrammePanel.js';
import { ShareTimerImage } from './TimerShare.js';
import './styles.css';

interface InstallPrompt extends Event { prompt:()=>Promise<void>;userChoice:Promise<{outcome:string}>; }
function RemoteTimer() {
  const [revision,setRevision]=useState(0);
  const [room,setRoom]=useState<TimerRoom>(()=>localStorage.getItem('kmc.timer-room')==='b'?'b':'main');
  const {state,connected,pairing,offset,unavailable}=useRemoteTimers(revision,room);
  const commands=roomApi(room);
  const [programme,setProgramme]=useState(false);
  const [deviceName,setDeviceName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const [install,setInstall]=useState<InstallPrompt|null>(null),[standalone,setStandalone]=useState(matchMedia('(display-mode: standalone)').matches);
  const meeting=state?.meeting,now=useClock(!!meeting?.parts.some(p=>p.running))+offset;
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
  return <div className="rc">
    <header className="rc-head"><span className="rc-title-top">⏱ Cronômetros</span><span className={`rc-dot ${connected?'on':''}`} title={connected?'Conectado':'Sem conexão'} /></header>
    <nav className="rc-rooms" aria-label="Sala dos cronômetros">{(['main','b'] as const).map(value=><button key={value} aria-pressed={room===value} className={room===value?'':'secondary'} disabled={busy || programme} onClick={()=>{setRoom(value);localStorage.setItem('kmc.timer-room',value);setError(null);}}>{value==='b'?'Sala B':'Salão principal'}</button>)}</nav>
    {!standalone && (install?<button className="secondary rc-install" onClick={async()=>{await install.prompt();await install.userChoice;setInstall(null);}}>Instalar no celular</button>
      :<details className="rc-install"><summary>Instalar como aplicativo</summary><p className="small muted">Android: menu do navegador → Instalar aplicativo. iPhone: Compartilhar → Adicionar à Tela de Início. Use o link HTTPS fixo configurado no computador.</p></details>)}
    {error && <div className="rc-err" role="alert">{error}</div>}
    {pairing ? <form className="rc-pair" onSubmit={pair}><h2>Conectar este aparelho</h2><p>Acesse os cronômetros sem código. O painel do operador permite revogar os aparelhos conectados.</p>
      <label>Nome do aparelho (obrigatório)<input aria-label="Nome do aparelho" required autoComplete="off" maxLength={80} placeholder="Ex.: João — Sala B" value={deviceName} onChange={e=>setDeviceName(e.target.value)} /></label>
      <span className="small muted">Informe quem está utilizando para identificar o acesso no painel.</span>
      <button disabled={busy || !deviceName.trim()}>{busy?'Conectando…':'Conectar este aparelho'}</button></form>
      : !state ? <div className="rc-wait"><p>{!unavailable && navigator.onLine?'Conectando ao computador do Salão…':'Sem conexão. Conecte-se à internet para controlar os cronômetros.'}</p><button className="secondary" onClick={()=>setRevision(n=>n+1)}>Tentar novamente</button></div>
      : <>
        {!connected && <div className="rc-err" role="status">Sem conexão. Comandos desativados até reconectar.</div>}
        <div className="rc-tools"><button className="secondary" disabled={!connected || busy} onClick={()=>setProgramme(true)}>Programação e nomes</button><ShareTimerImage key={room} state={state} now={now} disabled={!connected || busy} onError={setError} /></div>
        {room==='b' && <p className="small muted">Controle interno · dirigente e ajudante · independente do salão principal</p>}
        {(state.period?.weekLabel || meeting?.weekLabel) && <div className="rc-week"><b>{state.period?.weekLabel || meeting?.weekLabel}</b>{state.period?.dateLabel && <div>{meeting?.kind==='weekend'?'Fim de semana':'Meio de semana'} · {state.period.dateLabel}</div>}</div>}
        {state.period?.matchesMainWeek===false && <div className="rc-err" role="status">A Sala B está em outra semana. Se houver um cronômetro em execução, pause-o para carregar a semana do salão principal.</div>}
        {active && <div className="rc-active"><ActivePart part={active} now={now} warnSeconds={state.warnSeconds} busy={busy || !connected} run={run} commands={commands} /></div>}
        <ul className="rc-list">{meeting?.parts.map(part=> {
          const elapsed=elapsedSec(part,now),remaining=part.allottedSec-elapsed;
          return <li key={part.id} className={`rc-row ${part.id===meeting.activePartId?'active':''}`}>
            <button className="rc-rowmain" disabled={busy || !connected} onClick={()=>void run(()=>commands.active(part.id))}><span className="rc-sec">{part.section}</span><span className="rc-rowtitle">{part.title}</span><span className="small muted">{[state.details?.assignments[part.id]?.name,state.details?.assignments[part.id]?.secondName].filter(Boolean).join(' / ')}</span></button>
            <span className={`rc-rem ${remaining<0?'over':''}`}>{fmtClock(part.allottedSec>0?remaining:elapsed)}</span>
            <button className={`rc-btn ${part.running?'pause':'play'}`} aria-label={part.running?'Pausar':'Iniciar'} disabled={busy || !connected} onClick={()=>void run(()=>part.running?commands.pause(part.id):commands.start(part.id))}>{part.running?'❚❚':'▶'}</button>
            <button className="rc-btn reset" aria-label="Zerar" disabled={busy || !connected} onClick={()=>void run(()=>commands.reset(part.id))}>↺</button>
          </li>;
        })}</ul>
        {!meeting?.parts.length && <p className="rc-empty">{room==='b'?'Importe o PDF em “Programação e nomes”. Todas as datas serão preparadas automaticamente.':'O operador ainda não carregou a reunião.'}</p>}
        {programme && connected && <RemoteProgrammePanel key={room} room={room} state={state} close={()=>setProgramme(false)} changed={()=>{}} />}
      </>}
  </div>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><RemoteTimer /></React.StrictMode>);
