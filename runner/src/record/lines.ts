// Finds the line each key and table of a TOML text starts on, so errors can sort by where they sit.
// It reads only text that Bun's parser already accepted.

/** Where a value sits in the record: table keys, and array indexes counting from 0. */
export type Path = (string | number)[];

const BARE_KEY = /[A-Za-z0-9_-]/;

export interface KeyLines {
  /** The line of a path's key or table header, or of the nearest one above it. A top-level path not found is at line 0. */
  lineOf(path: Path): number;
  /** The first key or table header in the text. */
  first: Path | undefined;
}

export function keyLines(text: string): KeyLines {
  const { lines, first } = scan(text);
  return {
    first,
    lineOf: (path) => {
      for (let k = path.length; k > 0; k--) {
        const line = lines.get(JSON.stringify(path.slice(0, k)));
        if (line !== undefined) return line;
      }
      return 0;
    },
  };
}

function scan(text: string): { lines: Map<string, number>; first: Path | undefined } {
  const lines = new Map<string, number>();
  let first: Path | undefined;
  const tableArrays = new Map<string, number>(); // an array of tables to its entry count
  let table: Path = [];
  // Bun accepts a byte-order mark, which would otherwise read as an empty first key.
  let pos = text.startsWith("﻿") ? 1 : 0;
  let line = 1;

  const mark = (path: Path, header = false) => {
    first ??= path;
    for (let k = 1; k <= path.length; k++) {
      const id = JSON.stringify(path.slice(0, k));
      // A table's own header replaces the line that an earlier child header implied for it.
      if (!lines.has(id) || (header && k === path.length)) lines.set(id, line);
    }
  };

  // A header's key, with the latest entry of each array of tables it passes through.
  const resolve = (keys: string[]): Path => {
    const path: Path = [];
    for (const key of keys) {
      path.push(key);
      const count = tableArrays.get(JSON.stringify(path));
      if (count !== undefined) path.push(count - 1);
    }
    return path;
  };

  const skipSpaces = () => {
    while (text[pos] === " " || text[pos] === "\t") pos++;
  };

  const skipComment = () => {
    while (pos < text.length && text[pos] !== "\n") pos++;
  };

  const readQuoted = (quote: string): string => {
    pos++;
    const start = pos;
    while (pos < text.length && text[pos] !== quote) pos += quote === '"' && text[pos] === "\\" ? 2 : 1;
    const raw = text.slice(start, pos);
    pos++;
    return quote === '"' ? unescapeBasic(raw) : raw;
  };

  const readKey = (): string[] => {
    const keys: string[] = [];
    for (;;) {
      skipSpaces();
      const ch = text[pos];
      if (ch === '"' || ch === "'") {
        keys.push(readQuoted(ch));
      } else {
        const start = pos;
        while (pos < text.length && BARE_KEY.test(text[pos] ?? "")) pos++;
        keys.push(text.slice(start, pos));
      }
      skipSpaces();
      if (text[pos] !== ".") return keys;
      pos++;
    }
  };

  const skipMultiline = (fence: string) => {
    pos += 3;
    while (pos < text.length && !text.startsWith(fence, pos)) {
      // A backslash escapes the next character, which may be the newline a line-ending backslash trims.
      if (fence === '"""' && text[pos] === "\\") pos++;
      if (text[pos] === "\n") line++;
      pos++;
    }
    pos += 3;
    // A closing fence may carry up to two quotes of the string's own.
    if (text[pos] === fence[0]) pos++;
    if (text[pos] === fence[0]) pos++;
  };

  // Skips a value, which may span lines inside a multi-line string, an array, or an inline table.
  const skipValue = () => {
    let depth = 0;
    while (pos < text.length) {
      const ch = text[pos];
      if (text.startsWith('"""', pos) || text.startsWith("'''", pos)) skipMultiline(text.slice(pos, pos + 3));
      else if (ch === '"' || ch === "'") readQuoted(ch);
      else if (ch === "#") skipComment();
      else if (ch === "[" || ch === "{") (depth++, pos++);
      else if (ch === "]" || ch === "}") (depth--, pos++);
      else if (ch === "\n") {
        line++;
        pos++;
        if (depth === 0) return;
      } else pos++;
    }
  };

  while (pos < text.length) {
    skipSpaces();
    const ch = text[pos];
    if (ch === "\n") {
      line++;
      pos++;
    } else if (ch === "\r") {
      pos++;
    } else if (ch === "#") {
      skipComment();
    } else if (ch === "[") {
      const isArray = text[pos + 1] === "[";
      pos += isArray ? 2 : 1;
      const keys = readKey();
      pos += isArray ? 2 : 1;
      if (isArray) {
        const path = [...resolve(keys.slice(0, -1)), keys[keys.length - 1] ?? ""];
        const id = JSON.stringify(path);
        const count = tableArrays.get(id) ?? 0;
        tableArrays.set(id, count + 1);
        table = [...path, count];
      } else {
        table = resolve(keys);
      }
      mark(table, true);
    } else {
      const keys = readKey();
      pos++; // "="
      mark([...table, ...keys]);
      skipValue();
    }
  }
  return { lines, first };
}

const ESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\x1b", '"': '"', "\\": "\\" };

function unescapeBasic(raw: string): string {
  return raw.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (_, esc: string) =>
    esc.length > 1 ? String.fromCodePoint(parseInt(esc.slice(1), 16)) : (ESCAPES[esc] ?? esc),
  );
}
