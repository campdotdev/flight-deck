import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import schemaJson from "../../../data/record.schema.json";
import { keyLines, type KeyLines, type Path } from "./lines.ts";
import { checkRules, type Problem } from "./rules.ts";
import type { RepoRecord } from "./types.ts";

/** The record schema this runner reads. */
export const RUNNER_SCHEMA = 1;

export type RecordResult =
  | { ok: true; record: RepoRecord }
  | { ok: false; reason: "invalid"; errors: string[] }
  | { ok: false; reason: "newer"; schema: number; errors: [string] };

const ajv = new Ajv2020({ allErrors: true, strict: true, verbose: true });
// `message` is the schema's own text for a failed pattern. Ajv only carries it.
ajv.addKeyword({ keyword: "message", schemaType: "string" });
const validate = ajv.compile(schemaJson);

export function readRecord(text: string): RecordResult {
  const parsed = parse(text);
  if (!parsed.ok) return { ok: false, reason: "invalid", errors: [parsed.error] };
  const data = parsed.data;
  const schema = (data as { schema?: unknown }).schema;
  if (typeof schema === "number" && Number.isInteger(schema) && schema > RUNNER_SCHEMA) {
    const error = `schema: is ${schema}, newer than the schema ${RUNNER_SCHEMA} this runner reads. Run flight-deck update.`;
    return { ok: false, reason: "newer", schema, errors: [error] };
  }
  const keys = keyLines(text);
  const problems: Problem[] = [];
  if (!validate(data)) problems.push(...(validate.errors ?? []).flatMap((error) => problemOf(error, data)));
  // A value the schema already rejected gets no second error from a rule.
  const rejected = new Set(problems.map((problem) => JSON.stringify(problem.path)));
  problems.push(...checkRules(data).filter((problem) => !rejected.has(JSON.stringify(problem.path))));
  if (schema !== undefined && JSON.stringify(keys.first) !== '["schema"]') {
    problems.push({ path: ["schema"], message: "must be the first key" });
  }
  if (problems.length > 0) {
    // The extras' `then` branch checks `run` a second time, so one error can come twice.
    const errors = [...new Set(sortByLine(problems, keys).map(format))];
    return { ok: false, reason: "invalid", errors };
  }
  return { ok: true, record: data as unknown as RepoRecord };
}

const PARSE_PREFIX = "TOML Parse error: ";

function parse(text: string): { ok: true; data: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, data: Bun.TOML.parse(text) };
  } catch (error) {
    const message = errorMessage(error).replace(PARSE_PREFIX, "");
    const line = parseErrorLine(text, message);
    return { ok: false, error: line === undefined ? message : `line ${line}: ${message}` };
  }
}

/**
 * Bun's TOML parser reports no line, so find the first line from which every longer prefix of the
 * text fails with the same message. A shorter prefix can fail with it too: one that stops at a
 * complete multi-line string's opening `"""` is an unterminated string.
 */
function parseErrorLine(text: string, message: string): number | undefined {
  const lines = text.split("\n");
  let line: number | undefined;
  for (let n = lines.length; n >= 1; n--) {
    if (prefixError(lines, n) !== message) break;
    line = n;
  }
  return line;
}

function prefixError(lines: string[], n: number): string | undefined {
  try {
    Bun.TOML.parse(`${lines.slice(0, n).join("\n")}\n`);
    return undefined;
  } catch (error) {
    return errorMessage(error).replace(PARSE_PREFIX, "");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const TYPE_NAMES: Record<string, string> = {
  string: "a string",
  integer: "an integer",
  number: "a number",
  array: "a list",
  object: "a table",
  boolean: "true or false",
};

function problemOf(error: ErrorObject, data: unknown): Problem[] {
  const path = pointerToPath(error.instancePath, data);
  const params = error.params as Record<string, unknown>;
  const parent = error.parentSchema as Record<string, unknown> | undefined;
  switch (error.keyword) {
    case "required":
      return [{ path: [...path, String(params.missingProperty)], message: "is missing", missing: true }];
    case "additionalProperties":
      return [{ path: [...path, String(params.additionalProperty)], message: "is not a schema-1 field" }];
    case "type":
      return [{ path, message: `must be ${TYPE_NAMES[String(params.type)] ?? String(params.type)}` }];
    case "const":
      return [{ path, message: `must be ${JSON.stringify(params.allowedValue)}` }];
    case "enum":
      return [{ path, message: `must be one of ${(params.allowedValues as unknown[]).join(", ")}` }];
    case "minLength":
      return [{ path, message: "must not be empty" }];
    case "minimum":
    case "maximum":
      return [{ path, message: `must be between ${parent?.minimum} and ${parent?.maximum}` }];
    case "pattern":
      return [{ path, message: typeof parent?.message === "string" ? parent.message : `must match ${params.pattern}` }];
    case "if":
      // The `then` branch reports its own error.
      return [];
    default:
      return [{ path, message: error.message ?? "is invalid" }];
  }
}

/** Turns a JSON pointer into a path, reading `data` so that only an array's index becomes a number. */
function pointerToPath(pointer: string, data: unknown): Path {
  if (pointer === "") return [];
  const path: Path = [];
  let node = data;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    const part = Array.isArray(node) ? Number(key) : key;
    path.push(part);
    node = (node as Record<string | number, unknown> | undefined)?.[part];
  }
  return path;
}

/** `commands[2].category`, with each index counting from 1. */
function formatPath(path: Path): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part + 1}]`;
    else out += out === "" ? part : `.${part}`;
  }
  return out;
}

function sortByLine(problems: Problem[], keys: KeyLines): Problem[] {
  const line = (problem: Problem) => keys.lineOf(problem.missing ? problem.path.slice(0, -1) : problem.path);
  return problems
    .map((problem) => ({ problem, line: line(problem) }))
    .sort((a, b) => a.line - b.line || byIndex(a.problem.path, b.problem.path))
    .map(({ problem }) => problem);
}

/**
 * Orders two paths on the same line by the first array index where they differ. The key lines
 * don't mark a list's entries, so every error in one list shares the list's line, and the schema's
 * errors would otherwise all come before the rules'. Paths that differ at a key keep their order.
 */
function byIndex(a: Path, b: Path): number {
  for (let k = 0; k < Math.min(a.length, b.length); k++) {
    const x = a[k];
    const y = b[k];
    if (x === y) continue;
    return typeof x === "number" && typeof y === "number" ? x - y : 0;
  }
  return 0;
}

function format(problem: Problem): string {
  return `${formatPath(problem.path)}: ${problem.message}`;
}
