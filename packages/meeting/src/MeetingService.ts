import { randomUUID } from "node:crypto";
import {
  MeetingScheduleSchema,
  type MeetingKind,
  type MeetingPart,
  type MeetingSchedule,
  type Settings,
} from "@kmc/shared-types";
import { isoWeek, isWeekendDay, wolMeetingsUrl } from "./isoWeek.js";
import { WolClient, type RawPart } from "./wol.js";

export interface MeetingLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface MeetingDeps {
  log: MeetingLogger;
  getSettings: () => Settings;
  /** Publish a domain event (type must exist in EventTypeSchema). */
  emit: (type: "meeting.loaded" | "meeting.updated" | "system.warning", data?: Record<string, unknown>) => void;
  loadState: () => string | null;
  saveState: (json: string) => void;
  wol?: WolClient;
  now?: () => number;
}

const EMPTY: MeetingSchedule = MeetingScheduleSchema.parse({});

export interface LoadOpts {
  /** Explicit WOL meetings URL (overrides week). */
  url?: string;
  /** ISO "YYYY/WW" or "YYYY-MM-DD"; defaults to the current week. */
  week?: string;
  /** midweek | weekend; defaults by weekday. */
  kind?: MeetingKind;
}

/**
 * Owns the loaded meeting plan and the per-part timers. The server is the single
 * source of truth; clients render from (running, startedAt, baseElapsedSec) and
 * compute the live value themselves, so no per-second traffic is needed.
 */
export class MeetingService {
  private state: MeetingSchedule;
  private readonly wol: WolClient;
  private readonly now: () => number;

  constructor(private readonly deps: MeetingDeps) {
    this.wol = deps.wol ?? new WolClient();
    this.now = deps.now ?? (() => Date.now());
    const raw = deps.loadState();
    let parsed = EMPTY;
    if (raw) {
      try {
        parsed = MeetingScheduleSchema.parse(JSON.parse(raw));
      } catch {
        parsed = EMPTY;
      }
    }
    this.state = parsed;
  }

  getState(): MeetingSchedule {
    return structuredClone(this.state);
  }

  isEmpty(): boolean {
    return this.state.source === "none" || this.state.parts.length === 0;
  }

  private persist(): void {
    this.deps.saveState(JSON.stringify(this.state));
  }

  private changed(loaded = false): MeetingSchedule {
    this.persist();
    this.deps.emit(loaded ? "meeting.loaded" : "meeting.updated", { kind: this.state.kind });
    return this.getState();
  }

  private part(id: string): MeetingPart | undefined {
    return this.state.parts.find((p) => p.id === id);
  }

  /** Fold a running timer's elapsed time into base and stop it. */
  private accrue(p: MeetingPart): void {
    if (p.running && p.startedAt) {
      p.baseElapsedSec += Math.max(0, (this.now() - Date.parse(p.startedAt)) / 1000);
    }
    p.running = false;
    p.startedAt = null;
  }

  private newPart(raw: RawPart, order: number, source: "wol" | "manual"): MeetingPart {
    return {
      id: randomUUID(),
      section: raw.section,
      order,
      title: raw.title,
      allottedSec: Math.round(raw.minutes * 60),
      running: false,
      startedAt: null,
      baseElapsedSec: 0,
      source,
    };
  }

  private resolveUrl(opts: LoadOpts): string {
    if (opts.url) return opts.url;
    const base = this.deps.getSettings().meetingSchedule.wolBase;
    let date = new Date();
    if (opts.week && /^\d{4}-\d{2}-\d{2}$/.test(opts.week)) date = new Date(opts.week + "T12:00:00");
    if (opts.week && /^\d{4}\/\d{1,2}$/.test(opts.week)) {
      const [ys, ws] = opts.week.split("/");
      return wolMeetingsUrl(base, Number(ys), Number(ws));
    }
    const { year, week } = isoWeek(date);
    return wolMeetingsUrl(base, year, week);
  }

  /** Load a meeting from WOL (or rebuild weekend parts). Resets all timers. */
  async load(opts: LoadOpts = {}): Promise<MeetingSchedule> {
    const kind: MeetingKind = opts.kind ?? (isWeekendDay(new Date()) ? "weekend" : "midweek");
    const url = this.resolveUrl(opts);

    this.state = { ...this.state, loading: true, error: null, kind, wolUrl: url };
    this.changed();

    try {
      const cfg = this.deps.getSettings().meetingSchedule;
      let parts: MeetingPart[] = [];
      let weekLabel = "";
      let title = "";

      if (kind === "midweek") {
        const r = await this.wol.fetchMidweek(url);
        weekLabel = r.weekLabel;
        title = r.title;
        parts = r.parts.map((p, i) => this.newPart(p, i, "wol"));
      } else {
        const r = await this.wol.fetchWeekend(url);
        weekLabel = r.weekLabel;
        title = r.watchtowerTitle;
        const raws: RawPart[] = [
          { section: "Fim de Semana", title: "Discurso público", minutes: cfg.publicTalkMinutes },
          {
            section: "Fim de Semana",
            title: r.watchtowerTitle ? `A Sentinela: ${r.watchtowerTitle}` : "Estudo de A Sentinela",
            minutes: cfg.watchtowerMinutes,
          },
        ];
        parts = raws.map((p, i) => this.newPart(p, i, "wol"));
      }

      this.state = {
        source: "wol",
        kind,
        weekLabel,
        title,
        wolUrl: url,
        fetchedAt: new Date().toISOString(),
        activePartId: parts[0]?.id ?? null,
        parts,
        loading: false,
        error: null,
      };
      this.deps.log.info({ kind, count: parts.length, url }, "Meeting loaded from WOL");
      return this.changed(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state = { ...this.state, loading: false, error: message };
      this.deps.log.warn({ err: message, url }, "WOL load failed");
      this.deps.emit("system.warning", { scope: "meeting", message });
      this.persist();
      return this.getState();
    }
  }

  setActive(id: string): MeetingSchedule {
    if (this.part(id)) this.state.activePartId = id;
    return this.changed();
  }

  start(id: string): MeetingSchedule {
    const target = this.part(id);
    if (!target) return this.getState();
    if (target.running) return this.getState();
    // Only one timer runs at a time — pause any other running part.
    for (const p of this.state.parts) if (p.id !== id && p.running) this.accrue(p);
    target.running = true;
    target.startedAt = new Date(this.now()).toISOString();
    this.state.activePartId = id;
    return this.changed();
  }

  pause(id: string): MeetingSchedule {
    const p = this.part(id);
    if (p) this.accrue(p);
    return this.changed();
  }

  /** Pause the part and make the NEXT part active (fast meeting flow). */
  pauseAndAdvance(id: string): MeetingSchedule {
    const p = this.part(id);
    if (p) this.accrue(p);
    const idx = this.state.parts.findIndex((x) => x.id === id);
    const next = idx >= 0 ? this.state.parts[idx + 1] : undefined;
    if (next) this.state.activePartId = next.id;
    return this.changed();
  }

  reset(id: string): MeetingSchedule {
    const p = this.part(id);
    if (p) {
      p.running = false;
      p.startedAt = null;
      p.baseElapsedSec = 0;
    }
    return this.changed();
  }

  /** Set the elapsed time directly (the "forgot to start/reset" fix). */
  setElapsed(id: string, sec: number): MeetingSchedule {
    const p = this.part(id);
    if (p) {
      p.baseElapsedSec = Math.max(0, sec);
      if (p.running) p.startedAt = new Date(this.now()).toISOString();
    }
    return this.changed();
  }

  setAllotted(id: string, sec: number): MeetingSchedule {
    const p = this.part(id);
    if (p) p.allottedSec = Math.max(0, Math.round(sec));
    return this.changed();
  }

  setTitle(id: string, title: string): MeetingSchedule {
    const p = this.part(id);
    if (p) p.title = title;
    return this.changed();
  }

  addPart(input: { section?: string; title: string; minutes: number }): MeetingSchedule {
    const order = this.state.parts.length
      ? Math.max(...this.state.parts.map((p) => p.order)) + 1
      : 0;
    this.state.parts.push(
      this.newPart(
        { section: input.section ?? "Extra", title: input.title, minutes: input.minutes },
        order,
        "manual",
      ),
    );
    return this.changed();
  }

  removePart(id: string): MeetingSchedule {
    this.state.parts = this.state.parts.filter((p) => p.id !== id);
    if (this.state.activePartId === id) this.state.activePartId = this.state.parts[0]?.id ?? null;
    return this.changed();
  }

  resetAll(): MeetingSchedule {
    for (const p of this.state.parts) {
      p.running = false;
      p.startedAt = null;
      p.baseElapsedSec = 0;
    }
    return this.changed();
  }

  /** Explicit import; callers preview the programme before replacing timers. */
  replaceProgramme(input: {weekLabel:string;title:string;kind:MeetingKind;parts:{section:string;title:string;allottedSec:number}[]}): MeetingSchedule {
    this.state=MeetingScheduleSchema.parse({source:'manual',kind:input.kind,weekLabel:input.weekLabel,title:input.title,
      activePartId:null,parts:input.parts.map((part,order)=>({id:randomUUID(),order,section:part.section,title:part.title,allottedSec:part.allottedSec,source:'manual'}))});
    this.state.activePartId=this.state.parts[0]?.id ?? null;
    return this.changed(true);
  }
}
