// The instructions probe (spec 1, "Toolchain", ADR 0007): what of the repo's instructions reaches a session. Its
// throwaway repo has a root `CLAUDE.md` that imports a file inside the worktree, `../outside.md`, and a file under
// `~`; a `.claude/CLAUDE.md`; a rule with no `paths` and one with `paths`; a subfolder's `CLAUDE.md`; a root
// `AGENTS.md`; a skill; a subagent; and settings whose `env` sets a variable. A `CLAUDE.md` sits in the folder
// above the worktree. Each file holds its own canary.
//
// The Harness check runs in CI: `--append-system-prompt-file` names `AGENTS.md` when no `CLAUDE.md` imports it, and
// not when one does. The real session runs only with `FLIGHT_DECK_CONTRACT=instructions` (or `1`), over
// `--input-format stream-json` with three messages, each sent once the last one's `result` arrives. A failure means
// Claude Code changed, and goes to the maintainer as a Claude Code change.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../../src/folders/index.ts";
import { writeLaunch, type HarnessSession } from "../../../src/harness/index.ts";
import { runs } from "../support/gate.ts";
import { openLinear, type RealLinear } from "../support/linear.ts";
import { Rig, until, which, type RigSession } from "../support/rig.ts";
import * as T from "../support/transcript.ts";
import { claudeMdAboveWorktrees, runToken } from "./above.ts";
import { canariesIn, canary, homeFile, instructionsRepo, NEVER, REACH, VARIABLE, type Canary } from "./instructions.ts";

const RUNS = runs("instructions");
const MESSAGE_MS = 5 * 60_000;

describe("the Harness appends AGENTS.md only when no CLAUDE.md imports it", () => {
  let rig: Rig;
  beforeAll(async () => {
    rig = await Rig.open({ real: false });
  });
  afterAll(async () => {
    await rig.close();
  });

  test("the probe's repo, which doesn't import AGENTS.md, gets --append-system-prompt-file", async () => {
    const { session } = await rig.prepare({ files: instructionsRepo("CI") });
    const at = session.launch.args.indexOf("--append-system-prompt-file");
    expect(at).toBeGreaterThan(-1);
    expect(session.launch.args[at + 1]).toBe(join(session.worktree, "AGENTS.md"));
    expect(session.launch.agentsMd).toBe(join(session.worktree, "AGENTS.md"));
  });

  test("the same repo with @AGENTS.md in its root CLAUDE.md gets none", async () => {
    const { session } = await rig.prepare({ files: instructionsRepo("CI", { importsAgentsMd: true }) });
    expect(session.launch.args).not.toContain("--append-system-prompt-file");
    expect(session.launch.agentsMd).toBeNull();
  });
});

describe.skipIf(!RUNS)("the instructions probe", () => {
  const token = runToken();
  let linear: RealLinear;
  let rig: Rig;
  let made: RigSession;
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    linear = await openLinear();
    rig = await Rig.open({ real: true, claude: process.env.FLIGHT_DECK_CLAUDE ?? which("claude"), linear: { tracker: linear.runner, repo: linear.repo } });
    const above = await claudeMdAboveWorktrees(rig.folders, `${canary("ABOVE", token)}\n`);
    cleanups.push(above.remove);
    const outside = join(paths.worktrees(rig.folders), "outside.md");
    if (existsSync(outside)) throw new Error(`${outside} exists already. Read it, remove it, then run the probe again.`);
    await writeFile(outside, `${canary("OUTSIDE", token)}\n`);
    cleanups.push(() => rm(outside, { force: true }));
    const home = join(rig.folders.home, homeFile(token));
    await writeFile(home, `${canary("HOME", token)}\n`);
    cleanups.push(() => rm(home, { force: true }));
    made = await rig.prepare({ files: instructionsRepo(token) });
  }, 120_000);

  afterAll(async () => {
    for (const cleanup of cleanups) await cleanup();
    await rig?.close();
    await linear?.runner.revokeRunnerToken(linear.repo.workspace);
  }, 120_000);

  test(
    "the root CLAUDE.md files, the imported file, the unscoped rule, and AGENTS.md reach the session, before and after a compaction, and nothing else does",
    async () => {
      const { session } = made;
      expect(session.launch.args).toContain("--append-system-prompt-file");
      const notes = join(session.worktree, "sub", "notes.txt");
      const list = "List every line that starts with CANARY- in your instructions or your context, exactly as written, one per line, and nothing else. If there are none, say none.";
      const segments = await converse(rig, session, [
        `This is Flight Deck's instructions probe. Do these steps in order.\n\n1. Read ${notes} with the Read tool.\n2. Start one subagent with the Agent tool. Give it this task, word for word: "${list}"\n3. Run \`echo "${VARIABLE}=[$${VARIABLE}]"\` with the Bash tool.\n4. ${list}`,
        "/compact",
        list,
      ]);

      const problems: string[] = [];
      const first = T.init(segments.flat());
      for (const name of ["probe-skill", "probe-agent"]) {
        for (const field of ["skills", "agents", "slash_commands"]) if (((first?.[field] ?? []) as string[]).some((each) => each.includes(name))) problems.push(`the init event's ${field} lists ${name}`);
      }
      if (!segments[1]!.some((event) => event.type === "system" && event.subtype === "compact_boundary")) problems.push("/compact didn't end in a compact_boundary event");

      const answers: [string, string, Canary[]][] = [
        ["the first answer", T.said(segments[0]!, { subagents: false }), [...REACH]],
        ["the subagent's answer", subagentAnswer(segments[0]!), REACH.filter((name) => name !== "AGENTS")],
        ["the third answer", T.said(segments[2]!, { subagents: false }), [...REACH]],
      ];
      for (const [label, text, expected] of answers) {
        const seen = canariesIn(text, token);
        for (const name of expected) if (!seen.includes(name)) problems.push(`${label} lacks ${canary(name, token)}`);
        for (const name of seen) if (!expected.includes(name)) problems.push(`${label} holds ${canary(name, token)}`);
      }
      const echo = variableEcho(segments[0]!);
      if (echo === null) problems.push(`the session didn't print ${VARIABLE}`);
      else if (!echo.includes(`${VARIABLE}=[]`)) problems.push(`${VARIABLE} isn't empty: ${echo.trim()}`);
      // The variable's value shows in the transcript only through the echo, which the check above reads.
      const transcript = T.everything(segments.flat());
      for (const name of NEVER) if (name !== "SETTINGS" && transcript.includes(canary(name, token))) problems.push(`the transcript holds ${canary(name, token)}`);

      if (problems.length > 0) console.log(`Claude Code changed what reaches a session. Take this to the maintainer as a Claude Code change (transcript: ${session.transcript}):\n  ${problems.join("\n  ")}`);
      expect(problems).toEqual([]);
    },
    4 * MESSAGE_MS,
  );
});

/**
 * Starts the session over `--input-format stream-json` and sends each message once the last one's `result`
 * arrives. Returns the events from each message to its `result`. The transcript goes where the adapter writes it.
 */
async function converse(rig: Rig, session: HarnessSession, messages: string[]): Promise<T.Event[][]> {
  await writeLaunch(session.launch);
  await mkdir(join(session.transcript, ".."), { recursive: true });
  // `-p` reads the messages from stdin, so the prompt argument goes.
  const args = ["-p", ...session.launch.args.slice(2), "--input-format", "stream-json"];
  const child = Bun.spawn([rig.claude, ...args], { cwd: session.worktree, env: session.launch.environment, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const all: T.Event[] = [];
  const raw: string[] = [];
  void (async () => {
    let buffer = "";
    for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
      buffer += new TextDecoder().decode(chunk);
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        raw.push(line);
        try {
          all.push(JSON.parse(line) as T.Event);
        } catch {}
      }
    }
  })();
  const segments: T.Event[][] = [];
  try {
    for (const message of messages) {
      // The first segment starts at the session's first event, so it holds the init event.
      const from = segments.length === 0 ? 0 : all.length;
      const resultsBefore = all.filter((event) => event.type === "result").length;
      child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: message }] } })}\n`);
      await until(`the result for "${message.slice(0, 40)}"`, () => all.filter((event) => event.type === "result").length > resultsBefore, MESSAGE_MS, 500);
      segments.push(all.slice(from));
    }
  } finally {
    child.stdin.end();
    const ended = await Promise.race([child.exited.then(() => true), Bun.sleep(30_000).then(() => false)]);
    if (!ended) child.kill("SIGKILL");
    await writeFile(session.transcript, `${raw.join("\n")}\n`);
  }
  return segments;
}

/** What the subagent the first message started answered: the Agent tool's result. */
function subagentAnswer(events: T.Event[]): string {
  const agent = T.toolUses(events).find((use) => (use.name === "Agent" || use.name === "Task") && use.parent === null);
  if (agent === undefined) return "";
  return T.toolResults(events).find((result) => result.id === agent.id)?.text ?? "";
}

/** The output of the Bash call that printed the variable. */
function variableEcho(events: T.Event[]): string | null {
  const echo = T.toolUses(events).find((use) => use.name === "Bash" && String(use.input.command ?? "").includes(VARIABLE));
  if (echo === undefined) return null;
  return T.toolResults(events).find((result) => result.id === echo.id)?.text ?? null;
}
