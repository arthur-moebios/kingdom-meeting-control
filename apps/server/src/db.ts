import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  SettingsSchema,
  type DomainEvent,
  type EventType,
  type Settings,
} from "@kmc/shared-types";

/**
 * SQLite persistence using Node's built-in node:sqlite (no native build).
 * Stores: settings (single JSON row), operational events, and a command audit.
 * Participant personal data is NOT persisted beyond transient event payloads.
 */
export class Db {
  private db: DatabaseSync;

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
    `);
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
