// Each session's port (spec 1's "Workspace" and "Starts", ADR 0003). A session of a repo with an app gets a port
// of its own. A single-instance app always runs on its `default_port`, which Poll tests before each take. Both
// use one in-use test, `portInUse`.
import { connect, createServer } from "node:net";
import type { RepoRecord } from "../record/index.ts";

/** The ports a session of an app that can run more than once may get. */
export const SESSION_PORTS = { from: 4400, to: 4999 } as const;

type App = NonNullable<RepoRecord["app"]>;

/**
 * The session's port: `default_port` for a single-instance app, which "Starts" has already tested. Otherwise the
 * lowest port in 4400 to 4999 that no listed session holds and that `portInUse` finds free. Throws when none is
 * free, or when a listed session holds the single-instance app's port, which fails `prepare`.
 */
export async function sessionPort(app: App, held: ReadonlySet<number>): Promise<number> {
  if (app.single_instance) {
    if (held.has(app.default_port)) throw new Error(`another session holds the app's port ${app.default_port}`);
    return app.default_port;
  }
  for (let port = SESSION_PORTS.from; port <= SESSION_PORTS.to; port++) {
    if (!held.has(port) && !(await portInUse(port))) return port;
  }
  throw new Error(`no port in ${SESSION_PORTS.from} to ${SESSION_PORTS.to} is free for the app`);
}

/** The app's URL on the session's port: the record's `url` with `{port}` filled in. */
export function appUrl(app: App, port: number): string {
  return app.url.replaceAll("{port}", String(port));
}

/**
 * Whether something already uses a port: a bind on `0.0.0.0` or `::` fails, or a connect to
 * `127.0.0.1` or `::1` succeeds, because a dev server may listen on any of them (spec 1's "Starts", ADR 0003).
 * The connects matter on macOS, where a bind on a wildcard address succeeds beside a listener on a loopback one.
 */
export async function portInUse(port: number): Promise<boolean> {
  // One at a time, so a connect never reaches the test's own bind.
  if (!(await binds("0.0.0.0", port)) || !(await binds("::", port))) return true;
  return (await connects("127.0.0.1", port)) || (await connects("::1", port));
}

/** Whether a listener can bind `host` and `port` now. It closes at once. */
function binds(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host, port, ipv6Only: host.includes(":") }, () => server.close(() => resolve(true)));
  });
}

/** Whether a connect to `host` and `port` succeeds within a second. */
function connects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
