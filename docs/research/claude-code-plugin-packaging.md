# How a Claude Code plugin installs from GitHub, and whether it can ship a background runner

Research for [FLD-7](https://linear.app/campdotdev/issue/FLD-7/how-is-a-claude-code-plugin-installed-from-github-and-can-it-ship-a). All sources were fetched on 2026-10-16. The Claude Code docs describe releases up to v2.1.302, the newest entry in the changelog [S24]. Several features below name a minimum version, and the note gives it where the docs do.

## Answer

**Install.** A GitHub repo becomes installable once it has a `.claude-plugin/marketplace.json` that lists one or more plugins. The user registers the repo once with `claude plugin marketplace add owner/repo`, then runs `claude plugin install <plugin>@<marketplace>`. On v2.1.292 or later, `claude plugin install <plugin> --marketplace owner/repo` does both in one command [S4]. One repo can be both the marketplace and the plugin: Matt Pocock's repo does this with `"source": "./"` [S26].

**Contents.** A plugin can hold skills, legacy commands, subagents, hooks, MCP servers, LSP servers, monitors, a `bin/` folder of executables, workflows, output styles, themes, default settings, `userConfig` prompts, and channels [S1].

**Versions and updates.** Claude Code copies each version into its own cache directory and updates only when the computed version changes. That version comes from `version` in `plugin.json`, then from the marketplace entry, then from the commit SHA [S9]. Auto-update is off by default for any marketplace Anthropic doesn't own, and `marketplace.json` has no field to turn it on. Each user turns it on in `/plugin`, or a settings file sets `autoUpdate` [S7] [S13].

**Background runner.** A plugin can start processes, but every process it declares lives and dies with a Claude Code session. Monitors and MCP servers start with the session and stop when it ends [S2] [S15]. No manifest key declares a process that outlives sessions, and none declares a scheduled job [S1]. A hook can launch a fully detached process, and the docs say so, but Claude Code doesn't track or stop it [S14]. A runner that keeps going between sessions has to be Flight Deck's own process, started by something outside the plugin system. On a Mac that means launchd or the user's shell. Claude Code's own background sessions, `claude --bg` and `/loop`, are the closest built-in options [S17] [S19].

**Depending on Matt Pocock's skills.** `plugin.json` takes a `dependencies` array. A dependency in another marketplace installs only when the depending plugin's marketplace lists that marketplace in `allowCrossMarketplaceDependenciesOn` [S10]. Matt Pocock's skills ship as the plugin `mattpocock-skills`, listed both in his own `mattpocock` marketplace and in Anthropic's `claude-plugins-official` [S25] [S26]. A version range won't resolve against his repo, because version ranges need `mattpocock-skills--v<version>` git tags and his repo tags `v1.3.1` [S10] [S26].

**`npx skills add`.** The `skills` CLI from `vercel-labs/skills` copies `SKILL.md` folders into `.agents/skills/` and symlinks them into `.claude/skills/` [S27] [S28]. It works in 79 agents, according to its README, but it gives up hooks, MCP servers, subagents, `bin/`, monitors, plugin dependencies, skill namespacing, and auto-update.

## Sources

Every source was fetched on 2026-10-16. The Claude Code docs pages were read as raw Markdown from the `.md` URL of each page.

| ID | Source |
| :- | :- |
| S1 | [Plugin manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference) |
| S2 | [Add components to a plugin](https://code.claude.com/docs/en/plugins/components) |
| S3 | [Plugins overview](https://code.claude.com/docs/en/plugins/overview) |
| S4 | [Install and manage plugins](https://code.claude.com/docs/en/plugins/install) |
| S5 | [Create a marketplace](https://code.claude.com/docs/en/plugins/create-marketplace) |
| S6 | [Marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference) |
| S7 | [Host and maintain a marketplace](https://code.claude.com/docs/en/plugins/host-marketplace) |
| S8 | [Publish and distribute a plugin](https://code.claude.com/docs/en/plugins/publish) |
| S9 | [Plugin loading reference](https://code.claude.com/docs/en/plugins/loading) |
| S10 | [Plugin dependencies](https://code.claude.com/docs/en/plugins/dependencies) |
| S11 | [Plugin commands reference](https://code.claude.com/docs/en/plugins/cli-reference) |
| S12 | [Troubleshoot plugins](https://code.claude.com/docs/en/plugins/troubleshooting) |
| S13 | [Settings reference](https://code.claude.com/docs/en/settings-reference), `enabledPlugins` and `extraKnownMarketplaces` |
| S14 | [Hooks reference](https://code.claude.com/docs/en/hooks) |
| S15 | [MCP](https://code.claude.com/docs/en/mcp), "Plugin-provided MCP servers" |
| S16 | [Skills](https://code.claude.com/docs/en/skills) |
| S17 | [Run prompts on a schedule](https://code.claude.com/docs/en/scheduled-tasks) |
| S18 | [Schedule recurring tasks in Claude Code Desktop](https://code.claude.com/docs/en/desktop-scheduled-tasks) |
| S19 | [Manage multiple agents with agent view](https://code.claude.com/docs/en/agent-view) |
| S20 | [Channels](https://code.claude.com/docs/en/channels) |
| S21 | [Run Claude Code programmatically](https://code.claude.com/docs/en/headless) |
| S22 | [Plugins in the SDK](https://code.claude.com/docs/en/agent-sdk/plugins) |
| S23 | [Plugin security and trust](https://code.claude.com/docs/en/plugins/security) |
| S24 | [`anthropics/claude-code` `CHANGELOG.md`](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) |
| S25 | [`anthropics/claude-plugins-official` `.claude-plugin/marketplace.json`](https://github.com/anthropics/claude-plugins-official/blob/main/.claude-plugin/marketplace.json) |
| S26 | [`mattpocock/skills`](https://github.com/mattpocock/skills): `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, `README.md`, and the repo's tag list |
| S27 | [`vercel-labs/skills` `README.md`](https://github.com/vercel-labs/skills), latest release v1.7.2 published 2026-10-09 |
| S28 | `vercel-labs/skills` source: `src/installer.ts`, `src/agents.ts`, `src/skill-lock.ts`, `src/local-lock.ts`, `src/plugin-manifest.ts` |
| S29 | Apple, [Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html) |
| S30 | [Orchestrate subagents at scale with dynamic workflows](https://code.claude.com/docs/en/workflows) |

## What a plugin can contain

A plugin is a directory. The manifest at `.claude-plugin/plugin.json` is optional, and `name` is its only required field. Without a manifest, Claude Code loads whatever it finds in the default locations [S1].

| Component | Default location | What it does |
| :- | :- | :- |
| Skills | `skills/<name>/SKILL.md` | Run as `/<plugin>:<skill>`. The bare `/<skill>` also works unless another command already uses that name [S16] |
| Commands | `commands/*.md` | The older format. The docs say to prefer skills [S1] |
| Agents | `agents/*.md` | Subagent definitions, named `<plugin>:<agent>` [S1] |
| Hooks | `hooks/hooks.json` | Registered when the session loads the plugin and fire on their events from then on, whether or not a plugin skill runs [S2] |
| MCP servers | `.mcp.json` | Start at session startup for enabled plugins. Tools are named `mcp__plugin_<plugin>_<server>__<tool>` [S15] |
| LSP servers | `.lsp.json` | Language servers for code intelligence [S1] |
| Monitors | `monitors/monitors.json`, under the `experimental.monitors` key | A shell command that runs in the background for the session. Each line it prints reaches Claude as a notification [S2] |
| Executables | `bin/` | On the Bash tool's `PATH` while the plugin is enabled, after the user's own entries, so a plugin can't shadow `git` [S2] |
| Workflows | `workflows/*.js` | Scripts that run many subagents in the background of a session, as `/<plugin>:<name>` [S30] |
| Output styles and themes | `output-styles/`, `themes/` | Appear in `/output-style` and `/theme` [S2] |
| Settings | `settings.json` | Only `agent` and `subagentStatusLine` take effect. `agent` runs one of the plugin's agents as the main thread [S2] |

The manifest can also declare these [S1]:

- `userConfig`: values Claude Code asks the user for when the plugin is enabled. A `sensitive` value goes to the system credential store. `claude plugin install` from the shell never prompts. Pass `--config KEY=VALUE` instead [S2].
- `channels`: an MCP server that pushes outside events into a running session. Channels are a research preview, and `--channels` accepts only plugins on an Anthropic allowlist or an organization allowlist. A custom channel needs `--dangerously-load-development-channels` [S20].
- `dependencies`: other plugins that must be enabled. See [Depend on another plugin's skills](#depend-on-another-plugins-skills).

Three path variables let a plugin find its files [S1]:

- `${CLAUDE_PLUGIN_ROOT}` is the installed version's directory. It changes on every update, so the docs say not to write state there.
- `${CLAUDE_PLUGIN_DATA}` is `~/.claude/plugins/data/<id>/`. It survives updates, and Claude Code deletes it by default when the plugin is uninstalled from its last scope.
- `${CLAUDE_PROJECT_DIR}` is the project root.

These variables aren't set in the environment of commands Claude runs through the Bash tool. In skill, command, and agent content, Claude Code substitutes them inline when it loads the text [S1].

A plugin with a `package.json` and an npm or Bun lockfile gets its Node packages installed into the cache at install and update time. That install accepts only registry packages pinned in the lockfile, runs with `--ignore-scripts`, and stops after 60 seconds. For anything else, the docs show a `SessionStart` hook that installs into `${CLAUDE_PLUGIN_DATA}` [S2] [S9].

Every enabled plugin costs context on every turn. The name and description of each skill, agent, and command that Claude can invoke on its own sit in context whether or not anything from the plugin runs [S3].

## Install from GitHub

### Register a marketplace, then install a plugin from it

A marketplace is a directory or repo with `.claude-plugin/marketplace.json`. The file needs `name`, `owner`, and a `plugins` array, and each entry needs `name` and `source` [S5] [S6]. A plugin's `source` can be a relative path inside the marketplace repo, another GitHub repo, any git URL, a subdirectory of a git repo, a zip archive, an npm package, or a command that prints a directory [S6]. The git-based sources accept `ref` and `sha` to pin a branch, tag, or commit [S6].

The user's side [S4] [S11]:

1. `claude plugin marketplace add owner/repo` registers the marketplace. `owner/repo#ref` pins a branch or tag. The command writes the marketplace to `extraKnownMarketplaces` in user settings unless `--scope project` or `--scope local` says otherwise.
2. `claude plugin install <plugin>@<marketplace>` installs at user scope. `--scope project` or `--scope local` picks another scope.

Inside a session, `/plugin install <plugin> --marketplace owner/repo` adds and installs in one step on v2.1.275 or later. From the shell, `claude plugin install <plugin> --marketplace owner/repo` does the same on v2.1.292 or later, with no confirmation prompt [S4].

Before install, Claude Code shows the same trust warning for every marketplace: "Make sure you trust a plugin before installing, updating, or using it" [S23].

The docs suggest that a tool with its own installer print or run these two commands for the user [S8]. Without a marketplace, a user can clone the repo and load it for one session with `claude --plugin-dir <path>`, or move the plugin directory under `~/.claude/skills/` to load it in every session [S8].

### One repo can be the marketplace and the plugin

Matt Pocock's repo has both `.claude-plugin/marketplace.json` and `.claude-plugin/plugin.json` at its root. The marketplace is named `mattpocock`, and its single entry, `mattpocock-skills`, uses `"source": "./"`. The manifest lists 27 skill directories in its `skills` key [S26]. The docs allow `"."` for the marketplace root [S6].

### Scopes decide who gets the plugin

| Scope | Settings file | Reaches |
| :- | :- | :- |
| User | `~/.claude/settings.json` | The user, in every project on the machine |
| Project | `.claude/settings.json`, committed | Everyone who clones the repo, but each person still installs the plugin once |
| Local | `.claude/settings.local.json` | The user, in this repo only |

Sources: [S4] [S13]. When the same plugin is set at several scopes, local overrides project, and project overrides user [S9].

The terminal, the Desktop app's local sessions, and the VS Code extension read the same settings files, so a user-scope install reaches all three. A cloud session doesn't load plugins from local settings [S3].

A plugin enabled only in a project's `.claude/settings.json` is not fetched onto a machine that hasn't installed it, unless its source is a relative path inside the marketplace [S9].

### Versions and updates follow the computed version

Claude Code computes a version for each install and uses it to decide whether an update changes anything [S9]:

1. The `version` field in `plugin.json` comes first.
2. The `version` in the marketplace entry comes next.
3. With neither set, a `github`, `url`, or `git-subdir` source uses the commit SHA, shortened to 12 characters.

A pinned `"version": "1.0.0"` keeps every user on the cached copy until the author changes the string, however many commits land [S9]. The docs give two options: bump `version` on every release, or omit it from both files so users track commits [S7].

Auto-update runs in an interactive session after the first message, following a random delay of up to ten minutes. It refreshes each marketplace that has auto-update on and updates its plugins on disk. The running session keeps the version it loaded until `/reload-plugins` or the next launch [S9]. Auto-update is on by default for `claude-plugins-official` and off for third-party marketplaces [S4]. `marketplace.json` has no field to turn it on. Each user selects **Enable auto-update** in `/plugin`, or a settings file sets `"autoUpdate": true` on the marketplace's `extraKnownMarketplaces` entry [S7] [S13]. Without auto-update, users run `claude plugin update <plugin>@<marketplace>` [S8].

Claude Code has no release-channel concept. For stable and early-access tracks, the docs suggest two marketplaces with different names that point at different refs [S7].

### Installed files live in a per-version cache

Installed copies go to `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, and `${CLAUDE_PLUGIN_ROOT}` points there. When a plugin updates, Claude Code marks the old version directory and deletes it 14 days later [S9]. After a mid-session update, hooks, MCP servers, and LSP servers keep the old path until `/reload-plugins`. Monitors keep it until the session restarts [S9].

## Long-running processes and scheduled jobs

### Every process a plugin declares is tied to a session

| Mechanism | Starts | Stops | Limits |
| :- | :- | :- | :- |
| Monitor | At session start, or the first time a named skill runs with `"when": "on-skill-invoke:<skill>"` | When the session ends. Disabling the plugin mid-session doesn't stop it | Interactive sessions only, never with `-p`. Not on Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry. Can't read `userConfig` values. Lives under `experimental`, so the manifest shape may still change |
| MCP server | At session startup | When the session ends or the plugin is disabled | Runs in every session where the plugin is enabled |
| LSP server | Not stated in the docs | Not stated in the docs. `restartOnCrash` defaults to `true` | Speaks LSP over stdio, and `shutdownTimeout` bounds a graceful stop |
| Async hook | On its hook event | Runs without a timeout. With `-p`, Claude Code kills it at teardown | Results reach Claude on the next turn |

Sources: [S1] [S2] [S3] [S14] [S15].

Monitors run with the user's full permissions and outside the sandbox [S2]. A plugin checked into a repo, through `.claude/skills/` or project settings, loads only after the workspace trust dialog. For such a plugin, background monitors don't load, and its MCP servers need the same per-server approval as a project `.mcp.json` [S9]. Personal-scope plugins have none of these restrictions [S9].

### Nothing in the plugin system outlives a session, except what a hook detaches

The manifest has no key for a daemon, a service, or a scheduled job. Its full field list covers the components above and nothing more [S1]. Claude Code strips an unrecognized top-level key and loads the plugin anyway [S1].

The hooks reference covers one escape hatch: "If your hook's work must outlive a `claude -p` session, start a fully detached process from it" [S14]. It also says how to do this safely. Print the hook's decision first, then start the background process with its stdout and stderr redirected, or Claude Code may block the tool call [S14]. A `SessionStart` hook supports only `command` and `mcp_tool` types, and the docs ask that it stay fast [S14]. Nothing in the docs says that Claude Code tracks, restarts, or stops a process a hook detaches.

A `bin/` executable runs only when Claude or a skill's instructions call it through the Bash tool [S2]. A `bin/` script could write a launchd agent plist, but no Claude Code doc covers that pattern. On macOS, per-user agents live in `~/Library/LaunchAgents`, and launchd loads them at login. `StartInterval` and `StartCalendarInterval` schedule a job, and `KeepAlive` keeps one running [S29]. Any such job would run outside Claude Code's knowledge.

### Scheduled jobs come from three places, and none is a plugin key

| | `/loop` and the cron tools | Desktop scheduled task | Cloud routine |
| :- | :- | :- | :- |
| Runs on | The user's machine | The user's machine | Anthropic's cloud |
| Needs an open session | Yes | No, but the Desktop app must be open and the machine awake | No |
| Local files | Yes | Yes | No, it uses a fresh clone |
| Lifetime | Recurring tasks expire after 7 days | Persistent | Persistent |
| Minimum interval | 1 minute | 1 minute | 1 hour |

Sources: [S17] [S18].

Details that matter for packaging:

- A `/loop` fire runs only skills that Claude may invoke on its own. A skill marked `disable-model-invocation: true` reaches Claude as plain text instead [S17].
- Desktop tasks are created on the Desktop app's **Routines** page, or by asking Claude in a Desktop session. Each task's prompt is stored at `~/.claude/scheduled-tasks/<task-name>/SKILL.md`, but its schedule, folder, and model are not in that file [S18].
- A Desktop task that a sleeping machine misses gets one catch-up run on wake, for the most recent missed time [S18].

### Claude Code's own supervisor keeps background sessions running

`claude --bg "<prompt>"` starts a session under a supervisor process that Claude Code starts and manages. The session keeps running after the terminal closes. `claude agents` lists these sessions, and `claude agents --json` reads them from a script [S19]. A session with a pending `/loop` wakeup counts as working, so the supervisor keeps its process alive [S19]. Sessions survive sleep and stop when the machine shuts down. Agent view is a research preview [S19].

On macOS, the background session host asks for access to protected folders such as `~/Documents` separately from the terminal. Without that access, a background session gets `Operation not permitted` [S19].

A non-interactive `claude -p` run loads installed plugins the way an interactive session does, unless `--bare` is passed [S21]. The Agent SDK loads plugins only from local paths, with `plugins: [{ type: "local", path }]`, so a plugin from a marketplace has to be on disk first [S22].

## Depend on another plugin's skills

Dependencies go in the `dependencies` array of `plugin.json` or in the marketplace entry. Each item is `"name"`, `"name@marketplace"`, or `{ "name", "marketplace", "version" }` [S10]. Installing a plugin installs and enables its dependencies at the same scope. Uninstalling leaves auto-installed dependencies until `claude plugin prune` [S4].

Cross-marketplace dependencies have three rules [S10]:

- A bare name resolves in the depending plugin's own marketplace.
- A dependency from another marketplace installs only when the root marketplace lists that marketplace in `allowCrossMarketplaceDependenciesOn`.
- If the allowlist is missing and the dependency is declared in `plugin.json`, the install completes without the dependency, and the plugin then fails to load.

The allowlist check is skipped when the user already has the dependency enabled at the same scope [S10]. When a dependency's marketplace isn't registered, the troubleshooting page tells the user to add it and run `/reload-plugins` [S12].

A version range such as `^1.3` resolves against git tags named `<plugin-name>--v<version>` on the repo that hosts the dependency. When no tag matches and the plugin has its own repo, the install fails [S10]. For an `npm`, `archive`, or `command` source, the range is checked only at load time [S10].

Matt Pocock's skills, as of 2026-10-16:

- His repo is a marketplace named `mattpocock` with one plugin, `mattpocock-skills`, at `version` 1.3.1 [S26].
- `claude-plugins-official` also lists `mattpocock-skills`, as a `url` source pinned to commit `49dd158d1076134a641b33efb035946536778336` [S25]. His README gives `claude plugin install mattpocock-skills@claude-plugins-official` as the Claude Code install command [S26].
- Claude Code registers `claude-plugins-official` the first time the user starts an interactive terminal session [S3]. Auto-update is on by default for that marketplace [S4].
- His tags are `v1.0.0` through `v1.3.1`, plus `mattpocock-skills@1.0.0`. None follows the `mattpocock-skills--v<version>` form, so a versioned dependency on his plugin finds no tag [S26] [S10].
- His README warns that installing both the plugin and the `npx skills` copy "gives you every skill twice" [S26].

Plugin skills are namespaced, so a Flight Deck skill would invoke his `tdd` skill as `/mattpocock-skills:tdd`. Plain `/tdd` also works when no other command claims the name [S16].

## Alternatives to a marketplace plugin

### `npx skills add` copies skill folders only

`npx skills add owner/repo` finds `SKILL.md` files in the repo's `skills/` folder, in agent folders such as `.claude/skills/`, and at the paths a `.claude-plugin/marketplace.json` or `plugin.json` lists under `skills` [S27].

For Claude Code, a project install targets `.claude/skills/`, and `-g` targets `~/.claude/skills/` [S27]. In the default symlink mode, the installer copies each skill into `.agents/skills/` in the project, or `~/.agents/skills/` with `-g`, then symlinks the Claude Code folder to that copy. `--copy` writes independent copies instead [S27] [S28]. The CLI tracks installs in `skills-lock.json` in the project and in `~/.agents/.skill-lock.json` for global installs. `npx skills update` refreshes them [S27] [S28].

The installer copies each skill's folder. `src/plugin-manifest.ts` reads only the `skills` arrays of a plugin manifest. I found no code that installs hooks, MCP servers, agents, `bin/`, or monitors [S28].

### Plugins can also load without a marketplace

- **A folder under `~/.claude/skills/` with a `.claude-plugin/plugin.json`** loads as `<name>@skills-dir` in every session, in place, with no install record. Updates are whatever the folder holds, such as after a `git pull` [S8] [S9].
- **The same folder under a repo's `.claude/skills/`** loads only after the workspace trust dialog, only when the session starts at the repo root, and without background monitors [S9].
- **`claude --plugin-dir <path>` or `--plugin-url <zip-url>`** loads a plugin for one session [S11].

### What each route keeps

| | Marketplace plugin | `~/.claude/skills/` plugin folder | Plugin in a repo's `.claude/skills/` | `npx skills add` |
| :- | :- | :- | :- | :- |
| Skills | Yes, namespaced | Yes, namespaced | Yes, namespaced | Yes, not namespaced |
| Hooks, MCP servers, agents, `bin/` | Yes | Yes | Yes, after trust. MCP servers need approval | No |
| Monitors | Yes | Yes | No | No |
| Plugin `dependencies` | Yes | Unconfirmed | Unconfirmed | No |
| Updates | `claude plugin update`, or auto-update once the user turns it on | Manual, such as `git pull` | Whatever the repo commits | `npx skills update` |
| Other agents | No | No | No | 79 agents |

Sources: [S4] [S9] [S10] [S27] [S28].

## Unconfirmed

- Whether plugin monitors start in a `claude --bg` background session. The manifest reference says monitors run "only in interactive sessions" [S1], and agent view counts a running monitor as work [S19]. Neither page says a plugin monitor starts in a background session.
- Whether `claude --bg` accepts a slash command such as `/loop 30m /some-skill` as its prompt. The agent view page shows only plain-text prompts [S19].
- Whether `dependencies` resolve for a plugin loaded from `~/.claude/skills/` or `--plugin-dir` against a marketplace install. The docs cover only a local dependency satisfying a local plugin [S10].
- Whether `allowCrossMarketplaceDependenciesOn` accepts `claude-plugins-official`. The docs give no example with an official marketplace and list no exception [S10].
- Whether a plugin's `bin/` folder is on the `PATH` of hooks, monitors, or the user's own terminal. The docs mention only the Bash tool's shell [S2].
- Whether Anthropic's directory accepts a plugin with a top-level `bin/`. claude.ai and Cowork don't install such a plugin [S2], and the directory route syncs plugins through claude.ai [S8].

## What this means for Flight Deck

These facts constrain the packaging decision. The decision itself belongs to the maintainer.

- **A marketplace plugin can't own a process that outlives a session.** Monitors and MCP servers stop when the session ends [S2] [S15]. A runner that polls Linear between sessions needs a host outside the plugin system: launchd, a long-lived Claude Code background session, or a terminal the user keeps open. No Claude Code doc covers a plugin that installs a launchd job.
- **A runner started outside Claude Code can't point at `${CLAUDE_PLUGIN_ROOT}`.** That path changes on every update, and old version directories are deleted 14 days later [S9]. `${CLAUDE_PLUGIN_DATA}` is stable across updates but is deleted on uninstall [S1].
- **Monitors are interactive-only and experimental.** They never start under `claude -p`, and they don't load from a plugin checked into the repo [S2] [S9]. A design that relies on them excludes headless runs.
- **Scheduled skills must be model-invocable.** A `/loop` fire treats a `disable-model-invocation: true` skill as plain text [S17]. `/loop` tasks also expire after 7 days. Desktop scheduled tasks persist, but only the user can create them in the Desktop app or a Desktop session, and only while the app is open [S17] [S18].
- **Auto-update is the user's call.** A Flight Deck marketplace starts with auto-update off, and `marketplace.json` can't change that [S7]. Setup would have to tell the user to turn it on, or write `autoUpdate` into a settings file [S13].
- **Matt Pocock's skills can be a dependency, but only unversioned.** `mattpocock-skills@claude-plugins-official` with an `allowCrossMarketplaceDependenciesOn` entry is the documented route [S10] [S25]. His tags don't fit the format that version ranges need [S26]. A user who also installed his skills with `npx skills` gets every skill twice [S26].
- **`npx skills` keeps the skills portable but drops everything else.** Hooks, MCP servers, `bin/`, monitors, and dependencies don't come along [S28]. That route fits the standing decision that skills stay plain Markdown. It doesn't carry a runner.
- **Background sessions can't read `~/Documents` until macOS grants access.** This repo lives at `~/Documents/flight-deck`, so a background session working on a repo stored there needs that grant first [S19].
- **Each enabled plugin adds every skill description to every turn** [S3]. Flight Deck plus its dependencies would carry that cost into sessions in unrelated repos when installed at user scope.
