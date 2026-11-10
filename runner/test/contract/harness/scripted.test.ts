// The Harness contract suite's scripted half. It runs in CI, so the scripted adapter passes the same assertions
// that a real `claude -p` session does when the maintainer runs the real half (`claude-code.test.ts`).
import { ScriptedHarness, Stream } from "../../../src/harness/index.ts";
import { CLAUDE_CODE } from "../../../src/harness/stream.ts";
import { fixture } from "../../harness/fixtures.ts";
import { Rig } from "../support/rig.ts";
import { harnessContract } from "./contract.ts";

harnessContract("the scripted adapter", async () => {
  const rig = await Rig.open({ real: false });
  const harness = new ScriptedHarness();
  const [allowed] = new Stream(CLAUDE_CODE).line(fixture("rate-limit-event.allowed.json"));
  if (allowed?.kind !== "rate_limit") throw new Error("the allowed rate_limit_event fixture doesn't parse");
  return {
    harness,
    async writes(text) {
      const { session } = await rig.prepare({ files: { "README.md": "A scratch repo.\n" } });
      harness.script(session.issue, { outbox: { "summary.md": `${text}\n` }, rateLimits: [allowed.event], exit: { kind: "exited", code: 0 }, costUsd: 0.01 });
      return session;
    },
    async waits() {
      return (await rig.prepare({ files: { "README.md": "A scratch repo.\n" } })).session;
    },
    async running() {},
    close: () => rig.close(),
  };
});
