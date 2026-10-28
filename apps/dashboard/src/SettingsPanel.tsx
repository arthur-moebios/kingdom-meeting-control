import { useEffect, useState, type ReactNode } from "react";
import type { Display, Settings } from "@kmc/shared-types";
import { api } from "./api.js";

interface Props {
  displays: Display[];
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Operator-facing settings form. Loads the current settings, lets the operator
 * edit meeting / share / reconnect / retention, and saves via PUT /settings.
 * Experimental options are labelled honestly inline.
 */
export function SettingsPanel({ displays, onClose, onSaved }: Props) {
  const [form, setForm] = useState<Settings | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getSettings()
      .then(setForm)
      .catch((e) => setLoadErr(String(e)));
  }, []);

  if (loadErr) {
    return (
      <Overlay onClose={onClose} title="Configurações">
        <div className="card error">Não foi possível carregar: {loadErr}</div>
      </Overlay>
    );
  }
  if (!form) {
    return (
      <Overlay onClose={onClose} title="Configurações">
        <p className="muted">Carregando…</p>
      </Overlay>
    );
  }

  // Typed, immutable updates into the nested settings object.
  const setMeeting = (patch: Partial<Settings["meeting"]>) =>
    setForm((f) => (f ? { ...f, meeting: { ...f.meeting, ...patch } } : f));
  const setShare = (patch: Partial<Settings["share"]>) =>
    setForm((f) => (f ? { ...f, share: { ...f.share, ...patch } } : f));
  const setReconnect = (patch: Partial<Settings["reconnect"]>) =>
    setForm((f) => (f ? { ...f, reconnect: { ...f.reconnect, ...patch } } : f));
  const setRetention = (patch: Partial<Settings["retention"]>) =>
    setForm((f) => (f ? { ...f, retention: { ...f.retention, ...patch } } : f));
  const setAutomations = (patch: Partial<Settings["automations"]>) =>
    setForm((f) => (f ? { ...f, automations: { ...f.automations, ...patch } } : f));
  const setBrowser = (patch: Partial<Settings["browser"]>) =>
    setForm((f) => (f ? { ...f, browser: { ...f.browser, ...patch } } : f));

  const save = async () => {
    setBusy(true);
    setSaveErr(null);
    setSaved(false);
    try {
      const result = await api.putSettings(form);
      setForm(result);
      setSaved(true);
      onSaved();
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setSaveErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const m = form.meeting;
  const sh = form.share;
  const rc = form.reconnect;

  return (
    <Overlay onClose={onClose} title="Configurações">
      <div className="settings">
        <fieldset>
          <legend>Reunião</legend>
          <Field label="ID da reunião">
            <input value={m.meetingId} onChange={(e) => setMeeting({ meetingId: e.target.value })} placeholder="ex.: 123 4567 8901" />
          </Field>
          <Field label="Senha de ingresso">
            <input type="password" value={m.passcode} onChange={(e) => setMeeting({ passcode: e.target.value })} placeholder="(se houver)" />
          </Field>
          <Field label="Nome de exibição">
            <input value={m.displayName} onChange={(e) => setMeeting({ displayName: e.target.value })} />
          </Field>
          <Field label="Modo">
            <select value={m.joinMode} onChange={(e) => setMeeting({ joinMode: e.target.value as "join" | "start" })}>
              <option value="join">Entrar (participante)</option>
              <option value="start">Iniciar como anfitrião (experimental)</option>
            </select>
          </Field>
          {m.joinMode === "start" && (
            <p className="muted small warn-text">
              Iniciar como anfitrião via Zoom Web não é suportado nesta fase — o operador deve
              iniciar a reunião e o sistema entra.
            </p>
          )}
          <Field label="Horário programado">
            <input value={m.scheduledTime ?? ""} onChange={(e) => setMeeting({ scheduledTime: e.target.value || null })} placeholder="(opcional, ISO)" />
          </Field>
          <Check label="Entrar automaticamente" checked={m.autoJoin} onChange={(v) => setMeeting({ autoJoin: v })} />
          <Check label="Iniciar reunião automaticamente" checked={m.autoStartMeeting} onChange={(v) => setMeeting({ autoStartMeeting: v })} />
          <Check label="Microfone ligado ao entrar" checked={m.micOnJoin} onChange={(v) => setMeeting({ micOnJoin: v })} />
          <Check label="Câmera ligada ao entrar" checked={m.cameraOnJoin} onChange={(v) => setMeeting({ cameraOnJoin: v })} />
          <Field label="Câmera padrão">
            <input value={m.cameraLabel} onChange={(e) => setMeeting({ cameraLabel: e.target.value })} placeholder='ex.: "OBS" (vazio = atual do Zoom)' />
          </Field>
          <p className="muted small">
            Seleciona a câmera cujo nome contém esse texto ao entrar (ex.: OBS Virtual Camera). O
            dispositivo precisa existir — a câmera do OBS só aparece com o OBS aberto.
          </p>
        </fieldset>

        <fieldset>
          <legend>Compartilhamento</legend>
          <Field label="Modo">
            <select value={sh.mode} onChange={(e) => setShare({ mode: e.target.value as Settings["share"]["mode"] })}>
              <option value="manual">Manual</option>
              <option value="assisted">Assistido</option>
              <option value="automatic">Automático (recomendado)</option>
            </select>
          </Field>
          {sh.mode === "automatic" && (
            <p className="muted small">
              Compartilha a janela do JW Library automaticamente quando ele projeta, e para quando
              a projeção acaba. Deixe o título da tela vazio para usar o seletor por janela.
            </p>
          )}
          <Field label="Monitor do projetor">
            <select value={sh.projectorDisplayId ?? ""} onChange={(e) => setShare({ projectorDisplayId: e.target.value || null })}>
              <option value="">(não definido)</option>
              {displays.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label} {d.primary ? "(principal)" : ""} — {d.bounds.width}×{d.bounds.height}
                </option>
              ))}
            </select>
          </Field>
          {displays.length === 0 && <p className="muted small">Monitores são enumerados apenas no Windows.</p>}
          <Check label="Compartilhar áudio da mídia (experimental)" checked={sh.shareAudio} onChange={(v) => setShare({ shareAudio: v })} />
          <Field label="Título da tela p/ auto-captura">
            <input value={sh.autoSourceTitle} onChange={(e) => setShare({ autoSourceTitle: e.target.value })} placeholder='ex.: "Tela 2" (experimental)' />
          </Field>
          <p className="muted small">
            Usado pelo modo automático para escolher o monitor sem o seletor do sistema. Frágil —
            requer reinício para aplicar e validação ao vivo.
          </p>
        </fieldset>

        <fieldset>
          <legend>Automações de anfitrião</legend>
          <Check label="Admitir automaticamente da sala de espera" checked={form.automations.autoAdmit} onChange={(v) => setAutomations({ autoAdmit: v })} />
          <Check label="Impedir que participantes se desmutem (ao entrar)" checked={form.automations.lockUnmute} onChange={(v) => setAutomations({ lockUnmute: v })} />
          <Check label="Reassumir host automaticamente (se outro aparelho pegar)" checked={form.automations.autoReclaimHost} onChange={(v) => setAutomations({ autoReclaimHost: v })} />
          <Check label="Lançar enquete automaticamente ao entrar" checked={form.automations.autoLaunchPoll} onChange={(v) => setAutomations({ autoLaunchPoll: v })} />
          <Field label="Enquete (nome)">
            <input value={form.automations.pollName} onChange={(e) => setAutomations({ pollName: e.target.value })} placeholder="(vazio = a primeira da lista)" />
          </Field>
          <p className="muted small">
            A enquete precisa estar criada no portal do Zoom e vinculada a esta reunião. O sistema só
            a lança — não cria perguntas. Deixe o nome vazio para lançar a primeira.
          </p>
          <Check label="Ocultar o navegador (off-screen) após autenticar" checked={form.browser.hidden} onChange={(v) => setBrowser({ hidden: v })} />
          <p className="muted small">
            O navegador aparece durante o login e fica oculto depois. Não é headless, para o
            compartilhamento de tela continuar funcionando.
          </p>
        </fieldset>

        <fieldset>
          <legend>Reconexão</legend>
          <Check label="Reconexão habilitada" checked={rc.enabled} onChange={(v) => setReconnect({ enabled: v })} />
          <Field label="Máx. tentativas">
            <input type="number" min={1} value={rc.maxAttempts} onChange={(e) => setReconnect({ maxAttempts: Number(e.target.value) })} />
          </Field>
          <Field label="Atraso base (ms)">
            <input type="number" min={1} value={rc.baseDelayMs} onChange={(e) => setReconnect({ baseDelayMs: Number(e.target.value) })} />
          </Field>
          <Field label="Atraso máx. (ms)">
            <input type="number" min={1} value={rc.maxDelayMs} onChange={(e) => setReconnect({ maxDelayMs: Number(e.target.value) })} />
          </Field>
        </fieldset>

        <fieldset>
          <legend>Retenção</legend>
          <Field label="Dias de eventos/logs">
            <input type="number" min={1} value={form.retention.eventDays} onChange={(e) => setRetention({ eventDays: Number(e.target.value) })} />
          </Field>
        </fieldset>
      </div>

      {saveErr && <div className="card error">{saveErr}</div>}
      <div className="settings-actions">
        <button disabled={busy} onClick={save}>{busy ? "Salvando…" : "Salvar"}</button>
        <button className="secondary" onClick={onClose}>Fechar</button>
        {saved && <span className="saved-ok">✓ Salvo</span>}
      </div>
    </Overlay>
  );
}

function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="secondary" onClick={onClose}>✕</button>
        </header>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="fieldrow">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="checkrow">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
