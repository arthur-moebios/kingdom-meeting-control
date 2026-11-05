import { useEffect, useState } from 'react';
import type { UpdateStatus } from '@kmc/shared-types';
import { api } from './api.js';

/** Aviso discreto de atualização no cabeçalho do operador. */
export function UpdateNotice() {
  const [info, setInfo] = useState<UpdateStatus | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'started'>('idle'), [error, setError] = useState<string | null>(null);
  useEffect(() => { api.updateStatus().then(setInfo).catch(() => void 0); }, []);
  if (!info) return null;
  async function apply() {
    if (!window.confirm('Baixar e instalar a nova versão? O app será fechado e reaberto.')) return;
    setState('busy'); setError(null);
    try { await api.updateApply(); setState('started'); }
    catch (e) { setState('idle'); setError(e instanceof Error ? e.message.replace(/^\d+\s*/, '') : String(e)); }
  }
  if (state !== 'idle') return <span className="small" role="status">{state === 'busy' ? 'Baixando e instalando… o app será fechado e reaberto.' : 'Instalando… o app será fechado e reaberto.'}</span>;
  if (info.available) return <span className="small" role="status">Atualização disponível: {info.current} → {info.latest}{' '}
    <button className="secondary small" onClick={() => void apply()}>Atualizar agora</button>{error && <span style={{ color: '#b91c1c' }}> {error}</span>}</span>;
  return <span className="small muted" title={info.error ?? undefined}>Atualizado (versão {info.current})</span>;
}
