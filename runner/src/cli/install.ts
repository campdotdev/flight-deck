// `flight-deck install` (spec 1, "Install", ADRs 0005, 0015, and 0024). Run from a local build's own `bin/`, it
// first copies that version folder into `versions/<version>/`, points `current` at it, and links
// `~/.local/bin/flight-deck`. Then it runs its 8 steps in order. Each step is skipped when its result exists, so a
// failed install reruns from the top, and a step that fails prints what failed and how to fix it, and stops.
// It never installs another tool.
//
// Its `launchctl`, `gh`, and `claude plugin` calls run through `context.shell`, outside the test seam, and the
// maintainer checks them by hand during the Shaders run (spec 1, "The seam").
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../folders/index.ts";
import { CLAUDE_CODE } from "../harness/index.ts";
import {
  copyVersion,
  currentVersion,
  folderVersion,
  inVersions,
  isInstalled,
  LAUNCH_AGENT_LABEL,
  linkBin,
  readConfig,
  switchCurrent,
  updateConfig,
  writeCredentials,
  writeLaunchAgent,
  writeLauncher,
  type Config,
} from "../install/index.ts";
import { TEST_NOTIFICATION, type TrialResult } from "../poll/index.ts";
import { tooOld } from "../poll/trouble/version.ts";
import { ask } from "../socket/index.ts";
import { readJson, State, type Status } from "../state/index.ts";
import { ANSWER_MS, type CommandContext } from "./context.ts";
import { GITHUB_TOKEN_PAGE, GithubLoginFailed, loginGithub } from "./login-github.ts";
import { Canceled } from "./prompt.ts";
import { findOnPath, toolVersion, type ToolName } from "./tools.ts";

const AGAIN = "run flight-deck install again";
const GH_MINIMUM = "2.99.0";
/** Step 6's wait for the runner's first poll. */
const FIRST_POLL_MS = 2 * 60_000;
/** A heartbeat older than this means the runner isn't polling (ADR 0021). */
const FRESH_HEARTBEAT_MS = 3 * 60_000;
/** How long install waits for the trial's one reply: the trial may wait for a free place first. */
const TRIAL_ANSWER_MS = 2 * 60 * 60_000;
/** How often install reads `status.json` while the trial runs, to say when it waits for a free place. */
const TRIAL_LOOK_MS = 5_000;
const LAUNCHCTL = "/bin/launchctl";
const PLUGIN = "flight-deck@flight-deck";

/** A step that failed, with the text that says what failed and how to fix it. */
class InstallFailed extends Error {
  constructor(readonly lines: string[]) {
    super(lines.join("\n"));
  }
}

/** What step 2 asked, which step 4 writes. */
interface Billing {
  auth: Config["auth"];
  api?: NonNullable<Config["api"]>;
}

export async function installCommand(argv: string[], context: CommandContext): Promise<number> {
  if (argv.length > 0) {
    context.err("Usage: flight-deck install");
    return 64;
  }
  try {
    await install(context);
    return 0;
  } catch (error) {
    if (error instanceof InstallFailed) for (const line of error.lines) context.err(line);
    else if (error instanceof GithubLoginFailed) context.err(error.message);
    else if (error instanceof Canceled) context.err(`Canceled. Run flight-deck install again: it skips each step already done.`);
    else throw error;
    return 1;
  }
}

async function install(context: CommandContext): Promise<void> {
  await installBuild(context);
  const tools = await checkTools(context);
  const billing = await askBilling(context);
  await setUpMachineUser(context, tools.gh);
  await writeConfig(context, billing, tools);
  await registerPlugin(context, tools.claude);
  await loadRunner(context);
  await runTrial(context);
  for (const line of NEXT_STEPS) context.out(line);
}

/**
 * A binary that runs from outside `versions/` is a local build: its version folder is copied in, `current`
 * points at it, and `~/.local/bin/flight-deck` links to it.
 */
async function installBuild(context: CommandContext): Promise<void> {
  const { folders, version } = context;
  const installed = paths.version(folders, version);
  if (inVersions(folders, context.versionFolder)) {
    if ((await currentVersion(folders)) === null) await switchCurrent(folders, version);
    await linkBin(folders).catch(failWith);
    return;
  }
  // A binary run some other way, such as `bun src/cli/main.ts`, has no version folder to copy.
  const built = await folderVersion(context.versionFolder).catch((error: Error) => {
    throw new InstallFailed([`${error.message}. Run the flight-deck in a folder scripts/build-version.sh wrote.`]);
  });
  if (built !== version) throw new InstallFailed([`${context.versionFolder} holds Flight Deck ${built}, not ${version}. Run the flight-deck in a folder scripts/build-version.sh wrote.`]);
  const current = await currentVersion(folders);
  // Moving `current` under a loaded runner is `update`'s job, which first checks that no session runs.
  if (current !== null && current !== version) {
    throw new InstallFailed([`Flight Deck ${current} is installed. Run flight-deck update --from ${context.versionFolder} to switch to this build.`]);
  }
  const copied = !(await isInstalled(folders, version));
  if (copied) await copyVersion(folders, context.versionFolder, version);
  await switchCurrent(folders, version);
  await linkBin(folders).catch(failWith);
  if (copied) context.out(`Installed Flight Deck ${version} in ${installed}, and ${paths.binLink(folders)} runs it.`);
}

/** Step 1: Claude Code at this version's minimum, git, and `gh` 2.99.0 or later, on the maintainer's `PATH`. */
async function checkTools(context: CommandContext): Promise<Record<ToolName, string>> {
  const fixes: Record<ToolName, { name: string; missing: string; old: string; minimum: string | null }> = {
    claude: {
      name: "Claude Code",
      missing: "Install it from https://code.claude.com/docs/en/setup",
      old: "Update it with claude update",
      minimum: CLAUDE_CODE.minVersion,
    },
    git: { name: "git", missing: "Install it with xcode-select --install", old: "", minimum: null },
    gh: { name: "gh", missing: "Install it with brew install gh", old: "Update it with brew upgrade gh", minimum: GH_MINIMUM },
  };
  const found: Partial<Record<ToolName, { path: string; version: string }>> = {};
  const problems: string[] = [];
  for (const tool of ["claude", "git", "gh"] as const) {
    const fix = fixes[tool];
    const path = findOnPath(tool, context.env.PATH);
    if (path === null) {
      problems.push(`1. ${fix.name} isn't on your PATH. ${fix.missing}, then ${AGAIN}.`);
      continue;
    }
    const version = await toolVersion(path, context);
    if (version === null) {
      problems.push(`1. ${path} --version names no version. ${fix.missing}, then ${AGAIN}.`);
      continue;
    }
    if (fix.minimum !== null && tooOld(version, fix.minimum)) {
      const oldest = tool === "claude" ? `${fix.minimum}, the oldest this Flight Deck runs` : fix.minimum;
      problems.push(`1. ${fix.name} ${version} is older than ${oldest}. ${fix.old}, then ${AGAIN}.`);
      continue;
    }
    found[tool] = { path, version };
  }
  if (problems.length > 0) throw new InstallFailed(problems);
  const { claude, git, gh } = found as Record<ToolName, { path: string; version: string }>;
  context.out(`1. Claude Code ${claude.version}, git ${git.version}, and gh ${gh.version} are ready.`);
  return { claude: claude.path, git: git.path, gh: gh.path };
}

/**
 * Step 2: the subscription or an API key (ADR 0005). Done when `config.toml` holds `auth`. On an API key, the key
 * goes to `credentials.env` at once, and the budget and caps stay in memory for step 4.
 */
async function askBilling(context: CommandContext): Promise<Billing | null> {
  const config = await partialConfig(context);
  if (config.auth !== undefined) {
    context.out(`2. Sessions use ${config.auth === "api_key" ? "an API key" : "your Claude subscription"}.`);
    return null;
  }
  let auth: Config["auth"] | null = null;
  while (auth === null) {
    const answer = (await context.prompt.ask("Do sessions use your Claude subscription or an API key? Answer subscription or api_key")).trim().toLowerCase();
    if (answer === "subscription") auth = "subscription";
    if (answer === "api_key") auth = "api_key";
  }
  if (auth === "subscription") return { auth };
  let key = "";
  while (key === "") key = (await context.prompt.secret("Claude API key")).trim();
  await writeCredentials(context.folders, { ANTHROPIC_API_KEY: key });
  return {
    auth,
    api: {
      session_budget_usd: await askDollars(context, "Session budget, in US dollars"),
      daily_cap_usd: await askDollars(context, "Daily cap, in US dollars"),
      monthly_cap_usd: await askDollars(context, "Monthly cap, in US dollars"),
    },
  };
}

async function askDollars(context: CommandContext, question: string): Promise<number> {
  for (;;) {
    const answer = (await context.prompt.ask(question)).trim().replace(/^\$/, "");
    const amount = Number(answer);
    if (answer !== "" && Number.isFinite(amount) && amount > 0) return amount;
  }
}

/**
 * Step 3: the machine user (ADR 0005). Done when `config.toml` holds `[machine_user]`. It opens GitHub's signup page,
 * then the classic-token page preset to the `repo` and `read:org` scopes, then runs `login github`. GitHub's page
 * takes no expiry in its address, so the maintainer sets the one-year expiry by hand.
 */
async function setUpMachineUser(context: CommandContext, gh: string): Promise<void> {
  const config = await partialConfig(context);
  if (config.machine_user !== undefined) {
    context.out(`3. Flight Deck's machine user on GitHub is ${config.machine_user.login}.`);
    return;
  }
  context.out(
    "3. Flight Deck acts on GitHub as a machine user: a second GitHub account that only the factory signs in to. GitHub's signup page opens now. Make the account in a private window, so you stay signed in as yourself.",
  );
  await context.shell.open("https://github.com/signup");
  await context.prompt.ask("Press Return once the machine user's account exists");
  context.out("   The classic-token page opens now. Sign in to it as the machine user, keep the repo and read:org scopes, set the expiration to one year, and copy the token.");
  await context.shell.open(GITHUB_TOKEN_PAGE);
  await loginGithub(gh, context);
}

/**
 * Step 4: `config.toml` with an empty repo list, the defaults, and the absolute paths from step 1. Done when it
 * holds `concurrency_cap`. It merges, so `[machine_user]` from step 3 stays.
 */
async function writeConfig(context: CommandContext, billing: Billing | null, tools: Record<ToolName, string>): Promise<void> {
  const config = await partialConfig(context);
  if (config.concurrency_cap !== undefined) {
    context.out("4. config.toml holds Flight Deck's settings.");
    return;
  }
  await updateConfig(context.folders, (each) => {
    each.auth = billing?.auth ?? each.auth ?? "subscription";
    each.concurrency_cap = 2;
    each.usage = { five_hour: 0.8, weekly: 0.7 };
    if (billing?.api !== undefined) each.api = { ...billing.api };
    // `""` is Claude Code's default model, so check runs on build's model (ADR 0028).
    each.models = { plan: "", build: "", check: "", debrief: "" };
    each.paths = { ...tools };
    each.repos ??= [];
  });
  context.out(`4. Wrote ${paths.configToml(context.folders)}.`);
}

/**
 * Step 5: the hand-run plugin, from the local-folder marketplace at `current/plugin` (ADR 0015). Done when
 * `claude plugin list` names it.
 */
async function registerPlugin(context: CommandContext, claude: string): Promise<void> {
  const run = async (args: string[]) => {
    const result = await context.shell.run([claude, ...args], { env: context.env });
    if (result.code !== 0) {
      throw new InstallFailed([`5. claude ${args.join(" ")} failed: ${firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.code}`}. Fix that, then ${AGAIN}.`]);
    }
    return result.stdout;
  };
  if ((await run(["plugin", "list"])).includes(PLUGIN)) {
    context.out("5. The flight-deck plugin is registered.");
    return;
  }
  const marketplace = join(paths.current(context.folders), "plugin");
  // A rerun after a failed `install` finds the marketplace already added.
  if (!/(^|\s)flight-deck(\s|$)/m.test(await run(["plugin", "marketplace", "list"]))) await run(["plugin", "marketplace", "add", marketplace]);
  await run(["plugin", "install", PLUGIN]);
  context.out("5. Registered the flight-deck plugin, so /flight-plan works in your own Claude Code sessions.");
}

/**
 * Step 6: the launcher and the LaunchAgent, loaded, and up to 2 minutes for the runner's first poll in
 * `status.json`. Done when the agent is loaded and the heartbeat is under 3 minutes old.
 */
async function loadRunner(context: CommandContext): Promise<void> {
  const { folders, shell } = context;
  const service = `gui/${shell.uid}/${LAUNCH_AGENT_LABEL}`;
  const loaded = async () => (await shell.run([LAUNCHCTL, "print", service])).code === 0;
  const isLoaded = await loaded();
  const heartbeat = (await readJson<{ at: string } | null>(paths.heartbeat(folders), null))?.at;
  if (isLoaded && heartbeat !== undefined && context.clock().getTime() - Date.parse(heartbeat) < FRESH_HEARTBEAT_MS) {
    context.out("6. The runner is loaded and polling.");
    return;
  }

  await writeLauncher(folders);
  const changed = await writeLaunchAgent(folders);
  const started = context.clock();
  const launchctl = async (...args: string[]) => {
    const result = await shell.run([LAUNCHCTL, ...args]);
    if (result.code !== 0) throw new InstallFailed([`6. launchctl ${args.join(" ")} failed: ${firstLine(result.stderr) || `exit ${result.code}`}. Fix that, then ${AGAIN}.`]);
  };
  if (isLoaded && !changed) {
    await launchctl("kickstart", "-k", service);
  } else {
    if (isLoaded) {
      await launchctl("bootout", service);
      // `bootout` returns before the job is gone, and a `bootstrap` before then fails.
      for (let i = 0; i < 30 && (await loaded()); i++) await shell.sleep(500);
    }
    await mkdir(paths.state(folders), { recursive: true });
    await launchctl("bootstrap", `gui/${shell.uid}`, paths.launchAgent(folders));
  }

  for (;;) {
    const status = await readJson<Pick<Status, "polled_at"> | null>(paths.status(folders), null).catch(() => null);
    if (status !== null && Date.parse(status.polled_at) >= started.getTime()) {
      context.out(`6. The runner is loaded, and it polled at ${time(status.polled_at)}.`);
      return;
    }
    if (context.clock().getTime() - started.getTime() >= FIRST_POLL_MS) break;
    await shell.sleep(1_000);
  }
  throw new InstallFailed([
    `6. The runner didn't poll within 2 minutes of loading. Read ${paths.launchdLog(folders)} and ${paths.log(folders)}, fix what they show, then ${AGAIN}.`,
  ]);
}

/**
 * Step 7: one test notification and a trial run, asked of the runner over its socket. Done when `state/trial.json`
 * names the running version. The notification comes first, so a rerun after a failed one asks for it again.
 */
async function runTrial(context: CommandContext): Promise<void> {
  const { folders } = context;
  const passed = await new State(folders).trial();
  if (passed?.version === context.version) {
    context.out(`7. The trial run passed on ${context.version}.`);
    return;
  }
  const socket = paths.socket(folders);
  const notified = await ask(socket, { op: "notify", text: TEST_NOTIFICATION }, context.answerMs ?? ANSWER_MS);
  if (notified === null) throw new InstallFailed([`7. The runner didn't answer on ${socket}. Run flight-deck status to see whether it runs, then ${AGAIN}.`]);
  if (!notified.ok) throw new InstallFailed([`7. The runner couldn't post the test notification: ${notified.error}. Fix that, then ${AGAIN}.`]);
  context.out(`7. The runner posted a test notification, "${TEST_NOTIFICATION}" If it didn't appear, turn on notifications for Script Editor in System Settings.`);

  let answered = false;
  const reply = ask(socket, { op: "trial" }, TRIAL_ANSWER_MS).finally(() => (answered = true));
  void tellWaiting(context, () => answered);
  const result = await reply;
  if (result === null) throw new InstallFailed([`7. The runner didn't answer the trial request. Run flight-deck status to see whether it runs, then ${AGAIN}.`]);
  if (!result.ok) throw new InstallFailed([`7. The runner refused the trial run: ${result.error}. Fix that, then ${AGAIN}.`]);
  const trial = result as unknown as TrialResult;
  if (trial.result === "passed") {
    context.out(`   The trial run passed, in session ${trial.session}.`);
    return;
  }
  if (trial.result === "held") {
    const fix = trial.cause === "stop" ? "Run flight-deck start" : "Run flight-deck status to see the hold, and fix what it shows";
    throw new InstallFailed([`7. The trial run didn't start, because the runner holds with the cause ${trial.cause}. ${fix}, then ${AGAIN}.`]);
  }
  const how = trial.exit === null ? `couldn't start${trial.error ? `: ${trial.error}` : ""}` : `ended ${trial.exit}${trial.error ? `: ${trial.error}` : ""}`;
  throw new InstallFailed([
    `7. The trial run failed: session ${trial.session} ${how}. Its transcript is ${paths.trialTranscript(folders, trial.session)}. Fix what it shows, then ${AGAIN}.`,
  ]);
}

/**
 * Says once that the trial waits for a free place under the concurrency cap. The runner sends one reply per
 * request, so install reads `status.json` meanwhile: no trial is listed, and the cap is full.
 */
async function tellWaiting(context: CommandContext, answered: () => boolean): Promise<void> {
  while (!answered()) {
    await context.shell.sleep(TRIAL_LOOK_MS);
    if (answered()) return;
    const status = await readJson<Pick<Status, "sessions"> | null>(paths.status(context.folders), null).catch(() => null);
    const cap = (await readConfig(context.folders).catch(() => null))?.concurrency_cap;
    if (status === null || cap === undefined) continue;
    const running = status.sessions.filter((session) => session.state === "starting" || session.state === "running");
    if (status.sessions.some((session) => session.stage === "trial") || running.length < cap) continue;
    context.out(`   The trial run waits for a free place: ${running.length} sessions run, and the cap is ${cap}.`);
    return;
  }
}

const NEXT_STEPS = [
  "Next:",
  "1. Create the Flight Deck Reader app in your Linear workspace, with only the read scope.",
  "2. Run flight-deck login linear <workspace>, where <workspace> is the URL key in linear.app/<workspace>.",
  "3. Commit a repo record at .flight-deck/record.toml on the repo's default branch.",
  "4. Run flight-deck register owner/repo in your checkout of the repo.",
];

/** `config.toml` as far as it's written, or nothing before step 3 or 4 writes it. */
async function partialConfig(context: CommandContext): Promise<Partial<Config>> {
  return readConfig(context.folders).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return {};
    throw error;
  });
}

function failWith(error: unknown): never {
  throw new InstallFailed([error instanceof Error ? error.message : String(error)]);
}

/** `2026-11-10 09:01 UTC`, as `flight-deck status` writes a time. */
function time(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}
