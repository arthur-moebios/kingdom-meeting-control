import { useEffect, useState } from 'react';
import { api, type MapasJwPairStatus, type MapasJwSyncStatus } from './api.js';

const fmt = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString('pt-BR') : '—';
/** O servidor responde `NNN {json}`; extrai só a mensagem legível. */
function errText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const m = raw.match(/"message"\s*:\s*"([^"]+)"/) ?? raw.match(/"error"\s*:\s*"([^"]+)"/);
  return m ? m[1]! : raw.replace(/^\d+\s*/, '');
}
const finalMsg: Record<string, string> = {
  expirada: 'A solicitação expirou (vale 30 minutos). Solicite de novo.',
  recusada: 'A solicitação foi recusada ou revogada no Mapas JW. Solicite de novo, se for o caso.',
  perdida: 'O Mapas JW aprovou, mas o KMC não recebeu o token (ele só é entregue uma vez). Revogue a aprovação no Mapas JW e solicite de novo.',
  erro: 'O Mapas JW recusou a consulta. Cancele e solicite de novo.',
};

/** Integração opcional: o KMC solicita, um gestor aprova no Mapas JW conferindo o código. */
export function MapasJwPanel() {
  const [sync, setSync] = useState<MapasJwSyncStatus | null>(null), [pair, setPair] = useState<MapasJwPairStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState(''), [nome, setNome] = useState(''), [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [loadErr, setLoadErr] = useState(false);
  const refresh = async () => {
    try { const [s, p] = await Promise.all([api.mapasjwSync(), api.mapasjwPairStatus()]); setSync(s); setPair(p); setLoadErr(false); }
    catch { setLoadErr(true); }
  };
  useEffect(() => { void refresh(); const t = setInterval(() => void refresh(), 3000); return () => clearInterval(t); }, []);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(errText(e)); } finally { setBusy(false); await refresh(); }
  };
  const connect = () => run(async () => { await api.mapasjwPair(baseUrl.trim(), nome.trim(), slug.trim()); setBaseUrl(''); setSlug(''); });
  const disconnect = () => {
    const n = sync?.pending ?? 0;
    const aviso = n > 0 ? `${n} envio(s) pendente(s) serão DESCARTADOS e não serão enviados depois. ` : 'Não há envios pendentes. ';
    if (!window.confirm(`Desconectar do Mapas JW? ${aviso}A assistência deixa de ser enviada até parear de novo. A aprovação no Mapas JW continua existindo lá até ser revogada por um gestor.`)) return;
    return run(() => api.mapasjwDisconnect());
  };

  if (loadErr && !sync) return <fieldset><legend>Mapas JW</legend><p className="small muted">Estado indisponível (requer acesso de administrador).</p></fieldset>;
  if (!sync || !pair) return <fieldset><legend>Mapas JW</legend><p className="small muted">Carregando…</p></fieldset>;

  const pending = pair.estado === 'pendente';
  const connected = sync.state === 'connected', disconnected = sync.state === 'disconnected';
  const showForm = !pending && !connected;
  const canDisconnect = sync.source === 'store' && !pending;
  const minutesLeft = pair.expiraEm ? Math.max(0, Math.ceil((Date.parse(pair.expiraEm) - Date.now()) / 60000)) : 0;

  return <fieldset className="mapasjw-panel"><legend>Mapas JW · Envio da assistência</legend>
    <p className="small muted">Integração opcional. Sem conexão, o KMC não envia nada a nenhum servidor. O KMC solicita o pareamento, um gestor aprova no Mapas JW conferindo o código abaixo e o KMC passa a enviar a assistência das reuniões.</p>

    {connected && <p className="small" role="status"><b>Conectado</b>{sync.instancia ? ` · ${sync.instancia}` : ''}{sync.source === 'env' ? ' · configurado por variáveis de ambiente' : ''}</p>}
    {disconnected && <p className="err small" role="alert"><b>Desconectado.</b> O Mapas JW recusou o token: a aprovação foi revogada no Mapas JW. O envio está pausado; é preciso parear de novo.</p>}
    {sync.state === 'disabled' && !pending && <p className="small muted">Não conectado.</p>}

    {(connected || disconnected) && <ul className="small" style={{ margin: '6px 0', paddingLeft: 18 }}>
      <li>Pendentes de envio: {sync.pending}{sync.failed > 0 ? ` · com falha permanente: ${sync.failed}` : ''}</li>
      <li>Último envio com sucesso: {fmt(sync.lastSuccessAt)}</li>
      {sync.lastError && <li className="err">Último erro ({fmt(sync.lastError.at)}): {sync.lastError.message}</li>}
    </ul>}

    {pending && <div role="status" style={{ margin: '8px 0' }}>
      <p className="small">Confira este código na tela de aprovação do Mapas JW e aprove lá:</p>
      <p style={{ fontSize: 34, fontWeight: 700, letterSpacing: '0.18em', fontFamily: 'monospace', margin: '6px 0' }} aria-label={`Código ${pair.codigo}`}>{pair.codigo}</p>
      <p className="small muted">Aguardando aprovação… expira em cerca de {minutesLeft} min{pair.nome ? ` · instalação “${pair.nome}”` : ''}.</p>
      {pair.erroTransitorio && <p className="small muted">Última consulta falhou ({pair.erroTransitorio}); tentando de novo.</p>}
      <div className="actions"><button className="secondary" disabled={busy} onClick={() => void run(() => api.mapasjwPairCancel())}>Cancelar solicitação</button></div>
    </div>}

    {!pending && pair.estado !== 'nenhum' && <p className="err small" role="alert">{pair.mensagem || finalMsg[pair.estado]}</p>}

    {showForm && <>
      <label className="fieldrow"><span>Endereço do Mapas JW</span><input type="url" placeholder="https://exemplo.invalid" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} /></label>
      <label className="fieldrow"><span>Nome desta instalação</span><input maxLength={80} placeholder="ex.: computador do som" value={nome} onChange={e => setNome(e.target.value)} /></label>
      <label className="fieldrow"><span>Identificador da congregação</span><input placeholder="exemplo" autoCapitalize="none" value={slug} onChange={e => setSlug(e.target.value)} /></label>
      <div className="actions"><button disabled={busy || !baseUrl.trim() || !nome.trim() || !slug.trim()} onClick={() => void connect()}>{busy ? 'Solicitando…' : disconnected ? 'Parear de novo' : 'Conectar'}</button></div>
    </>}

    {canDisconnect && <div className="actions"><button className="secondary" disabled={busy} onClick={() => void disconnect()}>Desconectar</button></div>}
    {sync.source === 'env' && !pending && <p className="small muted">A conexão vem de variáveis de ambiente (KMC_MAPASJW_*); remova-as do arquivo de configuração para desconectar. Parear aqui passa a ter prioridade sobre elas.</p>}
    {error && <p className="err small" role="alert">{error}</p>}
  </fieldset>;
}
