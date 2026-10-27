import pino from "pino";
import { Writable } from "node:stream";

export interface LogRecord {
  level: number;
  levelLabel: string;
  time: string;
  msg: string;
}

const LEVEL_LABELS: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

/** Keeps the last N log records in memory for the dashboard "recent logs" panel. */
export class LogRingBuffer {
  private buf: LogRecord[] = [];
  constructor(private readonly max = 200) {}
  push(r: LogRecord): void {
    this.buf.push(r);
    if (this.buf.length > this.max) this.buf.shift();
  }
  recent(n = 50): LogRecord[] {
    return this.buf.slice(-n);
  }
  get size(): number {
    return this.buf.length;
  }
}

export function createLogger(level: string): { logger: pino.Logger; ring: LogRingBuffer } {
  const ring = new LogRingBuffer();

  // Custom stream that captures structured records into the ring buffer AND
  // writes a readable line to stdout. Logs never contain tokens/cookies —
  // callers must not log secrets (enforced by convention + review).
  const capture = new Writable({
    write(chunk, _enc, cb) {
      const line = chunk.toString();
      try {
        const o = JSON.parse(line) as { level: number; time: number; msg?: string };
        const levelLabel = LEVEL_LABELS[o.level] ?? String(o.level);
        ring.push({
          level: o.level,
          levelLabel,
          time: new Date(o.time).toISOString(),
          msg: o.msg ?? "",
        });
        process.stdout.write(
          `${new Date(o.time).toISOString()} ${levelLabel.toUpperCase().padEnd(5)} ${o.msg ?? ""}\n`,
        );
      } catch {
        process.stdout.write(line);
      }
      cb();
    },
  });

  const logger = pino({ level }, capture);
  return { logger, ring };
}
