// The Claude Code Harness adapter: it starts a real `claude -p` session from its launch, reads its `stream-json`
// output, and ends it with exactly one exit (spec 1, "Harness (Claude Code)", ADRs 0002, 0005, 0007, and 0015).
// It owns the signals: SIGKILL when no `init` comes within 2 minutes, and SIGTERM then SIGKILL 10 seconds later at
// the deadline or on a stop. It holds `caffeinate -i` while any session runs, and at every end kills the process
// group of anything still running from the worktree or the session's `deps/`.
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { sessionParts } from "../folders/index.ts";
import { transcriptUuid, writeLaunch } from "./launch.ts";
import { CLAUDE_CODE, exitOf, Stream, type ClaudeCodeData, type StreamEvent } from "./stream.ts";
import type { Exit, Handle, Harness, HarnessSession, SessionEvents } from "./types.ts";

export interface ClaudeCodeOptions {
  /** `config.toml`'s `[paths]` `claude`. */
  claude: string;
  /** `data/claude-code.toml`. */
  data?: ClaudeCodeData;
  /** How long a session may go without an `init` event before SIGKILL. 2 minutes (ADR 0007). */
  initTimeoutMs?: number;
  /** The wait between SIGTERM and SIGKILL. 10 seconds (ADR 0007). */
  killAfterMs?: number;
  /** How long to wait for the rest of the output after the process exits. */
  drainMs?: number;
  caffeinate?: string;
  lsof?: string;
}

interface Run {
  session: HarnessSession;
  events: SessionEvents;
  child: ChildProcess;
  stream: Stream;
  claudeCodeVersion: string;
  stopped: boolean;
  noInit: boolean;
  timedOut: boolean;
  terminating: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
}

export class ClaudeCodeHarness implements Harness {
  private readonly claude: string;
  private readonly data: ClaudeCodeData;
  private readonly initTimeoutMs: number;
  private readonly killAfterMs: number;
  private readonly drainMs: number;
  private readonly caffeinatePath: string;
  private readonly lsof: string;
  private readonly running = new Map<string, Run>();
  private caffeinate: ChildProcess | null = null;

  constructor(options: ClaudeCodeOptions) {
    this.claude = options.claude;
    this.data = options.data ?? CLAUDE_CODE;
    this.initTimeoutMs = options.initTimeoutMs ?? 2 * 60 * 1000;
    this.killAfterMs = options.killAfterMs ?? 10 * 1000;
    this.drainMs = options.drainMs ?? 1000;
    this.caffeinatePath = options.caffeinate ?? "/usr/bin/caffeinate";
    this.lsof = options.lsof ?? "/usr/sbin/lsof";
  }

  async start(session: HarnessSession, events: SessionEvents): Promise<Handle> {
    const { launch } = session;
    await writeLaunch(launch);
    const claudeCodeVersion = await this.version();
    await mkdir(dirname(session.transcript), { recursive: true });
    // Claude Code needs a UUID as its session ID, so the Harness records it beside the transcript (spec 1, "Session IDs").
    await writeFile(transcriptUuid(session.transcript), `${launch.uuid}\n`);
    const transcript = createWriteStream(session.transcript);

    // Its own process group, so a signal to the runner's group never reaches the session.
    const child = spawn(this.claude, launch.args, {
      cwd: session.worktree,
      env: launch.environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }).catch(async (error: Error) => {
      await new Promise((done) => transcript.end(done));
      throw new Error(`can't start ${this.claude}: ${error.message}`);
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error(`can't start ${this.claude}: no process ID`);

    const run: Run = {
      session,
      events,
      child,
      stream: new Stream(this.data),
      claudeCodeVersion,
      stopped: false,
      noInit: false,
      timedOut: false,
      terminating: false,
      timers: new Set(),
    };
    this.running.set(session.id, run);
    this.holdCaffeinate();

    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    let draining = true;
    readLines(child.stdout, (line) => {
      if (!draining) return;
      transcript.write(`${line}\n`);
      this.report(run, run.stream.line(line));
    });
    readLines(child.stderr, (line) => this.report(run, run.stream.stderr(line)));

    // A session that hangs before `init` ignores SIGTERM (ADR 0007).
    this.after(run, this.initTimeoutMs, () => {
      if (run.stream.facts.sawInit) return;
      run.noInit = true;
      signal(child, "SIGKILL");
    });
    this.after(run, Date.parse(session.deadline) - Date.now(), () => {
      run.timedOut = true;
      this.terminate(run);
    });

    void exited.then(async ({ code, signal: ended }) => {
      // A process the session left behind may hold the pipe open, so the wait for the rest of the output is short.
      await Promise.race([closed, Bun.sleep(this.drainMs)]);
      draining = false;
      await new Promise((done) => transcript.end(done));
      await this.end(run, code ?? 128 + (ended === null ? 0 : (constants.signals[ended] ?? 0)));
    });

    return { session: session.id, uuid: launch.uuid, pid, pidStartedAt: processStartedAt(pid) ?? new Date().toISOString() };
  }

  async stop(handle: Handle): Promise<void> {
    const run = this.running.get(handle.session);
    if (run === undefined) return;
    run.stopped = true;
    this.terminate(run);
  }

  async version(): Promise<string> {
    const result = Bun.spawnSync([this.claude, "--version"], { stdout: "pipe", stderr: "pipe" });
    const output = result.stdout.toString();
    const match = /\d+\.\d+\.\d+[\w.+-]*/.exec(output);
    if (!result.success || match === null) throw new Error(`${this.claude} --version printed no version: ${output.trim() || result.stderr.toString().trim()}`);
    return match[0];
  }

  /** Lets `caffeinate` go. Sessions still running keep running. */
  async close(): Promise<void> {
    this.releaseCaffeinate(true);
  }

  private report(run: Run, events: StreamEvent[]): void {
    for (const event of events) {
      // The init watchdog reads `sawInit` when it fires, so an `init` needs nothing here.
      if (event.kind === "rate_limit") run.events.rateLimit(event.event);
      else if (event.kind === "login_expiring") run.events.loginExpiring?.(event.text);
    }
  }

  /** SIGTERM, then SIGKILL after the wait. */
  private terminate(run: Run): void {
    if (run.terminating) return;
    run.terminating = true;
    signal(run.child, "SIGTERM");
    this.after(run, this.killAfterMs, () => signal(run.child, "SIGKILL"));
  }

  private after(run: Run, ms: number, action: () => void): void {
    // setTimeout holds at most 2^31 - 1 ms, about 24 days.
    const timer = setTimeout(() => {
      run.timers.delete(timer);
      action();
    }, Math.min(Math.max(ms, 0), 2 ** 31 - 1));
    run.timers.add(timer);
  }

  private async end(run: Run, code: number): Promise<void> {
    for (const timer of run.timers) clearTimeout(timer);
    run.timers.clear();
    this.running.delete(run.session.id);
    const kind = exitOf({ stopped: run.stopped, noInit: run.noInit, timedOut: run.timedOut, code }, run.stream.facts);
    const exit: Exit = { ...kind, transcript: run.session.transcript, claudeCodeVersion: run.claudeCodeVersion };
    const error = run.stream.facts.result?.error;
    if (error !== undefined) exit.error = error;
    // Written as soon as the session ends, so a runner that stops before it handles the exit still finds it (ADR 0002).
    writeFileSync(
      join(run.session.sessionFolder, "exit.json"),
      `${JSON.stringify({ ...exit, details: { code, sawInit: run.stream.facts.sawInit, result: run.stream.facts.result, endedAt: new Date().toISOString() } })}\n`,
    );
    await killLeftovers([run.session.worktree, sessionParts(run.session.sessionFolder).deps], this.lsof);
    if (this.running.size === 0) this.releaseCaffeinate(false);
    run.events.exit(exit);
  }

  private holdCaffeinate(): void {
    if (this.caffeinate !== null) return;
    // `-w` ties it to the runner, so a crashed runner never leaves the Mac awake.
    const child = spawn(this.caffeinatePath, ["-i", "-w", String(process.pid)], { stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    this.caffeinate = child;
  }

  private releaseCaffeinate(always: boolean): void {
    if (this.caffeinate === null || (!always && this.running.size > 0)) return;
    signal(this.caffeinate, "SIGTERM");
    this.caffeinate = null;
  }
}

/** The process's start time from `ps`, as an ISO time to the second, or `null` when no such process runs. */
export function processStartedAt(pid: number): string | null {
  const result = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const text = result.stdout.toString().trim();
  if (!result.success || text === "") return null;
  const time = new Date(text);
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

/**
 * Kills the process group of every process whose working folder sits under one of `roots`, such as a dev server
 * a session started in the background, which runs in a process group of its own (ADR 0007). Never the runner's
 * own group. Returns the groups it killed.
 */
export async function killLeftovers(roots: string[], lsof = "/usr/sbin/lsof"): Promise<number[]> {
  // lsof names each folder by its real path.
  const real = await Promise.all(roots.map((root) => realpath(root).catch(() => root)));
  const result = Bun.spawnSync([lsof, "-a", "-d", "cwd", "-F", "pgn"], { stdout: "pipe", stderr: "ignore" });
  const own = processGroup(process.pid);
  const groups = new Set<number>();
  const lone = new Set<number>();
  let pid = 0;
  let group = 0;
  for (const line of result.stdout.toString().split("\n")) {
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      pid = Number(value);
      group = 0;
    } else if (field === "g") group = Number(value);
    else if (field === "n" && real.some((root) => value === root || value.startsWith(`${root}/`))) {
      if (pid === process.pid) continue;
      if (group > 1 && group !== own) groups.add(group);
      else if (group !== own) lone.add(pid);
    }
  }
  const killed: number[] = [];
  for (const each of groups) {
    try {
      // A negative ID names the group.
      process.kill(-each, "SIGKILL");
      killed.push(each);
    } catch {}
  }
  for (const each of lone) {
    try {
      process.kill(each, "SIGKILL");
    } catch {}
  }
  return killed;
}

function processGroup(pid: number): number | null {
  const text = Bun.spawnSync(["/bin/ps", "-o", "pgid=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  return text === "" ? null : Number(text);
}

function signal(child: ChildProcess, name: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(name);
  } catch {}
}

/** Calls `each` with every complete line, and the last one when the stream ends. */
function readLines(stream: NodeJS.ReadableStream | null, each: (line: string) => void): void {
  if (stream === null) return;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      each(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer !== "") each(buffer);
    buffer = "";
  });
}
