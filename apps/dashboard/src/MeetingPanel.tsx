import { useState } from "react";
import type { MeetingPart, MeetingSchedule, TimerNames } from "@kmc/shared-types";
import { api } from "./api.js";
import { useClock, elapsedSec, fmtClock, parseClock } from "./timer.js";

type RunFn = () => Promise<unknown>;

/** Visual state of a part's remaining time. */
function phase(remaining: number, allotted: number, warnSeconds: number): "idle" | "ok" | "warn" | "over" {
  if (allotted <= 0) return "idle";
  if (remaining < 0) return "over";
  if (remaining <= warnSeconds) return "warn";
  return "ok";
}

export function MeetingPanel({ meeting, names, warnSeconds, compact = false }: { meeting: MeetingSchedule; names?:Record<string,TimerNames>; warnSeconds: number; compact?: boolean }) {
  const anyRunning = meeting.parts.some((p) => p.running);
  const now = useClock(anyRunning);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [week, setWeek] = useState("");
  const [adjustId, setAdjustId] = useState<string | null>(null);

  const run = async (fn: RunFn): Promise<void> => {
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

  const active = meeting.parts.find((p) => p.id === meeting.activePartId) ?? null;

  return (
    <section className="card meeting">
      <div className="m-head">
        <div>
          <h2 style={{ margin: 0 }}>Reunião</h2>
          <div className="m-week">
            {meeting.weekLabel || "Nenhuma reunião carregada"}
            {meeting.title && <span className="m-theme"> · {meeting.title}</span>}
          </div>
        </div>
        <details className="m-config" open={compact ? undefined : true}>
          {compact && <summary>Programação ▾</summary>}
        <div className="m-load">
          <button
            className={meeting.kind === "midweek" ? "" : "secondary"}
            disabled={busy}
            onClick={() => run(() => api.meetingLoad({ kind: "midweek", week: week || undefined }))}
          >
            Meio de semana
          </button>
          <button
            className={meeting.kind === "weekend" ? "" : "secondary"}
            disabled={busy}
            onClick={() => run(() => api.meetingLoad({ kind: "weekend", week: week || undefined }))}
          >
            Fim de semana
          </button>
          <input
            className="m-weekin"
            placeholder="semana (ex. 2026/44 ou data)"
            value={week}
            onChange={(e) => setWeek(e.target.value)}
          />
          <button
            className="secondary"
            disabled={busy}
            title="Recarregar do WOL"
            onClick={() => run(() => api.meetingLoad({ kind: meeting.kind ?? undefined, week: week || undefined }))}
          >
            ⟳ WOL
          </button>
        </div>
        </details>
      </div>

      {meeting.loading && <div className="m-info">Carregando do wol.jw.org…</div>}
      {meeting.error && <div className="m-err">WOL: {meeting.error}</div>}
      {err && <div className="m-err">{err}</div>}

      {/* Active part — big countdown */}
      {active ? <ActivePart part={active} now={now} warnSeconds={warnSeconds} busy={busy} run={run} /> : null}

      {/* Parts list */}
      {meeting.parts.length > 0 ? (
        <ul className="m-list">
          {meeting.parts.map((p) => {
            const el = elapsedSec(p, now);
            const remaining = p.allottedSec - el;
            const ph = phase(remaining, p.allottedSec, warnSeconds);
            const isActive = p.id === meeting.activePartId;
            return (
              <li key={p.id} className={`m-row ${isActive ? "active" : ""} ph-${ph}`}>
                <button className="m-rowmain" onClick={() => run(() => api.meetingActive(p.id))} title={`Tornar parte atual: ${p.title}`}>
                  <span className="m-sec">{p.section}</span>
                  <span className="m-title">{p.title}</span>
                  {(names?.[p.id]?.name || names?.[p.id]?.secondName) && <span className="m-assignment">{[names?.[p.id]?.name,names?.[p.id]?.secondName].filter(Boolean).join(' / ')}</span>}
                </button>
                <span className="m-alloc">{Math.round(p.allottedSec / 60)}m</span>
                <span className={`m-rem ph-${ph}`}>{p.allottedSec > 0 ? fmtClock(remaining) : fmtClock(el)}</span>
                <span className="m-ctl">
                  {p.running ? (
                    <button className="secondary" disabled={busy} onClick={() => run(() => api.meetingPause(p.id))}>❚❚</button>
                  ) : (
                    <button disabled={busy} onClick={() => run(() => api.meetingStart(p.id))}>▶</button>
                  )}
                  <button className="secondary" disabled={busy} onClick={() => run(() => api.meetingReset(p.id))}>↺</button>
                  <button className="secondary" disabled={busy} onClick={() => setAdjustId(adjustId === p.id ? null : p.id)}>✎</button>
                  {p.source === "manual" && (
                    <button className="danger" disabled={busy} onClick={() => run(() => api.meetingRemovePart(p.id))}>✕</button>
                  )}
                </span>
                {adjustId === p.id && (
                  <AdjustEditor part={p} now={now} busy={busy} run={run} onDone={() => setAdjustId(null)} />
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        !meeting.loading && <p className="muted">Carregue a reunião do WOL para ver as partes.</p>
      )}

      <div className="m-foot">
        <AddPart busy={busy} run={run} />
        {meeting.parts.length > 0 && (
          <button className="secondary" disabled={busy} onClick={() => run(() => api.meetingResetAll())}>
            Zerar todos
          </button>
        )}
      </div>
    </section>
  );
}

export function ActivePart({
  part,
  now,
  warnSeconds,
  busy,
  run,
  commands,
}: {
  part: MeetingPart;
  now: number;
  warnSeconds: number;
  busy: boolean;
  run: (fn: RunFn) => Promise<void>;
  commands?: {start:(id:string)=>Promise<unknown>;pauseNext:(id:string)=>Promise<unknown>;reset:(id:string)=>Promise<unknown>};
}) {
  const el = elapsedSec(part, now);
  const remaining = part.allottedSec - el;
  const ph = phase(remaining, part.allottedSec, warnSeconds);
  const pct = part.allottedSec > 0 ? Math.min(100, (el / part.allottedSec) * 100) : 0;
  return (
    <div className={`m-active ph-${ph}`}>
      <div className="m-active-top">
        <span className="m-sec">{part.section}</span>
        <span className="m-active-title">{part.title}</span>
      </div>
      <div className="m-bigclock">
        {part.allottedSec > 0 ? fmtClock(remaining) : fmtClock(el)}
        {part.allottedSec > 0 && remaining < 0 && <span className="m-over"> acima</span>}
      </div>
      {part.allottedSec > 0 && (
        <div className="m-bar">
          <div className="m-barfill" style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="m-active-ctl">
        {part.running ? (
            <button className="danger" disabled={busy} onClick={() => run(() => commands ? commands.pauseNext(part.id) : api.meetingPauseNext(part.id))}>
            ❚❚ Pausar e próxima
          </button>
        ) : (
          <button disabled={busy} onClick={() => run(() => commands ? commands.start(part.id) : api.meetingStart(part.id))}>▶ Iniciar</button>
        )}
        <button className="secondary" disabled={busy} onClick={() => run(() => commands ? commands.reset(part.id) : api.meetingReset(part.id))}>↺ Zerar</button>
        <span className="m-elapsed muted small">Decorrido {fmtClock(el)} / {fmtClock(part.allottedSec)}</span>
      </div>
    </div>
  );
}

function AdjustEditor({
  part,
  now,
  busy,
  run,
  onDone,
}: {
  part: MeetingPart;
  now: number;
  busy: boolean;
  run: (fn: RunFn) => Promise<void>;
  onDone: () => void;
}) {
  const [mins, setMins] = useState(String(Math.round(part.allottedSec / 60)));
  const [elapsed, setElapsed] = useState(fmtClock(elapsedSec(part, now)));

  const apply = async (): Promise<void> => {
    const allottedSec = Math.max(0, Math.round((parseFloat(mins) || 0) * 60));
    const elapsedSecVal = parseClock(elapsed);
    await run(() =>
      api.meetingAdjust(part.id, {
        allottedSec,
        ...(elapsedSecVal !== null ? { elapsedSec: elapsedSecVal } : {}),
      }),
    );
    onDone();
  };

  return (
    <div className="m-adjust">
      <label>
        Duração (min)
        <input type="number" min={0} value={mins} onChange={(e) => setMins(e.target.value)} />
      </label>
      <label>
        Tempo decorrido (m:ss)
        <input value={elapsed} onChange={(e) => setElapsed(e.target.value)} placeholder="0:00" />
      </label>
      <button disabled={busy} onClick={() => void apply()}>Aplicar</button>
      <button className="secondary" disabled={busy} onClick={onDone}>Cancelar</button>
    </div>
  );
}

function AddPart({ busy, run }: { busy: boolean; run: (fn: RunFn) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [mins, setMins] = useState("5");
  const add = async (): Promise<void> => {
    if (!title.trim()) return;
    await run(() => api.meetingAddPart({ title: title.trim(), minutes: parseFloat(mins) || 0 }));
    setTitle("");
  };
  return (
    <div className="m-addpart">
      <input placeholder="Parte extra" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input className="m-mini" type="number" min={0} value={mins} onChange={(e) => setMins(e.target.value)} />
      <button className="secondary" disabled={busy || !title.trim()} onClick={() => void add()}>+ Parte</button>
    </div>
  );
}
