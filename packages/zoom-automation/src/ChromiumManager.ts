import { chromium, type BrowserContext, type Page } from "playwright";
import fs from "node:fs";
import { captureControlScript } from "./captureControl.js";

export interface ChromiumLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface ChromiumOptions {
  profileDir: string;
  headless: boolean;
  startUrl: string;
  /** Auto-select a window by title without exposing the native picker.
   *  The capture guard verifies the returned HWND before Zoom gets the stream. */
  captureSourceTitle?: string;
}

/**
 * Owns the Chromium lifecycle using a PERSISTENT profile so that authentication
 * (cookies/localStorage/IndexedDB) survives restarts — the foundation for
 * "stay logged in across executions".
 *
 * This is the piece proven to work in Phase 1. It does NOT use insecure flags
 * or any automation-evasion tricks.
 */
export class ChromiumManager {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private onCloseListeners = new Set<() => void>();

  constructor(
    private readonly opts: ChromiumOptions,
    private readonly log: ChromiumLogger,
  ) {}

  get isRunning(): boolean {
    return this.context !== null;
  }

  get captureSourceTitle(): string | undefined {
    return this.opts.captureSourceTitle;
  }

  getPage(): Page | null {
    return this.page;
  }

  onClose(fn: () => void): () => void {
    this.onCloseListeners.add(fn);
    return () => this.onCloseListeners.delete(fn);
  }

  async start(): Promise<Page> {
    if (this.context && this.page) return this.page;

    fs.mkdirSync(this.opts.profileDir, { recursive: true });
    this.log.info({ profileDir: this.opts.profileDir, headless: this.opts.headless }, "Launching persistent Chromium");

    const args = [
      "--start-maximized",
      // Keep the renderer fully alive even when the window is moved off-screen
      // (our "hide"), so DOM scraping (participants/hands) keeps working.
      "--disable-features=CalculateNativeWinOcclusion",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
    ];
    // Optional CDP endpoint for live DOM inspection during development only
    // (set KMC_DEBUG_PORT). Never enabled in normal operation.
    if (process.env.KMC_DEBUG_PORT) {
      args.push(`--remote-debugging-port=${process.env.KMC_DEBUG_PORT}`);
    }
    if (this.opts.captureSourceTitle) {
      // Experimental auto-share: pick the matching screen without the OS picker.
      args.push(
        `--auto-select-window-capture-source-by-title=${this.opts.captureSourceTitle}`,
      );
    }

    this.context = await chromium.launchPersistentContext(this.opts.profileDir, {
      headless: this.opts.headless,
      viewport: null,
      // Pre-grant camera/mic so Zoom's in-meeting prompts don't block us.
      permissions: ["camera", "microphone"],
      args,
    });
    await this.context.addInitScript(captureControlScript);

    // Detect the browser being closed (by crash or by a human) so the
    // orchestrator can react / restart.
    this.context.on("close", () => {
      this.log.warn({}, "Chromium context closed");
      this.context = null;
      this.page = null;
      for (const fn of this.onCloseListeners) fn();
    });

    const pages = this.context.pages();
    this.page = pages[0] ?? (await this.context.newPage());
    await this.page.goto(this.opts.startUrl, { waitUntil: "domcontentloaded" }).catch((err) => {
      this.log.warn({ err: String(err) }, "Initial navigation failed (will retry via orchestrator)");
    });

    return this.page;
  }

  async navigate(url: string): Promise<void> {
    if (!this.page) throw new Error("Chromium not started");
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  /**
   * Show/hide the window at runtime via CDP by moving it OFF-SCREEN (not
   * minimized, not headless) so the page keeps rendering and DOM scraping +
   * screen capture keep working, while the operator does not see it.
   *
   * CRUCIAL: you cannot change a window's position while it is maximized —
   * Chrome ignores the new bounds and just refocuses the window (which looked
   * like "hide brings it to the foreground"). So we ALWAYS restore it to the
   * "normal" state in its own call first, then move it.
   */
  async setHidden(hidden: boolean): Promise<void> {
    if (!this.context || !this.page) return;
    try {
      const cdp = await this.context.newCDPSession(this.page);
      const info = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
      // 1) Un-maximize / un-minimize FIRST (separate call), or the move is ignored.
      await cdp.send("Browser.setWindowBounds", {
        windowId: info.windowId,
        bounds: { windowState: "normal" },
      });
      // 2) Move far off every monitor to hide, or back on-screen to show.
      const bounds = hidden
        ? { left: -32000, top: -32000, width: 1280, height: 800 }
        : { left: 60, top: 60, width: 1280, height: 800 };
      await cdp.send("Browser.setWindowBounds", { windowId: info.windowId, bounds });
      if (!hidden) await this.page.bringToFront().catch(() => void 0);
      await cdp.detach().catch(() => void 0);
      this.log.info({ hidden }, "Chromium window visibility set");
    } catch (err) {
      this.log.warn({ err: String(err) }, "setHidden failed (window stays as-is)");
    }
  }

  async stop(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => void 0);
    }
    this.context = null;
    this.page = null;
  }
}
