// What a session is started with: the command line, `settings.json`, `mcp.json`, the outside environment, and
// the root `AGENTS.md` (spec 1, "The command line", "`settings.json`", "`mcp.json`", ADRs 0002, 0005, and 0007).
// Both Harness adapters start a session from the same launch, so a scenario sees the exact settings a real
// session gets. Sandbox policy builds the `sandbox` block, Workspace the `env` block, and this the rest.
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { userInfo } from "node:os";
import docsHosts from "../../../data/docs-hosts.toml";
import { paths, sessionParts, type Folders } from "../folders/index.ts";
import type { RepoRecord } from "../record/index.ts";
import { GITHUB_HOSTS, sandboxPolicy, type SessionSandbox } from "../sandbox-policy/index.ts";
import type { Stage } from "../state/index.ts";
import type { SessionJson } from "../workspace/index.ts";
import { agentsMdToAppend } from "./agents-md.ts";

/** Each Linear read tool a session may call, by name. Never a rule for the whole server, which would allow `merge_diff`. */
export const LINEAR_READ_TOOLS = [
  "get_issue",
  "list_issues",
  "list_comments",
  "get_attachment",
  "extract_images",
  "get_document",
  "list_documents",
  "get_team",
  "list_teams",
  "list_issue_statuses",
  "get_issue_status",
  "list_issue_labels",
  "get_user",
  "list_users",
  "get_project",
  "list_projects",
  "get_milestone",
  "list_milestones",
  "list_cycles",
] as const;

/** The documentation hosts every session's WebFetch may reach, from `data/docs-hosts.toml`. */
export const DOCS_HOSTS: readonly string[] = (docsHosts as { hosts: string[] }).hosts;

const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";

/** How the session pays: the subscription, or an API key with a budget per session (ADR 0005, 0007). */
export type Auth = { kind: "subscription" } | { kind: "api_key"; sessionBudgetUsd: number };

export interface LaunchInput {
  folders: Folders;
  id: string;
  stage: Stage;
  /** `owner/repo`, or `""` for a trial. */
  repo: string;
  /** The issue's identifier, which the flow's prompt names, or `""` for a trial. */
  issue: string;
  worktree: string;
  sessionFolder: string;
  /** The record at the session's commit, or `null` for a trial, which has none. */
  record: Pick<RepoRecord, "sandbox"> | null;
  /** The `env` block from Workspace's `prepare`. Its `PATH` is the outside `PATH` too. */
  env: Record<string, string>;
  /** The stage's model from `config.toml`, or `""` for Claude Code's default. */
  model: string;
  auth: Auth;
  /** The exact version folder, never `current` (ADR 0015). */
  versionFolder: string;
  /** The runner's own environment, for `USER` and `LOGNAME`. Nothing else from it reaches a session. */
  environment?: Record<string, string | undefined>;
}

export interface Settings {
  permissions: { defaultMode: "dontAsk"; allow: string[]; deny: string[] };
  sandbox: SessionSandbox;
  disableAllHooks: true;
  autoMemoryEnabled: false;
  disableClaudeAiConnectors: true;
  attribution: { commit: ""; pr: "" };
  includeCoAuthoredBy: false;
  claudeMdExcludes: string[];
  apiKeyHelper?: string;
  env: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, { type: "http"; url: string; headersHelper: string }>;
}

/** Everything `start` needs to run `claude`, apart from the binary's own path. */
export interface Launch {
  /** The UUID Claude Code gets as `--session-id`. */
  uuid: string;
  /** The arguments after `<claude>`. */
  args: string[];
  /** The whole environment `claude` starts with. */
  environment: Record<string, string>;
  settings: Settings;
  mcp: McpConfig;
  /** The root `AGENTS.md` when the session appends it, or `null`. `session.json`'s `agents_md` matches. */
  agentsMd: string | null;
  /** Where `settings.json` and `mcp.json` go. */
  settingsPath: string;
  mcpPath: string;
  sessionJson: string;
}

const FLOWS: Partial<Record<Stage, string>> = { plan: "flight-plan", build: "flight-build", check: "flight-check", debrief: "flight-debrief" };

export async function buildLaunch(input: LaunchInput): Promise<Launch> {
  const { folders, worktree, sessionFolder, versionFolder } = input;
  const parts = sessionParts(sessionFolder);
  const flow = FLOWS[input.stage];
  const trial = input.stage === "trial";
  if (flow === undefined && !trial) throw new Error(`the Harness can't start a ${input.stage} session yet`);
  if (trial !== (input.record === null)) throw new Error("a trial, and only a trial, starts with no record");
  const uuid = randomUUID();
  const agentsMd = await agentsMdToAppend(worktree, folders.home);
  const bin = paths.bin(versionFolder);

  const args = [
    "-p",
    // A trial's prompt is its instructions (spec 1, "The command line").
    trial ? trialPrompt(parts.sessionJson, parts.outbox) : `/flight-deck:${flow} ${input.issue}`,
    "--output-format",
    "stream-json",
    "--verbose",
    "--session-id",
    uuid,
    "--setting-sources",
    "",
    "--settings",
    parts.settingsJson,
    "--mcp-config",
    parts.mcpJson,
    "--strict-mcp-config",
    "--plugin-dir",
    join(versionFolder, "plugin"),
    ...(input.model === "" ? [] : ["--model", input.model]),
    ...(input.auth.kind === "api_key" ? ["--max-budget-usd", String(input.auth.sessionBudgetUsd)] : []),
    "--add-dir",
    worktree,
    ...(agentsMd === null ? [] : ["--append-system-prompt-file", agentsMd]),
  ];

  const readOnly = (path: string) => `Read(${rulePath(path)})`;
  const readWrite = (path: string) => [`Read(${rulePath(path)})`, `Edit(${rulePath(path)})`];
  const settings: Settings = {
    permissions: {
      defaultMode: "dontAsk",
      allow: [
        "Bash",
        "Agent",
        "Task",
        "WebSearch",
        "TaskStop",
        ...readWrite(join(worktree, "**")),
        // The worktree's dependency folders are symlinks into deps/, which counts as part of the worktree (ADR 0018).
        readOnly(join(parts.deps, "**")),
        ...readWrite(join(parts.outbox, "**")),
        readOnly(join(parts.inbox, "**")),
        readOnly(join(versionFolder, "skills", "**")),
        // Where Claude Code saves an MCP result too large to return inline.
        readOnly(join(paths.claudeProject(folders, worktree), "**")),
        readOnly(parts.sessionJson),
        readOnly(join(versionFolder, "plugin", "**")),
        ...LINEAR_READ_TOOLS.map((tool) => `mcp__linear__${tool}`),
        ...unique([...(input.record?.sandbox.hosts ?? []), ...DOCS_HOSTS]).map((host) => `WebFetch(domain:${host})`),
      ],
      // WebFetch runs outside the sandbox, and a deny rule outranks any allow rule (ADR 0007).
      deny: GITHUB_HOSTS.map((host) => `WebFetch(domain:${host})`),
    },
    sandbox:
      input.record === null
        ? sandboxPolicy({ kind: "trial", folders, versionFolder, worktree, sessionFolder })
        : sandboxPolicy({ kind: "session", folders, repo: input.repo, record: input.record, versionFolder, worktree, sessionFolder }),
    disableAllHooks: true,
    autoMemoryEnabled: false,
    disableClaudeAiConnectors: true,
    attribution: { commit: "", pr: "" },
    includeCoAuthoredBy: false,
    claudeMdExcludes: claudeMdExcludes(folders.home, worktree),
    ...(input.auth.kind === "api_key" ? { apiKeyHelper: `${shellWord(bin)} api-key` } : {}),
    env: input.env,
  };

  // The session ID is an argument, because the helper may not see the `env` block (spec 1, "Session credentials").
  // A trial gets no Linear server and no Reader token.
  const mcp: McpConfig = {
    mcpServers: trial ? {} : { linear: { type: "http", url: LINEAR_MCP_URL, headersHelper: `${shellWord(bin)} linear-token ${input.id}` } },
  };

  const path = input.env.PATH;
  if (path === undefined) throw new Error("the env block has no PATH");
  const outside = input.environment ?? process.env;
  const user = outside.USER ?? userInfo().username;
  // Only these seven reach `claude` from outside `env`. On a subscription that leaves out ANTHROPIC_API_KEY,
  // and on an API key `apiKeyHelper` prints it (ADR 0005).
  const environment: Record<string, string> = {
    HOME: folders.home,
    USER: user,
    LOGNAME: outside.LOGNAME ?? user,
    SHELL: "/bin/bash",
    LANG: "en_US.UTF-8",
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1",
    PATH: path,
  };

  return { uuid, args, environment, settings, mcp, agentsMd, settingsPath: parts.settingsJson, mcpPath: parts.mcpJson, sessionJson: parts.sessionJson };
}

/** Writes `settings.json` and `mcp.json` into the session folder, and sets `session.json`'s `agents_md`. */
export async function writeLaunch(launch: Launch): Promise<void> {
  await writeFile(launch.settingsPath, `${JSON.stringify(launch.settings, null, 2)}\n`);
  await writeFile(launch.mcpPath, `${JSON.stringify(launch.mcp, null, 2)}\n`);
  const json = JSON.parse(await readFile(launch.sessionJson, "utf8")) as SessionJson;
  await writeFile(launch.sessionJson, `${JSON.stringify({ ...json, agents_md: launch.agentsMd }, null, 2)}\n`);
}

/** A trial's prompt: read `session.json`, run `true` in sandboxed Bash, write `summary.md`, and stop. */
function trialPrompt(sessionJson: string, outbox: string): string {
  return [
    "This is a Flight Deck trial run. It checks that a session starts, reads its files, and runs a command in the sandbox.",
    "",
    `1. Read ${sessionJson}.`,
    "2. Run `true` with the Bash tool, inside the sandbox.",
    `3. Write one line that says the trial ran to ${join(outbox, "summary.md")}.`,
    "4. Stop.",
  ].join("\n");
}

/** Where the Harness records the UUID Claude Code got: `transcripts/<session-id>.uuid`, beside the transcript. */
export function transcriptUuid(transcript: string): string {
  return transcript.replace(/\.jsonl$/, ".uuid");
}

/**
 * The home folder's `CLAUDE.md` and rules, and each folder's above the worktree up to `/`, by absolute path,
 * because `claudeMdExcludes` ignores a pattern that starts with `~` (ADR 0007).
 */
function claudeMdExcludes(home: string, worktree: string): string[] {
  const excludes = [join(home, ".claude", "CLAUDE.md"), join(home, ".claude", "rules", "**")];
  let folder = dirname(worktree);
  for (;;) {
    excludes.push(join(folder, "CLAUDE.md"), join(folder, "CLAUDE.local.md"), join(folder, ".claude", "CLAUDE.md"), join(folder, ".claude", "rules", "**"));
    if (folder === parse(folder).root) break;
    folder = dirname(folder);
  }
  return excludes;
}

/** A permission rule's absolute path is written `//<path>`. */
function rulePath(path: string): string {
  return `/${path}`;
}

/** A helper is a shell command, so a path with a character the shell reads goes in single quotes. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
