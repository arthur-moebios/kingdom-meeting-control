import type { MeetingSchedule } from "@kmc/shared-types";
import type { Db, OutboxRow } from "./db.js";
import { deriveTipo, isoWithOffset, zoomAttendance } from "./attendance.js";
import {
  MAPASJW_AUTH_KEY,
  resolveMapasJwConfigWithSource,
  tokenFingerprint,
  type MapasJwConfig,
  type MapasJwSource,
} from "./mapasjwConfig.js";

/** Push opcional da assistência consolidada para o backend externo "Mapas JW". */

export const ATTENDANCE_PATH = "/api/kmc/assistencia";
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
const IDLE_POLL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Item que não conseguiu sair em 3 dias é abandonado (o valor mais novo já o teria substituído). */
const MAX_AGE_MS = 3 * 24 * 3600_000;
const KEEP_HISTORY_MS = 30 * 24 * 3600_000;

/** 5 s, 10 s, 20 s ... teto de 5 min. `attempts` = falhas já ocorridas (>=1). */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

export interface SyncLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface SyncDeps {
  db: Db;
  logger: SyncLogger;
  getMeeting: () => MeetingSchedule;
  appVersion: string;
  fetch?: typeof fetch;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type TickResult = "inactive" | "paused" | "idle" | "sent" | "retry" | "failed";

interface LastError { message: string; at: string; permanent: boolean; httpStatus: number | null }
interface LastResult { date: string; tipo: string; atualizado: boolean | null; motivo: string | null; at: string }

export class AttendanceSync {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private abort: AbortController | null = null;
  private lastAttemptAt: string | null = null;
  private lastError: LastError | null = null;
  private lastResult: LastResult | null = null;
  private warnedInactive = false;

  constructor(private readonly d: SyncDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }
  private resolve() { return resolveMapasJwConfigWithSource(this.d.db, this.d.env ?? process.env); }

  /** Configuração atual (recarregada a cada chamada) ou null => push inativo. */
  isActive(): boolean { return this.resolve() !== null; }

  private authFailed(cfg: MapasJwConfig): boolean {
    return this.d.db.getKv(MAPASJW_AUTH_KEY) === tokenFingerprint(cfg.token);
  }

  /**
   * Enfileira a assistência consolidada da data (lida do Db, sempre o valor atual).
   * Sem configuração não faz nada. Retorna true se enfileirou.
   */
  enqueue(date: string): boolean {
    if (!this.resolve()) return false;
    const { db } = this.d;
    const presencial = db.getPresencialOrNull(date);
    const zoom = zoomAttendance(db.pollResultsForDate(date));
    if (presencial === null && zoom === null) return false;
    const at = this.now();
    const tipo = deriveTipo(this.d.getMeeting(), date);
    const payload = {
      data: date,
      tipo,
      presencial,
      zoom,
      capturado_em: isoWithOffset(at),
      instancia: "",
      versao_kmc: this.d.appVersion,
    };
    db.outboxEnqueue(date, tipo, JSON.stringify(payload), at.toISOString());
    if (!this.stopped) this.schedule(0);
    return true;
  }

  start(): void {
    this.stopped = false;
    try { this.d.db.outboxPrune(new Date(this.now().getTime() - KEEP_HISTORY_MS).toISOString()); } catch { /* best-effort */ }
    const active = this.resolve();
    if (active) {
      this.d.logger.info({}, `Push de assistência para o Mapas JW ativo (instância "${active.config.instancia}", origem ${active.source})`);
    } else {
      this.d.logger.info({}, "Push de assistência para o Mapas JW inativo (integração opcional, sem configuração)");
    }
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), Math.max(0, delayMs));
    this.timer.unref();
  }

  private async run(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    let result: TickResult = "idle";
    try { result = await this.tick(); }
    catch (err) { this.d.logger.error({}, `Falha inesperada no envio de assistência: ${String(err)}`); result = "retry"; }
    finally { this.running = false; }
    if (this.stopped) return;
    if (result === "sent" || result === "failed") return this.schedule(0);
    const earliest = this.d.db.outboxEarliestPending();
    if (!earliest) return; // fila vazia: o próximo enqueue acorda o worker
    if (result === "inactive" || result === "paused") return this.schedule(IDLE_POLL_MS);
    this.schedule(Math.min(Math.max(Date.parse(earliest) - this.now().getTime(), 250), IDLE_POLL_MS));
  }

  /** Processa no máximo UM item vencido. Exposto para testes. */
  async tick(): Promise<TickResult> {
    const resolved = this.resolve();
    if (!resolved) {
      if (!this.warnedInactive && this.d.db.outboxCounts().pending > 0) {
        this.warnedInactive = true;
        this.d.logger.warn({}, "Mapas JW sem configuração: itens pendentes aguardam o pareamento");
      }
      return "inactive";
    }
    this.warnedInactive = false;
    const { config: cfg } = resolved;
    if (this.authFailed(cfg)) return "paused"; // token recusado: só retoma com outro token
    const row = this.d.db.outboxNextDue(this.now().toISOString());
    if (!row) return "idle";
    if (this.now().getTime() - Date.parse(row.createdAt) > MAX_AGE_MS) {
      this.permanent(row, "expirado após 3 dias sem conseguir enviar", null);
      return "failed";
    }
    return this.send(row, cfg);
  }

  private clean(text: string, cfg: MapasJwConfig): string {
    return text.split(cfg.token).join("***").replace(/\s+/g, " ").slice(0, 300);
  }

  private permanent(row: OutboxRow, message: string, httpStatus: number | null): void {
    const at = this.now().toISOString();
    this.d.db.outboxMarkFailed(row.id, row.attempts + 1, message);
    this.lastError = { message, at, permanent: true, httpStatus };
    this.d.logger.error({}, `Mapas JW recusou a assistência de ${row.date} (${row.tipo}) de forma permanente: ${message}`);
  }

  private async send(row: OutboxRow, cfg: MapasJwConfig): Promise<TickResult> {
    const doFetch = this.d.fetch ?? fetch;
    const payload = { ...(JSON.parse(row.payload) as Record<string, unknown>), instancia: cfg.instancia };
    const at = this.now().toISOString();
    this.lastAttemptAt = at;
    this.abort = new AbortController();
    const signals = [this.abort.signal, AbortSignal.timeout(this.d.timeoutMs ?? REQUEST_TIMEOUT_MS)];
    let res: Response;
    try {
      res = await doFetch(`${cfg.baseUrl}${ATTENDANCE_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
        redirect: "manual",
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error";
      return this.retry(row, cfg, `rede: ${name === "TimeoutError" || name === "AbortError" ? "tempo esgotado" : this.clean(String(err), cfg)}`, null, null);
    } finally { this.abort = null; }

    const status = res.status;
    let body: Record<string, unknown> | null = null;
    try { body = (await res.json()) as Record<string, unknown>; } catch { /* corpo não-JSON */ }

    if (status >= 200 && status < 300) {
      this.d.db.outboxMarkSent(row.id, this.now().toISOString());
      if (this.d.db.getKv(MAPASJW_AUTH_KEY)) this.d.db.deleteKv(MAPASJW_AUTH_KEY);
      const atualizado = typeof body?.atualizado === "boolean" ? body.atualizado : null;
      const motivo = typeof body?.motivo === "string" ? body.motivo : null;
      this.lastResult = { date: row.date, tipo: row.tipo, atualizado, motivo, at: this.now().toISOString() };
      this.lastError = null;
      this.d.logger.info({}, `Assistência de ${row.date} (${row.tipo}) enviada ao Mapas JW` +
        (atualizado === false ? ` — não aplicada pelo servidor (${motivo ?? "sem motivo"})` : ""));
      return "sent";
    }
    const detail = this.clean(typeof body?.message === "string" ? body.message : body ? JSON.stringify(body) : "", cfg);
    if (status === 401) {
      this.d.db.setKv(MAPASJW_AUTH_KEY, tokenFingerprint(cfg.token));
      this.permanent(row, `HTTP 401: token inválido ou revogado${detail ? ` (${detail})` : ""}`, 401);
      this.d.logger.error({}, "Mapas JW: conexão considerada DESCONECTADA (token recusado). Reconecte o KMC ao Mapas JW.");
      return "failed";
    }
    if (status === 429 || status === 408 || status === 425 || status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      return this.retry(row, cfg, `HTTP ${status}${detail ? `: ${detail}` : ""}`, status, Number.isFinite(ra) && ra > 0 ? ra * 1000 : null);
    }
    // 422 (validação), demais 4xx e 3xx: reenviar o mesmo corpo não resolve.
    this.permanent(row, `HTTP ${status}${detail ? `: ${detail}` : ""}`, status);
    return "failed";
  }

  private retry(row: OutboxRow, cfg: MapasJwConfig, message: string, httpStatus: number | null, retryAfterMs: number | null): TickResult {
    const attempts = row.attempts + 1;
    const wait = Math.min(Math.max(backoffMs(attempts), retryAfterMs ?? 0), BACKOFF_MAX_MS);
    const next = new Date(this.now().getTime() + wait).toISOString();
    this.d.db.outboxMarkRetry(row.id, attempts, next, message);
    this.lastError = { message, at: this.now().toISOString(), permanent: false, httpStatus };
    this.d.logger.warn({}, `Mapas JW: envio da assistência de ${row.date} falhou (${message}); tentativa ${attempts}, nova em ${Math.round(wait / 1000)} s`);
    return "retry";
  }

  /** Estado observável para o painel do operador. Nunca inclui URL nem token. */
  status() {
    const resolved = this.resolve();
    const counts = this.d.db.outboxCounts();
    const state: "disabled" | "connected" | "disconnected" = !resolved
      ? "disabled"
      : this.authFailed(resolved.config) ? "disconnected" : "connected";
    const source: MapasJwSource | null = resolved?.source ?? null;
    return {
      enabled: resolved !== null,
      /** disabled = sem configuração; disconnected = token recusado (401); connected = demais casos. */
      state,
      connected: state === "connected",
      source,
      instancia: resolved?.config.instancia ?? null,
      pending: counts.pending,
      failed: counts.failed,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.d.db.outboxLastSentAt(),
      nextAttemptAt: this.d.db.outboxEarliestPending(),
      lastError: this.lastError,
      lastResult: this.lastResult,
      recent: this.d.db.outboxList(10).map((r) => ({
        id: r.id, date: r.date, tipo: r.tipo, status: r.status, attempts: r.attempts,
        lastError: r.lastError, createdAt: r.createdAt, sentAt: r.sentAt,
      })),
    };
  }
}
