import { describe, it, expect } from "vitest";
import { ZoomStateMachine } from "./ZoomStateMachine.js";

describe("ZoomStateMachine", () => {
  it("starts STOPPED", () => {
    expect(new ZoomStateMachine().state).toBe("STOPPED");
  });

  it("allows a valid lifecycle path", () => {
    const sm = new ZoomStateMachine();
    expect(sm.transition("INITIALIZING")).toBe(true);
    expect(sm.transition("AUTHENTICATED")).toBe(true);
    expect(sm.transition("JOINING")).toBe(true);
    expect(sm.transition("IN_MEETING")).toBe(true);
    expect(sm.transition("SHARING")).toBe(true);
    expect(sm.state).toBe("SHARING");
  });

  it("rejects illegal jumps", () => {
    const sm = new ZoomStateMachine();
    expect(sm.transition("IN_MEETING")).toBe(false); // can't skip from STOPPED
    expect(sm.state).toBe("STOPPED");
  });

  it("notifies listeners with from/to", () => {
    const sm = new ZoomStateMachine();
    const seen: string[] = [];
    sm.onTransition((from, to) => seen.push(`${from}->${to}`));
    sm.transition("INITIALIZING");
    expect(seen).toEqual(["STOPPED->INITIALIZING"]);
  });

  it("can always force to ERROR and recover", () => {
    const sm = new ZoomStateMachine();
    sm.transition("INITIALIZING");
    sm.force("ERROR");
    expect(sm.state).toBe("ERROR");
    expect(sm.transition("INITIALIZING")).toBe(true);
  });
});
