// `flight-deck login linear <workspace>` (spec 1, "Install", ADRs 0005 and 0017). It reads, at hidden prompts,
// the Flight Deck app's and the Flight Deck Reader app's client IDs and secrets and the maintainer's setup key, and
// writes them to `credentials.env`. Then it mints one token from each app, confirms each reaches the workspace, and
// revokes both. Last, it reads the setup key's `viewer` and writes the maintainer and the app user to
// `config.toml`. It doesn't test the setup key's scopes: spec 6's `setup check` does. It reaches Linear only
// through the Tracker, and no secret it reads reaches its output.
import { updateConfig, workspaceKey, writeCredentials } from "../install/index.ts";
import { isUnavailable, MintFailed, TrackerRefused, type LinearApp, type Viewer } from "../tracker/index.ts";
import type { CommandContext } from "./context.ts";
import { Canceled } from "./prompt.ts";

const USAGE = "Usage: flight-deck login linear <workspace>, where <workspace> is the URL key in linear.app/<workspace>";

/** A Linear workspace's URL key. */
const WORKSPACE = /^[a-z0-9][a-z0-9-]*$/;

const APP_NAMES: Record<LinearApp, string> = { flight_deck: "Flight Deck", reader: "Flight Deck Reader" };

/** A failure that ends the login, with the text that says how to fix it. */
class LoginFailed extends Error {}

export async function loginCommand(argv: string[], context: CommandContext): Promise<number> {
  const [service, workspace, ...rest] = argv;
  if (service !== "linear") {
    context.err(service === "github" ? "flight-deck login github comes with flight-deck install." : USAGE);
    return 64;
  }
  if (workspace === undefined || rest.length > 0 || !WORKSPACE.test(workspace)) {
    context.err(USAGE);
    return 64;
  }
  const again = `run flight-deck login linear ${workspace} again`;
  try {
    await loginLinear(workspace, again, context);
    return 0;
  } catch (error) {
    if (error instanceof Canceled) context.err("Canceled, so Flight Deck wrote nothing.");
    else if (error instanceof LoginFailed) context.err(error.message);
    else if (isUnavailable(error)) context.err(`Linear didn't answer (${(error as Error).message}). Run flight-deck login linear ${workspace} again.`);
    else throw error;
    return 1;
  }
}

async function loginLinear(workspace: string, again: string, context: CommandContext): Promise<void> {
  const key = workspaceKey(workspace);
  const questions: [string, string][] = [
    [`LINEAR_APP_ID_${key}`, "Flight Deck app's client ID"],
    [`LINEAR_APP_SECRET_${key}`, "Flight Deck app's client secret"],
    [`LINEAR_READER_ID_${key}`, "Flight Deck Reader app's client ID"],
    [`LINEAR_READER_SECRET_${key}`, "Flight Deck Reader app's client secret"],
    [`LINEAR_SETUP_KEY_${key}`, `Setup key for ${workspace} (a personal API key)`],
  ];
  const values: Record<string, string> = {};
  for (const [name, question] of questions) {
    const answer = (await context.prompt.secret(question)).trim();
    if (answer === "") throw new LoginFailed(`The ${question.replace(/ \(.*\)$/, "")} is empty, so Flight Deck wrote nothing. ${capital(again)}.`);
    values[name] = answer;
  }
  // The adapter reads the apps from `credentials.env` at each mint, so the mints below use what was just written.
  await writeCredentials(context.folders, values);

  const tracker = context.adapters.maintainerTracker({ folders: context.folders, workspace, setupKey: values[`LINEAR_SETUP_KEY_${key}`]! });
  const app = await appUser(() => tracker.appViewer(workspace, "flight_deck"), "flight_deck", workspace, again);
  await appUser(() => tracker.appViewer(workspace, "reader"), "reader", workspace, again);
  let maintainer: Viewer;
  try {
    maintainer = await tracker.viewer(workspace);
  } catch (error) {
    if (error instanceof TrackerRefused) throw new LoginFailed(`${error.message}. Make a personal API key in ${workspace}'s Linear settings, then ${again}.`);
    throw error;
  }
  if (maintainer.workspace !== workspace) {
    throw new LoginFailed(`The setup key reaches workspace ${maintainer.workspace}, not ${workspace}. Make the key in ${workspace}'s Linear settings, then ${again}.`);
  }

  await updateConfig(context.folders, (config) => {
    const linear = (config.linear ?? {}) as Record<string, unknown>;
    linear[workspace] = { maintainer_id: maintainer.id, maintainer_name: maintainer.name, app_user_id: app.id };
    config.linear = linear;
  });
  context.out(
    `Signed in to Linear workspace ${workspace}. Flight Deck flags ${maintainer.name} there, and the Flight Deck app acts as ${app.name}. The runner reads the new secrets at its next poll.`,
  );
}

/** The app's own user, from a token minted and revoked for the check, which must reach the workspace. */
async function appUser(check: () => Promise<Viewer>, app: LinearApp, workspace: string, again: string): Promise<Viewer> {
  const name = APP_NAMES[app];
  let viewer: Viewer;
  try {
    viewer = await check();
  } catch (error) {
    if (error instanceof MintFailed) throw new LoginFailed(`${error.message}. Check the ${name} app's client ID and secret on its page in Linear's settings, then ${again}.`);
    throw error;
  }
  if (viewer.workspace !== workspace) {
    throw new LoginFailed(`The ${name} app's token reaches workspace ${viewer.workspace}, not ${workspace}. Use the ${name} app made in ${workspace}, then ${again}.`);
  }
  return viewer;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
