// The scripted Harness adapter. It stands in for `claude`, its `version()`, and `caffeinate`. A scenario tells
// it what each session leaves in its outbox and how it exits, and asserts on what it was asked to start.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionJson } from "../workspace/index.ts";
import type { Exit, ExitKind, Handle, Harness, HarnessSession, RateLimitEvent, SessionEvents } from "./types.ts";

/** What one session does. */
export interface SessionScript {
  /** Files the session leaves in its outbox, by path inside it, such as `summary.md` or `media/before.png`. */
  outbox?: Record<string, string | Uint8Array>;
  /** Each `rate_limit_event` the session reports while it runs. */
  rateLimits?: RateLimitEvent[];
  /** How the session ends. Without one, it runs until the scenario calls `finish` or the runner calls `stop`. */
  exit?: ExitKind;
  /** The last error message from the session's `result` event. */
  error?: string;
}

/** One `start` call, with what the session found when it started. */
export interface StartRecord {
  session: HarnessSession;
  /** `session.json`, parsed. */
  sessionJson: SessionJson;
  /** Every file in the inbox, by name. */
  inbox: Record<string, string>;
  /** The commit the worktree sat at. */
  worktreeHead: string;
}

interface Running {
  session: HarnessSession;
  events: SessionEvents;
  handle: Handle;
}

export class ScriptedHarness implements Harness {
  /** Every start, in order. */
  readonly started: StartRecord[] = [];
  /** The session ID of every stop request, in order. */
  readonly stops: string[] = [];
  /** The Claude Code version `version()` returns. */
  claudeCodeVersion: string;

  private readonly scripts = new Map<string, SessionScript[]>();
  private readonly running = new Map<string, Running>();
  private pids = 1000;

  constructor(options: { claudeCodeVersion?: string } = {}) {
    this.claudeCodeVersion = options.claudeCodeVersion ?? "2.1.321";
  }

  /** Queues what the next session on the issue does. A session with no script runs until it's finished or stopped. */
  script(issue: string, script: SessionScript): void {
    this.scripts.set(issue, [...(this.scripts.get(issue) ?? []), script]);
  }

  /** Ends a running session, with the last error message from its `result` event when it has one. */
  finish(session: string, exit: ExitKind, options: { error?: string } = {}): void {
    const running = this.running.get(session);
    if (running === undefined) throw new Error(`session ${session} isn't running`);
    this.end(running, exit, options.error);
  }

  /** The IDs of the sessions still running. */
  runningSessions(): string[] {
    return [...this.running.keys()];
  }

  async start(session: HarnessSession, events: SessionEvents): Promise<Handle> {
    this.started.push({
      session,
      sessionJson: JSON.parse(await readFile(session.sessionJson, "utf8")) as SessionJson,
      inbox: await readFiles(join(session.sessionFolder, "inbox")),
      worktreeHead: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: session.worktree }).stdout.toString().trim(),
    });
    const handle: Handle = { session: session.id, uuid: randomUUID(), pid: this.pids++, pidStartedAt: new Date().toISOString() };
    const running: Running = { session, events, handle };
    this.running.set(session.id, running);
    await mkdir(dirname(session.transcript), { recursive: true });
    await writeFile(session.transcript, "");

    const queue = this.scripts.get(session.issue) ?? [];
    const script = queue.shift() ?? {};
    for (const [path, content] of Object.entries(script.outbox ?? {})) {
      const file = join(session.sessionFolder, "outbox", path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    for (const event of script.rateLimits ?? []) events.rateLimit(event);
    if (script.exit !== undefined) this.end(running, script.exit, script.error);
    return handle;
  }

  async stop(handle: Handle): Promise<void> {
    this.stops.push(handle.session);
    const running = this.running.get(handle.session);
    if (running !== undefined) this.end(running, { kind: "stopped" });
  }

  async version(): Promise<string> {
    return this.claudeCodeVersion;
  }

  private end(running: Running, kind: ExitKind, error?: string): void {
    this.running.delete(running.session.id);
    const exit: Exit = { ...kind, transcript: running.session.transcript, claudeCodeVersion: this.claudeCodeVersion };
    if (error !== undefined) exit.error = error;
    // The adapter writes exit.json as soon as it sees the session end, before the runner handles the exit.
    writeFileSync(join(running.session.sessionFolder, "exit.json"), `${JSON.stringify(exit)}\n`);
    running.events.exit(exit);
  }
}

async function readFiles(folder: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of (await readdir(folder)).sort()) files[name] = await readFile(join(folder, name), "utf8");
  return files;
}
