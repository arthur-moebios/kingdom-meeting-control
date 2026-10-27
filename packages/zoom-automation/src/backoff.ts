/** Exponential backoff with full jitter, capped. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  // full jitter in [0, exp]
  return Math.floor(Math.random() * exp);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
