// The root `AGENTS.md`: Claude Code reads it only through a `CLAUDE.md` import, so the Harness appends it with
// `--append-system-prompt-file` when no loaded `CLAUDE.md` imports it, directly or through another import
// (spec 1, "The command line", ADR 0007).
//
// Imports resolve the way Claude Code resolves them: an `@<path>` at the start of a line or after whitespace,
// outside a code span or a fenced code block, relative to the file that holds it. A `\ ` escapes a space, and
// a `#` ends the path. Claude Code reads five levels of files, the `CLAUDE.md` and four hops of imports below
// it. The session's `CLAUDE.md` files load only from inside the worktree, so an import that resolves outside
// it counts as none, and Claude Code never reads that file's own imports.
import { realpath, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/** The `CLAUDE.md` files `--add-dir <worktree>` loads, relative to the worktree. */
const LOADED = ["CLAUDE.md", ".claude/CLAUDE.md"];

/** The `CLAUDE.md` at depth 0, and imports down to depth 4. */
const MAX_DEPTH = 5;

/**
 * The absolute path of the worktree's root `AGENTS.md` when the Harness appends it, or `null` when the file is
 * missing, lies outside the worktree, or a loaded `CLAUDE.md` imports it. `home` expands an `~/` import.
 */
export async function agentsMdToAppend(worktree: string, home: string): Promise<string | null> {
  const root = await realpath(worktree);
  const agents = join(worktree, "AGENTS.md");
  const agentsReal = await inside(root, agents);
  if (agentsReal === null) return null;

  const seen = new Set<string>();
  const queue: { file: string; depth: number }[] = [];
  for (const name of LOADED) {
    const file = await inside(root, join(worktree, name));
    if (file !== null) queue.push({ file, depth: 0 });
  }
  while (queue.length > 0) {
    const { file, depth } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (file === agentsReal) return null;
    if (depth + 1 >= MAX_DEPTH) continue;
    for (const path of importPaths(await readFile(file, "utf8"))) {
      const target = await inside(root, resolveImport(path, dirname(file), home));
      if (target !== null) queue.push({ file: target, depth: depth + 1 });
    }
  }
  return agents;
}

/** The real path of a regular file inside the worktree, or `null`. */
async function inside(root: string, path: string): Promise<string | null> {
  try {
    const real = await realpath(path);
    if (real !== root && !real.startsWith(root + sep)) return null;
    return (await stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

function resolveImport(path: string, from: string, home: string): string {
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return isAbsolute(path) ? path : resolve(from, path);
}

/** Each `@<path>` in a Markdown file's text, outside code spans and fenced code blocks. */
export function importPaths(text: string): string[] {
  const found: string[] = [];
  for (const line of proseLines(text)) {
    for (const match of line.matchAll(/(?:^|\s)@((?:[^\s\\]|\\ )+)/g)) {
      const path = match[1]!.replace(/\\ /g, " ").split("#")[0]!;
      if (isImportPath(path)) found.push(path);
    }
  }
  return found;
}

/** What Claude Code takes for a path, so `@mention` and `@@` stay text. */
function isImportPath(path: string): boolean {
  if (path === "" || path === "/") return false;
  if (path.startsWith("./") || path.startsWith("~/") || path.startsWith("/")) return true;
  return /^[A-Za-z0-9._-]/.test(path);
}

/** The text's lines with fenced code blocks dropped and code spans blanked. */
function proseLines(text: string): string[] {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null) {
      if (opener !== undefined && opener[0] === fence[0] && opener.length >= fence.length && line.trim() === opener) fence = null;
      continue;
    }
    if (opener !== undefined) {
      fence = opener;
      continue;
    }
    lines.push(line);
  }
  // A code span opens with a whole run of backticks and closes at the next whole run of the same length, across
  // lines. A run with no such closer stays text.
  return lines.join("\n").replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, (span) => " ".repeat(span.length)).split("\n");
}
