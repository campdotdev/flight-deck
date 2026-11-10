// `flight-deck login github` (spec 1, "Install", ADRs 0005, 0007, and 0025). It reads the machine user's classic
// token at a hidden prompt and checks it before it signs anything in: the scopes from the `X-OAuth-Scopes` header
// of `gh api user -i`, which must hold `repo` and `read:org` and no scope that could push a workflow change or
// administer anything, and the login, which must not be the maintainer's own. Then it signs the token in with
// `gh auth login --with-token --insecure-storage` under Flight Deck's `GH_CONFIG_DIR`, so the token sits in that
// folder's `hosts.yml` under `~`, where the sandbox denies reads, and not in the Keychain, which sandboxed Bash can
// read. Last, it writes `[machine_user]` and `gitconfig-runner`. No line it prints holds the token.
import { mkdir, chmod } from "node:fs/promises";
import { paths } from "../folders/index.ts";
import { updateConfig, writeRunnerGitconfig } from "../install/index.ts";
import type { CommandContext } from "./context.ts";
import { Canceled } from "./prompt.ts";
import { toolPath } from "./tools.ts";

const AGAIN = "run flight-deck login github again";
const TOKEN_PAGE = "https://github.com/settings/tokens/new?scopes=repo,read:org&description=Flight%20Deck";
/** Each variable that makes `gh` use a token other than the one in its config folder. */
const TOKEN_VARIABLES = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST"];

/** The classic-token page, preset to the two scopes the machine user's token holds. */
export const GITHUB_TOKEN_PAGE = TOKEN_PAGE;

/** A failure that ends the login, with the text that says how to fix it. */
export class GithubLoginFailed extends Error {}

export interface MachineUser {
  login: string;
  id: number;
  name: string;
  email: string;
}

/** `flight-deck login github`. */
export async function loginGithubCommand(argv: string[], context: CommandContext): Promise<number> {
  if (argv.length > 0) {
    context.err("Usage: flight-deck login github");
    return 64;
  }
  const gh = await toolPath("gh", context);
  if (gh === null) {
    context.err(`Flight Deck can't find gh on your PATH. Install it with brew install gh, then ${AGAIN}.`);
    return 1;
  }
  try {
    await loginGithub(gh, context);
    return 0;
  } catch (error) {
    if (error instanceof Canceled) context.err("Canceled, so Flight Deck wrote nothing.");
    else if (error instanceof GithubLoginFailed) context.err(error.message);
    else throw error;
    return 1;
  }
}

/** Reads, checks, and signs in the machine user's token with the `gh` at `gh`. Throws `GithubLoginFailed`. */
export async function loginGithub(gh: string, context: CommandContext): Promise<MachineUser> {
  const token = (await context.prompt.secret("Machine user's classic token")).trim();
  if (token === "") throw new GithubLoginFailed(`The token is empty, so Flight Deck wrote nothing. ${capital(AGAIN)}.`);
  const ghConfig = paths.ghConfig(context.folders);
  const clean = withoutTokens(context.env);

  // The token alone, so neither a variable nor a config of the maintainer's answers in its place.
  const read = await context.shell.run([gh, "api", "user", "-i"], { env: { ...clean, GH_TOKEN: token, GH_CONFIG_DIR: ghConfig, GH_HOST: "github.com" } });
  if (read.code !== 0) throw new GithubLoginFailed(`GitHub didn't accept the token: ${firstLine(read.stderr) || `gh exited ${read.code}`}. Copy the whole token, then ${AGAIN}.`);
  const { scopes, user } = parseUserResponse(read.stdout);

  const broken = scopeProblem(scopes);
  if (broken !== null) {
    throw new GithubLoginFailed(
      `Refused: the token can't be the machine user's, because ${broken}. Make a classic token with only the repo and read:org scopes at ${TOKEN_PAGE}, signed in as the machine user, then ${AGAIN}.`,
    );
  }

  const own = await maintainerLogin(gh, context);
  if (own.toLowerCase() === user.login.toLowerCase()) {
    throw new GithubLoginFailed(
      `Refused: the token belongs to ${user.login}, your own GitHub account, and the factory never acts as you. Sign in to GitHub as the machine user, make its token there, then ${AGAIN}.`,
    );
  }

  await mkdir(ghConfig, { recursive: true, mode: 0o700 });
  await chmod(ghConfig, 0o700);
  const signIn = await context.shell.run([gh, "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token", "--insecure-storage"], {
    env: { ...clean, GH_CONFIG_DIR: ghConfig },
    input: `${token}\n`,
  });
  if (signIn.code !== 0) throw new GithubLoginFailed(`gh couldn't sign the token in: ${firstLine(signIn.stderr) || `gh exited ${signIn.code}`}. ${capital(AGAIN)}.`);

  const machineUser: MachineUser = {
    login: user.login,
    id: user.id,
    name: user.name ?? user.login,
    email: `${user.id}+${user.login}@users.noreply.github.com`,
  };
  await updateConfig(context.folders, (config) => void (config.machine_user = { ...machineUser }));
  await writeRunnerGitconfig(context.folders, gh);
  context.out(`Signed in to GitHub as ${machineUser.login}. Flight Deck's commits name ${machineUser.name} <${machineUser.email}>.`);
  return machineUser;
}

/**
 * Why the scopes don't fit the machine user's token, or `null` when they do: it needs `repo` and `read:org`, and
 * it must not hold `workflow`, any `admin:` scope, `delete_repo`, or `write:packages` (ADRs 0005 and 0025).
 */
function scopeProblem(scopes: string[]): string | null {
  const missing = ["repo", "read:org"].filter((scope) => !scopes.includes(scope));
  if (missing.length > 0) return `it lacks the ${and(missing)} ${missing.length === 1 ? "scope" : "scopes"}`;
  const forbidden = scopes.filter((scope) => scope === "workflow" || scope.startsWith("admin:") || scope === "delete_repo" || scope === "write:packages");
  if (forbidden.length > 0) return `it has the ${and(forbidden)} ${forbidden.length === 1 ? "scope" : "scopes"}`;
  return null;
}

/** The login of the maintainer's own `gh` session, or the one they type when they have none. */
async function maintainerLogin(gh: string, context: CommandContext): Promise<string> {
  const own = await context.shell.run([gh, "api", "user", "--jq", ".login"], { env: context.env });
  const login = own.code === 0 ? own.stdout.trim() : "";
  if (login !== "") return login;
  const typed = (await context.prompt.ask("Your own GitHub login (you have no gh session to read it from)")).trim();
  if (typed === "") throw new GithubLoginFailed(`Flight Deck needs your own GitHub login to check the token isn't yours. ${capital(AGAIN)}.`);
  return typed;
}

/** `gh api -i`'s output: the status line and headers, a blank line, then the body. */
function parseUserResponse(text: string): { scopes: string[]; user: { login: string; id: number; name: string | null } } {
  const split = /\r?\n\r?\n/.exec(text);
  const head = split === null ? text : text.slice(0, split.index);
  const body = split === null ? "" : text.slice(split.index + split[0].length);
  const header = head.split(/\r?\n/).find((line) => /^x-oauth-scopes\s*:/i.test(line));
  const scopes = (header?.replace(/^[^:]*:/, "") ?? "").split(",").map((scope) => scope.trim()).filter((scope) => scope !== "");
  let user: { login?: unknown; id?: unknown; name?: unknown };
  try {
    user = JSON.parse(body) as typeof user;
  } catch {
    throw new GithubLoginFailed(`GitHub's answer to gh api user held no user. ${capital(AGAIN)}.`);
  }
  if (typeof user.login !== "string" || typeof user.id !== "number") throw new GithubLoginFailed(`GitHub's answer to gh api user held no login. ${capital(AGAIN)}.`);
  return { scopes, user: { login: user.login, id: user.id, name: typeof user.name === "string" && user.name.trim() !== "" ? user.name : null } };
}

function withoutTokens(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const clean = { ...env };
  for (const name of TOKEN_VARIABLES) delete clean[name];
  return clean;
}

function and(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
