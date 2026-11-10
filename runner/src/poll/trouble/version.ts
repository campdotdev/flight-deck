// The Claude Code version check before each start (spec 1, "Starts", ADR 0015).
import { CLAUDE_CODE } from "../../harness/index.ts";

/** The oldest Claude Code this version runs, from `data/claude-code.toml`. */
export const MIN_VERSION: string = CLAUDE_CODE.minVersion;

/** Whether `version` is older than `MIN_VERSION`. A version with no `x.y.z` in it counts as too old. */
export function tooOld(version: string, min = MIN_VERSION): boolean {
  const have = parts(version);
  const need = parts(min);
  if (have === null || need === null) return true;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i]! < need[i]!;
  return false;
}

function parts(version: string): number[] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match === null ? null : match.slice(1, 4).map(Number);
}
