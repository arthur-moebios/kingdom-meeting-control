import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import type { Display, PresentationStatus } from "@kmc/shared-types";

const execFileAsync = promisify(execFile);

export interface PresentationLogger {
  warn: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
}

/**
 * Windows-only. Enumerates monitors and detects whether JW Library is actively
 * presenting. It NEVER controls JW Library — read-only observation.
 *
 * VERIFIED signal (2026-10-26): JW Library is a UWP app that renders media onto
 * the projector monitor WITHOUT creating a new detectable top-level window, so
 * window enumeration is useless for "is presenting". However the projector is
 * PURE BLACK when idle (avg brightness ~3) and jumps to real content (~49) when
 * JW presents an image/video. So we sample the projector monitor's average
 * brightness: above a threshold (with hysteresis) + JW running == presenting.
 */
export class PresentationMonitorService {
  private displays: Display[] = [];
  private projectorBounds: { x: number; y: number; width: number; height: number } | null = null;
  // Regions to sample: the configured projector display if set, otherwise ALL
  // non-primary displays (the brightest wins), so JW on any secondary monitor is
  // detected even when the display layout changes.
  private sampleTargets: { id: string; bounds: { x: number; y: number; width: number; height: number } }[] = [];
  private status: PresentationStatus = {
    jwLibraryDetected: false,
    presentationActive: false,
    matchedWindowTitle: null,
    brightness: null,
    brightnessDisplayId: null,
    updatedAt: new Date().toISOString(),
  };
  private timer: NodeJS.Timeout | null = null;
  private readonly isWindows = os.platform() === "win32";

  // Full-projector average brightness (0-255). Calibrated live (2026-10-27):
  // JW idle = black screen + a small centre logo → whole-screen avg ~7; an image
  // fills the screen ~169; a video ~116. So the WHOLE screen average (not the
  // centre, which always has the logo) cleanly separates media from idle.
  // Hysteresis + the auto-stop debounce handle brief dark video frames.
  private static readonly ON_THRESHOLD = 25;
  private static readonly OFF_THRESHOLD = 12;

  constructor(
    private readonly log: PresentationLogger,
    private readonly onChange?: (status: PresentationStatus) => void,
  ) {}

  private async runPowerShell(script: string): Promise<string> {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 8000 },
    );
    return stdout;
  }

  /** Enumerate monitors via .NET Screen.AllScreens and remember the projector. */
  async enumerateDisplays(projectorDisplayId: string | null = null): Promise<Display[]> {
    if (!this.isWindows) {
      this.displays = [];
      return this.displays;
    }
    const script = `
Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
$out = foreach ($s in $screens) {
  [PSCustomObject]@{
    id = $s.DeviceName
    primary = $s.Primary
    x = $s.Bounds.X
    y = $s.Bounds.Y
    width = $s.Bounds.Width
    height = $s.Bounds.Height
  }
}
$out | ConvertTo-Json -Compress`;
    try {
      const raw = (await this.runPowerShell(script)).trim();
      if (!raw) return this.displays;
      const parsed = JSON.parse(raw) as unknown;
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      this.displays = arr.map((d, i) => {
        const o = d as Record<string, unknown>;
        const id = String(o.id ?? `display-${i}`);
        return {
          id,
          label: String(o.id ?? `Display ${i + 1}`).replace(/\\\\\.\\/, ""),
          primary: Boolean(o.primary),
          bounds: {
            x: Number(o.x ?? 0),
            y: Number(o.y ?? 0),
            width: Number(o.width ?? 0),
            height: Number(o.height ?? 0),
          },
          isProjector: projectorDisplayId != null && id === projectorDisplayId,
        } satisfies Display;
      });
    } catch (err) {
      this.log.warn({ err: String(err) }, "Display enumeration failed");
    }

    // Sample targets: the configured display if set, else ALL non-primary
    // displays (brightest wins at probe time). Robust to display-layout changes.
    const configured =
      projectorDisplayId != null ? this.displays.find((d) => d.id === projectorDisplayId) : undefined;
    this.sampleTargets = (configured ? [configured] : this.displays.filter((d) => !d.primary))
      .filter((d) => d.bounds.width >= 2 && d.bounds.height >= 2)
      .map((d) => ({ id: d.id, bounds: d.bounds }));
    this.projectorBounds = this.sampleTargets[0]?.bounds ?? null;
    return this.displays;
  }

  /** Whether JW Library is running (window present). */
  private async detectJwRunning(): Promise<{ detected: boolean; title: string | null }> {
    if (!this.isWindows) return { detected: false, title: null };
    const script = `
Get-Process |
  Where-Object { $_.MainWindowTitle -and ($_.ProcessName -match 'JWLibrary|JW.?Library' -or $_.MainWindowTitle -match 'JW Library') } |
  Select-Object -First 1 MainWindowTitle |
  ConvertTo-Json -Compress`;
    try {
      const raw = (await this.runPowerShell(script)).trim();
      if (!raw) return { detected: false, title: null };
      const o = JSON.parse(raw) as { MainWindowTitle?: string };
      return { detected: true, title: o.MainWindowTitle ?? "JW Library" };
    } catch {
      return { detected: false, title: null };
    }
  }

  /** Average brightness (0-255) of the projector monitor, or null if unavailable. */
  async sampleProjectorBrightness(): Promise<number | null> {
    if (!this.isWindows || !this.projectorBounds) return null;
    const { x, y, width, height } = this.projectorBounds;
    if (width < 2 || height < 2) return null;
    const script = `
Add-Type -AssemblyName System.Drawing
$w=${width};$h=${height}
$bmp=New-Object System.Drawing.Bitmap $w,$h
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${x},${y},0,0,(New-Object System.Drawing.Size($w,$h)))
$tw=48;$th=30
$t=New-Object System.Drawing.Bitmap $tw,$th
$tg=[System.Drawing.Graphics]::FromImage($t)
$tg.DrawImage($bmp,0,0,$tw,$th)
$s=0;$n=0
for($i=0;$i -lt $tw;$i++){for($j=0;$j -lt $th;$j++){$p=$t.GetPixel($i,$j);$s+=($p.R+$p.G+$p.B);$n++}}
$g.Dispose();$tg.Dispose();$bmp.Dispose();$t.Dispose()
[int]($s/(3*$n))`;
    try {
      const raw = (await this.runPowerShell(script)).trim();
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    } catch (err) {
      this.log.debug({ err: String(err) }, "Projector brightness sample failed");
      return null;
    }
  }

  /**
   * Single fast probe: detect JW + sample a SMALL center region of the projector
   * in ONE PowerShell call (one spawn, small bitmap), so the poll can run often
   * with low overhead and low latency.
   */
  private async probe(): Promise<{ jw: boolean; brightness: number | null; displayId: string | null }> {
    if (!this.isWindows) return { jw: false, brightness: null, displayId: null };
    const targets = this.sampleTargets;
    // For each target: capture the WHOLE display, downscale to 64x40, average —
    // so the idle centre logo doesn't keep it "active". Output the MAX across
    // targets plus which one, so JW on any secondary monitor is detected.
    const avgLines = targets
      .map(
        (t, k) =>
          `$v=Avg ${t.bounds.x} ${t.bounds.y} ${t.bounds.width} ${t.bounds.height};if($v -gt $best){$best=$v;$bi=${k}}`,
      )
      .join("\n");
    const script = `Add-Type -AssemblyName System.Drawing
$jw=0
if(Get-Process|Where-Object{ $_.MainWindowTitle -match 'JW Library' -or $_.ProcessName -match 'JWLibrary' }){$jw=1}
function Avg($x,$y,$w,$h){$bmp=New-Object System.Drawing.Bitmap $w,$h;$g=[System.Drawing.Graphics]::FromImage($bmp);$g.CopyFromScreen($x,$y,0,0,(New-Object System.Drawing.Size($w,$h)));$t=New-Object System.Drawing.Bitmap 64,40;$tg=[System.Drawing.Graphics]::FromImage($t);$tg.DrawImage($bmp,0,0,64,40);$s=0;$n=0;for($i=0;$i -lt 64;$i++){for($j=0;$j -lt 40;$j++){$p=$t.GetPixel($i,$j);$s+=($p.R+$p.G+$p.B);$n++}};$g.Dispose();$tg.Dispose();$bmp.Dispose();$t.Dispose();return [int]($s/(3*$n))}
$best=-1;$bi=-1
${avgLines}
"$jw $best $bi"`;
    try {
      const raw = (await this.runPowerShell(script)).trim();
      const parts = raw.split(/\s+/);
      const jw = parts[0] === "1";
      const n = parts[1] != null ? parseInt(parts[1], 10) : NaN;
      const bi = parts[2] != null ? parseInt(parts[2], 10) : -1;
      const displayId = bi >= 0 && targets[bi] ? targets[bi]!.id : null;
      return { jw, brightness: Number.isFinite(n) && n >= 0 ? n : null, displayId };
    } catch (err) {
      this.log.debug({ err: String(err) }, "probe failed");
      return { jw: false, brightness: null, displayId: null };
    }
  }

  /** One observation cycle: JW running + projector brightness → presentationActive. */
  private async refresh(): Promise<void> {
    const { jw, brightness, displayId } = await this.probe();

    // Hysteresis: turn ON above ON_THRESHOLD, OFF below OFF_THRESHOLD, else hold.
    let active = this.status.presentationActive;
    if (brightness != null) {
      if (brightness >= PresentationMonitorService.ON_THRESHOLD) active = true;
      else if (brightness <= PresentationMonitorService.OFF_THRESHOLD) active = false;
    }
    // Only consider it a JW presentation if JW is actually running.
    const presentationActive = active && jw;

    const next: PresentationStatus = {
      jwLibraryDetected: jw,
      presentationActive,
      matchedWindowTitle: jw ? "JW Library" : null,
      brightness,
      brightnessDisplayId: displayId,
      updatedAt: new Date().toISOString(),
    };
    const changed =
      next.presentationActive !== this.status.presentationActive ||
      next.jwLibraryDetected !== this.status.jwLibraryDetected;
    this.status = next;
    // Only fire onChange (auto-share trigger + event) on a real state change;
    // the live brightness is read via getStatus()/the status endpoint.
    if (changed) {
      this.log.info({ presentationActive, brightness, displayId, jw }, "Presentation state changed");
      if (this.onChange) this.onChange(next);
    }
  }

  start(projectorDisplayId: string | null, intervalMs = 1200): void {
    if (!this.isWindows) return;
    this.stop();
    void this.enumerateDisplays(projectorDisplayId).then(() => void this.refresh());
    this.timer = setInterval(() => void this.refresh(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getDisplays(): Display[] {
    return this.displays;
  }

  getStatus(): PresentationStatus {
    return this.status;
  }
}
