// `runner.sock`'s wire form (spec 1, "The runner's socket"): a Unix socket with mode `0600`, where each request
// is one line of JSON and each reply is one line of JSON, `{ "ok": true, ... }` or `{ "ok": false, "error" }`.
// This file knows the lines and the socket, not the ops: the runner's answers are in `../runner/socket.ts`.
import { chmod, mkdir, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

export type Request = { op: string } & Record<string, unknown>;
export type Reply = ({ ok: true } & Record<string, unknown>) | { ok: false; error: string };

export interface Listening {
  /** Stops listening, ends every open connection, and removes the socket file. */
  close(): Promise<void>;
}

/**
 * Listens on `path` with mode `0600`, replacing a socket file a dead runner left. Each line a client sends is
 * one request, and `answer` makes its reply. A line that isn't a JSON object with an `op` gets an error reply.
 */
export async function listen(path: string, answer: (request: Request) => Promise<Reply>): Promise<Listening> {
  await mkdir(dirname(path), { recursive: true });
  await rm(path, { force: true });
  const open = new Set<Socket>();
  const server = createServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    socket.on("error", () => {});
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      let end: number;
      while ((end = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        void replyTo(line, answer).then((reply) => {
          if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
        });
      }
    });
  });
  // No one else may connect between the bind and the chmod.
  const umask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => resolve());
    });
  } finally {
    process.umask(umask);
  }
  await chmod(path, 0o600);
  return {
    close: async () => {
      for (const socket of open) socket.destroy();
      await closeServer(server);
      await rm(path, { force: true });
    },
  };
}

async function replyTo(line: string, answer: (request: Request) => Promise<Reply>): Promise<Reply> {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    return { ok: false, error: "the request isn't one line of JSON" };
  }
  if (typeof request !== "object" || request === null || Array.isArray(request) || typeof (request as Request).op !== "string") {
    return { ok: false, error: "the request is a JSON object with an op" };
  }
  try {
    return await answer(request as Request);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Sends one request and waits up to `timeoutMs` for its reply. Returns `null` when the runner doesn't answer:
 * nothing listens on the socket, the connection fails, or no reply line comes in time.
 */
export function ask(path: string, request: Request, timeoutMs: number): Promise<Reply | null> {
  return new Promise((resolve) => {
    let settled = false;
    let buffered = "";
    const socket = createConnection(path);
    const done = (reply: Reply | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("error", () => done(null));
    socket.on("close", () => done(null));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      const end = buffered.indexOf("\n");
      if (end === -1) return;
      try {
        done(JSON.parse(buffered.slice(0, end)) as Reply);
      } catch {
        done(null);
      }
    });
  });
}
