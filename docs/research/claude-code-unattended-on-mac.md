# How Claude Code runs unattended on a Mac

Research note for [FLD-3](https://linear.app/campdotdev/issue/FLD-3/how-can-claude-code-run-unattended-on-a-mac). Sources were fetched on 2026-10-16 and are listed under [Sources](#sources). The local check ran against Claude Code 2.1.302 on macOS 26.6.2. Claims tagged **Unconfirmed** have no primary source behind them.

## Answer

- **Two ways to run a session with nobody at the keyboard.** `claude -p` runs one prompt and exits. The Agent SDK, for TypeScript and Python, runs the same Claude Code binary from your own program. Both load the repo's `CLAUDE.md`, skills, subagents, hooks, MCP servers, and plugins, the same as an interactive session. `--bare` and `settingSources: []` turn that loading off [S1][S2][S3].
- **Nothing in the Claude Code CLI starts a local session on a schedule or on an event.** `/loop` only fires inside a session that is already open, and its recurring tasks expire after seven days. The desktop app runs local scheduled tasks, but only while the app is open and the Mac is awake. Routines run on a schedule, an API call, or a GitHub event, but they run in Anthropic's cloud on a fresh clone. For a local CLI run on a timer, macOS gives you launchd. Apple deprecates cron [S18][S19][S20][S40].
- **When nobody can approve a prompt, the run denies it.** A `-p` or SDK run with no permission mode set starts in Manual mode and denies anything that would prompt. `dontAsk` runs only what you pre-approved. `auto` puts a classifier in place of you. `bypassPermissions` approves everything, and the docs reserve it for containers and VMs. Deny rules apply in every mode, but they match command text and are not a security boundary. The built-in Bash sandbox uses Seatbelt on macOS, and it covers shell commands only [S1][S9][S10][S13].
- **Parallel sessions get their own worktrees.** `claude -p --worktree <name>` works without a trust prompt, but `-p` never cleans up the worktree it made. Background sessions started with `claude --bg` move into a worktree on their own before they edit anything [S16][S17].
- **A Pro or Max subscription has a five-hour limit and a weekly limit.** Claude chat, every Claude Code session, `claude -p`, and the Agent SDK all draw on the same two limits. An API key bills per token, within the rate limits and monthly spend cap of its tier. When a subscription limit hits, an interactive session can wait and then continue. A headless run gets a `rate_limit` error and doesn't wait, unless you set `CLAUDE_CODE_RETRY_WATCHDOG=1`, which waits out the window [S23][S24][S25][S31][S32][S35].
- **Scheduled runs don't fire while the Mac sleeps, and a closed lid counts as sleep.** Background sessions survive sleep and resume on wake. A request that sleep breaks gets retried. A restart or shutdown kills every session. The transcript stays on disk, but nothing resumes the session on its own. A network drop gets up to 10 retries with backoff by default [S17][S19][S23].
- **The terms leave an open question.** The Consumer Terms bar scripted access unless Anthropic explicitly permits it. Anthropic does document `claude -p` with a subscription token for scripts. It also says Pro and Max limits "assume ordinary, individual usage", and that developers building products on the Agent SDK should use API keys [S8][S27][S34].

## Headless runs and the Agent SDK

### `claude -p` loads the repo's full configuration unless you pass `--bare`

`claude -p "<prompt>"` runs non-interactively. It exits 0 on success and non-zero when the run fails. A failure inside the run, such as missing authentication, prints as the result on stdout. `--output-format json` returns the result, the session ID, and a client-side cost estimate. `stream-json` emits one event per line [S1].

Without `--bare`, a `-p` run discovers and loads hooks, skills, custom commands, subagents, installed plugins, MCP servers, auto memory, and `CLAUDE.md`, including what is configured in the working directory and in `~/.claude` [S1]. Skills that a user invokes work when you put `/skill-name` in the prompt. Built-in commands that need the terminal interface, such as `/login`, don't [S1].

| Feature | `claude -p` | `claude --bare -p` | Agent SDK, default options | Agent SDK, `settingSources: []` |
| :- | :- | :- | :- | :- |
| `CLAUDE.md` and `.claude/rules/` | Loaded | Not loaded | Loaded | Not loaded |
| Skills in `.claude/skills/` and `~/.claude/skills/` | Loaded | Only from `--add-dir` folders | Loaded. No API registers a skill, so skills must exist as files | Not loaded |
| Subagents | Loaded from `.claude/agents/` | Only through `--agents` | From files or the `agents` option. The option wins on a name clash | Only through the `agents` option |
| Hooks | From settings files | Not discovered | From settings files, plus callbacks you pass | Callbacks only |
| MCP servers | From `.mcp.json` and settings | Only through `--mcp-config` | From `.mcp.json`, plus the `mcpServers` option | Only through `mcpServers` |
| Plugins | Installed plugins load | Only through `--plugin-dir` | By local path through the `plugins` option | By local path |

Sources for the table are [S1], [S3], [S4], [S42], and [S43].

The SDK plugin docs cover loading by local path only. They say to download a marketplace plugin first, or to point at its folder under `~/.claude/plugins/` [S4]. The TypeScript reference describes marketplace plugin install events in SDK sessions [S6]. **Unconfirmed:** whether an SDK session loads the plugins that user settings enable, with no `plugins` option.

Agent teams aren't available through SDK options. They are a CLI feature [S3].

### `-p` and the SDK trust the folder without asking

An interactive session holds back every hook until you accept the workspace trust dialog. A `-p` or SDK session never shows the dialog. It treats the folder as trusted, so hooks committed in a repo's `.claude/settings.json` run, and servers in its `.mcp.json` connect, with no prompt [S1][S15].

### The Agent SDK adds a permission callback

The SDK is a library that runs the Claude Code binary [S2]. It checks each tool call in this order: hooks, deny rules, ask rules, permission mode, allow rules, then your `canUseTool` callback. A hook that returns `allow` doesn't skip deny or ask rules [S5]. With `permissionPrompts: 'none'`, the callback is skipped and the call is denied unless a `PermissionRequest` hook allows it [S5].

Some inputs load whatever `settingSources` says. These are managed policy settings, `~/.claude.json`, auto memory, and the claude.ai MCP connectors when you sign in with a claude.ai login [S3].

### Unattended runs need a credential that works without a browser

Claude Code picks the first credential it finds in this order [S8]:

1. Cloud provider credentials
2. `ANTHROPIC_AUTH_TOKEN`
3. `ANTHROPIC_API_KEY`
4. `apiKeyHelper`
5. `CLAUDE_CODE_OAUTH_TOKEN`
6. Anthropic profiles
7. The subscription login from `/login`

In `-p`, an `ANTHROPIC_API_KEY` in the environment is always used, so a stray key quietly moves billing from the subscription to the API [S8].

`claude setup-token` mints a one-year OAuth token for scripts. It requires a Pro, Max, Team, or Enterprise plan. The token can only make model requests. It can't start Remote Control or fetch claude.ai connectors, though locally configured MCP servers still work [S8].

A `/login` credential expires. Claude Code warns three days ahead, and after expiry each request fails with `Login expired`. The docs single out unattended background sessions, which stop making progress when the login expires [S8]. On macOS the login lives in the login Keychain. When the Keychain rejects a write, as it does when locked in an SSH session, Claude Code falls back to `~/.claude/.credentials.json` [S28].

`--bare` never reads OAuth credentials, `CLAUDE_CODE_OAUTH_TOKEN`, or the Keychain. It needs `ANTHROPIC_API_KEY` or an `apiKeyHelper` [S1][S8]. The docs say `--bare` "will become the default for `-p` in a future release", with no date given [S1].

**Unconfirmed:** whether a `claude` process started by a launchd agent after a reboot can read the login Keychain before anyone logs in.

### Run controls and shutdown

- `--max-turns` and `--max-budget-usd` bound a print-mode run. The budget is checked against a client-side estimate, and spend can pass it [S7].
- On SIGTERM, a `-p` run exits with code 143. It kills the process tree of any running Bash command, runs `SessionEnd` hooks, and leaves the turn unfinished with no result [S1].
- `--resume <session-id>` continues a conversation from any directory on the machine. With `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`, Claude continues the interrupted turn instead of waiting for a new prompt [S1][S25].
- Transcripts are JSONL files under `~/.claude/projects/<project>/`, kept for 30 days by default [S29].

## Starting a session on a schedule or an event

### Claude Code's own schedulers

| Option | Where it runs | Needs the Mac on | Needs an open session | Minimum interval | Missed runs |
| :- | :- | :- | :- | :- | :- |
| `/loop` and `CronCreate` | Your Mac | Yes | Yes | 1 minute | No catch-up. A due task fires once when the session is idle |
| Desktop local scheduled task | Your Mac | Yes, awake, with the app open | No | 1 minute | One catch-up run on wake for the latest miss in the past 7 days |
| Routine | Anthropic's cloud | No | No | 1 hour | Not covered here |

Sources for the table are [S18], [S19], and [S20].

`/loop` tasks belong to the session. Recurring tasks expire after 7 days. A session holds 50 tasks at most. A recurring run starts late by up to half the gap to the next run, and by 30 minutes at most [S18]. Backgrounding the session with `/bg` carries its loops into a background session [S18]. A pending wakeup from a self-paced `/loop` keeps a `-p` run open until the loop ends [S1].

Desktop local scheduled tasks start a fresh session each time. Each task has its own permission mode. A task in Manual mode stalls on a prompt until you answer it in the app [S19]. The app's **Keep computer awake** setting prevents idle sleep only. "Closing the laptop lid still puts it to sleep" [S19].

Routines run as full cloud sessions with no permission prompts. They clone the repo fresh on every run and act as your GitHub and connector identities. Their runs count against your subscription [S20]. Self-hosted environments, which run cloud sessions on your own machines, are a Team and Enterprise beta [S21].

### Background sessions keep running without a terminal

`claude --bg "<prompt>"` starts a session under a supervisor process and returns at once. `claude agents` lists those sessions. The feature is a research preview [S17].

- The supervisor starts on demand, the first time you background a session or open agent view [S17].
- `--bg` can't be combined with `-p`. From a script, `--bg` exits with `Workspace not trusted` unless the folder was trusted in an interactive session first [S17].
- `claude agents --json --all` is the supported way for a script to read session state. The states are `working`, `blocked`, `done`, `failed`, and `stopped` [S17].
- The supervisor stops an idle, unattached session after about an hour and resumes it on the next reply. A crashed session process is restarted [S17].
- On macOS, the background host asks for Files and Folders access separately from your terminal. Without it, sessions can't read `~/Documents`, `~/Desktop`, or `~/Downloads` [S17].

### Channels push events into a session that is already running

A channel is an MCP server that pushes messages, CI results, or webhooks into an open session. Events arrive only while the session is open. Channels are a research preview and need claude.ai or Console authentication [S22]. No Claude Code feature starts a new local session in response to an outside event. The only event triggers are the API and GitHub triggers on routines, and those run in the cloud [S20].

### launchd is the macOS scheduler

Apple names launchd as the preferred way to add a timed job and calls cron deprecated [S40]. An agent is a per-user job, and running as a launchd agent is "the only way to run a process with a complete identity of that user." Per-user agents live in `~/Library/LaunchAgents` [S37].

| Key | Behavior |
| :- | :- |
| `StartCalendarInterval` | Cron-like schedule. If the Mac was asleep, the job runs on wake, and several missed runs merge into one [S36] |
| `StartInterval` | Every N seconds. A firing that falls during sleep is missed [S36] |
| `WatchPaths` | Starts the job when a path changes. Apple calls it "highly race-prone" [S36] |
| `KeepAlive` | Restarts the job. Jobs that exit fast and often get throttled [S36] |
| `ProcessType` | When unset, macOS throttles the job's CPU and I/O. `Interactive` removes the limits [S36] |
| `ExitTimeOut` | Seconds between SIGTERM and SIGKILL when launchd stops the job [S36] |
| `EnvironmentVariables` | Environment variables set for the job [S36] |

A job scheduled for a time when the Mac is off never runs, whether it uses cron or launchd [S40].

**Unconfirmed:** that a launchd job gets your shell's `PATH` and exported keys. A launchd job doesn't read `~/.zshrc`, so set what `claude` needs in `EnvironmentVariables`. **Unconfirmed:** whether `claude` started by launchd triggers the same Files and Folders prompt as the background host.

## Permissions and sandboxing when nobody approves prompts

### The starting mode for `-p` and the SDK is Manual

When nothing sets a mode, `-p` and SDK sessions that fetch feature flags start in `default`, which the CLI calls Manual [S9]. In a `-p` run with no permission host, anything that would prompt is denied [S1]. `--permission-prompts none` also tells Claude not to retry denied calls, and removes tools such as `AskUserQuestion` that need a person [S1].

A project's `.claude/settings.json` can't set `auto` or `bypassPermissions` as the default mode. Those values take effect only from the `--permission-mode` flag, `~/.claude/settings.json`, `--settings`, or managed settings [S9].

| Mode | What runs without asking | Unattended behavior |
| :- | :- | :- |
| `default` | Reads only | Everything else is denied in `-p` |
| `acceptEdits` | Reads, file edits, `mkdir`, `mv`, `cp`, and similar | Other shell commands and network requests need allow rules |
| `dontAsk` | Reads in the working directories, read-only commands, and allow-listed tools | Everything else is denied. Meant for CI |
| `auto` | Everything the classifier approves | Blocked actions are skipped and the run continues |
| `bypassPermissions` | Everything | The docs say to use it only in containers and VMs. It refuses to start as root |

Sources for the table are [S1], [S9], and [S10].

Some actions are never auto-approved in any mode, including `bypassPermissions`. These include ask rules, `AskUserQuestion`, MCP tools marked `requiresUserInteraction`, and `rm` of a critical path such as `~` or the working directory [S9].

### What auto mode blocks

Auto mode sends actions to a classifier model. It requires a supported model, and Anthropic can turn it off server-side, in which case the session starts in Manual [S9]. Among the actions it blocks by default [S9]:

- Merging a pull request no human has approved, approving Claude's own pull request, or disabling CI checks
- Force push, `git reset --hard`, and discarding uncommitted changes
- Launching an agent loop with `--dangerously-skip-permissions`
- Printing a live credential into the transcript, and sending sensitive data outside the repo
- Opening a tunnel that exposes a local service to the internet

It allows by default pushing to any branch of the working repo, including the default branch, and creating a pull request that matches the request [S9]. Boundaries you state in the conversation, such as "don't push", act as block signals. Compaction can drop them, and the docs point to deny rules for a hard guarantee [S9]. In a `-p` run, 3 blocks in a row or 20 in total don't stop the run. The blocked action doesn't run, and Claude keeps working [S9].

### Deny rules and hooks

Rules are checked deny first, then ask, then allow. Deny rules apply in every mode, including `bypassPermissions` [S9][S10]. A Bash rule matches the command text as Claude writes it. `Bash(git push *)` doesn't stop `git -C . push origin main`, so the docs say a deny rule "isn't a security boundary around the program" [S10].

A `PreToolUse` hook sees each tool call before it runs and can deny it. A hook that exits with code 2 blocks the call even when an allow rule matches. A hook's `allow` doesn't override deny or ask rules [S10][S15]. Command hooks run with your full user permissions [S15]. A `StopFailure` hook fires when a turn ends on an API error such as `rate_limit` [S15].

Managed settings override every other level, and no flag or settings file overrides a managed deny rule [S10][S11]. On macOS the file-based copy lives at `/Library/Application Support/ClaudeCode/managed-settings.json`. SDK sessions read it even with `settingSources: []` [S12]. **Unconfirmed:** whether the file-based source works on a Pro or Max plan. The docs state no plan requirement for it.

### The Bash sandbox covers shell commands only

The sandbox is off by default. On macOS it uses Seatbelt [S13]. By default:

| Access | Default |
| :- | :- |
| Writes | The working directory, a per-user temp directory, and added directories |
| Reads | Most of the machine, including `~/.ssh` and `~/.aws/credentials` |
| Network | Through a local proxy with an allowlist that starts empty |

Source for the table is [S13].

Claude's file tools, hooks, MCP servers, and LSP servers run outside the sandbox [S13]. Claude can retry a failed command unsandboxed. `"allowUnsandboxedCommands": false` turns that retry off, and `failIfUnavailable` stops commands from running when the sandbox can't start [S13]. The proxy doesn't inspect TLS, so a broad allowed domain such as `github.com` can carry data out [S13].

The docs say the Bash sandbox alone "is not sufficient for fully unattended runs" in auto or bypass mode [S14]. To put the whole process behind one boundary, run Claude Code inside the sandbox runtime, a dev container, or a VM. `npx @anthropic-ai/sandbox-runtime claude` starts it under the runtime. The sandbox runtime is a beta research preview. On macOS it needs no extra packages [S14].

Writes to protected paths, such as `.git`, `.claude`, `.husky`, `.mcp.json`, and shell startup files, prompt in Manual mode, go to the classifier in auto mode, and are denied in `dontAsk` [S9].

## Several sessions at once, each in its own worktree

- `claude --worktree <name>` creates `.claude/worktrees/<name>/` on a new branch named `worktree-<name>`. `-p` runs skip the trust check [S16].
- `-p` runs have no exit prompt. Claude Code doesn't remove their worktrees and leaves their git locks in place. `git worktree unlock` then `git worktree remove` clears one [S16].
- While a session sits in a worktree, Claude Code blocks edits to the main checkout, commands run from it, and git redirected into it. The checks don't track files written by `cp` or a shell redirect [S16].
- Worktrees share the repo's `.git` directory. They also share project-scope plugins and "don't ask again" approvals, which save to the main checkout's `.claude/settings.local.json` [S16].
- A worktree is a fresh checkout, so dependencies need installing. A `.worktreeinclude` file copies gitignored files such as `.env` into each new worktree [S16].
- A background session moves into its own worktree before it edits files. When it has changes, Claude commits and pushes the branch without asking, and opens a draft pull request when the task calls for one. It never pushes to `main` or `master`, force-pushes, or merges. Git instructions in the task or `CLAUDE.md` take precedence [S17].
- Each parallel session draws on your quota on its own, so ten sessions use it about ten times as fast [S17]. "A single burst of heavy activity, such as a large workflow fanout, can exhaust the weekly allowance before the session window resets" [S23].

## Usage limits: subscription versus API key

### Subscription limits

- Pro and Max have a five-hour session limit and a weekly limit. Max also has a separate weekly limit for Fable. Claude and Claude Code share these limits, IDE use included [S31].
- As of 2026-10-07, "Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription limits." Anthropic paused a change announced for 2026-06-15 that would have split them out [S32].
- Max and Team plans now include monthly API credits: $100 for Max 5x and $200 for Max 20x. Pro gets none. The credits cover `claude -p` and the SDK only when you run them with an API key from the linked Console organization. Signed in with the plan, the same runs draw from plan limits. Credits expire each billing cycle [S33].
- Usage credits let a Pro or Max plan keep going past a limit at metered rates [S26][S31].
- At the five-hour limit, a response already in progress may get a small capped allowance to finish its step [S31].

### API key limits

An API key bills at standard API rates [S31]. Each usage tier has a monthly spend cap: $500 for Start, $1,000 for Build, and $200,000 for Scale. Each tier also has per-model limits on requests and tokens per minute [S35]. At the spend cap, requests return 429 with no `retry-after` until the first of the next month [S35].

### What a session does at the limit

- **Interactive session with a claude.ai login.** Claude Code waits and continues after the reset, re-arming at most twice in a row. It doesn't wait for a reset more than 24 hours away. After more than about 30 minutes of sleep, it waits for you to press Enter [S24].
- **Headless run.** Claude Code blocks requests until the reset, and the automatic wait is for interactive sessions only [S23][S24]. The assistant message carries the error `rate_limit`, which means a 429 against your quota [S6]. A `StopFailure` hook fires with `error: rate_limit` [S15]. The SDK also emits a `rate_limit_event` with `status: "rejected"` and a `resetsAt` time [S6]. **Unconfirmed:** the exact exit code of a `-p` run that hits a session limit.
- **`CLAUDE_CODE_RETRY_WATCHDOG=1`.** Retries 429 and 529 errors indefinitely, waiting until the reset time when the response carries one, "so a session that hits a usage limit waits out the remaining window." A spend limit or exhausted usage credits still fails at once [S25].
- **Fable models.** A background or SDK-hosted session ends its turn when the Fable usage-credits consent prompt goes unanswered [S23].

### What the terms say about automation

- The Consumer Terms, which cover Free, Pro, and Max, bar access "through automated or non-human means, whether through a bot, script, or otherwise", except with an API key "or where we otherwise explicitly permit it" [S27][S34].
- Claude Code's legal page says advertised Pro and Max limits "assume ordinary, individual usage of Claude Code and the Agent SDK" [S27].
- The same page says developers building products, including those using the Agent SDK, should use API key authentication. They may not offer claude.ai login in their own apps or route requests through Free, Pro, or Max credentials on behalf of their users. It doesn't prevent an end user from signing in to the unmodified Claude Code binary with their own subscription [S27].
- The SDK overview repeats that third-party developers may not offer claude.ai login or rate limits "unless previously approved" [S2].
- Anthropic documents `setup-token` for "CI pipelines and scripts" [S8], and the help center says you "can still use the Claude Agent SDK, `claude -p`, and third-party apps with your subscription limits" [S32].

## Sleep, restart, and network loss

### Sleep

- Background sessions "are preserved across sleep and the supervisor reconnects to them on wake" [S17].
- A request cut off by sleep counts as a dropped connection and is retried. The retry label reads `Connection lost while your computer was asleep` [S23].
- Desktop scheduled tasks are skipped while the Mac sleeps. `/loop` has no catch-up. A launchd `StartCalendarInterval` job runs once on wake [S18][S19][S36].
- `caffeinate -i <command>` holds an idle-sleep assertion while the command runs. `-s` prevents system sleep, but only on AC power [S38]. `pmset` changes sleep settings and schedules wake or power-on events, and it must run as root [S39].
- On a laptop, **Prevent automatic sleeping on power adapter when the display is off** lives under Battery > Options in System Settings [S41].

### Restart and shutdown

- A shutdown or restart stops every background session. A session that last made progress within 48 hours shows `failed`, and an older one shows `stopped`. Either restarts from its saved conversation when you attach or reply, not on its own [S17].
- After a supervisor stop, sessions wait about a minute for a new supervisor. The next `claude agents` or `claude --bg` starts one [S17].
- After an auto-update, the supervisor restarts on the new version and moves idle sessions. Working sessions aren't interrupted [S17].
- `claude -p` handles SIGTERM as described under [Run controls and shutdown](#run-controls-and-shutdown). launchd sends SIGTERM, then SIGKILL after `ExitTimeOut` [S1][S36].

### Network loss

- Claude Code retries transient failures up to 10 times with exponential backoff before it shows an error [S23].
- A connection that drops before Claude has finished any part of its response gets re-sent [S23].
- A drop after Claude finished a tool call isn't re-sent, so no tool runs twice. Claude Code keeps the completed work and continues the turn [S23].
- `CLAUDE_CODE_RETRY_WATCHDOG=1` raises the retry count for transient errors to 300, about three hours of backoff [S25].

## What runs locally and what only runs in the cloud

| Runs on the Mac | Runs only in Anthropic's cloud |
| :- | :- |
| `claude` interactive sessions | Routines, with schedule, API, and GitHub triggers [S20] |
| `claude -p` and the Agent SDK [S1][S2] | Cloud sessions started with `claude --cloud` or from claude.ai [S14] |
| Background sessions from `claude --bg` and agent view [S17] | Self-hosted environments run cloud sessions on your own machines, but only for Team and Enterprise [S21] |
| `/loop` and `CronCreate` tasks [S18] | |
| Desktop local scheduled tasks [S19] | |
| Channels, into a session already running [S22] | |
| Remote Control, which runs locally while you steer from another device [S30] | |

## Sources

All sources were fetched on 2026-10-16. Help-center articles carry their `dateModified` value.

| ID | Source |
| :- | :- |
| S1 | [Run Claude Code programmatically](https://code.claude.com/docs/en/headless) |
| S2 | [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) |
| S3 | [Use Claude Code features in the SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features) |
| S4 | [Plugins in the SDK](https://code.claude.com/docs/en/agent-sdk/plugins) |
| S5 | [Configure permissions, Agent SDK](https://code.claude.com/docs/en/agent-sdk/permissions) |
| S6 | [Agent SDK reference, TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript) |
| S7 | [CLI reference](https://code.claude.com/docs/en/cli-reference) |
| S8 | [Authentication](https://code.claude.com/docs/en/authentication) |
| S9 | [Choose a permission mode](https://code.claude.com/docs/en/permission-modes) |
| S10 | [Configure permissions](https://code.claude.com/docs/en/permissions) |
| S11 | [Settings files and precedence](https://code.claude.com/docs/en/settings) |
| S12 | [Deploy managed settings](https://code.claude.com/docs/en/managed-settings) |
| S13 | [Configure the sandboxed Bash tool](https://code.claude.com/docs/en/sandboxing) |
| S14 | [Choose a sandbox environment](https://code.claude.com/docs/en/sandbox-environments) |
| S15 | [Hooks reference](https://code.claude.com/docs/en/hooks) |
| S16 | [Run parallel sessions with worktrees](https://code.claude.com/docs/en/worktrees) |
| S17 | [Manage multiple agents with agent view](https://code.claude.com/docs/en/agent-view) |
| S18 | [Run prompts on a schedule](https://code.claude.com/docs/en/scheduled-tasks) |
| S19 | [Schedule recurring tasks in Claude Code Desktop](https://code.claude.com/docs/en/desktop-scheduled-tasks) |
| S20 | [Automate work with routines](https://code.claude.com/docs/en/routines) |
| S21 | [Self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments) |
| S22 | [Push events into a running session with channels](https://code.claude.com/docs/en/channels) |
| S23 | [Error reference](https://code.claude.com/docs/en/errors) |
| S24 | [Interactive mode, wait for a usage limit to reset](https://code.claude.com/docs/en/interactive-mode) |
| S25 | [Environment variables](https://code.claude.com/docs/en/env-vars) |
| S26 | [Manage costs effectively](https://code.claude.com/docs/en/costs) |
| S27 | [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) |
| S28 | [Troubleshoot installation and login](https://code.claude.com/docs/en/troubleshoot-install) |
| S29 | [Manage sessions](https://code.claude.com/docs/en/sessions) |
| S30 | [Remote Control](https://code.claude.com/docs/en/remote-control) |
| S31 | [Help center: Use Claude Code with your Pro or Max plan](https://support.claude.com/en/articles/11145838), modified 2026-10-14 |
| S32 | [Help center: Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540), modified 2026-10-07 |
| S33 | [Help center: Monthly API credits for Max and Team plans](https://support.claude.com/en/articles/17154008), modified 2026-10-07 |
| S34 | [Anthropic Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms), effective 2025-10-08 |
| S35 | [Claude API rate limits](https://platform.claude.com/docs/en/api/rate-limits) |
| S36 | `man launchd.plist`, macOS 26.6.2 |
| S37 | `man launchd`, macOS 26.6.2 |
| S38 | `man caffeinate`, macOS 26.6.2 |
| S39 | `man pmset`, macOS 26.6.2 |
| S40 | [Apple, Scheduling Timed Jobs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html), documentation archive, updated 2016-09-13 |
| S41 | [Apple, Set sleep and wake settings for your Mac](https://support.apple.com/guide/mac-help/mchle41a6ccd/mac) |
| S42 | [Subagents in the SDK](https://code.claude.com/docs/en/agent-sdk/subagents) |
| S43 | [Connect to external tools with MCP, Agent SDK](https://code.claude.com/docs/en/agent-sdk/mcp) |

## What this means for Flight Deck

These facts constrain two decisions on the map. The maintainer makes both.

### For "What runs on the Mac, and how does it start each session?"

- Something outside the Claude Code CLI has to start each session. That could be launchd, the desktop app's scheduler, or a long-running process of Flight Deck's own. `/loop` needs an open session and stops after seven days.
- No local trigger starts a session when a Linear issue changes. Routines have event triggers, but they run in the cloud, which the map puts out of scope. Locally, something has to poll Linear or keep a session open for a channel.
- `claude -p` and the SDK both load skills, subagents, hooks, MCP servers, and plugins from the repo and from `~/.claude` by default.
- `--bare` turns that loading off and requires an API key. The docs say it will become the default for `-p`, with no date.
- Subscription auth for unattended runs comes down to a one-year `setup-token` or the `/login` credential, which expires. A `setup-token` session can't reach claude.ai connectors.
- `claude --bg` gives worktree isolation, restart on crash, and a JSON state feed for free. It is a research preview, can't run with `-p`, and needs the folder trusted in an interactive session first.
- Scheduled runs don't fire while the Mac sleeps, and a closed lid counts as sleep. A restart kills sessions and nothing resumes them on its own. Resuming a `-p` session takes its session ID or transcript path.
- A repo under `~/Documents` needs Files and Folders access for the background host. This planning folder is itself under `~/Documents`.
- Every parallel session draws on the five-hour and weekly limits that the maintainer's own chat and interactive work also use. A weekly limit can be days away. With the retry watchdog, a session waits that long.
- The terms point two ways. Anthropic documents scripted `-p` with a subscription token. It also says Pro and Max limits assume ordinary, individual usage, and that products built on the Agent SDK should use API keys. Whether Flight Deck counts as an end user running the unmodified binary, or as a third-party product, decides which credential it can ask its users for.

### For "What may an unattended agent never do, and what stops it?"

The controls below run from softest to hardest.

- **Instructions** in prompts, skills, and `CLAUDE.md`. Compaction can drop a boundary stated in the conversation.
- **The auto mode classifier.** It blocks merging a pull request no human approved, approving Claude's own pull request, force push, and disabling CI. It allows pushes to any branch of the repo, the default branch included. Anthropic can switch it off server-side, and the session then falls back to Manual.
- **Deny rules.** They apply in every mode but match command text. A different spelling of the same command gets through.
- **`PreToolUse` hooks.** They see the full command and can block it. They run outside the sandbox with the maintainer's full permissions.
- **The Bash sandbox.** It confines shell commands only. By default it can read `~/.ssh`.
- **The sandbox runtime, a container, or a VM.** These put the whole process behind one boundary. The docs require one of them for `bypassPermissions`.
- **The managed settings file.** No user setting, project setting, or flag overrides it. Writing it needs admin rights.
- **Controls outside Claude Code,** such as branch protection on the GitHub remote. This note didn't research them.

Two more facts bear on this decision:

- `-p` and SDK runs trust any repo's `.claude/settings.json` hooks and `.mcp.json` servers without asking. A factory added to "any repo" runs that repo's hooks with no prompt.
- A repo's checked-in settings can't put a session into `auto` or `bypassPermissions`. The mode has to come from the command line, the maintainer's user settings, or managed settings.
