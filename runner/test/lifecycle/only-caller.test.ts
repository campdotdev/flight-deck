// Lifecycle is the only caller of Tracker.move and Tracker.markDuplicate (overview). The adapters define them.
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../../src");

test("no module but Lifecycle calls Tracker.move or Tracker.markDuplicate", async () => {
  const calls: string[] = [];
  for await (const file of new Glob("**/*.ts").scan(SRC)) {
    if (file.startsWith("lifecycle/") || file.startsWith("tracker/")) continue;
    const text = await readFile(join(SRC, file), "utf8");
    for (const match of text.matchAll(/(\w+)\s*\.\s*(move|markDuplicate)\s*\(/g)) {
      if (!/lifecycle/i.test(match[1] ?? "")) calls.push(`${file}: ${match[0]}`);
    }
  }
  expect(calls).toEqual([]);
});
