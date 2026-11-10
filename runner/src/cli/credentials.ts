// A session's helpers (spec 1, "Session credentials", ADR 0005). `linear-token` is the Linear MCP server's
// `headersHelper`, and `api-key` is `apiKeyHelper` on an API key. Neither ever writes a secret anywhere else.
import { paths } from "../folders/index.ts";
import { readCredentials } from "../install/index.ts";
import { ask } from "../socket/index.ts";
import type { CommandContext } from "./context.ts";

/** How long the helper waits: the runner may be minting or testing the token with Linear. */
const TOKEN_ANSWER_MS = 30_000;

/**
 * `flight-deck linear-token <session-id>`: asks the runner for the session's Reader token and prints the
 * `Authorization` header as the JSON object of headers Claude Code reads from a `headersHelper`.
 */
export async function linearTokenCommand(argv: string[], context: CommandContext): Promise<number> {
  const [session] = argv;
  if (session === undefined || argv.length > 1) {
    context.err("Usage: flight-deck linear-token <session-id>");
    return 64;
  }
  const reply = await ask(paths.socket(context.folders), { op: "linear_token", session }, context.answerMs ?? TOKEN_ANSWER_MS);
  if (reply === null) {
    context.err(`The runner didn't answer, so there's no Linear token for session ${session}.`);
    return 1;
  }
  if (!reply.ok || typeof reply.token !== "string") {
    context.err(`The runner gave no Linear token: ${reply.ok ? "its reply held none" : reply.error}.`);
    return 1;
  }
  context.out(JSON.stringify({ Authorization: `Bearer ${reply.token}` }));
  return 0;
}

/** `flight-deck api-key`: prints `ANTHROPIC_API_KEY` from `credentials.env`. */
export async function apiKeyCommand(context: CommandContext): Promise<number> {
  const key = (await readCredentials(context.folders))?.values.ANTHROPIC_API_KEY;
  if (key === undefined || key === "") {
    context.err("credentials.env holds no ANTHROPIC_API_KEY. Run flight-deck install to choose an API key.");
    return 1;
  }
  context.out(key);
  return 0;
}
