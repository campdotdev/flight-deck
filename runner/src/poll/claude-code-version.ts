// The Claude Code version check before each start (spec 1's "Starts", ADR 0015). Below `data/claude-code.toml`'s
// `min_version`, the runner starts nothing. FLD-106 opens the trouble cause `claude_code_version` for it.
import claudeCode from "../../../data/claude-code.toml";

/** The oldest Claude Code this version runs. */
export const MIN_VERSION: string = (claudeCode as { min_version: string }).min_version;

/** Whether `version` is at least `MIN_VERSION`, comparing each dotted part as a number. An unreadable version isn't. */
export function supported(version: string, min: string = MIN_VERSION): boolean {
  const have = parts(version);
  const need = parts(min);
  if (have === null || need === null) return false;
  for (let i = 0; i < need.length; i++) {
    if (have[i]! !== need[i]!) return have[i]! > need[i]!;
  }
  return true;
}

function parts(version: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}
