import type { Duration } from "./types.ts";

const UNIT_MS = { h: 3_600_000, m: 60_000, s: 1_000 } as const;

/** A record duration, such as `"1h30m"`, in milliseconds. `readRecord` has already checked its form. */
export function durationMs(duration: Duration): number {
  let total = 0;
  for (const [, n, unit] of duration.matchAll(/(\d+)([hms])/g)) total += Number(n) * UNIT_MS[unit as keyof typeof UNIT_MS];
  return total;
}
