import { useEffect, useState } from "react";
import type { CapabilityStatus, MeetingSchedule } from "@kmc/shared-types";
import { api } from "./api.js";
import { useLiveState } from "./useLiveState.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { MeetingPanel, ActivePart } from "./MeetingPanel.js";
import { useClock } from "./timer.js";

const STATE_LABEL: Record<string, string> = {
  STOPPED: "Parado",
  INITIALIZING: "Inicializando",
  AUTH_REQUIRED: "Login necessário",
  AUTHENTICATED: "Autenticado",
  JOINING: "Entrando",
  IN_MEETING: "Na reunião",
  SHARING: "Compartilhando",
  RECONNECTING: "Reconectando",
  ERROR: "Erro",
};

const AVATARS = ["#3b82f6", "#ec4899", "#22c55e", "#f59e0b", "#8b5cf6", "#06b6d4"];
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATARS[Math.abs(h) % AVATARS.length]!;
}
function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

type RunNamed = (name: string, fn: () => Promise<unknown>) => Promise<void>;

function Card({
  icon,
  title,
  trailing,
  className,
  children,
}: {
  icon?: string;
  title?: string;
  trailing?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`card2 ${className ?? ""}`}>
      {title && (
        <div className="card2-head">
          <span className="card2-title">
            {icon && <span className="card2-ico">{icon}</span>}
            {title}
          </span>
          {trailing}
        </div>
      )}
      {children}
    </section>
  );
}

const TABS = [
  { key: "painel", label: "Painel", icon: "🏠" },
  { key: "cron", label: "Cronômetro", icon: "⏱" },
  { key: "anuncios", label: "Anúncios", icon: "📣" },
  { key: "pessoas", label: "Participantes", icon: "👥" },
  { key: "mais", label: "Mais", icon: "⋯" },
];

export function App() {
  const { connected, snapshot, lastEvent, reconnect } = useLiveState();
  const [tab, setTab] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const run: RunNamed = async (name, fn) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const s = snapshot;
  const status = s?.status;

  return (
    <div className="app">
      <header className="appbar">
        <div className="brand">
          <div className="brand-logo">📖</div>
          <div>
            <h1>Salão do Reino</h1>
            <div className="brand-sub">Painel do Operador</div>
          </div>
        </div>
        <div className="headright">
          <HeaderStatus connected={connected} state={status?.state ?? null} />
          <Clock />
          <button className="iconbtn" title="Configurações" onClick={() => setShowSettings(true)}>⚙</button>
          <button
            className="iconbtn danger"
            title="Encerrar"
            disabled={!!busy}
            onClick={() => {
              if (window.confirm("Encerrar o Kingdom Meeting Control? O painel e o tablet vão desconectar.")) {
                run("shutdown", () => api.shutdown());
              }
            }}
          >
            ⏻
          </button>
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t, i) => (
          <button key={t.key} className={`tab ${i === tab ? "active" : ""}`} onClick={() => setTab(i)}>
            <span className="tab-ico">{t.icon}</span>
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
      </nav>

      {error && <div className="banner-err">{error}</div>}

      <main className="tabarea">
        {!s ? (
          <Card className="center"><p className="muted">Conectando ao servidor…</p></Card>
        ) : tab === 0 ? (
          <PainelTab s={s} busy={busy} run={run} />
        ) : tab === 1 ? (
          <MeetingPanel meeting={s.meeting} warnSeconds={s.settings.meetingSchedule.warnSeconds} />
        ) : tab === 2 ? (
          <AnunciosTab value={s.settings.tablet.announcements} busy={!!busy} run={run} />
        ) : tab === 3 ? (
          <PessoasTab s={s} busy={busy} run={run} />
        ) : (
          <MaisTab s={s} busy={busy} run={run} reconnect={reconnect} lastEvent={lastEvent} openSettings={() => setShowSettings(true)} />
        )}
      </main>

      {showSettings && (
        <SettingsPanel displays={s?.displays ?? []} onClose={() => setShowSettings(false)} onSaved={reconnect} />
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- Painel */
function PainelTab({ s, busy, run }: { s: NonNullable<ReturnType<typeof useLiveState>["snapshot"]>; busy: string | null; run: RunNamed }) {
  const status = s.status;
  const inMeeting = status.state === "IN_MEETING" || status.state === "SHARING";
  const meeting: MeetingSchedule = s.meeting;
  const anyRunning = meeting.parts.some((p) => p.running);
  const now = useClock(anyRunning);
  const active = meeting.parts.find((p) => p.id === meeting.activePartId) ?? null;
  const localRun = async (fn: () => Promise<unknown>) => { await run("timer", fn); };

  return (
    <div className="stack">
      {/* Reunião — status + ação */}
      <Card icon="🎥" title="Reunião" className="reuniao">
        <div className="reuniao-row">
          <div className="reuniao-state">
            {!status
              ? "Conectando…"
              : status.state === "INITIALIZING"
                ? "Iniciando o navegador…"
                : status.state === "RECONNECTING"
                  ? "Reconectando…"
                  : !status.authenticated
                    ? "Faça login no Zoom na janela do Chromium (uma vez)."
                    : inMeeting
                      ? "✓ Na reunião"
                      : "Pronto para entrar."}
          </div>
          {inMeeting ? (
            <button className="btn danger" disabled={!!busy} onClick={() => run("leave", () => api.leave())}>Sair</button>
          ) : (
            <button className="btn big" disabled={!!busy || status.state === "INITIALIZING"} onClick={() => run("join", () => api.join())}>▶ Entrar</button>
          )}
        </div>
        <div className="minirow">
          <MiniStat label="Compartilhando" on={status.sharing} yes="sim" no="não" />
          <MiniStat label="JW projetando" on={s.presentation.presentationActive} yes="sim" no="não" />
        </div>
      </Card>

      {/* Parte atual — cronômetro grande */}
      <Card icon="⏱" title={`Parte atual${meeting.weekLabel ? ` · ${meeting.weekLabel}` : ""}`}>
        {active ? (
          <ActivePart part={active} now={now} warnSeconds={s.settings.meetingSchedule.warnSeconds} busy={!!busy} run={localRun} />
        ) : (
          <p className="muted big-empty">Reunião não iniciada. Abra o <b>Cronômetro</b> para carregar as partes.</p>
        )}
      </Card>

      {/* Mãos levantadas */}
      <HandsCard s={s} busy={busy} run={run} />
    </div>
  );
}

function MiniStat({ label, on, yes, no }: { label: string; on: boolean | null; yes: string; no: string }) {
  const color = on === null ? "#9ca3af" : on ? "#22c55e" : "#64748b";
  return (
    <div className="ministat">
      <span className="dot" style={{ background: color }} />
      <span className="ministat-label">{label}</span>
      <span className="ministat-val">{on === null ? "—" : on ? yes : no}</span>
    </div>
  );
}

/* ----------------------------------------------------------------- Anúncios */
function AnunciosTab({ value, busy, run }: { value: string; busy: boolean; run: RunNamed }) {
  const [text, setText] = useState(value);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setText(value); }, [value, dirty]);
  return (
    <Card icon="📣" title="Anúncios (enviados ao tablet)" trailing={dirty ? <span className="muted small">não salvo</span> : undefined}>
      <textarea
        className="annedit"
        value={text}
        rows={10}
        placeholder="Escreva os anúncios da reunião…"
        onChange={(e) => { setText(e.target.value); setDirty(true); }}
      />
      <div className="actions">
        <button className="btn" disabled={busy} onClick={() => { run("ann", () => api.putSettings({ tablet: { announcements: text } })); setDirty(false); }}>
          Salvar e enviar
        </button>
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------------- Participantes */
function PessoasTab({ s, busy, run }: { s: NonNullable<ReturnType<typeof useLiveState>["snapshot"]>; busy: string | null; run: RunNamed }) {
  return (
    <div className="stack">
      <Card icon="👥" title={`Participantes (${s.participants.length})`}>
        {s.participants.length > 0 ? (
          <ul className="plist2">
            {s.participants.map((p) => (
              <li key={p.id} className="prow">
                <span className="pav" style={{ background: avatarColor(p.displayName) }}>{initials(p.displayName)}</span>
                <span className="pinfo">
                  <span className="pname">{p.handRaised ? "✋ " : ""}{p.displayName}</span>
                  <span className="muted small">
                    {p.isHost ? "host" : p.isCoHost ? "co-host" : "participante"}
                    {p.isMuted === true ? " · mudo" : p.isMuted === false ? " · com som" : ""}
                  </span>
                </span>
                {p.isMuted !== false && (
                  <button className="btn small" disabled={!!busy} onClick={() => run("unmute", () => api.unmuteParticipant(p.displayName))}>🔊 Desmutar</button>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="muted">Nenhum participante detectado. (A lista atualiza quando o painel de participantes está aberto no Zoom.)</p>}
      </Card>
      <HandsCard s={s} busy={busy} run={run} />
    </div>
  );
}

function HandsCard({ s, busy, run }: { s: NonNullable<ReturnType<typeof useLiveState>["snapshot"]>; busy: string | null; run: RunNamed }) {
  const hands = s.raisedHands.order;
  return (
    <Card icon="✋" title={`Mãos levantadas (${hands.length})`} trailing={s.raisedHands.partial ? <span className="pill">lista parcial</span> : undefined}>
      {hands.length > 0 ? (
        <ul className="plist2">
          {hands.map((p, i) => (
            <li key={p.id} className="prow">
              <span className="pav" style={{ background: avatarColor(p.displayName) }}>{initials(p.displayName)}</span>
              <span className="pinfo">
                <span className="pname">{i + 1}. {p.displayName}</span>
                <span className="muted small">{p.handRaisedAt ? new Date(p.handRaisedAt).toLocaleTimeString() : ""}</span>
              </span>
              <button className="btn small" disabled={!!busy} onClick={() => run("unmute", () => api.unmuteParticipant(p.displayName))}>🔊 Desmutar</button>
            </li>
          ))}
        </ul>
      ) : <p className="muted">Ninguém com a mão levantada.</p>}
    </Card>
  );
}

/* ----------------------------------------------------------------- Mais / Sistema */
function MaisTab({
  s, busy, run, reconnect, lastEvent, openSettings,
}: {
  s: NonNullable<ReturnType<typeof useLiveState>["snapshot"]>;
  busy: string | null;
  run: RunNamed;
  reconnect: () => void;
  lastEvent: string | null;
  openSettings: () => void;
}) {
  const [logs, setLogs] = useState<{ time: string; levelLabel: string; msg: string }[]>([]);
  const [net, setNet] = useState<{ addresses: string[]; port: number; tabletUrls: string[] } | null>(null);
  useEffect(() => {
    const id = setInterval(() => { api.logs().then((r) => setLogs(r.logs)).catch(() => void 0); }, 4000);
    api.logs().then((r) => setLogs(r.logs)).catch(() => void 0);
    api.net().then(setNet).catch(() => void 0);
    return () => clearInterval(id);
  }, []);
  const status = s.status;

  return (
    <div className="stack">
      <Card icon="⚙" title="Configuração">
        <div className="actions">
          <button className="btn" onClick={openSettings}>⚙ Abrir configurações</button>
        </div>
      </Card>

      <Card icon="📡" title="Tablet (tribuna)">
        {net && net.addresses.length > 0 ? (
          <>
            <p className="muted small">Conexão é automática na mesma rede. Se precisar, informe o IP no tablet:</p>
            <ul className="plist">{net.addresses.map((ip) => <li key={ip}><strong>{ip}</strong> : {net.port}</li>)}</ul>
          </>
        ) : <p className="muted">Descobrindo endereços da rede…</p>}
      </Card>

      <Card icon="📺" title="Compartilhamento">
        <table className="kv">
          <tbody>
            <tr><td>Modo</td><td>{s.settings.share.mode}</td></tr>
            <tr><td>Monitor projetor</td><td>{s.settings.share.projectorDisplayId ?? "não definido"}</td></tr>
            <tr><td>Apresentação ativa</td><td><Dot on={s.presentation.presentationActive} /> {s.presentation.presentationActive ? "sim" : "não"}</td></tr>
            <tr><td>JW Library detectado</td><td><Dot on={s.presentation.jwLibraryDetected} /> {s.presentation.jwLibraryDetected ? "sim" : "não"}</td></tr>
          </tbody>
        </table>
        <div className="actions">
          <button className="btn" disabled={!!busy} onClick={() => run("sharemon", () => api.shareMonitorStart())}>Compartilhar (auto)</button>
          <button className="btn secondary" disabled={!!busy} onClick={() => run("sharestop", () => api.shareMonitorStop())}>Parar</button>
          <button className="btn secondary" disabled={!!busy} onClick={() => run("share", () => api.shareStart())}>Seletor (assistido)</button>
        </div>
      </Card>

      <Card icon="🩺" title="Estado detalhado">
        <table className="kv">
          <tbody>
            <tr><td>Estado</td><td><strong>{STATE_LABEL[status.state] ?? status.state}</strong></td></tr>
            <tr><td>Navegador (Chromium)</td><td><Dot on={status.browserRunning} /> {status.browserRunning ? "ativo" : "parado"}</td></tr>
            <tr><td>Autenticado</td><td><Dot on={status.authenticated} /> {status.authenticated ? "sim" : "não"}</td></tr>
            <tr><td>ID da reunião</td><td>{status.meetingId ?? "—"}</td></tr>
            <tr><td>Papel</td><td>{status.role ?? "—"}</td></tr>
            <tr><td>Compartilhando</td><td><Dot on={status.sharing} /> {status.sharing ? "sim" : "não"}</td></tr>
            {status.lastError && <tr><td>Último erro</td><td className="err">{status.lastError}</td></tr>}
          </tbody>
        </table>
        <div className="actions">
          <button className="btn secondary" disabled={!!busy} onClick={() => run("recover", () => api.recover())}>Recuperar navegador</button>
          <button className="btn secondary" disabled={!!busy} onClick={() => run("admit", () => api.admitAll())}>Admitir todos</button>
          <button className="btn secondary" disabled={!!busy} onClick={() => run("hide", () => api.setBrowserHidden(true))}>Ocultar navegador</button>
          <button className="btn secondary" disabled={!!busy} onClick={() => run("showb", () => api.setBrowserHidden(false))}>Mostrar navegador</button>
          <button className="btn secondary" disabled={!!busy} onClick={() => run("reconnect", async () => reconnect())}>Reconectar painel</button>
        </div>
      </Card>

      <Card icon="🖥" title="Monitores">
        {s.displays.length > 0 ? (
          <ul className="plist">{s.displays.map((d) => <li key={d.id}>{d.primary ? "🖥️ " : "📽️ "}{d.label} — {d.bounds.width}×{d.bounds.height}{d.isProjector ? " (projetor)" : ""}</li>)}</ul>
        ) : <p className="muted">Monitores só são enumerados no Windows.</p>}
      </Card>

      <Card icon="📋" title="Sistema">
        <div className="caps">
          {Object.entries(s.capabilities).map(([k, v]) => (
            <div key={k} className="caprow"><span>{k}</span><CapBadge status={v} /></div>
          ))}
        </div>
        <h3>Último evento</h3>
        <p className="muted small">{lastEvent ?? "—"}</p>
        <h3>Logs recentes</h3>
        <pre className="logs">{logs.map((l) => `${new Date(l.time).toLocaleTimeString()} ${l.levelLabel.toUpperCase()} ${l.msg}`).join("\n") || "—"}</pre>
      </Card>
    </div>
  );
}

/* ----------------------------------------------------------------- shared bits */
function Dot({ on }: { on: boolean | null }) {
  const color = on === null ? "#9ca3af" : on ? "#22c55e" : "#dc2626";
  return <span className="dot" style={{ background: color }} />;
}
function CapBadge({ status }: { status: CapabilityStatus }) {
  return <span className={`cap cap-${status}`}>{status}</span>;
}

function HeaderStatus({ connected, state }: { connected: boolean; state: string | null }) {
  let dot = "#9ca3af";
  let text = "Conectando…";
  if (!connected) { dot = "#9ca3af"; text = "Painel desconectado"; }
  else if (!state) { dot = "#9ca3af"; text = "Conectando…"; }
  else if (state === "IN_MEETING" || state === "SHARING") { dot = "#22c55e"; text = "Reunião ao vivo"; }
  else if (state === "INITIALIZING") { dot = "#f59e0b"; text = "Iniciando…"; }
  else if (state === "AUTH_REQUIRED") { dot = "#f59e0b"; text = "Login necessário"; }
  else if (state === "RECONNECTING") { dot = "#f59e0b"; text = "Reconectando"; }
  else if (state === "ERROR") { dot = "#ef4444"; text = "Erro"; }
  else if (state === "AUTHENTICATED") { dot = "#2f6fed"; text = "Pronto"; }
  else { dot = "#93a3b8"; text = STATE_LABEL[state] ?? state; }
  return (
    <div className="statuschip">
      <span className="dot" style={{ background: dot }} />
      <span>{text}</span>
    </div>
  );
}

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(id);
  }, []);
  const time = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString("pt-BR", { weekday: "short", day: "numeric", month: "short" });
  return (
    <div className="clock">
      <span className="clock-date">{date}</span>
      <span className="clock-time">{time}</span>
    </div>
  );
}
