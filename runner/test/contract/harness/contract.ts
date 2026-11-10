// The Harness contract suite (spec 1, "Suites"): one set of assertions that a scripted session and a real
// `claude -p` session both pass, through the Harness port. A session starts from its launch, writes its outbox,
// and ends with one exit that names its transcript and the Claude Code version, with `exit.json` written as it
// ends. A stop ends it with `stopped`. Each `rate_limit_event` it reports has the fields the runner reads.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sessionParts } from "../../../src/folders/index.ts";
import { transcriptUuid, type Exit, type Harness, type HarnessSession, type RateLimitEvent } from "../../../src/harness/index.ts";
import { CLAUDE_CODE } from "../../../src/harness/stream.ts";

/** One adapter, as the contract suite drives it. */
export interface HarnessWorld {
  harness: Harness;
  /** A session that writes `text` to its outbox's `summary.md`, then ends on its own. */
  writes(text: string): Promise<HarnessSession>;
  /** A session that runs until it's stopped. */
  waits(): Promise<HarnessSession>;
  /** Resolves once the session runs: once its `init` event arrives, for a real one. */
  running(session: HarnessSession): Promise<void>;
  close(): Promise<void>;
}

/** What a started session reported. */
export interface Run {
  session: HarnessSession;
  exit: Promise<Exit>;
  rateLimits: RateLimitEvent[];
  warnings: string[];
}

export async function startRun(harness: Harness, session: HarnessSession): Promise<Run & { handle: Awaited<ReturnType<Harness["start"]>> }> {
  const rateLimits: RateLimitEvent[] = [];
  const warnings: string[] = [];
  let ended: (exit: Exit) => void = () => {};
  const exit = new Promise<Exit>((resolve) => (ended = resolve));
  const handle = await harness.start(session, { exit: (each) => ended(each), rateLimit: (event) => rateLimits.push(event), loginExpiring: (text) => warnings.push(text) });
  return { session, exit, rateLimits, warnings, handle };
}

export function harnessContract(name: string, open: () => Promise<HarnessWorld>, options: { skip?: boolean; timeout?: number } = {}): void {
  const timeout = options.timeout ?? 30_000;

  describe.skipIf(options.skip === true)(`the Harness contract, against ${name}`, () => {
    let world: HarnessWorld;

    beforeAll(async () => {
      world = await open();
    }, timeout);

    afterAll(async () => {
      await world?.close();
    }, timeout);

    test(
      "version is a Claude Code version no older than min_version",
      async () => {
        const version = await world.harness.version();
        expect(version).toMatch(/^\d+\.\d+\.\d+/);
        expect(Bun.semver.order(version.replace(/[^\d.].*$/, ""), CLAUDE_CODE.minVersion)).toBeGreaterThanOrEqual(0);
      },
      timeout,
    );

    test(
      "a session starts from its launch, writes its outbox, and exits naming its transcript and the version",
      async () => {
        const text = `The contract suite's session ran (${Date.now()}).`;
        const session = await world.writes(text);
        const run = await startRun(world.harness, session);
        expect(run.handle).toMatchObject({ session: session.id, uuid: session.launch.uuid });
        expect(run.handle.pid).toBeGreaterThan(0);
        expect(Date.parse(run.handle.pidStartedAt)).not.toBeNaN();
        const parts = sessionParts(session.sessionFolder);
        expect(JSON.parse(await readFile(parts.settingsJson, "utf8"))).toEqual(session.launch.settings);
        expect(JSON.parse(await readFile(parts.mcpJson, "utf8"))).toEqual(session.launch.mcp);
        expect(await readFile(transcriptUuid(session.transcript), "utf8")).toBe(`${session.launch.uuid}\n`);

        const exit = await run.exit;
        expect(exit).toMatchObject({ kind: "exited", code: 0, transcript: session.transcript, claudeCodeVersion: await world.harness.version() });
        expect(typeof exit.costUsd).toBe("number");
        expect(JSON.parse(readFileSync(join(session.sessionFolder, "exit.json"), "utf8"))).toMatchObject({ kind: "exited", code: 0, transcript: session.transcript });
        expect(existsSync(session.transcript)).toBe(true);
        expect((await readFile(join(parts.outbox, "summary.md"), "utf8")).trim()).toBe(text);

        for (const event of run.rateLimits) {
          expect(["allowed", "allowed_warning", "rejected"]).toContain(event.status);
          for (const window of Object.values(event.windows)) {
            if (window.utilization !== null) expect(window.utilization).toBeWithin(0, 1.0001);
            if (window.resetsAt !== null) expect(Date.parse(window.resetsAt)).not.toBeNaN();
          }
        }
      },
      timeout,
    );

    test(
      "stop ends a running session with stopped",
      async () => {
        const session = await world.waits();
        const run = await startRun(world.harness, session);
        await world.running(session);
        const asked = Date.now();
        await world.harness.stop(run.handle);
        const exit = await run.exit;
        expect(exit).toMatchObject({ kind: "stopped", transcript: session.transcript });
        // SIGTERM, then SIGKILL 10 seconds later (ADR 0007).
        expect(Date.now() - asked).toBeLessThan(15_000);
        expect(JSON.parse(readFileSync(join(session.sessionFolder, "exit.json"), "utf8"))).toMatchObject({ kind: "stopped" });
      },
      timeout,
    );
  });
}
