import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { captureControlScript } from "./captureControl.js";

function environment(deviceId: string, expected: number) {
  const video = { getSettings: () => ({ deviceId }), stop: vi.fn() };
  const stream = { getVideoTracks: () => [video], getTracks: () => [video] };
  const getDisplayMedia = vi.fn(async () => stream);
  const context = {
    location: { hostname: "app.zoom.us" },
    navigator: { mediaDevices: { getDisplayMedia } },
    __kmcExpectedMediaWindow: expected,
    __kmcCaptureStream: undefined,
  };
  vm.runInNewContext(captureControlScript, context);
  return { context, stream, video, getDisplayMedia };
}

describe("native capture identity guard", () => {
  it("hands Zoom the stream only when Chromium selected the expected HWND", async () => {
    const { context, stream, video } = environment("window:1234:0", 1234);
    await expect(context.navigator.mediaDevices.getDisplayMedia()).resolves.toBe(stream);
    expect(context.__kmcCaptureStream).toBe(stream);
    expect(video.stop).not.toHaveBeenCalled();
  });
  it("stops and rejects a different window with the same title", async () => {
    const { context, video } = environment("window:5678:0", 1234);
    await expect(context.navigator.mediaDevices.getDisplayMedia()).rejects.toThrow("does not match");
    expect(video.stop).toHaveBeenCalledOnce();
    expect(context.__kmcCaptureStream).toBeUndefined();
  });
  it("does not replace capture APIs outside Zoom", () => {
    const getDisplayMedia = vi.fn();
    const context = { location: { hostname: "example.com" }, navigator: { mediaDevices: { getDisplayMedia } } };
    vm.runInNewContext(captureControlScript, context);
    expect(context.navigator.mediaDevices.getDisplayMedia).toBe(getDisplayMedia);
  });
});
