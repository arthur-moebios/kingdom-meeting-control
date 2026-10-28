import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { api } from "./api.js";
import { useLiveState } from "./useLiveState.js";
import { ActivePart } from "./MeetingPanel.js";
import { useClock, elapsedSec, fmtClock } from "./timer.js";
import "./styles.css";

/** Mobile-first remote control for the meeting timers. Served at /remote.html,
 *  opened by scanning the QR shown in the operator panel. Anyone on the LAN can
 *  trigger start / pause / next / reset — state is shared live via the WS. */
function RemoteTimer() {
  const { connected, snapshot } = useLiveState();
  const meeting = snapshot?.meeting ?? null;
  const warn = snapshot?.settings.meetingSchedule.warnSeconds ?? 60;
  const anyRunning = meeting?.parts.some((p) => p.running) ?? false;
  const now = useClock(anyRunning);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!snapshot || !meeting) {
    return <div className="rc"><div className="rc-wait">Conectando ao Salão…</div></div>;
  }
  const active = meeting.parts.find((p) => p.id === meeting.activePartId) ?? null;

  return (
    <div className="rc">
      <header className="rc-head">
        <span className="rc-title-top">⏱ Controle do Cronômetro</span>
        <span className={`rc-dot ${connected ? "on" : ""}`} title={connected ? "Conectado" : "Reconectando…"} />
      </header>
      {meeting.weekLabel && <div className="rc-week">{meeting.weekLabel}</div>}
      {err && <div className="rc-err">{err}</div>}

      {active ? (
        <div className="rc-active">
          <ActivePart part={active} now={now} warnSeconds={warn} busy={busy} run={run} />
        </div>
      ) : (
        <p className="rc-empty">Toque em uma parte abaixo para torná-la a atual.</p>
      )}

      {meeting.parts.length > 0 ? (
        <ul className="rc-list">
          {meeting.parts.map((p) => {
            const el = elapsedSec(p, now);
            const rem = p.allottedSec - el;
            const isActive = p.id === meeting.activePartId;
            const over = p.allottedSec > 0 && rem < 0;
            return (
              <li key={p.id} className={`rc-row ${isActive ? "active" : ""}`}>
                <button className="rc-rowmain" disabled={busy} onClick={() => run(() => api.meetingActive(p.id))}>
                  <span className="rc-sec">{p.section}</span>
                  <span className="rc-rowtitle">{p.title}</span>
                </button>
                <span className={`rc-rem ${over ? "over" : ""}`}>{p.allottedSec > 0 ? fmtClock(rem) : fmtClock(el)}</span>
                {p.running ? (
                  <button className="rc-btn pause" disabled={busy} onClick={() => run(() => api.meetingPause(p.id))} aria-label="Pausar">❚❚</button>
                ) : (
                  <button className="rc-btn play" disabled={busy} onClick={() => run(() => api.meetingStart(p.id))} aria-label="Iniciar">▶</button>
                )}
                <button className="rc-btn reset" disabled={busy} onClick={() => run(() => api.meetingReset(p.id))} aria-label="Zerar">↺</button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rc-empty">Nenhuma parte carregada. O operador carrega a reunião no painel.</p>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RemoteTimer />
  </React.StrictMode>,
);
