import { useEffect, useRef, useState } from "react";
import type { ServerFrame, Snapshot } from "@kmc/shared-types";
import { getToken } from "./api.js";

export interface LiveState {
  connected: boolean;
  snapshot: Snapshot | null;
  lastEvent: string | null;
}

/**
 * Subscribes to /ws, applies the initial snapshot, then refreshes the snapshot
 * on every event (simple + robust for a low-traffic operator panel). Auto-
 * reconnects with a short delay.
 */
export function useLiveState(): LiveState & { reconnect: () => void } {
  const [connected, setConnected] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [lastEvent, setLastEvent] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let closed = false;
    const token = getToken();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const qs = token ? `?token=${encodeURIComponent(token)}` : "";
    const ws = new WebSocket(`${proto}://${location.host}/ws${qs}`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      if (!closed) setTimeout(() => setNonce((n) => n + 1), 2000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (msg) => {
      try {
        const frame = JSON.parse(msg.data as string) as ServerFrame;
        if (frame.kind === "snapshot") {
          setSnapshot(frame.snapshot);
        } else if (frame.kind === "event") {
          setLastEvent(`${frame.event.type} @ ${new Date(frame.event.ts).toLocaleTimeString()}`);
          // Pull a fresh snapshot lazily by bumping nonce is overkill; instead we
          // keep server as source of truth: request nothing, the next snapshot
          // comes on reconnect. For live counts we patch status via REST below.
        }
      } catch {
        /* ignore malformed frame */
      }
    };

    return () => {
      closed = true;
      ws.close();
    };
  }, [nonce]);

  // Light polling of the snapshot via REST to keep counts fresh between events.
  useEffect(() => {
    const token = getToken();
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch("/api/v1/zoom/status", {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) return;
        const status = await res.json();
        setSnapshot((prev) => (prev ? { ...prev, status } : prev));
      } catch {
        /* ignore */
      }
    };
    const id = setInterval(() => void tick(), 3000);
    return () => clearInterval(id);
  }, [nonce]);

  return { connected, snapshot, lastEvent, reconnect: () => setNonce((n) => n + 1) };
}
