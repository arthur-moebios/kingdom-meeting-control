import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSchema } from "@kmc/shared-types";
import { ZoomStateMachine } from "./ZoomStateMachine.js";

const chrome = vi.hoisted(() => ({ setHidden: vi.fn() }));
vi.mock("./ChromiumManager.js", () => ({ ChromiumManager: class {
  captureSourceTitle: string | undefined;
  constructor(options: { captureSourceTitle?: string }) { this.captureSourceTitle = options.captureSourceTitle; }
  onClose() {}
  setHidden = chrome.setHidden;
} }));
import { ZoomAutomationService } from "./ZoomAutomationService.js";

function setup(ready = true) {
  const settings = SettingsSchema.parse({ share: { mode: "automatic" }, browser: { hidden: true } });
  let active = true;
  const picker = vi.fn();
  const emit = vi.fn();
  const service = new ZoomAutomationService({
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    profileDir: "unused", headless: false, zoomWebUrl: "https://app.zoom.us",
    getSettings: () => settings, isPresentationActive: () => active,
    isMediaCaptureReady: () => ready, getMediaWindowHandle: () => 1234,
    driveSharePicker: picker, emit,
  });
  const adapter = { setExpectedMediaWindow: vi.fn(), startMonitorShare: vi.fn(async () => true),
    waitForSharing: vi.fn(async () => true), stopScreenShareClick: vi.fn(async () => true) };
  const state = service as unknown as { sm: ZoomStateMachine; adapter: typeof adapter };
  state.sm.force("IN_MEETING");
  state.adapter = adapter;
  return { service, adapter, picker, emit, end: () => { active = false; } };
}

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("automatic capture latency path", () => {
  it("uses the JW default source and never exposes Chromium or drives the picker", async () => {
    const { service, adapter, picker, emit } = setup();
    expect(await service.startMonitorShare()).toBe(true);
    expect(adapter.setExpectedMediaWindow).toHaveBeenCalledWith(1234);
    expect(adapter.waitForSharing).toHaveBeenCalledWith(5000);
    expect(chrome.setHidden).not.toHaveBeenCalledWith(false);
    expect(chrome.setHidden).toHaveBeenCalledWith(true);
    expect(picker).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith("zoom.share.started", expect.objectContaining({ source: "JW Library" }));
  });
  it("refuses an ambiguous JW window before clicking Share", async () => {
    const { service, adapter } = setup(false);
    expect(await service.startMonitorShare()).toBe(false);
    expect(adapter.startMonitorShare).not.toHaveBeenCalled();
  });
  it("ends sharing after 100ms rather than the legacy four-second delay", async () => {
    vi.useFakeTimers();
    const { service, adapter, end } = setup();
    await service.startMonitorShare();
    end();
    await service.onPresentationChange(false);
    await vi.advanceTimersByTimeAsync(99);
    expect(adapter.stopScreenShareClick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.stopScreenShareClick).toHaveBeenCalledOnce();
  });
});
