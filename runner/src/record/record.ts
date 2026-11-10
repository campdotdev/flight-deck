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

/** The parts of a record `readRecordPart` reads on their own. */
export type RecordPart = "tracker" | "copy_files";

export type RecordPartResult<K extends RecordPart> = { ok: true; value: RepoRecord[K] } | { ok: false; errors: string[] };

/** One validator per part, each the schema's own subschema for it, so the two never disagree. */
const partValidators = new Map<RecordPart, ReturnType<typeof ajv.compile>>();

function partValidator(part: RecordPart): ReturnType<typeof ajv.compile> {
  let validator = partValidators.get(part);
  if (validator === undefined) {
    const schema = schemaJson as { $defs: unknown; properties: Record<string, unknown> };
    validator = ajv.compile({ type: "object", required: [part], properties: { [part]: schema.properties[part] }, $defs: schema.$defs });
    partValidators.set(part, validator);
  }
  return validator;
}

/**
 * Checks one part of a record and nothing else, as `flight-deck register` reads `[tracker]` from a record still
 * being written (spec 1, "Install"). The errors read as `readRecord`'s do, the part's rules included.
 */
export function readRecordPart<K extends RecordPart>(text: string, part: K): RecordPartResult<K> {
  const parsed = parse(text);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };
  const data = { [part]: (parsed.data as Record<string, unknown>)[part] };
  if (data[part] === undefined) delete data[part];
  const validate = partValidator(part);
  const problems: Problem[] = [];
  if (!validate(data)) problems.push(...(validate.errors ?? []).flatMap((error) => problemOf(error, data)));
  const rejected = new Set(problems.map((problem) => JSON.stringify(problem.path)));
  problems.push(...checkRules(data).filter((problem) => !rejected.has(JSON.stringify(problem.path))));
  if (problems.length > 0) return { ok: false, errors: [...new Set(sortByLine(problems, keyLines(text)).map(format))] };
  return { ok: true, value: data[part] as RepoRecord[K] };
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
 * Bun's TOML parser reports no line, so find the first line where a parse of the text up to it
 * fails with the same message. A prefix that stops inside a multi-line value fails differently.
 */
function parseErrorLine(text: string, message: string): number | undefined {
  const lines = text.split("\n");
  for (let n = 1; n <= lines.length; n++) {
    try {
      Bun.TOML.parse(`${lines.slice(0, n).join("\n")}\n`);
    } catch (error) {
      if (errorMessage(error).replace(PARSE_PREFIX, "") === message) return n;
    }
  }
  return undefined;
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
    .sort((a, b) => a.line - b.line)
    .map(({ problem }) => problem);
}

function format(problem: Problem): string {
  return `${formatPath(problem.path)}: ${problem.message}`;
}
