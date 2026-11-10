// Session lockdown: what the scripted Harness is asked to start (spec 1, "The command line", "`settings.json`",
// "`mcp.json`", and "Sandbox policy").
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StartRecord } from "../../src/harness/index.ts";
import { SHADERS_RECORD, World } from "./world.ts";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

/** Sends one issue and runs the tick that starts its session. */
async function startOne(): Promise<StartRecord> {
  const issue = world.issue({ title: "Save button is blue", description: "It should be red." });
  world.send(issue);
  await world.tick();
  const start = world.harness.started[0];
  if (start === undefined) throw new Error("no session started");
  return start;
}

describe("the command line", () => {
  test("names the flow, the settings, the strict MCP config, the exact version folder, and the worktree", async () => {
    const start = await startOne();
    const { id, sessionFolder, worktree, issue } = start.session;
    expect(start.args).toEqual([
      "-p",
      `/flight-deck:flight-plan ${issue}`,
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      start.handle.uuid,
      "--setting-sources",
      "",
      "--settings",
      join(sessionFolder, "settings.json"),
      "--mcp-config",
      join(sessionFolder, "mcp.json"),
      "--strict-mcp-config",
      "--plugin-dir",
      join(world.versionFolder, "plugin"),
      "--add-dir",
      worktree,
    ]);
    expect(id).toMatch(/^[0-9a-z]{6}$/);
  });

  test("passes the stage's model when config.toml names one", async () => {
    world.config.models.plan = "claude-opus-5-5";
    await world.writeConfig();
    const start = await startOne();
    expect(start.args.slice(start.args.indexOf("--model"), start.args.indexOf("--model") + 2)).toEqual(["--model", "claude-opus-5-5"]);
  });
});

describe("mcp.json", () => {
  test("holds only Linear's HTTP server, whose headersHelper names the exact version folder and the session ID", async () => {
    const start = await startOne();
    expect(start.mcp).toEqual({
      mcpServers: {
        linear: {
          type: "http",
          url: "https://mcp.linear.app/mcp",
          headersHelper: `${join(world.versionFolder, "bin", "flight-deck")} linear-token ${start.session.id}`,
        },
      },
    });
  });
});

describe("settings.json", () => {
  test("locks the sandbox to the worktree, the session's own folder, the record's hosts, and never GitHub", async () => {
    const start = await startOne();
    const { id, worktree, sessionFolder } = start.session;
    const { root, folders, versionFolder } = world;
    const clone = join(folders.data, "repos/campdotdev/shaders/clone");
    expect(start.settings.sandbox).toEqual({
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        denyRead: [`${root}/home/`, `${root}/session-root`],
        allowRead: [
          `${root}/session-root/worktrees/${id}`,
          `${root}/session-root/sessions/${id}`,
          `${versionFolder}/skills`,
          `${versionFolder}/plugin`,
          `${root}/home/.claude/projects/${worktree.replace(/[^A-Za-z0-9]/g, "-")}`,
          clone,
          `${root}/session-root/etc`,
        ],
        allowWrite: [`${sessionFolder}/outbox`, `${sessionFolder}/tmp`, `${sessionFolder}/deps`, `${sessionFolder}/home`],
        denyWrite: [`${clone}/.git`],
      },
      network: {
        allowedDomains: ["registry.npmjs.org", "nodejs.org", "fonts.googleapis.com", "fonts.gstatic.com"],
        deniedDomains: ["github.com", "api.github.com", "uploads.github.com"],
        allowLocalBinding: true,
      },
    });
    expect(JSON.stringify(start.settings)).not.toContain("blockReadsOutsideWorkingDirectories");
  });

  test("reopens each of the record's read paths under the maintainer's home folder", async () => {
    await world.push({ ".flight-deck/record.toml": SHADERS_RECORD.replace("read_paths = []", 'read_paths = ["~/.nvm", "~/Library/pnpm/"]') });
    const start = await startOne();
    expect(start.settings.sandbox.filesystem.allowRead.slice(-2)).toEqual([`${world.root}/home/.nvm`, `${world.root}/home/Library/pnpm/`]);
  });

  test("allows the tools, the session's paths, each Linear read tool by name, and WebFetch per host, and denies GitHub", async () => {
    const start = await startOne();
    const { worktree, sessionFolder } = start.session;
    const { root, versionFolder } = world;
    const project = `${root}/home/.claude/projects/${worktree.replace(/[^A-Za-z0-9]/g, "-")}`;
    expect(start.settings.permissions).toEqual({
      defaultMode: "dontAsk",
      allow: [
        "Bash",
        "Agent",
        "Task",
        "WebSearch",
        "TaskStop",
        `Read(/${worktree}/**)`,
        `Edit(/${worktree}/**)`,
        `Read(/${sessionFolder}/deps/**)`,
        `Read(/${sessionFolder}/outbox/**)`,
        `Edit(/${sessionFolder}/outbox/**)`,
        `Read(/${sessionFolder}/inbox/**)`,
        `Read(/${versionFolder}/skills/**)`,
        `Read(/${project}/**)`,
        `Read(/${sessionFolder}/session.json)`,
        `Read(/${versionFolder}/plugin/**)`,
        "mcp__linear__get_issue",
        "mcp__linear__list_issues",
        "mcp__linear__list_comments",
        "mcp__linear__get_attachment",
        "mcp__linear__extract_images",
        "mcp__linear__get_document",
        "mcp__linear__list_documents",
        "mcp__linear__get_team",
        "mcp__linear__list_teams",
        "mcp__linear__list_issue_statuses",
        "mcp__linear__get_issue_status",
        "mcp__linear__list_issue_labels",
        "mcp__linear__get_user",
        "mcp__linear__list_users",
        "mcp__linear__get_project",
        "mcp__linear__list_projects",
        "mcp__linear__get_milestone",
        "mcp__linear__list_milestones",
        "mcp__linear__list_cycles",
        // The record's hosts, then data/docs-hosts.toml's, each once: Shaders' record lists nodejs.org too.
        "WebFetch(domain:registry.npmjs.org)",
        "WebFetch(domain:nodejs.org)",
        "WebFetch(domain:fonts.googleapis.com)",
        "WebFetch(domain:fonts.gstatic.com)",
        "WebFetch(domain:developer.mozilla.org)",
        "WebFetch(domain:docs.github.com)",
        "WebFetch(domain:www.typescriptlang.org)",
        "WebFetch(domain:react.dev)",
        "WebFetch(domain:nextjs.org)",
        "WebFetch(domain:vitest.dev)",
        "WebFetch(domain:pnpm.io)",
        "WebFetch(domain:docs.npmjs.com)",
        "WebFetch(domain:git-scm.com)",
        "WebFetch(domain:docs.python.org)",
        "WebFetch(domain:doc.rust-lang.org)",
        "WebFetch(domain:pkg.go.dev)",
        "WebFetch(domain:code.claude.com)",
      ],
      deny: ["WebFetch(domain:github.com)", "WebFetch(domain:api.github.com)", "WebFetch(domain:uploads.github.com)"],
    });
    // Never a rule for the whole Linear server, which would allow merge_diff.
    expect(start.settings.permissions.allow.filter((rule) => /^mcp__linear(__\*)?$/.test(rule) || rule.endsWith("*"))).toEqual([]);
  });

  test("turns off hooks, memory, connectors, and attribution, and excludes every CLAUDE.md above the worktree", async () => {
    const start = await startOne();
    const { root } = world;
    const above = (folder: string) => ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", ".claude/rules/**"].map((file) => join(folder, file));
    const folders = [`${root}/session-root/worktrees`, `${root}/session-root`];
    for (let folder = root; ; folder = dirname(folder)) {
      folders.push(folder);
      if (folder === "/") break;
    }
    expect(start.settings).toMatchObject({
      disableAllHooks: true,
      autoMemoryEnabled: false,
      disableClaudeAiConnectors: true,
      attribution: { commit: "", pr: "" },
      includeCoAuthoredBy: false,
      claudeMdExcludes: [`${root}/home/.claude/CLAUDE.md`, `${root}/home/.claude/rules/**`, ...folders.flatMap(above)],
    });
    expect(start.settings.claudeMdExcludes.at(-1)).toBe("/.claude/rules/**");
    expect(start.settings.apiKeyHelper).toBeUndefined();
  });

  test("holds the one env block a session gets", async () => {
    const start = await startOne();
    const folder = start.session.sessionFolder;
    const etc = `${world.root}/session-root/etc`;
    expect(start.settings.env).toEqual({
      FLIGHT_DECK_SESSION: `${folder}/session.json`,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_SHELL: "/bin/bash",
      GIT_CONFIG_GLOBAL: `${etc}/gitconfig`,
      GIT_CONFIG_NOSYSTEM: "1",
      CI: "true",
      TMP: `${folder}/tmp`,
      TEMP: `${folder}/tmp`,
      TMPDIR: `${folder}/tmp`,
      TURBO_CACHE_DIR: `${folder}/home/cache/turbo`,
      TURBO_ENV_MODE: "loose",
      WATCHPACK_POLLING: "true",
      NPM_CONFIG_USERCONFIG: `${etc}/npmrc`,
      NODE_OPTIONS: `--require ${etc}/retry-reset.cjs`,
      TURBO_CONFIG_DIR_PATH: `${folder}/home/config/turborepo`,
      VERCEL_CONFIG_DIR_PATH: `${folder}/home/config/vercel`,
      TURBO_TELEMETRY_DISABLED: "1",
      XDG_CACHE_HOME: `${folder}/home/cache`,
      XDG_DATA_HOME: `${folder}/home/data`,
      XDG_CONFIG_HOME: `${folder}/home/config`,
      XDG_STATE_HOME: `${folder}/home/state`,
      PNPM_HOME: `${folder}/home/data/pnpm`,
      pnpm_config_store_dir: `${folder}/home/data/pnpm/store`,
      npm_config_store_dir: `${folder}/home/data/pnpm/store`,
      COREPACK_HOME: `${folder}/home/data/corepack`,
      npm_config_cache: `${folder}/home/cache/npm`,
    });
  });
});

describe("the outside environment", () => {
  const planted = { ANTHROPIC_API_KEY: "sk-ant-runner", LINEAR_APP_SECRET_CAMPDOTDEV: "secret", GH_TOKEN: "ghp_runner", NODE_OPTIONS: "--inspect" };
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const [key, value] of Object.entries(planted)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("only the seven variables reach claude, and nothing else from the runner's own environment", async () => {
    const start = await startOne();
    expect(start.environment).toEqual({
      HOME: `${world.root}/home`,
      USER: process.env.USER!,
      LOGNAME: process.env.LOGNAME ?? process.env.USER!,
      SHELL: "/bin/bash",
      LANG: "en_US.UTF-8",
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    });
    // Nor does anything reach the settings file.
    expect(JSON.stringify(start.settings)).not.toMatch(/sk-ant-runner|ghp_runner|--inspect|"secret"/);
  });

  test("PATH is the registration's path, in env and outside it", async () => {
    world.config.repos[0]!.path = "/opt/pnpm/bin:/usr/bin:/bin";
    await world.writeConfig();
    const start = await startOne();
    expect(start.environment.PATH).toBe("/opt/pnpm/bin:/usr/bin:/bin");
    expect(start.settings.env.PATH).toBe("/opt/pnpm/bin:/usr/bin:/bin");
  });
});

describe("auth", () => {
  test("on a subscription, no API key, no apiKeyHelper, and no budget", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-runner";
    try {
      const start = await startOne();
      expect(start.environment.ANTHROPIC_API_KEY).toBeUndefined();
      expect(start.settings.apiKeyHelper).toBeUndefined();
      expect(start.args).not.toContain("--max-budget-usd");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  test("on an API key, apiKeyHelper runs the exact version's api-key, and --max-budget-usd is the session budget", async () => {
    world.config.auth = "api_key";
    world.config.api = { session_budget_usd: 7.5, daily_cap_usd: 40, monthly_cap_usd: 400 };
    await world.writeConfig();
    const start = await startOne();
    expect(start.settings.apiKeyHelper).toBe(`${world.versionFolder}/bin/flight-deck api-key`);
    const at = start.args.indexOf("--max-budget-usd");
    expect(start.args.slice(at, at + 2)).toEqual(["--max-budget-usd", "7.5"]);
    // After the model and before --add-dir, as the command line orders them.
    expect(at).toBeLessThan(start.args.indexOf("--add-dir"));
    expect(start.environment.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("the root AGENTS.md", () => {
  const appended = (start: StartRecord) => {
    const at = start.args.indexOf("--append-system-prompt-file");
    return at === -1 ? null : start.args[at + 1];
  };

  test("is appended when no CLAUDE.md imports it, and session.json names it", async () => {
    await world.push({ "AGENTS.md": "# Agents\n", "CLAUDE.md": "# Claude\n\nSee @docs/style.md.\n", "docs/style.md": "Style.\n" });
    const start = await startOne();
    const agents = join(start.session.worktree, "AGENTS.md");
    expect(appended(start)).toBe(agents);
    expect(start.args.slice(-2)).toEqual(["--append-system-prompt-file", agents]);
    expect(start.sessionJson.agents_md).toBe(agents);
  });

  test("is left out when the root CLAUDE.md imports it", async () => {
    await world.push({ "AGENTS.md": "# Agents\n", "CLAUDE.md": "@AGENTS.md\n" });
    const start = await startOne();
    expect(appended(start)).toBeNull();
    expect(start.sessionJson.agents_md).toBeNull();
  });

  test("is left out when .claude/CLAUDE.md imports it through a nested import", async () => {
    await world.push({ "AGENTS.md": "# Agents\n", ".claude/CLAUDE.md": "Read @../docs/agents.md first.\n", "docs/agents.md": "- @./../AGENTS.md\n" });
    const start = await startOne();
    expect(appended(start)).toBeNull();
    expect(start.sessionJson.agents_md).toBeNull();
  });

  test("is appended when the only mentions sit in a code span or a code block", async () => {
    await world.push({ "AGENTS.md": "# Agents\n", "CLAUDE.md": "Not `@AGENTS.md`.\n\n```\n@AGENTS.md\n```\n\nNor me@AGENTS.md.\n" });
    const start = await startOne();
    expect(appended(start)).toBe(join(start.session.worktree, "AGENTS.md"));
  });

  test("is appended when the import sits deeper than Claude Code reads", async () => {
    // CLAUDE.md and four hops load. AGENTS.md would be the fifth hop.
    await world.push({
      "AGENTS.md": "# Agents\n",
      "CLAUDE.md": "@a.md\n",
      "a.md": "@b.md\n",
      "b.md": "@c.md\n",
      "c.md": "@d.md\n",
      "d.md": "@AGENTS.md\n",
    });
    expect(appended(await startOne())).not.toBeNull();
  });

  test("is left out when the import is the fourth hop, the deepest Claude Code reads", async () => {
    await world.push({ "AGENTS.md": "# Agents\n", "CLAUDE.md": "@a.md\n", "a.md": "@b.md\n", "b.md": "@c.md\n", "c.md": "@AGENTS.md\n" });
    expect(appended(await startOne())).toBeNull();
  });

  test("is left out, with no flag, when the worktree has none", async () => {
    await world.push({ "CLAUDE.md": "@AGENTS.md\n" });
    const start = await startOne();
    expect(appended(start)).toBeNull();
    expect(start.sessionJson.agents_md).toBeNull();
  });
});

describe("etc/", () => {
  const etc = (name: string) => join(world.folders.sessionRoot, "etc", name);
  const userName = () => Bun.spawnSync(["git", "config", "--file", etc("gitconfig"), "--get", "user.name"]).stdout.toString().trim();

  test("is written at the runner's first poll, before any session starts", async () => {
    await world.tick();
    expect(userName()).toBe("Flight Deck Bot");
    expect(await readFile(etc("npmrc"), "utf8")).toContain("registry=https://registry.npmjs.org/\n");
    expect(await readFile(etc("retry-reset.cjs"), "utf8")).toContain("ECONNRESET");
  });

  test("is written again when [machine_user] changes, and not at a poll where it didn't", async () => {
    await world.tick();
    await writeFile(etc("retry-reset.cjs"), "// changed\n");
    await world.tick();
    expect(await readFile(etc("retry-reset.cjs"), "utf8")).toBe("// changed\n");

    world.config.machine_user = { login: "factory-bot", id: 2, name: "Factory Bot", email: "2+factory-bot@users.noreply.github.com" };
    await world.writeConfig();
    await world.tick();
    expect(userName()).toBe("Factory Bot");
    expect(await readFile(etc("retry-reset.cjs"), "utf8")).toContain("ECONNRESET");
  });

  test("is written again at each start", async () => {
    await world.tick();
    await writeFile(etc("retry-reset.cjs"), "// changed\n");
    world.restart();
    await world.tick();
    expect(await readFile(etc("retry-reset.cjs"), "utf8")).toContain("ECONNRESET");
  });
});
