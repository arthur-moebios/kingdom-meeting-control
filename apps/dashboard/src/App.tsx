import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { CapabilityStatus, PollResult, RemoteIntegrationStatus } from "@kmc/shared-types";
import { api } from "./api.js";
import { useLiveState } from "./useLiveState.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { MeetingPanel } from "./MeetingPanel.js";
import { NativeDashboard } from "./NativeDashboard.js";
import { PanelDivider, remember, storedNumber } from "./PanelDivider.js";
import { HostCameraSlot } from './HostCameraSlot.js';

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
type Snapshot = NonNullable<ReturnType<typeof useLiveState>["snapshot"]>;

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

export function App() {
  return new URLSearchParams(window.location.search).get("native") === "1" ? <NativeDashboard /> : <WebApp />;
}

function WebApp() {
  const { connected, snapshot, lastEvent, reconnect } = useLiveState();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [compactMode, setCompactMode] = useState(() => storedNumber('kmc.operator.compact',1,0,1) === 1);
  const [timerWidth, setTimerWidth] = useState(() => storedNumber('kmc.operator.timerWidth',50,30,70));
  const [timerHeight, setTimerHeight] = useState(() => storedNumber('kmc.operator.timerHeight',70,30,70));
  const [clockSize, setClockSize] = useState(() => storedNumber('kmc.operator.clockSize',48,32,72));
  const [toolTab, setToolTab] = useState('people');

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
  const compact = status?.backend === 'native' && compactMode;

  return (
    <div className={`app ${compact ? 'operator-layout' : ''}`} style={{'--timer-width': `${timerWidth}fr`, '--tools-width': `${100-timerWidth}fr`, '--timer-height': `${timerHeight}fr`, '--attendance-height': `${100-timerHeight}fr`, '--clock-size': `${clockSize}px`} as React.CSSProperties}>
      <header className="appbar">
        <div className="brand">
          <div className="brand-logo">📖</div>
          <div>
            <h1>Salão do Reino</h1>
            <div className="brand-sub">Painel do Operador</div>
          </div>
        </div>
        <div className="headright">
          {status?.backend === 'native' && <details className="layout-options"><summary>Ajustar</summary><div>
            <label>Cronômetro <input type="range" min="32" max="72" value={clockSize} onChange={e => { const n=Number(e.target.value);setClockSize(n);remember('kmc.operator.clockSize',n); }} /></label>
            <button className="secondary small" onClick={() => { setCompactMode(!compactMode);remember('kmc.operator.compact',compactMode ? 0 : 1); }}>{compactMode ? 'Visão completa' : 'Visão compacta'}</button>
            <button className="secondary small" onClick={() => { setTimerWidth(50);setTimerHeight(70);setClockSize(48);remember('kmc.operator.timerWidth',50);remember('kmc.operator.timerHeight',70);remember('kmc.operator.clockSize',48); }}>Restaurar disposição</button>
          </div></details>}
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

      {error && <div className="banner-err">{error}</div>}

      {!s ? (
        <section className="card2 center"><p className="muted">Conectando ao servidor…</p></section>
      ) : (
        <>
          <div className="grid">
            <div className="col-main">
              <div className="operator-timer"><MeetingPanel compact={compact} meeting={s.meeting} names={s.meetingNames} warnSeconds={s.settings.meetingSchedule.warnSeconds} /></div>
              {compact && <PanelDivider horizontal label="Altura do cronômetro e assistência" value={timerHeight} onChange={n => {setTimerHeight(n);remember('kmc.operator.timerHeight',n);}} />}
              <div className="operator-lower operator-attendance"><EnquetesCard busy={busy} run={run} lastEvent={lastEvent} /></div>
            </div>
            {compact && <PanelDivider label="Largura do cronômetro" value={timerWidth} onChange={n => {setTimerWidth(n);remember('kmc.operator.timerWidth',n);}} />}
            <div className="col-side">
              {status?.backend==='native' && <HostCameraSlot />}
              <div className="operator-quicktools"><TransmissaoCard s={s} busy={busy} run={run} /></div>
              {compact && <nav className="operator-tabs" aria-label="Ferramentas">
                {[['people','Participantes'],['announcements','Anúncios'],['remote','Celular'],['advanced','Mais']].map(([id,label]) => <button key={id} className={toolTab===id?'':'secondary'} aria-pressed={toolTab===id} onClick={() => setToolTab(id!)}>{label}</button>)}
              </nav>}
              <div className="operator-data">
                <div className="operator-upper">
                  <div hidden={compact && toolTab!=='people'}><PeopleCard s={s} busy={busy} run={run} /></div>
                  <div hidden={compact && toolTab!=='announcements'}><AnunciosCard value={s.settings.tablet.announcements} busy={!!busy} run={run} /></div>
                  <div hidden={compact && toolTab!=='remote'}><RemoteQrCard /></div>
                  <div hidden={!compact || toolTab!=='advanced'}><AdvancedSection s={s} busy={busy} run={run} reconnect={reconnect} lastEvent={lastEvent} openSettings={() => setShowSettings(true)} /></div>
                </div>
              </div>
            </div>
          </div>

          <div hidden={compact}><AdvancedSection
            s={s}
            busy={busy}
            run={run}
            reconnect={reconnect}
            lastEvent={lastEvent}
            openSettings={() => setShowSettings(true)}
          /></div>
        </>
      )}

      {showSettings && (
        <SettingsPanel native={s?.status.backend === 'native'} displays={s?.displays ?? []} onClose={() => setShowSettings(false)} onSaved={reconnect} />
      )}
    </div>
  );
}

/* ----------------------------------------------------- Transmissão (Zoom) */
function TransmissaoCard({ s, busy, run }: { s: Snapshot; busy: string | null; run: RunNamed }) {
  const status = s.status;
  const inMeeting = status.state === "IN_MEETING" || status.state === "SHARING";
  const hidden = s.settings.browser.hidden;
  const toggleBrowser = () => run("vis", async () => {
    const next = !hidden;
    await api.setBrowserHidden(next);
    await api.putSettings({ browser: { hidden: next } });
  });
  const native = status.backend === 'native';
  const stateText = !status
    ? "Conectando…"
    : status.state === "INITIALIZING"
      ? native ? "Conectando ao Zoom desktop…" : "Iniciando o navegador…"
      : status.state === "JOINING"
        ? "Entrando na reunião…"
      : status.state === "RECONNECTING"
        ? "Reconectando…"
        : !status.authenticated
          ? native ? "Faça login no Zoom desktop (uma vez)." : "Faça login no Zoom na janela do Chromium (uma vez)."
          : inMeeting
            ? "✓ Na reunião"
            : "Pronto para entrar.";

  return (
    <Card icon="🎥" title="Transmissão (Zoom)" className="reuniao">
      <div className="reuniao-row">
        <div className="reuniao-state">{stateText}</div>
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
      <div className="actions">
        <button className="btn secondary small" disabled={!!busy || !inMeeting} onClick={() => run("sharemon", () => api.shareMonitorStart())}>📺 Compartilhar</button>
        <button className="btn secondary small" disabled={!!busy || !inMeeting} onClick={() => run("sharestop", () => api.shareMonitorStop())}>Parar</button>
        <button className="btn secondary small" disabled={!!busy} onClick={toggleBrowser} title="Mostra/esconde a janela do Zoom">
          {hidden ? "👁 Ver Zoom" : "🙈 Ocultar Zoom"}
        </button>
        <button className="btn secondary small" disabled={!!busy || !inMeeting} onClick={() => run("poll", () => api.launchPoll())} title="Lança a enquete pré-criada no Zoom">📊 Lançar enquete</button>
        <button className="btn secondary small" disabled={!!busy || !inMeeting} onClick={() => run("host", () => api.reclaimHost())} title="Reassume o papel de host se outro dispositivo pegou">👑 Reassumir host</button>
      </div>
    </Card>
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
function AnunciosCard({ value, busy, run }: { value: string; busy: boolean; run: RunNamed }) {
  const [text, setText] = useState(value);
  const [dirty, setDirty] = useState(false);
  const draft = useRef(value);
  // Marking a save complete must not reapply an older server snapshot.
  useEffect(() => { if (!dirty) { draft.current = value; setText(value); } }, [value]);
  return (
    <Card icon="📣" title="Anúncios (tablet)" trailing={dirty ? <span className="muted small">não salvo</span> : undefined}>
      <textarea
        className="annedit"
        value={text}
        rows={12}
        placeholder="Escreva os anúncios da reunião…"
        onChange={(e) => { draft.current = e.target.value; setText(e.target.value); setDirty(true); }}
      />
      <div className="actions">
        <button className="btn" disabled={busy} onClick={() => {
          const submitted = text;
          void run("ann", async () => {
            const saved = await api.putSettings({ tablet: { announcements: submitted } });
            if (draft.current === submitted) {
              draft.current = saved.tablet.announcements;
              setText(saved.tablet.announcements);
              setDirty(false);
            }
          });
        }}>
          Salvar e enviar
        </button>
      </div>
    </Card>
  );
}

/* ------------------------------------------------- Participantes + Mãos (um só) */
function PeopleCard({ s, busy, run }: { s: Snapshot; busy: string | null; run: RunNamed }) {
  const hands = s.raisedHands.order; // fila ordenada de mãos levantadas
  const handNames = new Set(hands.map((p) => p.displayName));
  const rest = s.participants.filter((p) => !handNames.has(p.displayName));
  const total = s.participants.length || (hands.length + rest.length);
  return (
    <Card
      icon="👥"
      title={`Participantes (${total})`}
      trailing={hands.length > 0 ? <span className="pill hand">✋ {hands.length}</span> : undefined}
    >
      {hands.length === 0 && rest.length === 0 ? (
        <p className="muted small">Nenhum participante detectado. (Atualiza com o painel de participantes aberto no Zoom.)</p>
      ) : (
        <ul className="plist2">
          {/* Mãos levantadas primeiro, na ordem da fila */}
          {hands.map((p, i) => (
            <li key={`h-${p.id}`} className="prow hand">
              <span className="pav" style={{ background: avatarColor(p.displayName) }}>{initials(p.displayName)}</span>
              <span className="pinfo">
                <span className="pname"><span className="phand">✋</span> {i + 1}. {p.displayName}</span>
                <span className="muted small">mão levantada{p.handRaisedAt ? ` · ${new Date(p.handRaisedAt).toLocaleTimeString()}` : ""}</span>
              </span>
              <button className="btn small" disabled={!!busy} onClick={() => run("unmute", () => api.unmuteParticipant(p.displayName))}>🔊</button>
            </li>
          ))}
          {/* Demais participantes */}
          {rest.map((p) => (
            <li key={p.id} className="prow">
              <span className="pav" style={{ background: avatarColor(p.displayName) }}>{initials(p.displayName)}</span>
              <span className="pinfo">
                <span className="pname">{p.displayName}</span>
                <span className="muted small">
                  {p.isHost ? "host" : p.isCoHost ? "co-host" : "participante"}
                  {p.isMuted === true ? " · mudo" : p.isMuted === false ? " · com som" : ""}
                </span>
              </span>
              {p.isMuted !== false && (
                <button className="btn small" disabled={!!busy} onClick={() => run("unmute", () => api.unmuteParticipant(p.displayName))}>🔊</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------- Enquetes */
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y!, (m ?? 1) - 1, d ?? 1);
  return dt.toLocaleDateString("pt-BR", { weekday: "short", day: "numeric", month: "short" });
}

function EnquetesCard({ busy, run, lastEvent }: { busy: string | null; run: RunNamed; lastEvent: string | null }) {
  const [history, setHistory] = useState<PollResult[]>([]);
  const load = () => api.pollsHistory().then((r) => setHistory(r.results)).catch(() => void 0);
  useEffect(() => {
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, []);
  // Refresh promptly when a capture event arrives.
  useEffect(() => { if (lastEvent && /poll\.results/.test(lastEvent)) load(); }, [lastEvent]);

  const today = todayStr();
  const todays = history.filter((h) => h.date === today);
  const past = history.filter((h) => h.date !== today);
  const byDay = new Map<string, PollResult[]>();
  for (const p of past) { const a = byDay.get(p.date) ?? []; a.push(p); byDay.set(p.date, a); }

  return (
    <Card
      icon="📊"
      title="Enquetes"
      trailing={<button className="btn secondary small" disabled={!!busy} onClick={() => run("capturepoll", async () => { await api.capturePoll(); await load(); })}>Capturar</button>}
    >
      {todays.length === 0 ? (
        <p className="muted small">Sem resultados de enquete hoje. A captura é automática enquanto a enquete está aberta no Zoom.</p>
      ) : (
        todays.map((p) => <PollResultView key={p.pollName} p={p} />)
      )}
      {byDay.size > 0 && (
        <details className="poll-hist">
          <summary>Histórico por dia ({byDay.size})</summary>
          {[...byDay.entries()].map(([date, polls]) => (
            <div key={date} className="poll-day">
              <div className="poll-day-date">{fmtDate(date)}</div>
              {polls.map((p) => <PollResultView key={p.pollName} p={p} compact />)}
            </div>
          ))}
        </details>
      )}
    </Card>
  );
}

function PollResultView({ p, compact }: { p: PollResult; compact?: boolean }) {
  // Attendance-style poll: every option label is a number (how many people at
  // that location), so total attendance = Σ(label × votes).
  const numeric = p.options.length > 0 && p.options.every((o) => /^\d+$/.test(o.label.trim()));
  const attendance = numeric ? p.options.reduce((s, o) => s + Number(o.label) * o.votes, 0) : null;
  return (
    <div className="pollres">
      <div className="pollres-head">
        <span className="pollres-name">{p.pollName}</span>
        <span className="muted small">{p.totalParticipants === null ? `${p.totalVoted} respostas` : `${p.totalVoted}/${p.totalParticipants} votaram`}</span>
      </div>
      {!compact && p.question && <div className="pollres-q muted small">{p.question}</div>}
      {attendance !== null &&
        (compact ? (
          <div className="pollres-attend-sm">Assistência total: <b>{attendance}</b></div>
        ) : (
          <div className="pollres-attend">
            <span className="pollres-attend-label">Assistência<br />total</span>
            <span className="pollres-attend-num">{attendance}</span>
          </div>
        ))}
      <ul className="pollres-opts">
        {p.options.map((o, i) => (
          <li key={i} className="pollres-opt">
            <span className="pollres-opt-label" title={o.label}>{o.label}</span>
            <span className="pollres-bar"><span className="pollres-barfill" style={{ width: `${o.percent ?? 0}%` }} /></span>
            <span className="pollres-opt-val">
              {numeric ? `${o.votes}×${o.label}=${o.votes * Number(o.label)}` : o.percent === null ? `${o.votes} respostas` : `${o.votes} (${o.percent}%)`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ----------------------------------------------------- Avançado (recolhível) */
function AdvancedSection({
  s, busy, run, reconnect, lastEvent, openSettings,
}: {
  s: Snapshot;
  busy: string | null;
  run: RunNamed;
  reconnect: () => void;
  lastEvent: string | null;
  openSettings: () => void;
}) {
  const [logs, setLogs] = useState<{ time: string; levelLabel: string; msg: string }[]>([]);
  const [net, setNet] = useState<{ addresses: string[]; port: number; tabletUrls: string[] } | null>(null);
  const [pres, setPres] = useState<Awaited<ReturnType<typeof api.presentationStatus>> | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const tick = () => {
      api.logs().then((r) => setLogs(r.logs)).catch(() => void 0);
      api.presentationStatus().then(setPres).catch(() => void 0);
    };
    const id = setInterval(tick, 2500);
    tick();
    api.net().then(setNet).catch(() => void 0);
    return () => clearInterval(id);
  }, [open]);
  const status = s.status;

  return (
    <details className="adv" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Avançado — rede, compartilhamento, estado e logs</summary>
      <div className="adv-grid">
        <Card icon="⚙" title="Configuração">
          <div className="actions">
            <button className="btn" onClick={openSettings}>⚙ Abrir configurações</button>
          </div>
        </Card>

        <Card icon="📡" title="Tablet (tribuna)">
          {net && net.addresses.length > 0 ? (
            <>
              <p className="muted small">Conexão automática na mesma rede. Se precisar, informe o IP no tablet:</p>
              <ul className="plist">{net.addresses.map((ip) => <li key={ip}><strong>{ip}</strong> : {net.port}</li>)}</ul>
            </>
          ) : <p className="muted">Descobrindo endereços da rede…</p>}
        </Card>

        <Card icon="📺" title="Compartilhamento">
          <table className="kv">
            <tbody>
              <tr><td>Modo</td><td>{s.settings.share.mode}</td></tr>
              <tr><td>Monitor projetor</td><td>{s.settings.share.projectorDisplayId ?? "não definido"}</td></tr>
              <tr><td>Apresentação ativa</td><td><Dot on={(pres ?? s.presentation).presentationActive} /> {(pres ?? s.presentation).presentationActive ? "sim" : "não"}</td></tr>
              <tr><td>JW Library detectado</td><td><Dot on={s.presentation.jwLibraryDetected} /> {s.presentation.jwLibraryDetected ? "sim" : "não"}</td></tr>
              <tr><td>Detecção de mídia</td><td>{(pres ?? s.presentation).detectionSource === "uia" ? "UI Automation" : "indisponível"} · {(pres ?? s.presentation).mediaKind === "video" ? "vídeo" : (pres ?? s.presentation).mediaKind === "image" ? "imagem" : "sem mídia detectada"}</td></tr>
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
    </details>
  );
}

/* ----------------------------------------------------- Controle remoto (QR) */
// Only a real private LAN IP (phone on the same Wi-Fi). Tailscale/CGNAT (100.64/10)
// is excluded — it is not on everyone's devices.
function lanAddr(addrs: string[]): string | undefined {
  const lan = addrs.filter((ip) => /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip));
  const score = (ip: string) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : 2);
  return [...lan].sort((a, b) => score(a) - score(b))[0];
}
function RemoteQrCard() {
  const [remote, setRemote] = useState<RemoteIntegrationStatus|null>(null);
  const [remoteError,setRemoteError] = useState('');
  const [net, setNet] = useState<{ addresses: string[]; port: number } | null>(null);
  const [small, setSmall] = useState("");
  const [large, setLarge] = useState("");
  const [big, setBig] = useState(false);
  useEffect(() => {
    api.net().then((n) => setNet({ addresses: n.addresses, port: n.port })).catch(() => void 0);
    const refresh=()=>void api.remoteStatus().then(setRemote).catch(()=>{});refresh();
    const timer=setInterval(refresh,5000);return()=>clearInterval(timer);
  }, []);
  const addr = net ? lanAddr(net.addresses) : undefined;
  const url = remote?.publicUrl ? (remote.phase==='connected' ? remote.publicUrl+'/remote.html' : '') : addr ? `http://${addr}:${net!.port}/remote.html` : "";
  const qrUrl = url;
  useEffect(() => {
    if (!url) { setSmall(""); setLarge(""); return; }
    QRCode.toDataURL(qrUrl, { width: 240, margin: 1 }).then(setSmall).catch(() => void 0);
    QRCode.toDataURL(qrUrl, { width: 640, margin: 2 }).then(setLarge).catch(() => void 0);
  }, [qrUrl]);
  return (
    <Card icon="📱" title="Controle remoto (celular)">
        <p className="small">{remote?.devices ?? 0} aparelhos conectados · acesso sem código</p>
        <div className="remote-devices">{remote?.deviceList?.map(device=><div className="remote-device" key={device.id}><div><b>{device.label}</b><div className="small muted">Conectado em {new Date(device.createdAt).toLocaleString('pt-BR')}</div></div><button className="secondary small" onClick={async()=>{try{setRemoteError('');await api.remoteRevokeDevice(device.id);setRemote(await api.remoteStatus());}catch(e){setRemoteError(String(e));}}}>Revogar acesso</button></div>)}</div>
        {!!remote?.devices && <button className="secondary small" onClick={async()=> {try {setRemoteError('');await api.remoteRevoke();setRemote(await api.remoteStatus());}catch(e){setRemoteError(String(e));}}}>Revogar todos ({remote.devices})</button>}
        {remoteError && <p className="err small">{remoteError}</p>}
      {url ? (
        <>
          <div className="qr-row">
            <img className="qr-sm" src={small} alt="QR do controle do cronômetro" onClick={() => setBig(true)} title="Toque para ampliar" />
            <div className="qr-info">
              <p className="muted small">Escaneie o QR ou abra o link e toque em <b>Conectar este aparelho</b>. Sem código. Depois instale o controle no celular.</p>
              <code className="qr-url">{url}</code>
            </div>
          </div>
          {big && (
            <div className="overlay" onClick={() => setBig(false)}>
              <div className="qr-modal" onClick={(e) => e.stopPropagation()}>
                <img src={large} alt="QR grande do controle do cronômetro" />
                <code className="qr-url">{url}</code>
                <button className="btn secondary" onClick={() => setBig(false)}>Fechar</button>
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="muted small">{remote?.publicUrl?'Aguardando a publicação e confirmação do link fixo Cloudflare…':'Sem IP de rede local. Conecte o PC ao Wi-Fi do Salão ou configure o link Cloudflare.'}</p>
      )}
    </Card>
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
