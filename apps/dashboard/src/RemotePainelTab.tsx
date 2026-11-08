import type { RemoteTimerState } from '@kmc/shared-types';
import { elapsedSec, fmtClock } from './timer.js';

/** Minutos entre a detecção da mão (relógio do servidor) e o envio deste estado. */
function detectedAgo(at: string | null, serverNow: string): string | null {
  if (!at) return null;
  const min = Math.floor((Date.parse(serverNow) - Date.parse(at)) / 60_000);
  if (!Number.isFinite(min)) return null;
  return min <= 0 ? 'detectada agora' : `detectada há cerca de ${min} min`;
}

/** Aba Painel (somente leitura): cronômetro ativo, mãos levantadas e anúncios — o mesmo do app da tribuna. */
export function RemotePainelTab({ state, now, connected }: { state: RemoteTimerState; now: number; connected: boolean }) {
  const painel = state.painel;
  if (!painel) return null;
  const meeting = state.meeting, active = meeting.parts.find(p => p.id === meeting.activePartId);
  const hands = painel.raisedHands, att = painel.attendance;
  return <div className="rc-painel">
    {!connected && <div className="rc-err" role="status">Sem conexão. Os dados abaixo podem estar desatualizados.</div>}
    <section className="rc-card" aria-label="Parte atual">
      <h2>Parte atual</h2>
      {active ? <>
        <div className="rc-sec">{active.section}</div><div className="rc-painel-title">{active.title}</div>
        <div className={`rc-painel-clock${active.allottedSec - elapsedSec(active, now) < 0 ? ' over' : ''}`}>{fmtClock(active.allottedSec > 0 ? active.allottedSec - elapsedSec(active, now) : elapsedSec(active, now))}</div>
        <div className="small muted">{active.running ? 'Em andamento' : 'Pausado'} · tempo previsto {fmtClock(active.allottedSec)}</div>
      </> : <p className="muted">Reunião não iniciada.</p>}
    </section>
    <section className="rc-card" aria-label="Mãos levantadas">
      <h2>Mãos levantadas ({hands.order.length})</h2>
      {hands.order.length === 0 ? <p className="muted">Ninguém com a mão levantada.</p> : <ol className="rc-hands">{hands.order.map((h, i) => <li key={h.id}><span className="rc-hand-pos">{i + 1}</span><span className="rc-hand-name">{h.displayName}</span>{detectedAgo(h.handRaisedAt, state.serverNow) && <span className="small muted">{detectedAgo(h.handRaisedAt, state.serverNow)}</span>}</li>)}</ol>}
      <p className="small muted">{hands.orderSource === 'zoom-native' ? 'Ordem informada pelo Zoom.' : 'A ordem segue o momento em que o computador do Salão detectou cada mão; não é o horário exato em que a pessoa a levantou.'}</p>
      {hands.partial && <p className="small rc-warning" role="status">Lista parcial (reunião grande): pode haver outras mãos levantadas que não aparecem aqui.</p>}
    </section>
    <section className="rc-card" aria-label="Anúncios">
      <h2>Anúncios da reunião</h2>
      {painel.announcements.trim() ? <div className="rc-announce">{painel.announcements}</div> : <p className="muted">Nenhum anúncio cadastrado.</p>}
    </section>
    <section className="rc-card" aria-label="Assistência de hoje">
      <h2>Assistência de hoje</h2>
      {att ? <p>Presencial <b>{att.presencial}</b> · Zoom <b>{att.zoom ?? '—'}</b> · Total <b>{att.total}</b></p> : <p className="muted">Ainda sem registro hoje.</p>}
    </section>
    <p className="small muted">Esta tela mostra nomes de participantes. Não compartilhe capturas dela.</p>
  </div>;
}
