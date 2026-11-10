// The maintainer's tools: Claude Code, git, and `gh`, found on the maintainer's `PATH` (spec 1, "Install").
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readConfig } from "../install/index.ts";
import type { CommandContext } from "./context.ts";

export type ToolName = "claude" | "git" | "gh";

/** The first executable file named `name` on `PATH`, as an absolute path, or `null`. */
export function findOnPath(name: string, path: string | undefined): string | null {
  for (const folder of (path ?? "").split(":")) {
    if (!isAbsolute(folder)) continue;
    const file = join(folder, name);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** The tool `config.toml`'s `[paths]` names, else the one on the command's `PATH`. */
export async function toolPath(name: ToolName, context: CommandContext): Promise<string | null> {
  const config = await readConfig(context.folders).catch(() => null);
  return config?.paths?.[name] ?? findOnPath(name, context.env.PATH);
}

/** The first `x.y.z` in a tool's `--version`, or `null` when it prints none or fails. */
export async function toolVersion(path: string, context: CommandContext): Promise<string | null> {
  const result = await context.shell.run([path, "--version"], { env: context.env });
  if (result.code !== 0) return null;
  return /(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1] ?? null;
}
