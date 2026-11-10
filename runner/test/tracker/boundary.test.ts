// Tracker is the only module that reaches Linear (overview, spec 1 "Tracker (Linear)"). No other module names
// Linear's API, imports the Linear adapter's files, or makes an HTTP request of its own. The session's
// `mcp.json` may name the Linear MCP server, because the session, not the runner, connects to it.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "bun:test";

const SRC = join(import.meta.dir, "..", "..", "src");

function files(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("no module but Tracker reaches Linear", () => {
  const reaching = files(SRC)
    .filter((path) => !relative(SRC, path).startsWith("tracker/"))
    .flatMap((path) => {
      const text = readFileSync(path, "utf8");
      const found = [
        /api\.linear\.app/.test(text) && "names Linear's API",
        /from ["'][^"']*tracker\/linear\//.test(text) && "imports the Linear adapter's files",
        /(?<![.\w]|async )fetch\(/.test(text) && "makes an HTTP request",
        /from ["']graphql/.test(text) && "imports graphql",
      ].filter((each): each is string => each !== false);
      return found.map((what) => `${relative(SRC, path)} ${what}`);
    });
  expect(reaching).toEqual([]);
});
