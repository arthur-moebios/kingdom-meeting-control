/** Runs before Zoom loads. Validate Chromium's chosen native window before
 * handing the stream to Zoom, and retain it for immediate track termination. */
export const captureControlScript = `(() => {
  if (location.hostname !== "app.zoom.us") return;
  const devices = navigator.mediaDevices;
  if (!devices?.getDisplayMedia) return;
  const original = devices.getDisplayMedia.bind(devices);
  devices.getDisplayMedia = async (...args) => {
    const expected = globalThis.__kmcExpectedMediaWindow;
    let stream;
    try { stream = await original(...args); }
    catch (error) {
      globalThis.__kmcCaptureError = error.name + ": " + error.message;
      throw error;
    }
    const video = stream.getVideoTracks()[0];
    const deviceId = video?.getSettings().deviceId || video?.label || "";
    if (expected && !deviceId.startsWith("window:" + expected + ":")) {
      stream.getTracks().forEach(track => track.stop());
      globalThis.__kmcCaptureError = "Selected source " + deviceId + " differs from expected HWND " + expected;
      throw new Error("Selected capture source does not match the JW media window");
    }
    globalThis.__kmcCaptureStream = stream;
    return stream;
  };
})();`;
