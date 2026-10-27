import { describe, it, expect } from "vitest";
import { ZoomParticipantsService } from "./ZoomParticipantsService.js";

type Raw = Parameters<ZoomParticipantsService["reconcile"]>[0];

const p = (id: string, handRaised = false): Raw[number] => ({
  id,
  displayName: id,
  handRaised,
  isHost: false,
  isCoHost: false,
  isMuted: null,
});

describe("ZoomParticipantsService", () => {
  it("emits joined on first sight", () => {
    const s = new ZoomParticipantsService();
    const diffs = s.reconcile([p("a"), p("b")], false);
    expect(diffs.map((d) => d.type)).toEqual([
      "zoom.participant.joined",
      "zoom.participant.joined",
    ]);
    expect(s.count).toBe(2);
  });

  it("emits hand.raised then hand.lowered and preserves detection time", () => {
    const s = new ZoomParticipantsService();
    s.reconcile([p("a")], false, new Date("2026-01-01T00:00:00Z"));
    const up = s.reconcile([p("a", true)], false, new Date("2026-01-01T00:00:05Z"));
    expect(up.map((d) => d.type)).toEqual(["zoom.hand.raised"]);
    expect(s.getRaisedHands().order[0]?.handRaisedAt).toBe("2026-01-01T00:00:05.000Z");

    const down = s.reconcile([p("a", false)], false, new Date("2026-01-01T00:00:10Z"));
    expect(down.map((d) => d.type)).toEqual(["zoom.hand.lowered"]);
    expect(s.getRaisedHands().order).toHaveLength(0);
  });

  it("orders raised hands by detection time", () => {
    const s = new ZoomParticipantsService();
    s.reconcile([p("a"), p("b")], false, new Date("2026-01-01T00:00:00Z"));
    s.reconcile([p("a"), p("b", true)], false, new Date("2026-01-01T00:00:02Z"));
    s.reconcile([p("a", true), p("b", true)], false, new Date("2026-01-01T00:00:04Z"));
    const hands = s.getRaisedHands();
    expect(hands.order.map((x) => x.id)).toEqual(["b", "a"]);
    expect(hands.orderSource).toBe("detection-time");
  });

  it("does NOT emit left events when the list is partial (virtualized)", () => {
    const s = new ZoomParticipantsService();
    s.reconcile([p("a"), p("b")], false);
    const diffs = s.reconcile([p("a")], true); // b missing but list partial
    expect(diffs).toHaveLength(0);
    expect(s.count).toBe(2);
  });

  it("emits left when a full list drops someone", () => {
    const s = new ZoomParticipantsService();
    s.reconcile([p("a"), p("b")], false);
    const diffs = s.reconcile([p("a")], false);
    expect(diffs.map((d) => d.type)).toEqual(["zoom.participant.left"]);
    expect(s.count).toBe(1);
  });
});
