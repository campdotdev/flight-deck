// What a real session's `stream-json` transcript shows: its `init` event, each tool call and its result, what
// permissions denied, and what the session said. The probes check evidence here, apart from the session's report.
import { existsSync, readFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export type Event = Record<string, any>;

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** The tool call that started the subagent this call ran in, or `null` for the session's own. */
  parent: string | null;
}

export interface ToolResult {
  id: string;
  isError: boolean;
  text: string;
}

export interface Denial {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
}

/** Every JSON line of a transcript. A line that isn't JSON is skipped. */
export function events(transcript: string): Event[] {
  if (!existsSync(transcript)) return [];
  return readFileSync(transcript, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return parsed !== null && typeof parsed === "object" ? [parsed as Event] : [];
      } catch {
        return [];
      }
    });
}

/** Every line of the transcript, as written, for a fixture. */
export function lines(transcript: string): string[] {
  return existsSync(transcript) ? readFileSync(transcript, "utf8").split("\n").filter((line) => line.trim() !== "") : [];
}

export function init(all: Event[]): Event | null {
  return all.find((event) => event.type === "system" && event.subtype === "init") ?? null;
}

export function results(all: Event[]): Event[] {
  return all.filter((event) => event.type === "result");
}

function blocks(event: Event): Event[] {
  const content = event.message?.content;
  return Array.isArray(content) ? content : [];
}

export function toolUses(all: Event[]): ToolUse[] {
  return all
    .filter((event) => event.type === "assistant")
    .flatMap((event) =>
      blocks(event)
        .filter((block) => block.type === "tool_use")
        .map((block) => ({ id: String(block.id), name: String(block.name), input: (block.input ?? {}) as Record<string, unknown>, parent: (event.parent_tool_use_id as string | null) ?? null })),
    );
}

export function toolResults(all: Event[]): ToolResult[] {
  return all
    .filter((event) => event.type === "user")
    .flatMap((event) =>
      blocks(event)
        .filter((block) => block.type === "tool_result")
        .map((block) => ({ id: String(block.tool_use_id), isError: block.is_error === true, text: textOf(block.content) })),
    );
}

/** Every call each `result` event lists as denied by permissions. */
export function denials(all: Event[]): Denial[] {
  return results(all).flatMap((event) => (Array.isArray(event.permission_denials) ? (event.permission_denials as Denial[]) : []));
}

/** The session's own words: its text blocks, and each `result`'s text. With `subagents: false`, the top level only. */
export function said(all: Event[], options: { subagents?: boolean } = {}): string {
  const text = all
    .filter((event) => event.type === "assistant" && (options.subagents !== false || event.parent_tool_use_id == null))
    .flatMap((event) => blocks(event).filter((block) => block.type === "text").map((block) => String(block.text)));
  const final = results(all).flatMap((event) => (typeof event.result === "string" ? [event.result] : []));
  return [...text, ...final].join("\n");
}

/** Everything the transcript holds as text: what the session said, its tool calls, and what each returned. */
export function everything(all: Event[]): string {
  return all.map((event) => JSON.stringify(event)).join("\n");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
  return "";
}

/** The name of every Unix socket file under `folder`, at any depth. */
export async function socketsUnder(folder: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6) return;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const stats = await lstat(path);
        if (stats.isSocket()) found.push(path);
        else if (stats.isDirectory()) await walk(path, depth + 1);
      } catch {
        // The file went while the walk read the folder.
      }
    }
  }
  await walk(folder, 0);
  return found;
}
