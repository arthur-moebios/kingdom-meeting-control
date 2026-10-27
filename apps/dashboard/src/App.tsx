import { useEffect, useState } from "react";
import type { CapabilityStatus } from "@kmc/shared-types";
import { api } from "./api.js";
import { useLiveState } from "./useLiveState.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { MeetingPanel } from "./MeetingPanel.js";

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

function Dot({ on }: { on: boolean | null }) {
  const color = on === null ? "#9ca3af" : on ? "#16a34a" : "#dc2626";
  return <span className="dot" style={{ background: color }} />;
}

function CapBadge({ status }: { status: CapabilityStatus }) {
  return <span className={`cap cap-${status}`}>{status}</span>;
}

export function App() {
  const { connected, snapshot, lastEvent, reconnect } = useLiveState();
  const [logs, setLogs] = useState<{ time: string; levelLabel: string; msg: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  const [net, setNet] = useState<{ addresses: string[]; port: number; tabletUrls: string[] } | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      api.logs().then((r) => setLogs(r.logs)).catch(() => void 0);
    }, 4000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    api.net().then(setNet).catch(() => void 0);
  }, []);

  const run = async (name: string, fn: () => Promise<unknown>) => {
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
    <div className="wrap">
      <header>
        <h1>Kingdom Meeting Control</h1>
        <div className="headright">
          <div className="conn">
            <Dot on={connected} /> {connected ? "Painel conectado" : "Painel desconectado"}
          </div>
          <button className={advanced ? "" : "secondary"} onClick={() => setAdvanced((v) => !v)}>
            {advanced ? "Ocultar avançado" : "Avançado"}
          </button>
          <button className="secondary" onClick={() => setShowSettings(true)}>⚙ Configurações</button>
          <button
            className="danger"
            disabled={!!busy}
            onClick={() => {
              if (window.confirm("Encerrar o Kingdom Meeting Control? O painel e o tablet vão desconectar.")) {
                run("shutdown", () => api.shutdown());
              }
            }}
          >
            ⏻ Encerrar
          </button>
        </div>
      </header>

      {showSettings && (
        <SettingsPanel
          displays={s?.displays ?? []}
          onClose={() => setShowSettings(false)}
          onSaved={reconnect}
        />
      )}

      {error && <div className="card error">{error}</div>}

      <div className="grid">
        {/* Cronômetros da reunião (WOL) */}
        {s && <MeetingPanel meeting={s.meeting} warnSeconds={s.settings.meetingSchedule.warnSeconds} />}

        {/* Reunião — só o essencial */}
        <section className="card">
          <h2>Reunião</h2>
          <p className="muted">
            {!status
              ? "Conectando…"
              : status.state === "INITIALIZING"
                ? "Iniciando o navegador… aguarde alguns segundos."
                : status.state === "RECONNECTING"
                  ? "Reconectando…"
                  : !status.authenticated
                    ? "Faça login no Zoom na janela do Chromium (uma vez)."
                    : status.state === "IN_MEETING" || status.state === "SHARING"
                      ? "Na reunião."
                      : "Pronto para entrar."}
          </p>
          <div className="actions">
            <button
              className="big"
              disabled={!!busy || status?.state === "INITIALIZING"}
              onClick={() => run("join", () => api.join())}
            >
              ▶ Entrar na reunião
            </button>
            <button disabled={!!busy} className="secondary" onClick={() => run("leave", () => api.leave())}>
              Sair
            </button>
          </div>
        </section>

        {/* Anúncios (enviados ao tablet) */}
        {s && (
          <AnnouncementsEditor
            value={s.settings.tablet.announcements}
            busy={!!busy}
            onSave={(text) => run("ann", () => api.putSettings({ tablet: { announcements: text } }))}
          />
        )}

        {/* Tablet / rede */}
        <section className="card">
          <h2>Tablet (tribuna)</h2>
          {net && net.addresses.length > 0 ? (
            <>
              <p className="muted small">No app do tablet, toque na engrenagem e informe o IP do PC:</p>
              <ul className="plist">
                {net.addresses.map((ip) => (
                  <li key={ip}><strong>{ip}</strong> : {net.port}</li>
                ))}
              </ul>
              {net.tabletUrls[0] && (
                <p className="muted small">Ou abra no navegador do tablet: {net.tabletUrls[0]}</p>
              )}
            </>
          ) : (
            <p className="muted">Descobrindo endereços da rede…</p>
          )}
        </section>

        {/* Mãos levantadas */}
        <section className="card">
          <h2>Mãos levantadas {s?.raisedHands.partial && <span className="pill">lista parcial</span>}</h2>
          {s && s.raisedHands.order.length > 0 ? (
            <ol>
              {s.raisedHands.order.map((p, i) => (
                <li key={p.id}>
                  <strong>{i + 1}.</strong> {p.displayName}{" "}
                  <span className="muted small">
                    {p.handRaisedAt ? new Date(p.handRaisedAt).toLocaleTimeString() : ""}
                  </span>
                </li>
              ))}
            </ol>
          ) : <p className="muted">Ninguém com a mão levantada.</p>}
          {s && <p className="muted small">Ordem: {s.raisedHands.orderSource} (aproximada)</p>}
        </section>

        {advanced && (<>
        {/* Estado detalhado */}
        <section className="card">
          <h2>Estado detalhado</h2>
          {status ? (
            <table>
              <tbody>
                <tr><td>Estado</td><td><strong>{STATE_LABEL[status.state] ?? status.state}</strong></td></tr>
                <tr><td>Navegador (Chromium)</td><td><Dot on={status.browserRunning} /> {status.browserRunning ? "ativo" : "parado"}</td></tr>
                <tr><td>Autenticado</td><td><Dot on={status.authenticated} /> {status.authenticated ? "sim" : "não"}</td></tr>
                <tr><td>ID da reunião</td><td>{status.meetingId ?? "—"}</td></tr>
                <tr><td>Papel</td><td>{status.role ?? "—"}</td></tr>
                <tr><td>Microfone</td><td><Dot on={status.micOn} /> {status.micOn === null ? "n/d" : status.micOn ? "ligado" : "desligado"}</td></tr>
                <tr><td>Câmera</td><td><Dot on={status.cameraOn} /> {status.cameraOn === null ? "n/d" : status.cameraOn ? "ligada" : "desligada"}</td></tr>
                <tr><td>Compartilhando</td><td><Dot on={status.sharing} /> {status.sharing ? "sim" : "não"}</td></tr>
                {status.lastError && <tr><td>Último erro</td><td className="err">{status.lastError}</td></tr>}
              </tbody>
            </table>
          ) : <p className="muted">Sem dados ainda.</p>}
          <div className="actions">
            <button disabled={!!busy} onClick={() => run("wait", () => api.waitLogin())}>Aguardar login</button>
            <button disabled={!!busy} onClick={() => run("admit", () => api.admitAll())}>Admitir todos</button>
          </div>
        </section>

        {/* Participantes */}
        <section className="card">
          <h2>Participantes ({s?.participants.length ?? 0})</h2>
          {s && s.participants.length > 0 ? (
            <ul className="plist">
              {s.participants.map((p) => (
                <li key={p.id}>
                  {p.handRaised ? "✋ " : ""}
                  {p.displayName}
                  {p.isHost ? " (host)" : p.isCoHost ? " (co-host)" : ""}
                </li>
              ))}
            </ul>
          ) : <p className="muted">Nenhum participante detectado.</p>}
        </section>

        {/* Compartilhamento */}
        <section className="card">
          <h2>Compartilhamento</h2>
          <table>
            <tbody>
              <tr><td>Modo</td><td>{s?.settings.share.mode ?? "—"}</td></tr>
              <tr><td>Monitor projetor</td><td>{s?.settings.share.projectorDisplayId ?? "não definido"}</td></tr>
              <tr><td>Apresentação ativa</td><td><Dot on={s?.presentation.presentationActive ?? null} /> {s?.presentation.presentationActive ? "sim" : "não"}</td></tr>
              <tr><td>JW Library detectado</td><td><Dot on={s?.presentation.jwLibraryDetected ?? null} /> {s?.presentation.jwLibraryDetected ? "sim" : "não"}</td></tr>
            </tbody>
          </table>
          <div className="actions">
            <button disabled={!!busy} onClick={() => run("share", () => api.shareStart())}>Abrir seletor (assistido)</button>
            <button disabled={!!busy} onClick={() => run("sharemon", () => api.shareMonitorStart())}>Compartilhar monitor (auto)</button>
            <button disabled={!!busy} className="secondary" onClick={() => run("sharestop", () => api.shareMonitorStop())}>Parar</button>
          </div>
          <p className="muted small">
            Modo assistido: o sistema abre o seletor do Zoom; o operador escolhe o monitor do
            projetor. Seleção automática de monitor não é suportada.
          </p>
          <h3>Monitores</h3>
          {s && s.displays.length > 0 ? (
            <ul className="plist">
              {s.displays.map((d) => (
                <li key={d.id}>{d.primary ? "🖥️ " : "📽️ "}{d.label} — {d.bounds.width}×{d.bounds.height}{d.isProjector ? " (projetor)" : ""}</li>
              ))}
            </ul>
          ) : <p className="muted">Monitores só são enumerados no Windows.</p>}
        </section>

        {/* Sistema / capacidades / logs */}
        <section className="card wide">
          <h2>Sistema</h2>
          <div className="caps">
            {s && Object.entries(s.capabilities).map(([k, v]) => (
              <div key={k} className="caprow"><span>{k}</span><CapBadge status={v} /></div>
            ))}
          </div>
          <h3>Último evento</h3>
          <p className="muted">{lastEvent ?? "—"}</p>
          <h3>Logs recentes</h3>
          <pre className="logs">
            {logs.map((l) => `${new Date(l.time).toLocaleTimeString()} ${l.levelLabel.toUpperCase()} ${l.msg}`).join("\n") || "—"}
          </pre>
          <div className="actions">
            <button disabled={!!busy} onClick={() => run("recover", () => api.recover())}>Recuperar (reabrir navegador)</button>
            <button disabled={!!busy} onClick={() => run("lock", () => api.lockUnmute(true))}>Travar desmutar</button>
            <button disabled={!!busy} onClick={() => run("unlock", () => api.lockUnmute(false))}>Liberar desmutar</button>
            <button disabled={!!busy} className="secondary" onClick={() => run("hide", () => api.setBrowserHidden(true))}>Ocultar navegador</button>
            <button disabled={!!busy} className="secondary" onClick={() => run("showb", () => api.setBrowserHidden(false))}>Mostrar navegador</button>
            <button disabled={!!busy} className="secondary" onClick={() => run("reconnect", async () => reconnect())}>Reconectar painel</button>
          </div>
        </section>
        </>)}
      </div>
      <footer className="muted small">
        Fase 1 — fundação. Recursos marcados "experimental/assisted/unsupported" ainda dependem de
        validação com reunião real. Veja docs/limitations.md.
      </footer>
    </div>
  );
}

function AnnouncementsEditor({
  value,
  busy,
  onSave,
}: {
  value: string;
  busy: boolean;
  onSave: (text: string) => void;
}) {
  const [text, setText] = useState(value);
  const [dirty, setDirty] = useState(false);
  // Keep in sync with the server value until the operator starts editing.
  useEffect(() => {
    if (!dirty) setText(value);
  }, [value, dirty]);
  return (
    <section className="card wide">
      <h2>Anúncios (enviados ao tablet)</h2>
      <textarea
        className="annedit"
        value={text}
        rows={5}
        placeholder="Escreva os anúncios da reunião…"
        onChange={(e) => { setText(e.target.value); setDirty(true); }}
      />
      <div className="actions">
        <button disabled={busy} onClick={() => { onSave(text); setDirty(false); }}>Salvar e enviar</button>
        {dirty && <span className="muted small">alterações não salvas</span>}
      </div>
    </section>
  );
}
