import { useEffect, useState } from 'react';
import type { AttendanceSummary } from '@kmc/shared-types';
import { roomApi } from './remoteApi.js';

export function whatsappText(a: AttendanceSummary): string {
  const [y, m, d] = a.date.split('-');
  return `Assistência — ${d}/${m}/${y}\n\n🏛️ *Presencial*: ${a.presencial}\n💻 *Zoom*: ${a.zoom ?? 0}\n\n👥 *TOTAL*: ${a.presencial + (a.zoom ?? 0)}`;
}
async function copyText(text: string): Promise<void> {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return; } } catch { /* fallback */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  const ok = document.execCommand('copy'); ta.remove();
  if (!ok) throw new Error('Não foi possível copiar.');
}

export function RemoteAttendance({ connected, canWrite, onError, standalone = false }: { connected: boolean; canWrite: boolean; onError: (m: string) => void; standalone?: boolean }) {
  const api = roomApi('main');
  const [open, setOpen] = useState(standalone), [data, setData] = useState<AttendanceSummary | null>(null);
  const [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [copied, setCopied] = useState(false);
  const apply = (r: AttendanceSummary) => { setData(r); setDraft(String(r.presencial)); };
  useEffect(() => { if (open && connected) api.attendance().then(apply).catch(e => onError(e instanceof Error ? e.message : String(e))); }, [open, connected]);
  const fail = (e: unknown) => onError(e instanceof Error ? e.message : String(e));
  async function save() {
    const n = Number(draft);
    if (!Number.isInteger(n) || n < 0 || n > 100000) { onError('Informe um número inteiro de 0 a 100000.'); return; }
    setBusy(true);
    try { apply(await api.setAttendance(n)); } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function copy() {
    if (!data) return;
    try { await copyText(whatsappText(data)); setCopied(true); setTimeout(() => setCopied(false), 3000); } catch (e) { fail(e); }
  }
  const dirty = data !== null && draft !== String(data.presencial);
  const body = <>{!data ? <p className="small muted">Carregando…</p> : <div>
      <label>Presencial <input type="number" inputMode="numeric" min={0} max={100000} value={draft} disabled={!canWrite || busy} onChange={e => setDraft(e.target.value)} /></label>
      {canWrite && <button className="secondary" disabled={busy || !connected || !dirty} onClick={() => void save()}>{busy ? 'Salvando…' : 'Salvar presencial'}</button>}
      <p>Zoom (automático): <b>{data.zoom ?? '—'}</b></p>
      <p>Total: <b>{data.total}</b></p>
      <button disabled={dirty} onClick={() => void copy()}>Copiar para WhatsApp</button>
      {copied && <p className="small" role="status">Copiado! Cole no WhatsApp.</p>}
    </div>}</>;
  if (standalone) return <section className="rc-tab-section"><h2>Assistência de hoje</h2>{body}</section>;
  return <details className="rc-install" onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
    <summary>Assistência</summary>
    {body}
  </details>;
}
