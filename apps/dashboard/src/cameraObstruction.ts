/**
 * Geometry for the native camera preview. The Windows host paints the video in a
 * top-level window over the page, so HTML can never draw above it. The page must
 * therefore tell the host to hide it whenever ANYTHING is painted over the camera
 * slot. This is decided by hit-testing the slot (what is really on top at each
 * sampled point), not by a list of class names. DOM-free so it can run under Node.
 */

export interface Box { left: number; top: number; right: number; bottom: number }

/** True when the box has area and lies entirely inside the viewport (1px tolerance). */
export function insideViewport(r: Box, width: number, height: number): boolean {
  return r.right - r.left > 0 && r.bottom - r.top > 0 && r.left >= 0 && r.top >= 0 && r.right <= width + 1 && r.bottom <= height + 1;
}

export interface SampleOptions { step?: number; maxPerAxis?: number; inset?: number }

function axis(from: number, to: number, step: number, max: number): number[] {
  const span = to - from;
  if (span <= 0) return [(from + to) / 2];
  const n = Math.min(max, Math.max(2, Math.ceil(span / step) + 1));
  return Array.from({ length: n }, (_, i) => from + (span * i) / (n - 1));
}

/** Grid of points inside the box (inset from the edges), denser than any normal menu is narrow. */
export function samplePoints(r: Box, o: SampleOptions = {}): Array<[number, number]> {
  const step = o.step ?? 16, max = o.maxPerAxis ?? 10, inset = o.inset ?? 2;
  const xs = axis(r.left + inset, r.right - inset, step, max), ys = axis(r.top + inset, r.bottom - inset, step, max);
  const points: Array<[number, number]> = [];
  for (const y of ys) for (const x of xs) points.push([x, y]);
  return points;
}

/** Answers: is the topmost thing at (x, y) the camera slot itself (or one of its children)? */
export type OwnsPoint = (x: number, y: number) => boolean;

/** True when something other than the slot is painted over at least one sampled point. */
export function isObstructed(r: Box, ownsPoint: OwnsPoint, o?: SampleOptions): boolean {
  for (const [x, y] of samplePoints(r, o)) if (!ownsPoint(x, y)) return true;
  return false;
}

interface SlotLike { contains(other: unknown): boolean }

/**
 * Builds the hit-test probe. `elementFromPoint` returns null outside the viewport,
 * which counts as "not the slot": a point we cannot see is a point we cannot vouch for.
 */
export function slotProbe(slot: SlotLike, elementFromPoint: (x: number, y: number) => unknown): OwnsPoint {
  return (x, y) => {
    const hit = elementFromPoint(x, y);
    return hit !== null && hit !== undefined && slot.contains(hit);
  };
}

/** Minimum gap between two evaluations, in ms (leading edge runs at once, the rest is coalesced). */
export const EVALUATE_MIN_INTERVAL_MS = 60;

/** Delay before the next evaluation given when the last one ran; 0 means "now". Clock is injected. */
export function nextEvaluationDelay(lastRunAt: number | null, now: number, minInterval = EVALUATE_MIN_INTERVAL_MS): number {
  if (lastRunAt === null) return 0;
  return Math.max(0, minInterval - (now - lastRunAt));
}
