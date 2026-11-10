// The hidden prompt (spec 1, "Install"): every command that reads a secret reads it here, with echo off, so no
// terminal transcript holds one. At a terminal it reads in raw mode and echoes nothing but the line break that
// ends the answer. From a pipe it reads one line per prompt, so a script can feed it.

export interface Prompt {
  /** Asks the question and reads one answer that nobody sees as it's typed. Throws "Canceled." at Ctrl-C or end of input. */
  secret(question: string): Promise<string>;
}

/** What the prompt reads: stdin, or a stand-in stream in tests. */
export interface PromptInput {
  isTTY?: boolean;
  setRawMode?(on: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export class Canceled extends Error {
  constructor() {
    super("Canceled.");
    this.name = "Canceled";
  }
}

const ENTER = new Set(["\r", "\n"]);
const ERASE = new Set(["\x7f", "\b"]);
const CANCEL = new Set(["\x03", "\x04"]);

/** The prompt over a stream. The question and the line break go to `output`, which is stderr on the Mac. */
export function hiddenPrompt(input: PromptInput, output: { write(text: string): unknown }): Prompt {
  // What arrived after the last answer's line break, such as the next lines of piped input.
  let pending = "";
  let ended = false;
  let waiting: (() => void) | null = null;
  let listening = false;
  const wake = () => {
    const next = waiting;
    waiting = null;
    next?.();
  };
  const listen = () => {
    if (listening) return;
    listening = true;
    input.on("data", (chunk) => {
      pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      wake();
    });
    input.on("end", () => {
      ended = true;
      wake();
    });
  };

  return {
    async secret(question) {
      output.write(`${question}: `);
      const raw = input.isTTY === true && typeof input.setRawMode === "function";
      listen();
      if (raw) input.setRawMode!(true);
      input.resume();
      let answer = "";
      try {
        for (;;) {
          while (pending !== "") {
            const char = pending[0]!;
            pending = pending.slice(1);
            if (ENTER.has(char)) {
              // A Windows line ending from a pipe: the `\n` after the `\r` belongs to this line.
              if (char === "\r" && pending[0] === "\n") pending = pending.slice(1);
              return answer;
            }
            if (raw && CANCEL.has(char)) throw new Canceled();
            if (raw && ERASE.has(char)) answer = answer.slice(0, -1);
            else answer += char;
          }
          if (ended) {
            if (answer !== "") return answer;
            throw new Canceled();
          }
          await new Promise<void>((resolve) => (waiting = resolve));
        }
      } finally {
        if (raw) input.setRawMode!(false);
        input.pause();
        output.write("\n");
      }
    },
  };
}
