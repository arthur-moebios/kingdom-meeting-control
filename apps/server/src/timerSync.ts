import type { TimerRoom } from "@kmc/shared-types";
import { AttendanceSync, type SyncDeps } from "./attendanceSync.js";
import { destinoFingerprint } from "./mapasjwConfig.js";
import { isoWithOffset } from "./attendance.js";
import type { TimerHistory, TimerTipo } from "./timerHistory.js";

export const TIMER_PATH = "/api/kmc/cronometro";

/** Push opcional do cronômetro das partes (Salão Principal e Sala B) para o Mapas JW. Mesmo worker da assistência, fila própria. */
export class TimerSync extends AttendanceSync {
  constructor(deps: Omit<SyncDeps, "outbox" | "path" | "label">, private readonly history: TimerHistory) {
    super({ ...deps, outbox: deps.db.timerOutbox, path: TIMER_PATH, label: "cronômetro" });
  }

  /** A assistência não passa por aqui: este worker só envia o cronômetro. */
  override enqueue(): boolean { return false; }

  override start(): void {
    try { this.d.db.pruneTimerHistory(new Date(this.now().getTime() - 90 * 86_400_000).toISOString().slice(0, 10)); } catch { /* best-effort */ }
    super.start();
  }

  /**
   * Enfileira o snapshot atual da reunião/sala. Pendentes da mesma reunião/sala são substituídos (coalescência).
   * Sem pareamento não faz nada. Retorna true se enfileirou.
   */
  enqueueSnapshot(date: string, tipo: TimerTipo, room: TimerRoom): boolean {
    const resolved = this.resolve();
    if (!resolved) return false;
    const snap = this.history.load(date, tipo, room);
    if (!snap || !snap.parts.some((p) => p.usado_s !== null)) return false;
    const at = this.now();
    const payload = {
      data: date,
      tipo,
      sala: room,
      partes: snap.parts.slice(0, 40).map((p) => ({
        chave: p.chave, ordem: p.ordem, secao: p.secao, titulo: p.titulo,
        previsto_s: p.previsto_s, usado_s: p.usado_s, designado: p.designado, ajudante: p.ajudante,
      })),
      capturado_em: isoWithOffset(at),
      instancia: "",
      versao_kmc: this.d.appVersion,
    };
    this.d.db.timerOutbox.outboxEnqueue(date, `${tipo}:${room}`, JSON.stringify(payload), at.toISOString(), destinoFingerprint(resolved.config));
    if (!this.stopped) this.schedule(0);
    return true;
  }

  /** Após o pareamento: reenvia o que foi medido nos últimos dias (o que estava na fila foi descartado). */
  enqueueRecent(days = 14): number {
    const since = new Date(this.now().getTime() - days * 86_400_000);
    const from = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, "0")}-${String(since.getDate()).padStart(2, "0")}`;
    let n = 0;
    for (const s of this.d.db.listTimerSnapshotsSince(from)) {
      if (this.enqueueSnapshot(s.date, s.tipo as TimerTipo, s.room as TimerRoom)) n++;
    }
    return n;
  }
}
