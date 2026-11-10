// The secret scan (spec 1, "The secret scan", ADR 0007). Before any write, the Outbox scans everything it will
// post, and the runner's own comments scan their facts. Two checks run: the pinned Betterleaks through
// `betterleaks stdin`, with its default rules and no allowlist of Flight Deck's own, and an exact-value match
// against the files `register` copied for the repo's `copy_files`.
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { paths, type Folders } from "../folders/index.ts";

/** One text the scan reads, and the outbox file it came from, which a hit names. */
export interface ScanText {
  file: string;
  text: string;
}

/** What matched, never the value. */
export type SecretHit =
  /** A Betterleaks rule, by its ID, such as `github-pat`. */
  | { file: string; rule: string }
  /** The value of a `KEY=VALUE` line in a copied file. */
  | { file: string; key: string; copied: string }
  /** A line of a copied file that isn't in `KEY=VALUE` form. */
  | { file: string; line: number; copied: string };

/** Betterleaks couldn't run, so nothing it would have read counts as scanned. */
export class SecretScanFailed extends Error {}

/** The shortest value, in Unicode code points, the exact-value match looks for, so `PORT=3000` matches nothing. */
export const COPIED_VALUE_MIN = 8;

/** Betterleaks' exit code for a hit, so any other non-zero code means it failed. */
const HIT_EXIT = 99;

export interface SecretScanOptions {
  folders: Folders;
  /** The version folder, whose `vendor/betterleaks` the scan runs. */
  versionFolder: string;
}

/** A value the exact-value match looks for, and what a hit names instead of it. */
interface CopiedValue {
  value: string;
  copied: string;
  key?: string;
  line?: number;
}

export class SecretScan {
  private readonly betterleaks: string;

  constructor(private readonly options: SecretScanOptions) {
    this.betterleaks = paths.betterleaks(options.versionFolder);
  }

  /** Every hit in the texts, in their order. `repo` names the repo whose copied files' values count. */
  async scan(repo: string, texts: readonly ScanText[]): Promise<SecretHit[]> {
    const values = await this.copiedValues(repo);
    const found = await Promise.all(
      texts.map(async ({ file, text }): Promise<SecretHit[]> => {
        const rules = await this.rules(text);
        const copied = values.filter(({ value }) => text.includes(value));
        return [
          ...rules.map((rule) => ({ file, rule })),
          ...copied.map(({ copied, key, line }) => (key !== undefined ? { file, key, copied } : { file, line: line!, copied })),
        ];
      }),
    );
    return found.flat();
  }

  /** Whether the text holds anything the scan matches. */
  async matches(repo: string, text: string): Promise<boolean> {
    return (await this.scan(repo, [{ file: "", text }])).length > 0;
  }

  /**
   * The IDs of the Betterleaks rules the text matches, each once. It runs with no environment and from the
   * version folder's `vendor/`, which holds no config or ignore file, so only the default rules apply.
   * `--ignore-gitleaks-allow` keeps an allow comment in the text from hiding a match, and `--redact` keeps
   * the matched value out of the report.
   */
  private async rules(text: string): Promise<string[]> {
    const args = ["stdin", "--no-banner", "--no-color", "--redact", "--ignore-gitleaks-allow", "--report-format", "json", "--report-path", "-", "--log-level", "error"];
    let proc;
    try {
      proc = Bun.spawn([this.betterleaks, ...args, "--exit-code", String(HIT_EXIT)], {
        cwd: dirname(this.betterleaks),
        env: {},
        stdin: new Blob([text]),
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      throw new SecretScanFailed(`Betterleaks didn't start: ${error instanceof Error ? error.message : String(error)}`);
    }
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0 && code !== HIT_EXIT) throw new SecretScanFailed(`Betterleaks exited with code ${code}: ${err.trim()}`);
    let report: unknown;
    try {
      report = JSON.parse(out);
    } catch {
      throw new SecretScanFailed("Betterleaks' report isn't JSON");
    }
    if (!Array.isArray(report)) throw new SecretScanFailed("Betterleaks' report isn't a list");
    const rules = report.map((finding: { RuleID?: unknown }) => (typeof finding.RuleID === "string" ? finding.RuleID : "unknown"));
    if (code === HIT_EXIT && rules.length === 0) throw new SecretScanFailed("Betterleaks reported a hit with no finding");
    return [...new Set(rules)];
  }

  /** The values of every file `register` copied for the repo, read fresh, so a new `register --files` counts. */
  private async copiedValues(repo: string): Promise<CopiedValue[]> {
    const root = paths.files(this.options.folders, repo);
    const values: CopiedValue[] = [];
    for (const path of await filesUnder(root)) {
      const copied = relative(root, path);
      const text = await readFile(path, "utf8");
      values.push(...valuesOf(text).map((value) => ({ ...value, copied })));
    }
    return values;
  }
}

const KEY_VALUE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;

/**
 * A copied file's values of 8 code points or more. A file whose every line is blank, a `#` comment, or
 * `KEY=VALUE` gives each value, unquoted, with an unquoted value's trailing ` # comment` dropped. Any other
 * file gives each trimmed line.
 */
function valuesOf(text: string): Omit<CopiedValue, "copied">[] {
  const lines = text.split(/\r?\n/);
  const keyValue = lines.every((line) => line.trim() === "" || line.trim().startsWith("#") || KEY_VALUE.test(line));
  const long = (value: string) => [...value].length >= COPIED_VALUE_MIN;
  if (!keyValue) {
    return lines.flatMap((line, index) => (long(line.trim()) ? [{ value: line.trim(), line: index + 1 }] : []));
  }
  return lines.flatMap((line) => {
    const match = KEY_VALUE.exec(line);
    if (match === null) return [];
    const value = unquote(match[2]!.trim());
    return long(value) ? [{ value, key: match[1]! }] : [];
  });
}

function unquote(value: string): string {
  const quote = value[0];
  if (quote === '"' || quote === "'" || quote === "`") {
    const end = value.lastIndexOf(quote);
    if (end > 0) return value.slice(1, end);
  }
  return value.replace(/\s+#.*$/, "").trim();
}

/** Every regular file under the folder, sorted, or none when it doesn't exist. Symlinks aren't followed. */
async function filesUnder(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}
