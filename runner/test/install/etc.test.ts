// Install writes etc/ against a temporary root (spec 1, "Folders and files", "Other module tests").
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Folders } from "../../src/folders/index.ts";
import { writeEtc } from "../../src/install/index.ts";

// The retries below wait real seconds: 1, 2, and 4 of them.
setDefaultTimeout(20_000);

const MACHINE_USER = { login: "flight-deck-bot", id: 1, name: "Flight Deck Bot", email: "1+flight-deck-bot@users.noreply.github.com" };

let root: string;
let folders: Folders;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "flight-deck-etc-")));
  folders = { data: join(root, "data"), config: join(root, "config"), sessionRoot: join(root, "session-root"), home: join(root, "home") };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function gitConfig(file: string, key: string): string | null {
  const result = Bun.spawnSync(["git", "config", "--file", file, "--get", key]);
  return result.exitCode === 0 ? result.stdout.toString().replace(/\n$/, "") : null;
}

describe("etc/gitconfig", () => {
  test("holds the machine user's identity, no hooks, no credential helper, and main as the default branch", async () => {
    await writeEtc(folders, MACHINE_USER);
    const file = join(root, "session-root/etc/gitconfig");
    expect(gitConfig(file, "user.name")).toBe("Flight Deck Bot");
    expect(gitConfig(file, "user.email")).toBe("1+flight-deck-bot@users.noreply.github.com");
    expect(gitConfig(file, "core.hooksPath")).toBe("/dev/null");
    expect(gitConfig(file, "credential.helper")).toBe("");
    expect(gitConfig(file, "init.defaultBranch")).toBe("main");
  });

  test("keeps a name with git's comment characters whole", async () => {
    await writeEtc(folders, { ...MACHINE_USER, name: 'Bot #1; "factory"' });
    expect(gitConfig(join(root, "session-root/etc/gitconfig"), "user.name")).toBe('Bot #1; "factory"');
  });

  test("holds no identity before login github writes a machine user", async () => {
    await writeEtc(folders, undefined);
    const file = join(root, "session-root/etc/gitconfig");
    expect(gitConfig(file, "user.name")).toBeNull();
    expect(gitConfig(file, "core.hooksPath")).toBe("/dev/null");
  });
});

describe("etc/npmrc", () => {
  test("names the public registry, turns off fund, audit, and the update notifier, and holds nothing else", async () => {
    await writeEtc(folders, MACHINE_USER);
    expect(await readFile(join(root, "session-root/etc/npmrc"), "utf8")).toBe(
      "registry=https://registry.npmjs.org/\nfund=false\naudit=false\nupdate-notifier=false\n",
    );
  });
});

describe("etc/retry-reset.cjs", () => {
  test("is the running version's data/retry-reset.cjs", async () => {
    await writeEtc(folders, MACHINE_USER);
    const shipped = await Bun.file(new URL("../../../data/retry-reset.cjs", import.meta.url)).text();
    expect(await readFile(join(root, "session-root/etc/retry-reset.cjs"), "utf8")).toBe(shipped);
  });
});

// The script under real Node, loaded through NODE_OPTIONS as a session loads it.
describe("retry-reset.cjs under NODE_OPTIONS", () => {
  const node = Bun.which("node");
  const fixture = new URL("./fixtures/reset-server.cjs", import.meta.url).pathname;
  const script = new URL("../../../data/retry-reset.cjs", import.meta.url).pathname;
  let certs: string;

  interface Run {
    ok: boolean;
    status?: number;
    body?: string;
    url?: string;
    cloneUrl?: string;
    complete?: boolean;
    codes?: string[];
    buffered?: number;
    closed?: boolean;
    ownRequest?: boolean;
    arrivals: number[];
    tokens: boolean[];
    abortedAt?: number;
    ended: number;
  }

  beforeAll(async () => {
    if (node === null) throw new Error("these tests need node on PATH");
    certs = await mkdtemp(join(tmpdir(), "flight-deck-certs-"));
    const keys = ["-keyout", join(certs, "key.pem"), "-out", join(certs, "cert.pem")];
    const made = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-days", "1", ...keys]);
    if (made.exitCode !== 0) throw new Error(made.stderr.toString());
  });

  afterAll(async () => {
    await rm(certs, { recursive: true, force: true });
  });

  type Client = "fetch" | "request" | "get" | "header" | "cancel" | "destroy-response" | "cancel-body" | "paused" | "body" | "timeout" | "abort";
  type Served = "etag" | "date" | "none" | "changed";

  async function run(client: Client, method: string, where: "body" | "head" | "large" | "stall", cuts: number, options: { load?: boolean; served?: Served } = {}): Promise<Run> {
    const args = [client, method, where, String(cuts), options.served ?? "etag"];
    const proc = Bun.spawn([node!, fixture, join(certs, "key.pem"), join(certs, "cert.pem"), ...args], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        NODE_NO_WARNINGS: "1",
        ...(options.load === false ? {} : { NODE_OPTIONS: `--require ${script}` }),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (out === "") throw new Error(err);
    return JSON.parse(out) as Run;
  }

  /** The gaps between request arrivals, rounded to the second. */
  const gaps = (arrivals: number[]) => arrivals.slice(1).map((at, i) => Math.round((at - arrivals[i]!) / 1000));

  test("without the script, a cut response fails with ECONNRESET", async () => {
    const [fetched, requested] = await Promise.all([run("fetch", "GET", "body", 1, { load: false }), run("request", "GET", "body", 1, { load: false })]);
    expect(fetched).toMatchObject({ ok: false, arrivals: [expect.any(Number)] });
    expect(fetched.codes).toContain("ECONNRESET");
    expect(requested).toMatchObject({ ok: false, codes: ["ECONNRESET"] });
  });

  test("a GET cut short after part of its body is retried after 1 second, and the caller gets the whole body once", async () => {
    const runs = await Promise.all([run("fetch", "GET", "body", 1), run("request", "GET", "body", 1), run("get", "GET", "body", 1)]);
    for (const each of runs) {
      expect(each).toMatchObject({ ok: true, status: 200, body: "0123456789" });
      expect(gaps(each.arrivals)).toEqual([1]);
    }
    expect(runs[0]!.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/font\.woff2$/);
    expect(runs[0]!.cloneUrl).toBe(runs[0]!.url);
    expect(runs[1]!.complete).toBe(true);
    expect(runs[1]!.ownRequest).toBe(true);
  });

  test("with no ETag, a retry continues the body when Last-Modified and Content-Length match", async () => {
    const runs = await Promise.all([run("fetch", "GET", "body", 1, { served: "date" }), run("request", "GET", "body", 1, { served: "date" })]);
    for (const each of runs) expect(each).toMatchObject({ ok: true, status: 200, body: "0123456789" });
  });

  test("a retry that answers with a different body, or with nothing to show it's the same, fails with the reset", async () => {
    const runs = await Promise.all([
      run("fetch", "GET", "body", 1, { served: "changed" }),
      run("request", "GET", "body", 1, { served: "changed" }),
      run("fetch", "GET", "body", 1, { served: "none" }),
      run("request", "GET", "body", 1, { served: "none" }),
    ]);
    for (const each of runs) {
      expect(each.ok).toBe(false);
      expect(each.codes).toContain("ECONNRESET");
      expect(each.arrivals).toHaveLength(2);
    }
  });

  test("a retry sends the headers the caller set after https.request()", async () => {
    expect(await run("header", "GET", "body", 1)).toMatchObject({ ok: true, body: "0123456789", tokens: [true, true] });
  });

  test("destroying the request or its response while a retry waits stops the retry and closes the request", async () => {
    const runs = await Promise.all([run("cancel", "GET", "body", 1), run("destroy-response", "GET", "body", 1)]);
    for (const each of runs) expect(each).toMatchObject({ ok: true, closed: true, arrivals: [expect.any(Number)] });
  });

  test("aborting a fetch while a retry waits rejects at once with the abort", async () => {
    const runs = await Promise.all([run("abort", "GET", "head", 1), run("abort", "GET", "body", 1)]);
    for (const each of runs) {
      expect(each).toMatchObject({ ok: false, codes: ["AbortError"], arrivals: [expect.any(Number)] });
      // The rest of the 1 second wait would be 650 ms.
      expect(each.ended - each.abortedAt!).toBeLessThan(400);
    }
  });

  test("canceling a fetch body while a retry waits stops the retry", async () => {
    expect(await run("cancel-body", "GET", "body", 1)).toMatchObject({ ok: true, status: 200, arrivals: [expect.any(Number)] });
  });

  test("a response nobody reads stops reading from the server once its buffer fills", async () => {
    const paused = await run("paused", "GET", "large", 0);
    expect(paused).toMatchObject({ ok: true, status: 200 });
    expect(paused.buffered).toBeLessThan(256 * 1024);
  });

  test("a GET reset before any answer, and a HEAD, are retried too", async () => {
    const runs = await Promise.all([run("fetch", "GET", "head", 2), run("request", "GET", "head", 2), run("fetch", "HEAD", "head", 1), run("request", "HEAD", "head", 1)]);
    expect(runs.map((each) => [each.ok, each.body, gaps(each.arrivals)])).toEqual([
      [true, "0123456789", [1, 2]],
      [true, "0123456789", [1, 2]],
      [true, "", [1]],
      [true, "", [1]],
    ]);
  });

  test("it retries 3 times, 1, 2, and 4 seconds apart, then fails with the reset", async () => {
    const runs = await Promise.all([run("fetch", "GET", "body", 4), run("request", "GET", "body", 4), run("fetch", "GET", "head", 4), run("request", "GET", "head", 4)]);
    for (const each of runs) {
      expect(each.ok).toBe(false);
      expect(each.codes).toContain("ECONNRESET");
      expect(gaps(each.arrivals)).toEqual([1, 2, 4]);
    }
  });

  test("a GET that sends a body isn't retried", async () => {
    expect(await run("body", "GET", "head", 1)).toMatchObject({ ok: false, codes: ["ECONNRESET"], arrivals: [expect.any(Number)] });
  });

  test("a retry keeps the caller's timeout, and its timeout reaches the caller", async () => {
    expect(await run("timeout", "GET", "stall", 1)).toMatchObject({ ok: false, codes: ["ETIMEDOUT"], arrivals: [expect.any(Number), expect.any(Number)] });
  });

  test("a POST cut short isn't retried", async () => {
    const runs = await Promise.all([run("fetch", "POST", "body", 1), run("request", "POST", "body", 1), run("request", "POST", "head", 1)]);
    for (const each of runs) {
      expect(each.ok).toBe(false);
      expect(each.codes).toContain("ECONNRESET");
      expect(each.arrivals).toHaveLength(1);
    }
  });

  test("an answer that isn't cut short passes through untouched", async () => {
    const runs = await Promise.all([run("fetch", "GET", "body", 0), run("request", "GET", "body", 0), run("request", "POST", "body", 0)]);
    for (const each of runs) expect(each).toMatchObject({ ok: true, status: 200, body: "0123456789", arrivals: [expect.any(Number)] });
  });
});
