// The programs install, `login github`, and `update` run at the maintainer's terminal: `launchctl`, `gh`,
// `claude`, and `open` (spec 1, "Install"). They run once, outside the runner, so they stay outside the test seam
// and are checked by hand (spec 1, "The seam"). Tests replace this `Shell` with one that records each call and
// answers from a script, so no test signs in, loads an agent, or registers a plugin.

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** The whole environment the program gets. The command's own environment when left out. */
  env?: Record<string, string | undefined>;
  /** What the program reads on stdin, such as a token for `gh auth login --with-token`. */
  input?: string;
}

export interface Shell {
  /** Runs a program and waits for it to end. A program that can't start ends with code 127. */
  run(argv: string[], options?: RunOptions): Promise<RunResult>;
  /** Opens a page in the maintainer's browser. */
  open(url: string): Promise<void>;
  /** Waits, as install does between its reads of `status.json`. */
  sleep(ms: number): Promise<void>;
  /** The maintainer's user ID, for launchd's `gui/<uid>` domain. */
  uid: number;
}

/** The Mac's own programs. */
export const MAC_SHELL: Shell = {
  async run(argv, options = {}) {
    try {
      const proc = Bun.spawn(argv, {
        env: (options.env ?? process.env) as Record<string, string>,
        stdin: options.input === undefined ? "ignore" : new TextEncoder().encode(options.input),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code, stdout, stderr };
    } catch (error) {
      return { code: 127, stdout: "", stderr: `${argv[0]}: ${error instanceof Error ? error.message : String(error)}` };
    }
  },
  async open(url) {
    await MAC_SHELL.run(["/usr/bin/open", url]);
  },
  sleep: (ms) => Bun.sleep(ms),
  uid: process.getuid?.() ?? 0,
};
