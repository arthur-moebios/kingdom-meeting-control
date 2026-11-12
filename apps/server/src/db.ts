import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  SettingsSchema,
  type DomainEvent,
  type EventType,
  type PollResult,
  type Settings,
} from "@kmc/shared-types";

/**
 * SQLite persistence using Node's built-in node:sqlite (no native build).
 * Stores: settings (single JSON row), operational events, and a command audit.
 * Participant personal data is NOT persisted beyond transient event payloads.
 */
export interface OutboxRow {
  id: number;
  date: string;
  tipo: string;
  payload: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  /** Impressão digital do destino (URL + token) para o qual o item foi montado; null = desconhecido. */
  destino: string | null;
}

/**
 * Fila de envio (outbox) em tabela própria, com o mesmo esquema e as mesmas operações da assistência.
 * Usada pelo cronômetro: tabela irmã, sem tocar na `attendance_outbox`.
 */
export class OutboxTable {
  constructor(private readonly db: DatabaseSync, private readonly table: string) {
    if (!/^[a-z_]+$/.test(table)) throw new Error("nome de tabela inválido");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        tipo TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        nextAttemptAt TEXT NOT NULL,
        lastError TEXT,
        createdAt TEXT NOT NULL,
        sentAt TEXT,
        destino TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_${table}_status ON ${table}(status, nextAttemptAt);
    `);
  }
  /** Pendentes do mesmo (date,tipo) são substituídos: o estado mais recente vence. */
  outboxEnqueue(date: string, tipo: string, payload: string, nowIso: string, destino: string): number {
    this.db.prepare(`DELETE FROM ${this.table} WHERE date = ? AND tipo = ? AND status = 'pending'`).run(date, tipo);
    const info = this.db
      .prepare(`INSERT INTO ${this.table} (date, tipo, payload, nextAttemptAt, createdAt, destino) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(date, tipo, payload, nowIso, nowIso, destino);
    return Number(info.lastInsertRowid);
  }
  outboxDiscardPending(): number {
    return Number(this.db.prepare(`DELETE FROM ${this.table} WHERE status = 'pending'`).run().changes);
  }
  outboxNextDue(nowIso: string): OutboxRow | null {
    return (this.db.prepare(`SELECT * FROM ${this.table} WHERE status = 'pending' AND nextAttemptAt <= ? ORDER BY id LIMIT 1`)
      .get(nowIso) as OutboxRow | undefined) ?? null;
  }
  outboxEarliestPending(): string | null {
    const row = this.db.prepare(`SELECT MIN(nextAttemptAt) AS t FROM ${this.table} WHERE status = 'pending'`).get() as { t: string | null };
    return row.t ?? null;
  }
  outboxMarkSent(id: number, nowIso: string): void {
    this.db.prepare(`UPDATE ${this.table} SET status = 'sent', sentAt = ?, lastError = NULL WHERE id = ? AND status = 'pending'`).run(nowIso, id);
  }
  outboxMarkRetry(id: number, attempts: number, nextIso: string, error: string): void {
    this.db.prepare(`UPDATE ${this.table} SET attempts = ?, nextAttemptAt = ?, lastError = ? WHERE id = ? AND status = 'pending'`).run(attempts, nextIso, error, id);
  }
  outboxMarkFailed(id: number, attempts: number, error: string): void {
    this.db.prepare(`UPDATE ${this.table} SET status = 'failed', attempts = ?, lastError = ? WHERE id = ? AND status = 'pending'`).run(attempts, error, id);
  }
  outboxCounts(): { pending: number; failed: number } {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM ${this.table} WHERE status IN ('pending','failed') GROUP BY status`)
      .all() as { status: string; n: number }[];
    const n = (st: string) => Number(rows.find((r) => r.status === st)?.n ?? 0);
    return { pending: n("pending"), failed: n("failed") };
  }
  outboxLastSentAt(): string | null {
    const row = this.db.prepare(`SELECT MAX(sentAt) AS t FROM ${this.table}`).get() as { t: string | null };
    return row.t ?? null;
  }
  outboxList(limit = 50): OutboxRow[] {
    return this.db.prepare(`SELECT * FROM ${this.table} ORDER BY id DESC LIMIT ?`).all(limit) as unknown as OutboxRow[];
  }
  outboxPrune(olderThanIso: string): number {
    return Number(this.db.prepare(`DELETE FROM ${this.table} WHERE status != 'pending' AND createdAt < ?`).run(olderThanIso).changes);
  }
}

export class Db {
  private db: DatabaseSync;
  /** Fila do cronômetro (tabela irmã da assistência). */
  readonly timerOutbox: OutboxTable;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        ts TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE TABLE IF NOT EXISTS audit (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS poll_results (
        date TEXT NOT NULL,
        pollName TEXT NOT NULL,
        json TEXT NOT NULL,
        capturedAt TEXT NOT NULL,
        PRIMARY KEY (date, pollName)
      );
      CREATE INDEX IF NOT EXISTS idx_poll_results_date ON poll_results(date);
      CREATE TABLE IF NOT EXISTS attendance_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        tipo TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        nextAttemptAt TEXT NOT NULL,
        lastError TEXT,
        createdAt TEXT NOT NULL,
        sentAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_attendance_outbox_status ON attendance_outbox(status, nextAttemptAt);
      CREATE TABLE IF NOT EXISTS timer_history (
        date TEXT NOT NULL,
        tipo TEXT NOT NULL,
        room TEXT NOT NULL,
        json TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (date, tipo, room)
      );
    `);
    this.timerOutbox = new OutboxTable(this.db, "timer_outbox");
    // Migração: bancos criados antes da marca de destino ganham a coluna (itens antigos ficam com NULL e são recusados no envio).
    const cols = this.db.prepare("PRAGMA table_info(attendance_outbox)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "destino")) this.db.exec("ALTER TABLE attendance_outbox ADD COLUMN destino TEXT");
  }

  // -- poll results (history by day) -----------------------------------------

  /** Upsert the latest results for a given day + poll (one row per day+poll). */
  upsertPollResult(r: PollResult): void {
    this.db
      .prepare(
        "INSERT INTO poll_results (date, pollName, json, capturedAt) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(date, pollName) DO UPDATE SET json = excluded.json, capturedAt = excluded.capturedAt",
      )
      .run(r.date, r.pollName, JSON.stringify(r), r.capturedAt);
  }

  listPollResults(limit = 90): PollResult[] {
    const rows = this.db
      .prepare("SELECT json FROM poll_results ORDER BY date DESC, pollName ASC LIMIT ?")
      .all(limit) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as PollResult);
  }

  pollResultsForDate(date: string): PollResult[] {
    const rows = this.db
      .prepare("SELECT json FROM poll_results WHERE date = ? ORDER BY pollName ASC")
      .all(date) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as PollResult);
  }

  // -- generic key/value (JSON) ---------------------------------------------

  getKv(key: string): string | null {
    const row = this.db.prepare("SELECT v FROM kv WHERE k = ?").get(key) as
      | { v: string }
      | undefined;
    return row?.v ?? null;
  }

  setKv(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .run(key, value);
  }

  deleteKv(key: string): void {
    this.db.prepare("DELETE FROM kv WHERE k = ?").run(key);
  }

  /** Assistência presencial por data (YYYY-MM-DD), podada em ~90 dias. */
  getPresencial(date: string): number {
    try { const map = JSON.parse(this.getKv("attendance.presencial") || "{}") as Record<string, number>; return Number(map[date]) || 0; } catch { return 0; }
  }

  /** Como getPresencial, mas null quando nenhum valor foi registrado para a data. */
  getPresencialOrNull(date: string): number | null {
    try {
      const map = JSON.parse(this.getKv("attendance.presencial") || "{}") as Record<string, number>;
      return typeof map[date] === "number" ? map[date]! : null;
    } catch { return null; }
  }

  setPresencial(date: string, n: number): void {
    let map: Record<string, number> = {};
    try { map = JSON.parse(this.getKv("attendance.presencial") || "{}"); } catch { /* recomeça */ }
    map[date] = n;
    const cutoff = new Date(Date.now() - 90 * 24 * 3600_000).toISOString().slice(0, 10);
    for (const k of Object.keys(map)) if (k < cutoff) delete map[k];
    this.setKv("attendance.presencial", JSON.stringify(map));
  }

  // -- outbox da assistência (push para o Mapas JW) --------------------------

  /** Enfileira; envios PENDENTES do mesmo (date,tipo) são substituídos — o último valor vence. */
  outboxEnqueue(date: string, tipo: string, payload: string, nowIso: string, destino: string): number {
    this.db.prepare("DELETE FROM attendance_outbox WHERE date = ? AND tipo = ? AND status = 'pending'").run(date, tipo);
    const info = this.db
      .prepare("INSERT INTO attendance_outbox (date, tipo, payload, nextAttemptAt, createdAt, destino) VALUES (?, ?, ?, ?, ?, ?)")
      .run(date, tipo, payload, nowIso, nowIso, destino);
    return Number(info.lastInsertRowid);
  }

  /** Descarta os envios ainda pendentes (montados para um destino que deixou de valer). Devolve quantos. */
  outboxDiscardPending(): number {
    return Number(this.db.prepare("DELETE FROM attendance_outbox WHERE status = 'pending'").run().changes) + this.timerOutbox.outboxDiscardPending();
  }

  outboxNextDue(nowIso: string): OutboxRow | null {
    return (this.db
      .prepare("SELECT * FROM attendance_outbox WHERE status = 'pending' AND nextAttemptAt <= ? ORDER BY id LIMIT 1")
      .get(nowIso) as OutboxRow | undefined) ?? null;
  }

  /** Próximo instante em que há algo a enviar (null se a fila está vazia). */
  outboxEarliestPending(): string | null {
    const row = this.db
      .prepare("SELECT MIN(nextAttemptAt) AS t FROM attendance_outbox WHERE status = 'pending'")
      .get() as { t: string | null };
    return row.t ?? null;
  }

  outboxMarkSent(id: number, nowIso: string): void {
    this.db.prepare("UPDATE attendance_outbox SET status = 'sent', sentAt = ?, lastError = NULL WHERE id = ? AND status = 'pending'").run(nowIso, id);
  }

  outboxMarkRetry(id: number, attempts: number, nextIso: string, error: string): void {
    this.db.prepare("UPDATE attendance_outbox SET attempts = ?, nextAttemptAt = ?, lastError = ? WHERE id = ? AND status = 'pending'").run(attempts, nextIso, error, id);
  }

  outboxMarkFailed(id: number, attempts: number, error: string): void {
    this.db.prepare("UPDATE attendance_outbox SET status = 'failed', attempts = ?, lastError = ? WHERE id = ? AND status = 'pending'").run(attempts, error, id);
  }

  outboxCounts(): { pending: number; failed: number } {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM attendance_outbox WHERE status IN ('pending','failed') GROUP BY status")
      .all() as { status: string; n: number }[];
    const n = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
    return { pending: n("pending"), failed: n("failed") };
  }

  outboxLastSentAt(): string | null {
    const row = this.db.prepare("SELECT MAX(sentAt) AS t FROM attendance_outbox").get() as { t: string | null };
    return row.t ?? null;
  }

  outboxList(limit = 50): OutboxRow[] {
    return this.db.prepare("SELECT * FROM attendance_outbox ORDER BY id DESC LIMIT ?").all(limit) as unknown as OutboxRow[];
  }

  /** Último item enfileirado para a data (qualquer status), para dedupe de mudanças. */
  outboxLatestForDate(date: string): OutboxRow | null {
    return (this.db
      .prepare("SELECT * FROM attendance_outbox WHERE date = ? ORDER BY id DESC LIMIT 1")
      .get(date) as OutboxRow | undefined) ?? null;
  }

  /** Remove enviados/falhos antigos (os pendentes nunca são podados aqui). */
  outboxPrune(olderThanIso: string): number {
    const info = this.db.prepare("DELETE FROM attendance_outbox WHERE status != 'pending' AND createdAt < ?").run(olderThanIso);
    return Number(info.changes);
  }

  // -- histórico do cronômetro (medições consolidadas por reunião e sala) ----

  getTimerSnapshot(date: string, tipo: string, room: string): string | null {
    const row = this.db.prepare("SELECT json FROM timer_history WHERE date = ? AND tipo = ? AND room = ?").get(date, tipo, room) as { json: string } | undefined;
    return row?.json ?? null;
  }

  putTimerSnapshot(date: string, tipo: string, room: string, json: string, nowIso: string): void {
    this.db.prepare(
      "INSERT INTO timer_history (date, tipo, room, json, updatedAt) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(date, tipo, room) DO UPDATE SET json = excluded.json, updatedAt = excluded.updatedAt",
    ).run(date, tipo, room, json, nowIso);
  }

  /** Snapshots com data >= `sinceDate` (YYYY-MM-DD). */
  listTimerSnapshotsSince(sinceDate: string): { date: string; tipo: string; room: string }[] {
    return this.db.prepare("SELECT date, tipo, room FROM timer_history WHERE date >= ? ORDER BY date, tipo, room")
      .all(sinceDate) as { date: string; tipo: string; room: string }[];
  }

  pruneTimerHistory(beforeDate: string): number {
    return Number(this.db.prepare("DELETE FROM timer_history WHERE date < ?").run(beforeDate).changes);
  }

  // -- settings --------------------------------------------------------------

  getSettings(): Settings {
    const row = this.db.prepare("SELECT json FROM settings WHERE id = 1").get() as
      | { json: string }
      | undefined;
    if (!row) {
      const defaults = SettingsSchema.parse({});
      this.saveSettings(defaults);
      return defaults;
    }
    // Validate on read so a corrupt/old row can't crash the app silently.
    return SettingsSchema.parse(JSON.parse(row.json));
  }

  saveSettings(settings: Settings): void {
    const json = JSON.stringify(settings);
    this.db
      .prepare(
        "INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
      )
      .run(json);
  }

  // -- events ----------------------------------------------------------------

  appendEvent(ev: DomainEvent): void {
    this.db
      .prepare("INSERT OR IGNORE INTO events (id, type, ts, data) VALUES (?, ?, ?, ?)")
      .run(ev.id, ev.type, ev.ts, JSON.stringify(ev.data));
  }

  recentEvents(limit = 100): DomainEvent[] {
    const rows = this.db
      .prepare("SELECT id, type, ts, data FROM events ORDER BY ts DESC LIMIT ?")
      .all(limit) as { id: string; type: string; ts: string; data: string }[];
    return rows.map((r) => ({
      id: r.id,
      type: r.type as EventType,
      ts: r.ts,
      data: JSON.parse(r.data) as Record<string, unknown>,
    }));
  }

  pruneEvents(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const info = this.db.prepare("DELETE FROM events WHERE ts < ?").run(cutoff);
    return Number(info.changes);
  }

  // -- audit -----------------------------------------------------------------

  audit(actor: string, action: string, detail: Record<string, unknown> = {}): void {
    this.db
      .prepare("INSERT INTO audit (id, ts, actor, action, detail) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), new Date().toISOString(), actor, action, JSON.stringify(detail));
  }

  close(): void {
    this.db.close();
  }
}
