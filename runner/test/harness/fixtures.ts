// The parser's stream fixtures. Each one is a real recording when the Harness contract suite has recorded it, and
// a `placeholder.<name>` file until then (see `fixtures/README.md`). Tests ask for a fixture by its plain name, so
// a recording replaces its placeholder without a test changing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURES = join(import.meta.dir, "fixtures");

/** The prefix of a fixture written from Claude Code's documented format, before a real session recorded it. */
export const PLACEHOLDER = "placeholder.";

/** The fixture's path: the recording when there is one, else its placeholder. */
export function fixturePath(name: string, folder = FIXTURES): string {
  const recorded = join(folder, name);
  if (existsSync(recorded)) return recorded;
  const placeholder = join(folder, `${PLACEHOLDER}${name}`);
  if (existsSync(placeholder)) return placeholder;
  throw new Error(`no fixture ${name} or ${PLACEHOLDER}${name} in ${folder}`);
}

/** The fixture's text, without its final newline. */
export function fixture(name: string, folder = FIXTURES): string {
  return readFileSync(fixturePath(name, folder), "utf8").trimEnd();
}

/** The fixture as one parsed `stream-json` line. */
export function fixtureEvent(name: string, folder = FIXTURES): Record<string, unknown> {
  return JSON.parse(fixture(name, folder)) as Record<string, unknown>;
}
