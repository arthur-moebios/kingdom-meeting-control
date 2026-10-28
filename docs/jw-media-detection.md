# JW Library media detection (Windows)

The presentation monitor uses a persistent Windows PowerShell 5.1/.NET UI
Automation observer. It only reads JW Library. It does not click, change
playback, or capture the projector screen.

Selectors and the structure-event approach come from
[JarbasJWL/frmPrincipal.cs](https://github.com/arthur-moebios/JarbasJWL/blob/c2dfa260a1cbb80b7095bc215675ee274db7fbb1/frmPrincipal.cs):

- Video context: `AutomationId = VolumeButton`, independent of the button name,
  UI language, or mute state.
- Image context: `FlipViewItem` / `ListItem` named
  `Watchtower.Apps.JWLibrary.Common.ViewModels.PlayMedia.ImageViewModel`.

The observer attaches to every JW Library root, including UWP windows exposed
under ApplicationFrameHost. Structure and relevant property events wake the
worker immediately. It queries the complete roots, rather than the event's
subtree, and sends JSON lines to Node. A scan every second covers missing
events and discovers new/reopened windows. This interval does not gate events.
The first subscription requires PowerShell startup and .NET compilation.

Each real activity transition invokes automatic sharing when
`share.mode = automatic` and Zoom is ready. Chromium uses
`--auto-select-window-capture-source-by-title=JW Library`, including when
`autoSourceTitle` is empty. It stays off-screen; no native picker is driven.
Changing this title or entering automatic mode requires a browser restart.
The window-only switch is documented in
[Chromium's switches](https://chromium.googlesource.com/chromium/src/+/refs/tags/147.0.7727.118/chrome/common/chrome_switches.cc).

`JwMediaWindows.cs` identifies the separate media window using the core-window
children from [JwlMediaWin's Fixer](https://github.com/AntonyCorbett/JwlMediaWin/blob/b0bb10ac9f2dd1bb8b2452dd0ce3abf427bab29b/JwlMediaWin.Core/Fixer.cs):
WebView2, ProgressRing, ImageViewer, or an empty core. Unlike the fixer's initial
search, it allows a disabled window: the fixer disables it after adjustment.
For duplicate JW titles, automatic selection requires the media HWND to be
the first capturable JW window and topmost. This matches the current
[WebRTC enumeration order](https://chromium.googlesource.com/external/webrtc/+/HEAD/modules/desktop_capture/win/window_capture_utils.cc).
A Zoom-only getDisplayMedia wrapper checks the returned native device ID against
the expected HWND and stops/rejects the stream if Chromium picked another window.
This check was validated against the installed Chromium; other versions may
expose a different device-ID format and need adjustment.

At media end, a 100ms coalescing delay replaces the former four-second debounce.
The retained capture tracks are stopped directly and their ended listeners are
notified, without waiting for Zoom's hidden toolbar. A DOM/toolbar stop remains
as fallback for captures made outside this wrapper. Participant polling yields
while share start/stop is pending, and startup automations finish before capture.
A medium arriving during stop is retriggered immediately after stop completes.

The status endpoint exposes `detectionSource` (`uia` or `unavailable`),
`mediaKind` (`video`, `image`, or null), `mediaWindowHandle`,
`mediaWindowCaptureReady`, and the last successful `updatedAt`.
The legacy brightness fields remain null for API compatibility. Observation
failures preserve the last activity state so a UIA failure does not stop an
ongoing transmission. A dead worker restarts after two seconds; a worker with
no valid readings for fifteen seconds is terminated and restarted. Shutdown
kills the worker, which also checks whether its parent still exists.

## Validation on 2026-10-28

Type checks and automated tests pass. Live UIA observations detected the image,
video, and no-media transitions. The first integration still used a native
picker: it failed while Chromium was off-screen and later shared after showing
Chromium. That path also retained the four-second stop delay.

The replacement was tested in an isolated, off-screen Chromium with Zoom's
origin intercepted locally (no real Zoom call): the selected source was exactly
`window:2231368:0`, the identified media HWND. Stream selection took 417ms,
the first rendered frame 491ms, and the production adapter's direct stop took
11ms with the real track reaching `ended`. These are local capture timings,
not remote Zoom latency. The new flow still needs a live Zoom restart/test;
remote reception, audio, and Zoom's response to direct track termination remain
to be checked. Zero lost opening frames cannot be guaranteed when capture only
starts after media is detected. The user requires sharing to end for each medium.

Before relying on it during a meeting, check images, videos with and without
audio, dark scenes, hidden playback controls, stop, and closing/reopening JW
Library. Verify the remote participant receives the intended projector content
and audio. These selectors identify JW's media UI context; they do not prove
that the content is projected, playing, or being received by Zoom. A JW update
or controls disappearing from the UIA tree may require selector adjustments.

The Windows package must include `watch-jw-media.ps1`, `JwMediaObserver.cs`, and `JwMediaWindows.cs`
alongside the server. The Windows workflow copies both files.

## Live Zoom follow-up

The first hidden integration attempt was blocked by the adapter rechecking
visible in-meeting controls and using coordinate clicks. Removing that gate
and activating Share through Playwright Chromium evaluation (which supplies
transient user activation) also passed an isolated test with the button below
the viewport: first frame 499ms, stop 11ms.

After restart, the real Zoom page exposed a live capture track with device
ID window:2231368:0 and a Stop Share control, and the backend entered SHARING.
The initial already-open image was confirmed locally 61ms after the share
request; this is a local control confirmation, not remote first-frame timing.
Starting capture restored Chromium to on-screen bounds. Hiding it again was
verified to preserve the live stream; the source now reapplies the configured
visibility after each successful share. Its next deployment restart is still
needed for that last visibility adjustment. Video start/end timing and remote
reception remain to be measured on this revised path.

The operator subsequently tested the revised flow and reported the behavior
acceptable, requesting a commit/push checkpoint. No independently measured
remote first-frame or remote stop latency was recorded.
