import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", () => ({ default: { existsSync: () => true } }));
import { JwMediaWatcher, parseJwMediaReading } from "./JwMediaWatcher.js";

function worker() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
}

describe("JW UIA worker protocol and lifecycle", () => {
  let watcher: JwMediaWatcher;
  beforeEach(() => { vi.useFakeTimers(); mocks.spawn.mockReset(); });
  afterEach(() => { watcher?.stop(); vi.useRealTimers(); });

  it("rejects malformed or contradictory readings", () => {
    for (const line of ["noise", "null", "{}", '{"jw":false,"active":true,"kind":"video"}',
      '{"jw":true,"active":false,"kind":"image"}', '{"jw":true,"active":true,"kind":"other"}']) {
      expect(parseJwMediaReading(line)).toBeNull();
    }
    expect(parseJwMediaReading('{"jw":true,"active":true,"kind":"image"}')?.kind).toBe("image");
  });

  it("delivers split JSON lines immediately without waiting for a poll", () => {
    const child = worker();
    mocks.spawn.mockReturnValue(child);
    const onReading = vi.fn();
    watcher = new JwMediaWatcher({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }, onReading, vi.fn());
    watcher.start();
    child.stdout.write('{"jw":true,"active":');
    expect(onReading).not.toHaveBeenCalled();
    child.stdout.write('true,"kind":"video"}\n');
    expect(onReading).toHaveBeenCalledWith({ jw: true, active: true, kind: "video" });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("restarts after failure and ignores late output from a stopped worker", () => {
    const first = worker(), second = worker();
    mocks.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const onReading = vi.fn(), unavailable = vi.fn();
    watcher = new JwMediaWatcher({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }, onReading, unavailable);
    watcher.start();
    first.emit("close", 1);
    expect(unavailable).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2000);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    watcher.stop();
    second.stdout.write('{"jw":true,"active":true,"kind":"image"}\n');
    second.emit("close", 0);
    vi.advanceTimersByTime(30_000);
    expect(onReading).not.toHaveBeenCalled();
    expect(second.kill).toHaveBeenCalledOnce();
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("kills an unresponsive worker so it can restart", () => {
    const child = worker();
    mocks.spawn.mockReturnValue(child);
    const unavailable = vi.fn();
    watcher = new JwMediaWatcher({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }, vi.fn(), unavailable);
    watcher.start();
    vi.advanceTimersByTime(20_000);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(unavailable).toHaveBeenCalledOnce();
  });
});
