import type { MeetingKind, MeetingPart, MeetingSchedule, TimerRoom } from "@kmc/shared-types";
import type { Db } from "./db.js";
import { localDate } from "./attendance.js";

/**
 * Histórico do cronômetro: guarda, por reunião (data + tipo) e sala, o tempo REALMENTE usado em cada parte.
 *
 * Quando o tempo se consolida: o `MeetingService` soma o tempo corrido em `baseElapsedSec` quando a parte
 * PARA (pausar, "pausar e avançar", iniciar outra parte, fim da Sala B) ou quando o operador ajusta o tempo
 * à mão. Este módulo observa o estado a cada mudança e, ao ver uma parte parada cujo `baseElapsedSec`
 * mudou para um valor > 0, grava esse valor. Zerar (reset/resetAll) leva a base a 0 e NÃO apaga a medição;
 * trocar ou reimportar a programação gera partes novas (ids novos), mas a medição fica no histórico e é
 * reencontrada pelo título. Parte nunca medida fica com `usado_s = null`.
 */

export type TimerTipo = "meio_semana" | "fim_de_semana";

export interface TimerPartRecord {
  /** Identificador estável DESTE histórico (não muda com edição de título, nem com reimportação). */
  chave: string;
  ordem: number;
  secao: string;
  titulo: string;
  previsto_s: number;
  /** null = nunca medida. */
  usado_s: number | null;
  designado: string;
  ajudante: string;
  /** Id da parte no cronômetro da última vez em que foi vista (só para reencontrá-la; não vai ao servidor). */
  partId: string | null;
}

export interface TimerSnapshot { parts: TimerPartRecord[]; }

export interface TimerHistoryDeps {
  db: Db;
  getMeeting: (room: TimerRoom) => MeetingSchedule;
  /** Data da reunião carregada na sala (YYYY-MM-DD) ou null quando não se sabe. */
  getDate: (room: TimerRoom) => string | null;
  getAssignments: (room: TimerRoom) => Record<string, { name: string; secondName: string }>;
  /** Chamado quando o snapshot muda (e há ao menos uma medição). */
  onChange: (date: string, tipo: TimerTipo, room: TimerRoom) => void;
  now?: () => Date;
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
const slug = (s: string) => norm(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
const baseChave = (section: string, title: string) => [slug(section), slug(title)].filter(Boolean).join("-") || "parte";
const cut = (s: string, n: number) => (s ?? "").trim().slice(0, n);
export const tipoOf = (kind: MeetingKind | null): TimerTipo | null =>
  kind === "midweek" ? "meio_semana" : kind === "weekend" ? "fim_de_semana" : null;

export class TimerHistory {
  /** Último `baseElapsedSec` visto por id de parte — detecta o que MUDOU (a primeira vista só fixa a referência). */
  private readonly lastBase = new Map<string, number>();

  constructor(private readonly d: TimerHistoryDeps) {}
  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  load(date: string, tipo: TimerTipo, room: TimerRoom): TimerSnapshot | null {
    const raw = this.d.db.getTimerSnapshot(date, tipo, room);
    if (!raw) return null;
    try { const v = JSON.parse(raw) as TimerSnapshot; return Array.isArray(v.parts) ? v : null; } catch { return null; }
  }

  /** Observa o estado atual da sala. Com `live`, partes ainda correndo são gravadas com o tempo até agora (encerramento do app). */
  observe(room: TimerRoom, live = false): boolean {
    const meeting = this.d.getMeeting(room);
    const tipo = tipoOf(meeting.kind);
    if (!tipo || meeting.parts.length === 0) return false;
    if (room === "b" && tipo !== "meio_semana") return false; // a Sala B só existe no meio de semana
    const date = this.d.getDate(room) ?? localDate(this.now());
    const stored = this.load(date, tipo, room);
    const records: TimerPartRecord[] = (stored?.parts ?? []).map((r) => ({ ...r }));
    const assignments = this.d.getAssignments(room);
    const nowMs = this.now().getTime();

    const claimed = new Set<TimerPartRecord>();
    let measuredChange = false;
    const ordered = [...meeting.parts].sort((a, b) => a.order - b.order);
    const used = new Set<string>(records.map((r) => r.chave));
    for (const part of ordered) {
      // 1) mesma parte do cronômetro; 2) mesmo título/seção (reimportação); 3) nova.
      let rec = records.find((r) => !claimed.has(r) && r.partId === part.id)
        ?? records.find((r) => !claimed.has(r) && norm(r.secao) === norm(part.section) && norm(r.titulo) === norm(part.title));
      if (!rec) {
        const base = baseChave(part.section, part.title);
        let chave = base;
        for (let n = 2; used.has(chave); n++) chave = `${base}-${n}`;
        used.add(chave);
        rec = { chave, ordem: 0, secao: "", titulo: "", previsto_s: 0, usado_s: null, designado: "", ajudante: "", partId: part.id };
        records.push(rec);
      }
      claimed.add(rec);
      rec.partId = part.id; rec.ordem = Math.max(0, Math.min(1000, part.order)); rec.secao = cut(part.section, 120);
      rec.titulo = cut(part.title, 200) || `Parte ${rec.ordem + 1}`; rec.previsto_s = Math.max(0, Math.min(86_400, part.allottedSec));
      const names = assignments[part.id];
      if (names) { rec.designado = cut(names.name, 160); rec.ajudante = cut(names.secondName, 160); }

      const measured = this.measured(part, nowMs, live);
      if (measured !== null && measured !== rec.usado_s) { rec.usado_s = measured; measuredChange = true; }
    }
    // Registros que sumiram da programação: mantêm-se só os que têm medição.
    const kept = records.filter((r) => claimed.has(r) || r.usado_s !== null);
    for (const r of kept) if (!claimed.has(r)) r.partId = null;
    kept.sort((a, b) => a.ordem - b.ordem);

    if (!kept.some((r) => r.usado_s !== null)) return false; // nada medido ainda: não há o que guardar
    const next = JSON.stringify({ parts: kept } satisfies TimerSnapshot);
    if (!measuredChange && stored && JSON.stringify(stored) === next) return false;
    this.d.db.putTimerSnapshot(date, tipo, room, next, this.now().toISOString());
    this.d.onChange(date, tipo, room);
    return true;
  }

  /** Segundos a registrar para a parte agora, ou null (nada a registrar). */
  private measured(part: MeetingPart, nowMs: number, live: boolean): number | null {
    const prev = this.lastBase.get(part.id);
    this.lastBase.set(part.id, part.baseElapsedSec);
    let total: number;
    if (part.running && part.startedAt) {
      if (!live) return null; // correndo: o tempo só se consolida ao parar
      total = part.baseElapsedSec + Math.max(0, (nowMs - Date.parse(part.startedAt)) / 1000);
    } else {
      if (prev === undefined) return null;        // primeira vista: só referência
      if (prev === part.baseElapsedSec) return null; // nada mudou
      total = part.baseElapsedSec;
    }
    const sec = Math.min(86_400, Math.round(total));
    return sec > 0 ? sec : null; // zerar nunca sobrescreve uma medição
  }
}
