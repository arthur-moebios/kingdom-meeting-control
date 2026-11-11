import { useEffect, useState } from 'react';
import type { DeviceAccess, RemoteDeviceInfo } from '@kmc/shared-types';
import { devicesApi } from './remoteApi.js';

const ACCESS: [DeviceAccess, string][] = [['readonly', 'Somente leitura'], ['main', 'Salão principal'], ['b', 'Sala B'], ['both', 'Ambas as salas']];
const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR'); };

/** Em Mais, para quem tem o papel Painel: libera ou bloqueia os outros aparelhos sem ir ao computador. */
export function RemoteDevices({ connected, onError }: { connected: boolean; onError: (m: string | null) => void }) {
  const [list, setList] = useState<RemoteDeviceInfo[] | null>(null), [busy, setBusy] = useState(false);
  const fail = (e: unknown) => onError(e instanceof Error ? e.message : String(e));
  useEffect(() => { if (connected) devicesApi.list().then(setList).catch(fail); }, [connected]);
  async function change(body: Parameters<typeof devicesApi.update>[0]) {
    setBusy(true); onError(null);
    try { setList(await devicesApi.update(body)); } catch (e) { fail(e); } finally { setBusy(false); }
  }
  if (!list) return null;
  return <div className="rc-devices">
    <h2>Aparelhos conectados ({list.length})</h2>
    <p className="small muted">Painel libera mãos levantadas, anúncios, mídias e esta lista.</p>
    <ul className="rc-list">{list.map(d => <li key={d.id} className="rc-row rc-row-plain rc-device">
      <div className="rc-rowmain"><span className="rc-rowtitle rc-wrap">{d.label}{d.self ? ' (este aparelho)' : ''}</span><span className="small muted">desde {when(d.createdAt)}</span></div>
      <select aria-label={`Permissão de ${d.label}`} value={d.access} disabled={busy || !connected} onChange={e => void change({ id: d.id, access: e.target.value as DeviceAccess })}>
        {ACCESS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <label className="rc-device-painel"><input type="checkbox" checked={d.painel} disabled={busy || !connected || d.self} onChange={e => void change({ id: d.id, painel: e.target.checked })} /> Painel</label>
    </li>)}</ul>
  </div>;
}
