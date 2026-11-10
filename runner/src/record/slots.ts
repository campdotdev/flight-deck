// Slot resolution (spec 1, "The repo record, schema 1", ADR 0014). `readRecord` checks only each entry's form.
// Before a session starts, the runner resolves every entry: a name against the skills the running version
// ships, and a `.claude/skills/<name>` path against the commit the session starts from. An entry that
// resolves to neither makes the record invalid.
import type { RecordResult } from "./record.ts";
import type { RepoRecord } from "./types.ts";

export interface SlotLookup {
  /** Whether the running version ships `skills/<name>/SKILL.md`. */
  shipped(name: string): boolean | Promise<boolean>;
  /** Whether the commit holds `<path>/SKILL.md`, for a path such as `.claude/skills/triage`. */
  inRepo(path: string): boolean | Promise<boolean>;
  /** The commit, for the error. */
  commit: string;
}

/**
 * Resolves every slot entry in the record, in the record's order. Returns the record when each one resolves,
 * or else one error per entry that doesn't, such as `slots.plan.reproduce[2]: ...`, where `[2]` counts from 1.
 */
export async function resolveSlots(record: RepoRecord, lookup: SlotLookup): Promise<RecordResult> {
  const errors: string[] = [];
  for (const [stage, slots] of Object.entries(record.slots)) {
    for (const [slot, entries] of Object.entries(slots as Record<string, string[]>)) {
      for (const [index, entry] of entries.entries()) {
        const where = `slots.${stage}.${slot}[${index + 1}]`;
        if (entry.includes("/")) {
          if (!(await lookup.inRepo(entry))) errors.push(`${where}: ${entry}/SKILL.md isn't in the repo at commit ${lookup.commit.slice(0, 7)}`);
        } else if (!(await lookup.shipped(entry))) {
          errors.push(`${where}: Flight Deck ships no skill named "${entry}"`);
        }
      }
    }
  }
  return errors.length === 0 ? { ok: true, record } : { ok: false, reason: "invalid", errors };
}
