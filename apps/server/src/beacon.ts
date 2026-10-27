import dgram from "node:dgram";
import os from "node:os";

export interface BeaconLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

/** UDP port the beacon broadcasts/listens on (distinct from the HTTP API port). */
export const BEACON_PORT = 41317;

/** IPv4 subnet broadcast address for an address+netmask (e.g. 192.168.0.255). */
function subnetBroadcast(ip: string, mask: string): string {
  const i = ip.split(".").map(Number);
  const m = mask.split(".").map(Number);
  if (i.length !== 4 || m.length !== 4) return "255.255.255.255";
  return i.map((o, k) => (o & (m[k] ?? 0)) | (~(m[k] ?? 0) & 0xff)).join(".");
}

/**
 * Zero-config LAN discovery that survives DHCP IP changes. The PC broadcasts a
 * small JSON beacon every 2s to the subnet broadcast address(es); the tablet
 * listens and reads the PC's CURRENT address from the packet source, so it
 * always reconnects to the right IP. UDP broadcast works on many Wi-Fi routers
 * where mDNS multicast is filtered, and the periodic beacon is outbound from the
 * PC, so it arrives even if the PC's inbound firewall is strict.
 *
 * It also answers an active "KMC?" query packet immediately, so a tablet that
 * just launched doesn't have to wait for the next beacon tick.
 */
export class BeaconService {
  private sock: dgram.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly log: BeaconLogger,
    private readonly opts: { apiPort: number; name: string; version: string },
  ) {}

  private payload(): Buffer {
    return Buffer.from(
      JSON.stringify({ kmc: 1, api: this.opts.apiPort, name: this.opts.name, version: this.opts.version }),
    );
  }

  private targets(): string[] {
    const set = new Set<string>(["255.255.255.255"]);
    for (const iface of Object.values(os.networkInterfaces())) {
      for (const a of iface ?? []) {
        if (a.family === "IPv4" && !a.internal && a.address && a.netmask) {
          set.add(subnetBroadcast(a.address, a.netmask));
        }
      }
    }
    return [...set];
  }

  private broadcast(): void {
    if (!this.sock) return;
    const data = this.payload();
    for (const t of this.targets()) {
      this.sock.send(data, BEACON_PORT, t, () => void 0);
    }
  }

  start(): void {
    try {
      const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      this.sock = sock;
      sock.on("error", (err) => this.log.warn({ err: String(err) }, "beacon socket error (ignored)"));
      sock.on("message", (msg, rinfo) => {
        // Answer an active query directly to the asker for instant discovery.
        if (msg.toString("utf8").startsWith("KMC?")) {
          sock.send(this.payload(), rinfo.port, rinfo.address, () => void 0);
        }
      });
      sock.bind(BEACON_PORT, () => {
        try {
          sock.setBroadcast(true);
        } catch {
          /* ignore */
        }
        this.broadcast();
        this.timer = setInterval(() => this.broadcast(), 2000);
        this.timer.unref();
        this.log.info({ port: BEACON_PORT, api: this.opts.apiPort }, "UDP beacon broadcasting (tablet auto-discovery)");
      });
    } catch (err) {
      this.log.warn({ err: String(err) }, "beacon start failed (auto-discovery via mDNS only)");
    }
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      if (!this.sock) return resolve();
      try {
        this.sock.close(() => resolve());
      } catch {
        resolve();
      }
      this.sock = null;
    });
  }
}
