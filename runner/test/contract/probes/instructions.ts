// The instructions probe's throwaway repo (spec 1, "Toolchain", ADR 0007). Every file holds its own canary line,
// `CANARY-<NAME>-<token>`, so the session's answers show which files reached it.

/** The canaries that must reach the session, and its subagent apart from `AGENTS`. */
export const REACH = ["ROOT", "DOTCLAUDE", "IMPORTED", "RULE", "AGENTS"] as const;
/** The canaries that must never reach it. `SETTINGS` is the `env` variable the repo's settings set. */
export const NEVER = ["SCOPED", "SUB", "OUTSIDE", "HOME", "ABOVE", "SKILL", "AGENT", "SETTINGS"] as const;

export type Canary = (typeof REACH)[number] | (typeof NEVER)[number];

export function canary(name: Canary, token: string): string {
  return `CANARY-${name}-${token}`;
}

/** The home file the root `CLAUDE.md` imports as `@~/<name>`. */
export function homeFile(token: string): string {
  return `fd-instructions-probe-${token}.md`;
}

export const VARIABLE = "FD_PROBE_VAR";

/**
 * The repo's files. The root `CLAUDE.md` imports a file inside the worktree, `../outside.md`, and `~/<home file>`,
 * and imports `AGENTS.md` only with `importsAgentsMd`, which turns `--append-system-prompt-file` off.
 */
export function instructionsRepo(token: string, options: { importsAgentsMd?: boolean } = {}): Record<string, string> {
  const c = (name: Canary) => canary(name, token);
  return {
    "CLAUDE.md": ["# The instructions probe's repo", "", c("ROOT"), "", "@docs/imported.md", "", "@../outside.md", "", `@~/${homeFile(token)}`, ...(options.importsAgentsMd === true ? ["", "@AGENTS.md"] : []), ""].join("\n"),
    "docs/imported.md": `${c("IMPORTED")}\n`,
    ".claude/CLAUDE.md": `${c("DOTCLAUDE")}\n`,
    ".claude/rules/general.md": `${c("RULE")}\n`,
    ".claude/rules/scoped.md": `---\npaths:\n  - "sub/**"\n---\n\n${c("SCOPED")}\n`,
    "sub/CLAUDE.md": `${c("SUB")}\n`,
    "sub/notes.txt": "Notes the probe's session reads.\n",
    "AGENTS.md": `${c("AGENTS")}\n`,
    ".claude/skills/probe-skill/SKILL.md": `---\nname: probe-skill\ndescription: The instructions probe's skill, which must not load.\n---\n\n${c("SKILL")}\n`,
    ".claude/agents/probe-agent.md": `---\nname: probe-agent\ndescription: The instructions probe's subagent, which must not load.\n---\n\n${c("AGENT")}\n`,
    ".claude/settings.json": `${JSON.stringify({ env: { [VARIABLE]: c("SETTINGS") } }, null, 2)}\n`,
  };
}

/** The canaries in `text`, by name. */
export function canariesIn(text: string, token: string): Canary[] {
  return [...REACH, ...NEVER].filter((name) => text.includes(canary(name, token)));
}
