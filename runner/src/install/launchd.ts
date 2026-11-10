// The runner's launcher and LaunchAgent (spec 1, "Install", ADRs 0002 and 0024). The agent runs the launcher, a
// shell script that `exec`s `current/bin/flight-deck runner`. Background Task Management records an agent's
// executable and posts "can run in the background" when it changes, and an ad-hoc build gets a new identity
// every time, so the launcher is written once and never changed, and the plist is written only when it differs.
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { paths, type Folders } from "../folders/index.ts";
import { writeAtomic } from "../state/files.ts";

export const LAUNCH_AGENT_LABEL = "dev.campdotdev.flight-deck";

/** A shell word in single quotes. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** Writes the launcher when there is none, with mode `0755`. Returns whether it wrote one. */
export async function writeLauncher(folders: Folders): Promise<boolean> {
  const path = paths.launcher(folders);
  if (existsSync(path)) return false;
  const binary = join(paths.current(folders), "bin", "flight-deck");
  await writeAtomic(path, `#!/bin/sh\nexec ${shellQuote(binary)} runner\n`, 0o755);
  return true;
}

/**
 * Writes the LaunchAgent unless it already says the same. `ProcessType` is `Standard` because `Background`
 * throttled every Shaders session about tenfold, and `NumberOfFiles` is 65536 because launchd's default of 256
 * made Next's file watcher fail in a session (FLD-42). Returns whether it wrote the file.
 */
export async function writeLaunchAgent(folders: Folders): Promise<boolean> {
  const path = paths.launchAgent(folders);
  const text = plist(folders);
  const old = await readFile(path, "utf8").catch(() => null);
  // launchd opens the log before the runner starts.
  await mkdir(paths.state(folders), { recursive: true });
  if (old === text) return false;
  await writeAtomic(path, text);
  return true;
}

function plist(folders: Folders): string {
  const log = xml(paths.launchdLog(folders));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LAUNCH_AGENT_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xml(paths.launcher(folders))}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ProcessType</key>
	<string>Standard</string>
	<key>SoftResourceLimits</key>
	<dict>
		<key>NumberOfFiles</key>
		<integer>65536</integer>
	</dict>
	<key>StandardOutPath</key>
	<string>${log}</string>
	<key>StandardErrorPath</key>
	<string>${log}</string>
</dict>
</plist>
`;
}

function xml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
