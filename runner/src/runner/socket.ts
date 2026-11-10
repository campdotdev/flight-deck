// The runner's answers on `runner.sock` (spec 1, "The runner's socket"). Each op calls the Poll, which runs
// `hold`, `start`, and `stop` in its serial queue, so a request that comes in while a tick runs waits for it.
import { paths, type Folders } from "../folders/index.ts";
import type { Poll } from "../poll/index.ts";
import { listen, type Reply, type Request } from "../socket/index.ts";

export interface RunnerSocketOptions {
  folders: Folders;
  poll: Poll;
  clock: () => Date;
}

export interface RunnerSocket {
  close(): Promise<void>;
}

/** Listens on `state/runner.sock` and answers every op spec 1 lists. */
export async function listenRunnerSocket(options: RunnerSocketOptions): Promise<RunnerSocket> {
  return listen(paths.socket(options.folders), (request) => answer(options, request));
}

async function answer({ poll, clock }: RunnerSocketOptions, request: Request): Promise<Reply> {
  switch (request.op) {
    case "hold":
      // `flight-deck update` holds with the cause `update`. The maintainer's hold has no cause.
      if (request.cause === "update") await poll.holdForUpdate(clock());
      else if (request.cause === undefined) await poll.hold(clock());
      else return { ok: false, error: 'hold takes no cause but "update"' };
      return { ok: true };
    case "release":
      if (request.cause !== "update") return { ok: false, error: 'only flight-deck update releases a hold, with cause "update"' };
      await poll.releaseUpdate(clock());
      return { ok: true };
    case "start":
      await poll.start(clock());
      return { ok: true };
    case "stop":
      await poll.stop(clock());
      return { ok: true };
    case "linear_token": {
      if (typeof request.session !== "string") return { ok: false, error: "linear_token needs a session" };
      return { ok: true, token: await poll.linearToken(request.session) };
    }
    case "sessions":
      return { ok: true, sessions: await poll.sessions() };
    case "trial":
      // It returns once the trial ends, which takes ticks, so it doesn't wait in the Poll's queue.
      return { ok: true, ...(await poll.trial()) };
    case "notify": {
      if (typeof request.text !== "string") return { ok: false, error: "notify needs a text" };
      return poll.notify(request.text);
    }
    case "issue_memory": {
      const { repo, issue, write } = request;
      if (typeof repo !== "string" || typeof issue !== "string") return { ok: false, error: "issue_memory needs a repo and an issue" };
      if (typeof write !== "object" || write === null || Array.isArray(write)) return { ok: false, error: "issue_memory needs a write object" };
      await poll.writeIssueMemory(repo, issue, write);
      return { ok: true };
    }
    default:
      return { ok: false, error: `the runner has no op ${JSON.stringify(request.op)}` };
  }
}
