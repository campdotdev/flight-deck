// The hidden prompt every command reads a secret with (spec 1, "Install"): echo stays off, so no transcript of the
// terminal holds the secret. A stand-in stream plays the terminal, so the test needs none.
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { hiddenPrompt } from "../../src/cli/prompt.ts";

/** A terminal's stdin: a stream that records each raw-mode switch. */
function terminal(tty = true) {
  const input = Object.assign(new PassThrough(), { isTTY: tty, raw: [] as boolean[], setRawMode(on: boolean) {
    input.raw.push(on);
    return input;
  } });
  const written: string[] = [];
  const prompt = hiddenPrompt(input, { write: (text: string) => void written.push(text) });
  return { input, written, prompt };
}

describe("hiddenPrompt", () => {
  test("reads a line in raw mode, echoes none of it, and turns raw mode off after", async () => {
    const { input, written, prompt } = terminal();
    const answer = prompt.secret("Flight Deck app client secret");
    input.write("s3cr");
    input.write("et\r");
    expect(await answer).toBe("s3cret");
    expect(written.join("")).toBe("Flight Deck app client secret: \n");
    expect(input.raw).toEqual([true, false]);
  });

  test("a backspace removes the last character", async () => {
    const { input, prompt } = terminal();
    const answer = prompt.secret("Key");
    input.write("abx\x7fc\n");
    expect(await answer).toBe("abc");
  });

  test("Ctrl-C cancels the prompt and turns raw mode off", async () => {
    const { input, written, prompt } = terminal();
    const answer = prompt.secret("Key");
    input.write("ab\x03");
    await expect(answer).rejects.toThrow("Canceled.");
    expect(written.join("")).toBe("Key: \n");
    expect(input.raw).toEqual([true, false]);
  });

  test("piped input gives one line to each prompt, in order", async () => {
    const { input, written, prompt } = terminal(false);
    input.write("first\nsecond\r\nthird\n");
    expect(await prompt.secret("One")).toBe("first");
    expect(await prompt.secret("Two")).toBe("second");
    expect(await prompt.secret("Three")).toBe("third");
    expect(written.join("")).toBe("One: \nTwo: \nThree: \n");
  });

  test("a Windows line ending split across two chunks ends one line", async () => {
    const { input, prompt } = terminal(false);
    const first = prompt.secret("One");
    input.write("first\r");
    expect(await first).toBe("first");
    const second = prompt.secret("Two");
    input.write("\nsecond\r\n");
    expect(await second).toBe("second");
  });

  test("a last line with no line break counts, and input that has ended cancels the next prompt", async () => {
    const { input, prompt } = terminal(false);
    const answer = prompt.secret("Key");
    input.end("last");
    expect(await answer).toBe("last");
    await expect(prompt.secret("More")).rejects.toThrow("Canceled.");
  });

  test("ask reads a line the terminal echoes, with raw mode left off", async () => {
    const { input, written, prompt } = terminal();
    const answer = prompt.ask("Subscription or API key");
    input.write("subscription\n");
    expect(await answer).toBe("subscription");
    expect(written.join("")).toBe("Subscription or API key: ");
    expect(input.raw).toEqual([]);
  });

  test("ask and secret share piped input, one line each", async () => {
    const { input, prompt } = terminal(false);
    input.write("api_key\nsk-ant\n");
    expect(await prompt.ask("Which")).toBe("api_key");
    expect(await prompt.secret("Key")).toBe("sk-ant");
  });
});
