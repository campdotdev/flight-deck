// `readRecordPart` checks one part of a record against the schema's own rules for it, so `flight-deck register`
// can read `[tracker]` and `copy_files` from a record still being written (spec 1, "Install").
import { describe, expect, test } from "bun:test";
import { readRecordPart } from "../../src/record/index.ts";

const SHADERS = await Bun.file(new URL("./fixtures/shaders.toml", import.meta.url)).text();

/** A record that holds only the schema line and its `[tracker]` tables. */
const TRACKER_ONLY = `schema = 1\n\n${SHADERS.slice(SHADERS.indexOf("[tracker]"), SHADERS.indexOf("[dependencies]"))}`;

describe("readRecordPart", () => {
  test("reads [tracker] and [tracker.statuses] from a record that holds nothing else", () => {
    const read = readRecordPart(TRACKER_ONLY, "tracker");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.workspace).toBe("campdotdev");
    expect(read.value.team).toBe("SHA");
    expect(read.value.statuses.ready_to_plan).toBe("Ready to plan");
  });

  test("ignores every other part, even an invalid one", () => {
    expect(readRecordPart(TRACKER_ONLY.replace("schema = 1\n", 'schema = 1\ntime_limits = "soon"\nmystery = 1\n'), "tracker").ok).toBe(true);
  });

  test("reports the schema's errors for the part, with the record's own paths", () => {
    const read = readRecordPart(TRACKER_ONLY.replace('kind = "linear"', 'kind = "jira"').replace('canceled = "Canceled"\n', ""), "tracker");
    expect(read).toEqual({ ok: false, errors: ['tracker.kind: must be "linear"', "tracker.statuses.canceled: is missing"] });
  });

  test("keeps the rule that only intake and backlog may share a status", () => {
    const read = readRecordPart(TRACKER_ONLY.replace('planning = "Planning"', 'planning = "Ready to plan"'), "tracker");
    expect(read).toEqual({ ok: false, errors: ['tracker.statuses.planning: "Ready to plan" is also ready_to_plan\'s status, and only intake and backlog may share one'] });
  });

  test("a missing part is an error", () => {
    expect(readRecordPart("schema = 1\n", "tracker")).toEqual({ ok: false, errors: ["tracker: is missing"] });
  });

  test("a record that isn't TOML reports the line", () => {
    const read = readRecordPart(`${TRACKER_ONLY}\n[tracker\n`, "tracker");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.errors[0]).toMatch(/^line \d+: /);
  });

  test("reads copy_files, and refuses a path that leaves the checkout", () => {
    expect(readRecordPart(`schema = 1\ncopy_files = [".env", "apps/docs/.env.local"]\n`, "copy_files")).toEqual({ ok: true, value: [".env", "apps/docs/.env.local"] });
    expect(readRecordPart(`schema = 1\ncopy_files = ["../secrets"]\n`, "copy_files")).toEqual({
      ok: false,
      errors: ['copy_files[1]: must be a path relative to the checkout, with no leading "/" and no ".." part'],
    });
  });
});
