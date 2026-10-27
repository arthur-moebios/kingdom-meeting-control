import type { EventType, RaisedHands, ZoomParticipant } from "@kmc/shared-types";

export interface ParticipantDiff {
  type: Extract<
    EventType,
    "zoom.participant.joined" | "zoom.participant.left" | "zoom.hand.raised" | "zoom.hand.lowered"
  >;
  participant: ZoomParticipant;
}

type RawParticipant = Omit<ZoomParticipant, "handRaisedAt">;

/**
 * Holds the authoritative in-memory participant state and derives incremental
 * diffs from successive observations. Hand ordering is by OUR detection time
 * (see docs/zoom-research.md §5) — flagged honestly as such.
 */
export class ZoomParticipantsService {
  private byId = new Map<string, ZoomParticipant>();
  private _partial = false;

  /** Reconcile a fresh observation; returns the diffs to broadcast/persist. */
  reconcile(raw: RawParticipant[], partial: boolean, now: Date = new Date()): ParticipantDiff[] {
    this._partial = partial;
    const nowIso = now.toISOString();
    const diffs: ParticipantDiff[] = [];
    const seen = new Set<string>();

    for (const r of raw) {
      seen.add(r.id);
      const prev = this.byId.get(r.id);
      if (!prev) {
        const p: ZoomParticipant = {
          ...r,
          handRaisedAt: r.handRaised ? nowIso : null,
        };
        this.byId.set(r.id, p);
        diffs.push({ type: "zoom.participant.joined", participant: p });
        if (p.handRaised) diffs.push({ type: "zoom.hand.raised", participant: p });
        continue;
      }

      // Hand raised newly?
      if (r.handRaised && !prev.handRaised) {
        prev.handRaised = true;
        prev.handRaisedAt = nowIso; // preserve detection order
        diffs.push({ type: "zoom.hand.raised", participant: { ...prev } });
      } else if (!r.handRaised && prev.handRaised) {
        prev.handRaised = false;
        prev.handRaisedAt = null;
        diffs.push({ type: "zoom.hand.lowered", participant: { ...prev } });
      }

      // Update mutable best-effort fields without clobbering handRaisedAt.
      prev.displayName = r.displayName;
      prev.isHost = r.isHost;
      prev.isCoHost = r.isCoHost;
      prev.isMuted = r.isMuted;
    }

    // Anyone not seen left — BUT only trust this when the list is NOT partial,
    // otherwise virtualization would cause false "left" events.
    if (!partial) {
      for (const [id, p] of this.byId) {
        if (!seen.has(id)) {
          this.byId.delete(id);
          diffs.push({ type: "zoom.participant.left", participant: { ...p } });
        }
      }
    }

    return diffs;
  }

  list(): ZoomParticipant[] {
    return [...this.byId.values()];
  }

  getRaisedHands(): RaisedHands {
    const order = this.list()
      .filter((p) => p.handRaised && p.handRaisedAt)
      .sort((a, b) => (a.handRaisedAt! < b.handRaisedAt! ? -1 : 1));
    return {
      order,
      orderSource: "detection-time",
      partial: this._partial,
    };
  }

  get count(): number {
    return this.byId.size;
  }

  clear(): void {
    this.byId.clear();
    this._partial = false;
  }
}
