import os from "node:os";
import { Bonjour, type Service } from "bonjour-service";

export interface DiscoveryLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * Advertises the backend on the LAN via mDNS / DNS-SD (Zeroconf/Bonjour) so the
 * tablet finds it WITHOUT any hardcoded IP. The Android app discovers the same
 * service type with NsdManager (`_kmc._tcp`), reads the TXT records, and
 * connects to the resolved host:port.
 *
 * Service type: `_kmc._tcp.local.`
 * TXT: v (protocol), api (REST base), ws (WS path), name (friendly), host.
 */
export class DiscoveryService {
  private bonjour: Bonjour | null = null;
  private service: Service | null = null;

  constructor(
    private readonly log: DiscoveryLogger,
    private readonly opts: { port: number; version: string },
  ) {}

  /** Stable-ish identity for this Salão PC (the machine hostname). */
  get instanceName(): string {
    return `Kingdom Meeting Control @ ${os.hostname()}`;
  }

  start(): void {
    try {
      this.bonjour = new Bonjour();
      this.service = this.bonjour.publish({
        name: this.instanceName,
        type: "kmc",
        protocol: "tcp",
        port: this.opts.port,
        txt: {
          v: "1",
          api: "/api/v1",
          ws: "/ws",
          name: this.instanceName,
          host: os.hostname(),
          version: this.opts.version,
        },
      });
      this.log.info(
        { type: "_kmc._tcp", port: this.opts.port, name: this.instanceName },
        "mDNS service published — tablet can discover this PC without an IP",
      );
    } catch (err) {
      this.log.warn({ err: String(err) }, "mDNS publish failed (LAN discovery unavailable)");
    }
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.bonjour) return resolve();
      this.bonjour.unpublishAll(() => {
        this.bonjour?.destroy();
        this.bonjour = null;
        this.service = null;
        resolve();
      });
    });
  }
}
