// `flight-deck runner`: the process launchd keeps alive (spec 1, "Poll", "Exits", and "Tokens", ADRs 0002 and
// 0005). It calls `tick` at its start and then about once a minute, listens on `runner.sock`, and writes its own
// log. On SIGTERM it stops each running session as `shutdown`, which also revokes its Linear token, waits for
// the sessions to end, lets the Harness go, and stops listening.
import type { Folders } from "../folders/index.ts";
import { paths } from "../folders/index.ts";
import type { Harness } from "../harness/index.ts";
import { Poll } from "../poll/index.ts";
import { ask } from "../socket/index.ts";
import { State } from "../state/index.ts";
import type { Tracker } from "../tracker/index.ts";
import { listenRunnerSocket } from "./socket.ts";

/** About once a minute (ADR 0002). */
const INTERVAL_MS = 60_000;
/** How long SIGTERM waits for stopped sessions: the Claude Code adapter's SIGKILL comes 10 seconds after its SIGTERM. */
const SESSIONS_END_MS = 20_000;

export interface RunnerOptions {
  folders: Folders;
  version: string;
  versionFolder: string;
  /** The Tracker as the Flight Deck app: the Linear adapter in production. */
  tracker: Tracker;
  harness: Harness;
  /** Lets the Harness go at the end, such as the Claude Code adapter's `close()`. */
  closeHarness?: () => Promise<void>;
  /** The runner's `PATH`, for `osascript`. The process's own by default. */
  path?: string;
  clock?: () => Date;
  intervalMs?: number;
}

export interface Runner {
  /** Runs one tick now, in the Poll's queue, as the interval does. */
  tick(): Promise<void>;
  /** What SIGTERM does. A second call waits for the first and does nothing more. */
  terminate(): Promise<void>;
}

/** Starts the runner. It refuses while another runner answers on the socket. */
export async function startRunner(options: RunnerOptions): Promise<Runner> {
  const { folders, version } = options;
  const clock = options.clock ?? (() => new Date());
  const intervalMs = options.intervalMs ?? INTERVAL_MS;
  const socketPath = paths.socket(folders);
  if ((await ask(socketPath, { op: "sessions" }, 2_000)) !== null) throw new Error(`another runner is answering on ${socketPath}`);

  const path = options.path ?? process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  const state = new State(folders);
  const poll = new Poll({
    folders,
    version,
    versionFolder: options.versionFolder,
    tracker: options.tracker,
    harness: options.harness,
    path,
  });
  await state.log(clock(), `runner ${version} started, pid ${process.pid}`);
  const socket = await listenRunnerSocket({ folders, poll, path, clock });

  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let terminated: Promise<void> | null = null;

  // A poll that throws is logged, and the next one runs on time, so one bad poll never stops the runner.
  const tick = async () => {
    try {
      await poll.tick(clock());
    } catch (error) {
      await state.log(clock(), `poll failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  };
  const loop = async () => {
    timer = null;
    if (stopping) return;
    await tick();
    if (!stopping) timer = setTimeout(() => void loop(), intervalMs);
  };
  timer = setTimeout(() => void loop(), 0);

  const terminate = async () => {
    stopping = true;
    if (timer !== null) clearTimeout(timer);
    await state.log(clock(), "SIGTERM: stopping each running session as shutdown");
    // `shutdown` waits for a tick that's running, and revokes the runner's Linear token in each workspace.
    await poll.shutdown(clock());
    await poll.sessionsEnded(SESSIONS_END_MS);
    await options.closeHarness?.();
    await socket.close();
    await state.log(clock(), "runner stopped on SIGTERM");
  };

  return {
    tick,
    terminate: () => (terminated ??= terminate()),
  };
}
