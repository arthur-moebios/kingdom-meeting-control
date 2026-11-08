import { useEffect, useState } from 'react';
import type { UpdateStatus, UpdateApplyResult } from '@kmc/shared-types';
import { api } from './api.js';

interface ApplyFailure { message: string; installerPath?: string; logPath?: string }

/** A API responde "<status> {json}"; extrai a mensagem e os caminhos de emergência. */
export function parseApplyError(e: unknown): ApplyFailure {
  const raw = (e instanceof Error ? e.message : String(e)).replace(/^\d+\s*/, '');
  try {
    const j = JSON.parse(raw) as { error?: string; installerPath?: string; logPath?: string };
    if (j && typeof j.error === 'string') return { message: j.error, installerPath: j.installerPath, logPath: j.logPath };
  } catch { /* texto simples */ }
  return { message: raw };
}

/** Aviso discreto de atualização no cabeçalho do operador. */
export function UpdateNotice() {
  const [info, setInfo] = useState<UpdateStatus | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'started'>('idle'), [error, setError] = useState<ApplyFailure | null>(null);
  const [started, setStarted] = useState<UpdateApplyResult | null>(null);
  useEffect(() => { api.updateStatus().then(setInfo).catch(() => void 0); }, []);
  if (!info) return null;
  async function apply() {
    if (!window.confirm('Baixar e instalar a nova versão? O app será fechado e reaberto.')) return;
    setState('busy'); setError(null);
    try { setStarted(await api.updateApply()); setState('started'); }
    catch (e) { setState('idle'); setError(parseApplyError(e)); }
  }
  if (state !== 'idle') return <span className="small" role="status">{state === 'busy' ? 'Baixando e verificando a atualização…' : 'Atualização iniciada: o app será fechado, instalado e reaberto automaticamente.'}
    {started && state === 'started' && <><br />Se o app não reabrir em alguns minutos, veja o log em <code>{started.logPath}</code> ou execute o instalador <code>{started.installerPath}</code> à mão.</>}</span>;
  if (info.available) return <span className="small" role="status">Atualização disponível: {info.current} → {info.latest}{' '}
    <button className="secondary small" onClick={() => void apply()}>Atualizar agora</button>
    {error && <span role="alert" style={{ color: '#b91c1c' }}> {error.message}
      {error.installerPath && <><br />O instalador já foi baixado em <code>{error.installerPath}</code>. Feche o app e execute-o à mão.</>}
      {error.logPath && <><br />Log: <code>{error.logPath}</code></>}</span>}</span>;
  return <span className="small muted" title={info.error ?? undefined}>Atualizado (versão {info.current})</span>;
}
