import type { MeetingPart } from "@kmc/shared-types";
import { useLiveState } from "./useLiveState.js";
import { useClock, elapsedSec, fmtClock } from "./timer.js";

const STATE_LABEL: Record<string, string> = {
  STOPPED: "Parado",
  INITIALIZING: "Iniciando",
  AUTH_REQUIRED: "Login necessário",
  AUTHENTICATED: "Pronto",
  JOINING: "Entrando",
  IN_MEETING: "Reunião ao vivo",
  SHARING: "Reunião ao vivo",
  RECONNECTING: "Reconectando",
  ERROR: "Sem conexão",
};

function phase(remaining: number, allotted: number, warn: number): string {
  if (allotted <= 0) return "idle";
  if (remaining < 0) return "over";
  if (remaining <= warn) return "warn";
  return "ok";
}

/**
 * READ-ONLY tribune view (10" touchscreen). Shows the per-part timers extracted
 * from wol.jw.org, with the current part's countdown big, plus the raised-hands
 * queue. Controlled entirely from the operator's PC.
 */
export function TabletView() {
  const { connected, snapshot } = useLiveState();
  const meeting = snapshot?.meeting;
  const anyRunning = !!meeting?.parts.some((p) => p.running);
  const now = useClock(anyRunning);
  const warn = snapshot?.settings.meetingSchedule.warnSeconds ?? 60;

  const status = snapshot?.status;
  const hands = snapshot?.raisedHands;
  const live = status?.state === "IN_MEETING" || status?.state === "SHARING";
  const active: MeetingPart | null =
    meeting?.parts.find((p) => p.id === meeting.activePartId) ?? null;

  const activeRemaining = active ? active.allottedSec - elapsedSec(active, now) : 0;
  const activePhase = active ? phase(activeRemaining, active.allottedSec, warn) : "idle";
  const activePct =
    active && active.allottedSec > 0
      ? Math.min(100, (elapsedSec(active, now) / active.allottedSec) * 100)
      : 0;

  return (
    <div className="t-wrap">
      <header className="t-top">
        <div className={`t-live ${live ? "on" : "off"}`}>
          <span className="t-dot" />
          {status ? STATE_LABEL[status.state] ?? status.state : connected ? "Aguardando" : "Conectando…"}
        </div>
        <div className="t-week">{meeting?.weekLabel || "—"}</div>
        <div className="t-count">
          <strong>{status?.participantCount ?? 0}</strong> part.
        </div>
      </header>

      {active ? (
        <section className={`t-active ph-${activePhase}`}>
          <div className="t-active-sec">{active.section}</div>
          <div className="t-active-title">{active.title}</div>
          <div className="t-bigclock">
            {active.allottedSec > 0 ? fmtClock(activeRemaining) : fmtClock(elapsedSec(active, now))}
          </div>
          {active.allottedSec > 0 && (
            <div className="t-bar">
              <div className="t-barfill" style={{ width: `${activePct}%` }} />
            </div>
          )}
          {!active.running && <div className="t-paused">pausado</div>}
        </section>
      ) : (
        <section className="t-active idle">
          <div className="t-active-title">{meeting?.loading ? "Carregando reunião…" : "Reunião não iniciada"}</div>
        </section>
      )}

      {meeting && meeting.parts.length > 0 && (
        <section className="t-parts">
          {meeting.parts.map((p) => {
            const el = elapsedSec(p, now);
            const rem = p.allottedSec - el;
            const ph = phase(rem, p.allottedSec, warn);
            const isActive = p.id === meeting.activePartId;
            return (
              <div key={p.id} className={`t-part ${isActive ? "active" : ""} ph-${ph}`}>
                <span className="t-part-title">{p.title}</span>
                <span className={`t-part-rem ph-${ph}`}>
                  {p.allottedSec > 0 ? fmtClock(rem) : fmtClock(el)}
                </span>
              </div>
            );
          })}
        </section>
      )}

      {hands && hands.order.length > 0 && (
        <section className="t-hands">
          <h2>Mãos levantadas <span className="t-badge">{hands.order.length}</span></h2>
          <ol className="t-queue">
            {hands.order.slice(0, 5).map((p, i) => (
              <li key={p.id} className={i === 0 ? "t-first" : ""}>
                <span className="t-pos">{i + 1}</span>
                <span className="t-name">{p.displayName}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
