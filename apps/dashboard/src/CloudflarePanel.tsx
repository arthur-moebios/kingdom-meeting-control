import { useEffect, useState } from 'react';
import type { RemoteIntegrationStatus } from '@kmc/shared-types';
import { api } from './api.js';

const phases:Record<string,string>={disabled:'Desativado',authorizing:'Aguardando autorização no navegador',connecting:'Conectando',publishing:'Publicando e verificando o endereço…',connected:'Conectado · Link público verificado',error:'Não conectado'};
export function CloudflarePanel() {
  const [state,setState]=useState<RemoteIntegrationStatus|null>(null),[url,setUrl]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const refresh=()=>api.remoteStatus().then(value=> {setState(value);setUrl(previous=>previous || value.publicUrl);});
  useEffect(()=> {void refresh().catch(()=>{});const timer=setInterval(()=>void refresh().catch(()=>{}),2000);return()=>clearInterval(timer);},[]);
  const run=async(fn:()=>Promise<unknown>)=> {setBusy(true);setError('');try{await fn();await refresh();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  return <fieldset className="cloudflare-panel"><legend>Cloudflare · Link fixo do celular</legend>
    <p className="small muted">O conector já faz parte do app. Autorize uma conta com domínio cadastrado no Cloudflare e escolha um subdomínio disponível. O túnel acompanha a inicialização e o fechamento deste app.</p>
    <p className="small"><b>{state?phases[state.phase] || state.phase:'Carregando…'}</b>{state?.authorized?' · Conta autorizada':''}</p>
    {!state?.bundled && state && <p className="err small">Esta instalação não contém cloudflared. Atualize o pacote Windows.</p>}
    {state && !state.gatewayAvailable && <p className="err small">Gateway mobile indisponível. Reinicie o app e confira a porta {state.gatewayPort}.</p>}
    {!state?.authorized && <div className="actions"><button disabled={busy || !state?.bundled} onClick={()=>void run(api.cloudflareAuthorize)}>1. Autorizar Cloudflare</button>
      {state?.authorizationUrl && <a className="btn secondary" href={state.authorizationUrl} target="_blank" rel="noreferrer">Abrir autorização</a>}</div>}
    <label className="fieldrow"><span>Endereço fixo</span><input type="url" placeholder="https://cronometro.seudominio.com" value={url} onChange={e=>setUrl(e.target.value)} /></label>
    <div className="actions"><button disabled={busy || state?.busy || !state?.authorized || !url || !state.gatewayAvailable} onClick={()=>void run(()=>api.cloudflareSetup(url))}>{busy || state?.busy?'Configurando…':'2. Criar e ativar link fixo'}</button>
      {state?.configured && <button className="secondary" disabled={busy} onClick={()=>void run(()=>api.cloudflareEnabled(!state.enabled))}>{state.enabled?'Desativar túnel':'Ativar túnel'}</button>}</div>
    {state?.publicUrl && <p className="small remote-fixed-url">{state.phase==='connected'
      ?<a href={state.publicUrl+'/remote.html'} target="_blank" rel="noreferrer">{state.publicUrl}/remote.html</a>
      :<><code>{state.publicUrl}/remote.html</code><br/>Aguarde a confirmação do link antes de abrir no celular.</>}</p>}
    {(error || state?.error) && <p className="err small" role="alert">{error || state?.error}</p>}
    <p className="small muted">Abra o link no celular e toque em “Conectar este aparelho”, sem código. Em “Celular” no painel, você pode revogar os aparelhos individualmente ou todos de uma vez. O computador precisa permanecer ligado e conectado.</p>
  </fieldset>;
}
