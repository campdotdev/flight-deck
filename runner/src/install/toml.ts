// A small TOML writer for `config.toml`. It writes strings, numbers, booleans, arrays of those, tables, and
// arrays of tables, which is all `config.toml` holds.

type Value = string | number | boolean | Value[] | { [key: string]: Value };

function isTable(value: unknown): value is Record<string, Value> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTableArray(value: unknown): value is Record<string, Value>[] {
  return Array.isArray(value) && value.length > 0 && value.every(isTable);
}

function scalar(value: Value): string {
  // JSON's escapes are TOML's, except that TOML also escapes DEL.
  if (typeof value === "string") return JSON.stringify(value).replaceAll("\x7f", "\\u007F");
  if (Array.isArray(value)) return `[${value.map(scalar).join(", ")}]`;
  if (isTable(value)) return `{ ${Object.entries(value).map(([key, each]) => `${quoteKey(key)} = ${scalar(each)}`).join(", ")} }`;
  return String(value);
}

function quoteKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function table(path: string[], value: Record<string, Value>, header: string | null): string[] {
  const lines: string[] = header === null ? [] : ["", header];
  const nested: string[] = [];
  for (const [key, each] of Object.entries(value)) {
    if (each === undefined) continue;
    const at = [...path, quoteKey(key)];
    if (isTableArray(each)) {
      for (const item of each) nested.push(...table(at, item, `[[${at.join(".")}]]`));
    } else if (isTable(each)) {
      nested.push(...table(at, each, `[${at.join(".")}]`));
    } else {
      lines.push(`${quoteKey(key)} = ${scalar(each)}`);
    }
  }
  return [...lines, ...nested];
}

export function toToml(value: Record<string, unknown>): string {
  return `${table([], value as Record<string, Value>, null).join("\n").trim()}\n`;
}
