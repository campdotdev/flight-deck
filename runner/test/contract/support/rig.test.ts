// The contract rig answers a session's `headersHelper` the way the runner does: the helper in `mcp.json` asks
// `runner.sock` for the session's Reader token and prints the `Authorization` header. A real rig does this with
// the Linear adapter; this test does it with the in-memory one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { InMemoryTracker, type TrackerRepo } from "../../../src/tracker/index.ts";
import { shadersStatuses } from "./linear.ts";
import { Rig } from "./rig.ts";

const repo: TrackerRepo = { name: "campdotdev/shaders", workspace: "campdotdev", team: "SHA", statuses: shadersStatuses(), maintainer: "maintainer" };

/** Runs a shell command without blocking, because the rig's socket answers in this process. */
async function sh(command: string, env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["/bin/sh", "-c", command], { ...(env === undefined ? {} : { env }), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

describe("the contract rig", () => {
  let rig: Rig;
  const tracker = new InMemoryTracker({ clock: () => new Date("2026-11-10T09:00:00Z"), appUser: "app-user" });

  beforeAll(async () => {
    rig = await Rig.open({ real: false, linear: { tracker, repo } });
  });
  afterAll(async () => {
    await rig.close();
  });

  test("a session's headersHelper prints the Reader token the rig mints for it", async () => {
    const { id, session } = await rig.prepare({ files: { "README.md": "A scratch repo.\n" } });
    const helper = session.launch.mcp.mcpServers.linear!.headersHelper;
    expect(helper).toBe(`${rig.versionFolder}/bin/flight-deck linear-token ${id}`);
    const run = await sh(helper, session.launch.environment);
    expect(run.stderr).toBe("");
    const token = tracker.tokens.find((record) => record.session === id)?.token;
    expect(JSON.parse(run.stdout)).toEqual({ Authorization: `Bearer ${token}` });
    expect(rig.requests).toEqual([{ op: "linear_token", session: id }]);
  });

  test("the rig answers no session it didn't prepare", async () => {
    const run = await sh(`${rig.versionFolder}/bin/flight-deck linear-token zzzzzz`);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("The runner gave no Linear token");
  });

  test("a session gets the probe record's one host, with the plan prompt unless a test gives its own", async () => {
    const plain = await rig.prepare({ files: { "README.md": "A scratch repo.\n" } });
    expect(plain.session.launch.settings.sandbox.network.allowedDomains).toEqual(["registry.npmjs.org"]);
    expect(plain.session.launch.args.slice(0, 2)).toEqual(["-p", `/flight-deck:flight-plan ${plain.session.issue}`]);
    const own = await rig.prepare({ files: { "README.md": "A scratch repo.\n" }, prompt: () => "Say hello.", args: ["--max-budget-usd", "0.01"], environment: { EXTRA: "1" } });
    expect(own.session.launch.args[1]).toBe("Say hello.");
    expect(own.session.launch.args.slice(-2)).toEqual(["--max-budget-usd", "0.01"]);
    expect(own.session.launch.environment.EXTRA).toBe("1");
  });
});
