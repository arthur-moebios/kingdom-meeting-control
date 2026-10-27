import { useLiveState } from "./useLiveState.js";

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

/** Minutes:seconds since an ISO timestamp. */
function since(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/**
 * READ-ONLY view for the 10" tribune touchscreen. Consumes the viewer API/WS
 * only — it has no control actions (join/leave/share/settings are impossible
 * with a viewer token). Focused on the raised-hands queue, which is what the
 * person at the tribune needs to see.
 */
export function TabletView() {
  const { connected, snapshot } = useLiveState();

  const status = snapshot?.status;
  const hands = snapshot?.raisedHands;
  const live = status?.state === "IN_MEETING" || status?.state === "SHARING";

  return (
    <div className="t-wrap">
      <header className="t-top">
        <div className={`t-live ${live ? "on" : "off"}`}>
          <span className="t-dot" />
          {status ? STATE_LABEL[status.state] ?? status.state : (connected ? "Aguardando" : "Conectando…")}
        </div>
        <div className="t-count">
          <strong>{status?.participantCount ?? 0}</strong> participantes
        </div>
      </header>

      <main className="t-hands">
        <h2>
          Mãos levantadas
          {hands && hands.order.length > 0 && <span className="t-badge">{hands.order.length}</span>}
        </h2>

        {hands && hands.order.length > 0 ? (
          <ol className="t-queue">
            {hands.order.map((p, i) => (
              <li key={p.id} className={i === 0 ? "t-first" : ""}>
                <span className="t-pos">{i + 1}</span>
                <span className="t-name">{p.displayName}</span>
                <span className="t-time">{since(p.handRaisedAt)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="t-empty">Ninguém com a mão levantada</div>
        )}

        {hands?.partial && <p className="t-note">Lista parcial (reunião grande)</p>}
      </main>

      <footer className="t-foot">
        {status?.meetingId ? `Reunião ${status.meetingId}` : "—"} · ordem aproximada por detecção
      </footer>
    </div>
  );
}
