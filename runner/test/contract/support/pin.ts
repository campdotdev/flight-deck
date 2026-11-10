// What a contract run writes: a measured value into the TOML file the version pins it in, and a recorded stream
// line over its `placeholder.*` fixture (spec 1, "Session IDs", "Watchdogs and exits", and "Suites").
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FIXTURES, PLACEHOLDER } from "../../harness/fixtures.ts";

/** The repo's `data/` folder. */
export const DATA = join(import.meta.dir, "../../../../data");
export const LIMITS_TOML = join(DATA, "limits.toml");
export const CLAUDE_CODE_TOML = join(DATA, "claude-code.toml");

type Value = number | string | string[];

/** A value as TOML: a literal string when it can be one, so a regular expression reads as written. */
export function tomlValue(value: Value): string {
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[\n${value.map((each) => `  ${tomlValue(each)},\n`).join("")}]`;
  if (!/['\n\r\t]/.test(value) && !/[\u0000-\u001f\u007f]/.test(value)) return `'${value}'`;
  // JSON's string escapes are TOML basic-string escapes too.
  return JSON.stringify(value);
}

/**
 * Sets `key` in a TOML file's text. The key's line, any array lines after it, and the comment lines right above it
 * give way to `comment` and the new value. Everything else stays. A key the text doesn't hold is appended.
 */
export function pinToml(text: string, key: string, value: Value, comment: string[]): string {
  const block = [...comment.map((line) => (line === "" ? "#" : `# ${line}`)), `${key} = ${tomlValue(value)}`];
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const at = lines.findIndex((line) => new RegExp(`^${key}\\s*=`).test(line));
  if (at === -1) {
    const gap = lines.length === 0 || lines.at(-1) === "" ? [] : [""];
    return `${[...lines, ...gap, ...block].join("\n")}\n`;
  }
  let end = at;
  const rest = lines[at]!.slice(lines[at]!.indexOf("=") + 1).trim();
  if (rest.startsWith("[") && !rest.endsWith("]")) {
    while (end + 1 < lines.length && lines[end]!.trim() !== "]") end++;
  }
  let start = at;
  while (start > 0 && lines[start - 1]!.startsWith("#")) start--;
  return `${[...lines.slice(0, start), ...block, ...lines.slice(end + 1)].join("\n")}\n`;
}

/** Pins `key` in the file at `path`, creating the file when there's none. */
export async function pinFile(path: string, key: string, value: Value, comment: string[]): Promise<void> {
  const text = existsSync(path) ? await readFile(path, "utf8") : "";
  await writeFile(path, pinToml(text, key, value, comment));
}

/** Writes a recorded fixture and removes its `placeholder.` stand-in, so the parser's tests read the recording. */
export async function recordFixture(name: string, content: string, folder = FIXTURES): Promise<void> {
  await writeFile(join(folder, name), `${content.trimEnd()}\n`);
  await rm(join(folder, `${PLACEHOLDER}${name}`), { force: true });
}

/**
 * `login_expired_patterns` from the error texts a revoked login produced: from a `result` that holds an API error,
 * the error's message, else the text. Each keeps its first sentence, with every regular-expression character
 * escaped, so a request ID or a time in the rest never makes a pattern miss the next time.
 */
export function loginExpiredPatterns(texts: string[]): string[] {
  const patterns = texts.map((text) => escape(firstSentence(apiMessage(text) ?? text))).filter((each) => each !== "");
  return [...new Set(patterns)];
}

/** The `error.message` of a JSON object inside the text, such as `API Error: 401 {...}`. */
function apiMessage(text: string): string | null {
  const from = text.indexOf("{");
  const to = text.lastIndexOf("}");
  if (from === -1 || to < from) return null;
  try {
    const json = JSON.parse(text.slice(from, to + 1)) as { error?: { message?: unknown }; message?: unknown };
    const message = json.error?.message ?? json.message;
    return typeof message === "string" ? message : null;
  } catch {
    return null;
  }
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.search(/\.(\s|$)/);
  return end === -1 ? trimmed : trimmed.slice(0, end);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
