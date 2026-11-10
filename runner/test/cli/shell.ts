// A stand-in for the programs install, `login github`, and `update` run. It records each call and answers from a
// script, so no test runs `launchctl`, `gh`, `claude`, or `open` (spec 1, "The seam").
import type { RunOptions, RunResult, Shell } from "../../src/cli/shell.ts";

export interface Call {
  argv: string[];
  env?: Record<string, string | undefined>;
  input?: string;
}

type Reply = Partial<RunResult> | ((call: Call) => Partial<RunResult> | Promise<Partial<RunResult>>);

export class FakeShell implements Shell {
  readonly calls: Call[] = [];
  readonly opened: string[] = [];
  uid = 501;
  /** Called at each `sleep`, so a test can move its clock. */
  onSleep: (ms: number) => void | Promise<void> = () => {};
  private readonly replies: { prefix: string[]; reply: Reply }[] = [];

  /** Answers every call whose argv starts with `prefix`. A later answer for the same calls wins. */
  on(prefix: string[], reply: Reply): this {
    this.replies.unshift({ prefix, reply });
    return this;
  }

  async run(argv: string[], options: RunOptions = {}): Promise<RunResult> {
    const call: Call = { argv, ...(options.env === undefined ? {} : { env: options.env }), ...(options.input === undefined ? {} : { input: options.input }) };
    this.calls.push(call);
    const found = this.replies.find(({ prefix }) => prefix.every((part, i) => argv[i] === part));
    if (found === undefined) throw new Error(`the test scripted no answer for ${argv.join(" ")}`);
    const reply = typeof found.reply === "function" ? await found.reply(call) : found.reply;
    return { code: 0, stdout: "", stderr: "", ...reply };
  }

  async open(url: string): Promise<void> {
    this.opened.push(url);
  }

  /** Moves the test's clock through `onSleep`, and yields for a millisecond so a waiting loop can't spin. */
  async sleep(ms: number): Promise<void> {
    await this.onSleep(ms);
    await Bun.sleep(1);
  }

  /** Each call's argv, joined, for an assertion on the order. */
  get commands(): string[] {
    return this.calls.map((call) => call.argv.join(" "));
  }
}
