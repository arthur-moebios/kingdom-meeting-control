import type { ZoomState } from "@kmc/shared-types";

/**
 * Explicit, guarded state machine. State only changes through `transition()`,
 * which rejects illegal transitions so we never, e.g., jump from STOPPED to
 * IN_MEETING without going through auth + join.
 */
const ALLOWED: Record<ZoomState, ZoomState[]> = {
  STOPPED: ["INITIALIZING"],
  INITIALIZING: ["AUTH_REQUIRED", "AUTHENTICATED", "ERROR", "STOPPED"],
  AUTH_REQUIRED: ["AUTHENTICATED", "JOINING", "ERROR", "STOPPED"],
  AUTHENTICATED: ["JOINING", "AUTH_REQUIRED", "ERROR", "STOPPED"],
  JOINING: ["IN_MEETING", "AUTHENTICATED", "RECONNECTING", "ERROR", "STOPPED"],
  IN_MEETING: ["SHARING", "RECONNECTING", "AUTHENTICATED", "ERROR", "STOPPED"],
  SHARING: ["IN_MEETING", "RECONNECTING", "ERROR", "STOPPED"],
  RECONNECTING: ["IN_MEETING", "AUTHENTICATED", "AUTH_REQUIRED", "ERROR", "STOPPED"],
  ERROR: ["INITIALIZING", "STOPPED", "RECONNECTING"],
};

export type TransitionListener = (from: ZoomState, to: ZoomState) => void;

export class ZoomStateMachine {
  private _state: ZoomState = "STOPPED";
  private listeners = new Set<TransitionListener>();

  get state(): ZoomState {
    return this._state;
  }

  onTransition(fn: TransitionListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  canTransition(to: ZoomState): boolean {
    return ALLOWED[this._state].includes(to);
  }

  /** Returns true if the transition happened. Illegal transitions are ignored (and reported false). */
  transition(to: ZoomState): boolean {
    if (to === this._state) return true;
    if (!this.canTransition(to)) return false;
    const from = this._state;
    this._state = to;
    for (const fn of this.listeners) fn(from, to);
    return true;
  }

  /** Force a state (used only for hard resets); still notifies listeners. */
  force(to: ZoomState): void {
    const from = this._state;
    this._state = to;
    for (const fn of this.listeners) fn(from, to);
  }
}
