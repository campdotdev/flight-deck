// Scenarios assert only on the in-memory Tracker, the scripted Harness, and status.json (spec 1, "The seam").
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** What a scenario would name to reach the session list or issue memory. */
const REACHES = ["sessions.json", "/issues/", "sessionList", "issueMemory", "writeSessions", "new State", "readJson", "writeJson"];

test("no scenario reads or writes the session list or issue memory", async () => {
  const found: string[] = [];
  for await (const file of new Glob("*.ts").scan(import.meta.dir)) {
    if (file === "seam.test.ts") continue;
    const text = await readFile(join(import.meta.dir, file), "utf8");
    for (const reach of REACHES) if (text.includes(reach)) found.push(`${file}: ${reach}`);
  }
  expect(found).toEqual([]);
});
