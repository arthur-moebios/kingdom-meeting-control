import { describe, expect, it, vi } from "vitest";
import type { JwMediaReading } from "./JwMediaWatcher.js";

const callbacks = vi.hoisted(() => ({
  reading: (_value: JwMediaReading) => {}, unavailable: () => {},
}));
vi.mock("./JwMediaWatcher.js", () => ({
  JwMediaWatcher: class {
    constructor(_log: unknown, reading: typeof callbacks.reading, unavailable: () => void) {
      callbacks.reading = reading;
      callbacks.unavailable = unavailable;
    }
    start() {}
    stop() {}
  },
}));
import { PresentationMonitorService } from "./PresentationMonitorService.js";

describe("presentation changes from UIA", () => {
  it("triggers immediately, deduplicates UI events, and holds activity on read failures", () => {
    const onChange = vi.fn();
    const service = new PresentationMonitorService({ info: vi.fn(), debug: vi.fn(), warn: vi.fn() }, onChange);
    callbacks.reading({ jw: true, active: true, kind: "video" });
    expect(onChange).toHaveBeenCalledOnce();
    expect(service.getStatus()).toMatchObject({ presentationActive: true, detectionSource: "uia", brightness: null });
    callbacks.reading({ jw: true, active: true, kind: "image" });
    expect(onChange).toHaveBeenCalledOnce();
    expect(service.getStatus().mediaKind).toBe("image");
    callbacks.unavailable();
    expect(service.getStatus()).toMatchObject({ presentationActive: true, detectionSource: "unavailable" });
    expect(onChange).toHaveBeenCalledOnce();
    callbacks.reading({ jw: true, active: false, kind: "none" });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(service.getStatus()).toMatchObject({ presentationActive: false, detectionSource: "uia" });
    callbacks.reading({ jw: false, active: false, kind: "none" });
    expect(service.getStatus().jwLibraryDetected).toBe(false);
  });
});
