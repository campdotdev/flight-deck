// `flight-deck update --from <folder>` (spec 1, "Install", ADR 0015): switches to a local build and restarts the
// runner on it. It asks the runner to hold with the cause `update`, so no session starts between the check and the
// restart, then checks the session list. While the list holds any entry, in any state, it ends that hold, refuses,
// and changes nothing. When the runner doesn't answer within 10 seconds, it reads `state/sessions.json` itself
// and goes ahead only when the list is empty, because a runner that doesn't answer may be what the update fixes.
// Then it copies the build into `versions/<version>/`, switches `current`, and runs `launchctl kickstart -k`.
// The `update` hold lives only in the old runner's memory, so the new runner starts with none. Spec 10's drain
// replaces the refusal.
import { paths } from "../folders/index.ts";
import { copyVersion, folderVersion, isInstalled, LAUNCH_AGENT_LABEL, switchCurrent } from "../install/index.ts";
import { ask } from "../socket/index.ts";
import { State, type SessionEntry } from "../state/index.ts";
import { ANSWER_MS, type CommandContext } from "./context.ts";

const USAGE = "Usage: flight-deck update --from <folder>";

export async function updateCommand(argv: string[], context: CommandContext): Promise<number> {
  const [flag, from, ...rest] = argv;
  if (flag !== "--from" || from === undefined || rest.length > 0) {
    context.err(USAGE);
    return 64;
  }
  const { folders } = context;
  let version: string;
  try {
    version = await folderVersion(from);
  } catch (error) {
    context.err(`Refused: ${(error as Error).message}. Name the folder scripts/build-version.sh wrote.`);
    return 1;
  }
  if (await isInstalled(folders, version)) {
    context.err(`Refused: ${version} is already in ${paths.versions(folders)}. Build a new version with scripts/build-version.sh, then update from it.`);
    return 1;
  }

  const socket = paths.socket(folders);
  const waitMs = context.answerMs ?? ANSWER_MS;
  const held = await ask(socket, { op: "hold", cause: "update" }, waitMs);
  if (held !== null && !held.ok) {
    context.err(`The runner refused to hold for the update: ${held.error}`);
    return 1;
  }
  const release = async () => {
    if (held !== null) await ask(socket, { op: "release", cause: "update" }, waitMs);
  };

  let sessions: SessionEntry[];
  let source: "runner" | "file";
  const reply = held === null ? null : await ask(socket, { op: "sessions" }, waitMs);
  if (reply !== null && reply.ok && Array.isArray(reply.sessions)) {
    sessions = reply.sessions as SessionEntry[];
    source = "runner";
  } else {
    sessions = await new State(folders).sessions();
    source = "file";
  }
  if (sessions.length > 0) {
    await release();
    const holder = source === "runner" ? "the runner lists" : "the session list holds";
    const count = sessions.length === 1 ? "1 session, and an update would cut it off" : `${sessions.length} sessions, and an update would cut them off`;
    context.err(
      `Refused: ${holder} ${count}: ${sessions.map(describe).join(", ")}. Run flight-deck hold, wait until flight-deck status lists no session, then run flight-deck update --from ${from} again.`,
    );
    return 1;
  }

  try {
    await copyVersion(folders, from, version);
  } catch (error) {
    await release();
    throw error;
  }
  const old = context.version;
  await switchCurrent(folders, version);
  const service = `gui/${context.shell.uid}/${LAUNCH_AGENT_LABEL}`;
  const restart = await context.shell.run(["/bin/launchctl", "kickstart", "-k", service]);
  if (restart.code !== 0) {
    await release();
    const why = restart.stderr.trim().split("\n")[0]?.trim().replace(/\.$/, "") || `exit ${restart.code}`;
    context.err(`current now points at ${version}, but launchctl couldn't restart the runner: ${why}. Run flight-deck install to load it.`);
    return 1;
  }
  context.out(`Updated Flight Deck from ${old} to ${version}, and restarted the runner on it.`);
  return 0;
}

function describe(entry: SessionEntry): string {
  if (entry.stage === "trial") return `${entry.id}, a trial run (${entry.state})`;
  return `${entry.id} on ${entry.issue} (${entry.repo}, ${entry.state})`;
}
