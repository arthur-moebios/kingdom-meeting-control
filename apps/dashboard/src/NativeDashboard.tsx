import { useEffect, useState } from "react";

interface NativePerson {
  id: string; displayName: string; handRaised: boolean | null; handRaisedAt?: string | null;
  isHost: boolean | null; isCoHost: boolean | null; isMuted: boolean | null;
}
interface NativePollResult {
  pollId: string; questionId: string; pollName: string; question: string; totalVoted: number;
  attendanceTotal: number | null; countsConsistent: boolean;
  options: { label: string; votes: number; percent: number | null }[];
}
interface NativeSnapshot {
  observedAt: string; partial: boolean; stale?: boolean; error?: string;
  participants: NativePerson[]; waitingRoom: NativePerson[];
  raisedHands: { order: NativePerson[]; partial: boolean };
  polls?: { error?: string; normalizedResults?: NativePollResult[] };
}
interface NativeAutomations {
  phase: string; meetingId: string; autoShare: boolean; autoAdmit: boolean;
  message: string; share: string; waiting: number | null; lastError?: string;
}

export function NativeDashboard() {
  const [snapshot, setSnapshot] = useState<NativeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [automation, setAutomation] = useState<NativeAutomations | null>(null);
  const [meetingId, setMeetingId] = useState('');
  const [autoShare, setAutoShare] = useState(true);
  const [autoAdmit, setAutoAdmit] = useState(true);
  const [saving, setSaving] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const configure = async (disable = false) => {
    setSaving(true); setControlError(null);
    try {
      const response = await fetch('/api/v1/native/automations', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetingId: disable ? automation?.meetingId : meetingId, autoShare: !disable && autoShare, autoAdmit: !disable && autoAdmit }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setAutomation(result);
    } catch (e) { setControlError(e instanceof Error ? e.message : 'Falha ao ativar automações'); }
    finally { setSaving(false); }
  };
  useEffect(() => {
    let closed = false, running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const control = await fetch('/api/v1/native/automations', { cache: 'no-store' });
        if (control.ok && !closed) setAutomation(await control.json());
        const response = await fetch("/api/v1/native/snapshot", { cache: "no-store" });
        const data = await response.json();
        if (closed) return;
        if (!response.ok) { setError(data.error || "Aguardando a reunião do Zoom"); return; }
        setSnapshot(data);
        setError(data.stale ? "Leitura desatualizada. Aguardando o Zoom…" : data.error || null);
      } catch { if (!closed) setError("Aguardando conexão com o painel…"); }
      finally { running = false; }
    };
    void tick();
    const timer = setInterval(() => void tick(), 750);
    return () => { closed = true; clearInterval(timer); };
  }, []);
  const hands = snapshot?.raisedHands.order || [];
  return <main className="app native-panel">
    <header className="appbar"><div><h1>Painel do operador</h1><div className="brand-sub">Zoom nativo · experimental</div></div>
      <span className="statuschip">{snapshot && !error ? "Conectado" : "Aguardando"}</span></header>
    {error && <div className="banner-err" role="status">{error}</div>}
    <section className="card2">
      <div className="card2-head"><span className="card2-title">Automações</span></div>
      <label>ID da reunião <input aria-label="ID da reunião" inputMode="numeric" value={meetingId}
        onChange={event => setMeetingId(event.target.value.replace(/\D/g, ''))} placeholder={automation?.meetingId || 'ID da reunião aberta'} /></label>
      <label style={{ display: 'block', marginTop: 12 }}><input type="checkbox" checked={autoShare} onChange={event => setAutoShare(event.target.checked)} /> Compartilhar mídia do JW automaticamente</label>
      <label style={{ display: 'block', marginTop: 12 }}><input type="checkbox" checked={autoAdmit} onChange={event => setAutoAdmit(event.target.checked)} /> Admitir automaticamente da espera</label>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button disabled={saving || !/^\d{9,11}$/.test(meetingId)} onClick={() => void configure()}>Ativar / aplicar</button>
        <button disabled={saving || !['running', 'starting', 'stopping'].includes(automation?.phase || '')} onClick={() => void configure(true)}>Desativar</button>
      </div>
      <p className="small" role="status">{automation?.message || 'Consultando automações…'}</p>
      {automation?.phase === 'running' && <p className="small muted">Mídia: {automation.autoShare ? 'automática' : 'desativada'} · Admissão: {automation.autoAdmit ? 'automática' : 'desativada'} · Sala {automation.meetingId}</p>}
      {controlError && <p className="banner-err">{controlError}</p>}
      {automation?.lastError && <p className="banner-err">{automation.lastError}</p>}
    </section>
    <section className="card2 native-summary">
      <div><b>{snapshot?.participants.length ?? "—"}</b><span>participantes</span></div>
      <div><b>{hands.length}</b><span>mãos levantadas</span></div>
      <div><b>{snapshot?.waitingRoom.length ?? "—"}</b><span>na espera</span></div>
    </section>
    <section className="card2"><div className="card2-head"><span className="card2-title">Mãos levantadas</span></div>
      {hands.length === 0 ? <p className="muted">Nenhuma mão levantada na última leitura.</p> :
        <ol className="native-hands">{hands.map(person => <li key={person.id}>{person.displayName}</li>)}</ol>}
      {snapshot?.raisedHands.partial && <p className="muted small">Leitura parcial</p>}
    </section>
    {(snapshot?.polls?.normalizedResults || []).map(poll => <section className="card2" key={`${poll.pollId}:${poll.questionId}`}>
      <div className="card2-head"><span className="card2-title">{poll.pollName}</span><span className="muted small">{poll.totalVoted} respostas</span></div>
      <p className="small muted">{poll.question}</p>
      {poll.attendanceTotal !== null && <div className="pollres-attend"><span className="pollres-attend-label">Assistência<br />total</span>
        <strong className="pollres-attend-num">{poll.attendanceTotal}</strong></div>}
      <ul className="pollres-opts">{poll.options.map((option, i) => <li key={i} className="pollres-opt">
        <span className="pollres-opt-label">{option.label}</span>
        <span className="pollres-bar"><span className="pollres-barfill" style={{ width: `${option.percent ?? 0}%` }} /></span>
        <span className="pollres-opt-val">{poll.attendanceTotal !== null ? `${option.votes} × ${option.label} = ${option.votes * Number(option.label)}` : `${option.votes} respostas`}</span>
      </li>)}</ul>
      {!poll.countsConsistent && <p className="muted small">Resultado parcial ou tipo de pergunta ainda não validado.</p>}
    </section>)}
    {snapshot?.polls?.error && <section className="card2 muted">Enquetes temporariamente indisponíveis</section>}
    <details className="card2"><summary>Participantes</summary><ul className="native-roster">
      {(snapshot?.participants || []).map(person => <li key={person.id}><span>{person.displayName || "Nome oculto"}
        {person.isHost && <small> · Anfitrião</small>}{person.isCoHost && <small> · Coanfitrião</small>}</span>
        <span className="muted small">{person.isMuted === null ? "Áudio desconhecido" : person.isMuted ? "Mudo" : "Microfone aberto"}</span></li>)}
    </ul></details>
    <p className="muted small">Atualização: {snapshot ? new Date(snapshot.observedAt).toLocaleTimeString() : "aguardando"}</p>
  </main>;
}
