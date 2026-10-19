# What can stop an unattended session from merging, pushing, or reading secrets

Research note for [FLD-12](https://linear.app/campdotdev/issue/FLD-12/what-may-an-unattended-agent-never-do-and-what-stops-it). It builds on [How Claude Code runs unattended on a Mac](claude-code-unattended-on-mac.md) and doesn't repeat what that note covers. Sources were read on 2026-10-17 and are listed under [Sources](#sources), such as [S1]. Local tests ran on 2026-10-17, US time, against Claude Code 2.1.302 on macOS 26.6.2. They are listed under [How the local tests ran](#how-the-local-tests-ran), such as [T1].

Each claim carries one of three tags, or a citation that implies it:

- **Confirmed by local test** means a test in this note produced the result.
- **Documented** means a primary source says it.
- **Unconfirmed** means neither a test nor a primary source settles it.

The tests used Haiku, a throwaway repo under `/tmp`, and dummy secrets created for the test and deleted afterwards. No test read the maintainer's real credentials, keys, tokens, or Keychain items, and none pushed to a remote.

## Answer

1. **Auto memory and claude.ai connectors.** `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` or `"autoMemoryEnabled": false` in `--settings` turns auto memory off. `ENABLE_CLAUDEAI_MCP_SERVERS=false`, `"disableClaudeAiConnectors": true` in `--settings`, or `--strict-mcp-config` turns the connectors off. A repo's `.claude/settings.json` `env` block that sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` turns auto memory back on, unless `--settings` sets the variable in its own `env` block. **Confirmed by local test** [T1][T2][T3].
2. **Bash sandbox, filesystem.** Inside the working directory, the sandbox denied writes to `.claude` settings files and its `hooks`, `skills`, `agents`, and `commands` folders, `.mcp.json`, `.zshrc`, `.bashrc`, `.gitconfig`, `.vscode`, and the worktree's `.git` file. It allowed `.husky`, `.npmrc`, `.envrc`, `CLAUDE.md`, and `AGENTS.md`. In a linked worktree, `git commit` works, and the common dir's `hooks/` and `config` stay denied. Its `refs/` stays writable, so a sandboxed command moved the local `main` branch and committed a `.claude/settings.json` it couldn't write as a file. `denyRead` plus a narrower `allowRead` re-opens a subfolder. Claude's Read and Write tools ignore sandbox settings and follow `Read(...)` and `Edit(...)` rules, which also block a symlink that points at a denied file. **Confirmed by local test** [T5][T6][T7], and **Documented** [S1][S4].
3. **Bash sandbox, network and Keychain.** An allowlist with `registry.npmjs.org` and a deny list with `github.com` let `curl` reach npm and blocked `github.com`, `api.github.com`, and git over HTTPS. Git over SSH goes through the same proxy, and the proxy refused `github.com` on port 22. Sandboxed Bash read a dummy Keychain item with `security find-generic-password`, and `git credential-osxkeychain get` returned a dummy credential. **Confirmed by local test** [T5][T8].
4. **Sandbox and permission mode together.** In a `-p` run with `--permission-mode dontAsk`, sandboxed Bash runs with no allow rules, because `sandbox.autoAllowBashIfSandboxed` still defaults to `true`. `"allowUnsandboxedCommands": false` passed in `--settings` makes the sandbox admin-required, and the run then ignored a repo's `enabled: false`, `excludedCommands`, `allowWrite`, `allowRead`, and `filesystem.disabled`. Without that key, the same repo file added writable paths, including `~`, and took a command out of the sandbox. **Confirmed by local test** [T5][T9], and **Documented** [S1][S2].
5. **Settings changed mid-session.** An allow rule written to `.claude/settings.local.json` and a hook written to `.claude/settings.json` both took effect in the same `-p` session. Hooks from project settings run with no prompt and outside the sandbox. A test hook wrote to `~` and read the dummy Keychain item. **Confirmed by local test** [T10][T11].
6. **Whole-process sandbox.** `srt` wrapped `claude -p` on macOS, the subscription login from the Keychain worked inside it, and Claude's file tools were confined. The runtime is a "Beta Research Preview" at version 0.0.80. **Confirmed by local test** [T13], and **Documented** [S13][S16].
7. **MCP tool permissions.** `mcp__linear` allowed every tool on the server. A deny rule for `mcp__linear__merge_diff` removed that one tool from the session. In `dontAsk`, an MCP tool with no allow rule was denied. A `PreToolUse` hook received the MCP tool's input as JSON, plus the server's name and source. **Confirmed by local test** [T12], and **Documented** [S4][S12].
8. **Stopping sessions.** SIGTERM to `claude -p` stopped its background commands and its MCP server, and the process exited with 143. SIGKILL to `claude`, or to its whole process group, left its background commands running with launchd as their parent, because each one runs in its own process group. **Confirmed by local test** [T14].
9. **GitHub rulesets.** The documented bypass actors are repository roles, teams, GitHub Apps, and Dependabot. The REST API also accepts deploy keys and individual users. Rulesets work on public repos on GitHub Free. Rules can restrict creation, updates, deletion, and force pushes on a pattern such as `flight-deck/*`. No page states outright that Write can delete any branch no rule covers. **Documented** [S18][S19][S20][S21][S22][S23][S24][S25], with the personal-account bypass list and the Write-role deletion **Unconfirmed**.
10. **Linear `merge_diff`.** It merges a Linear diff, which is a GitHub pull request shown in Linear, or adds it to the repo's merge queue. Linear's docs don't say which GitHub identity performs the merge. **Unconfirmed** [S27][S28][S32].

## 1. Auto memory and claude.ai connectors

### What turns each one off

| Switch | Kind | Auto memory | claude.ai connectors |
| :- | :- | :- | :- |
| None, with `--setting-sources project,local` | | Loaded | Claude Docs and Google Drive connected. Gmail and Google Calendar listed as needing auth |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | Environment variable | Off | Still listed |
| `"autoMemoryEnabled": false` | Settings key, works in `--settings` | Off | Still fetched |
| `ENABLE_CLAUDEAI_MCP_SERVERS=false` | Environment variable | Loaded | Gone |
| `"disableClaudeAiConnectors": true` | Settings key, works in `--settings` | Loaded | Gone |
| `--strict-mcp-config` | Flag | Loaded | Gone. Only `--mcp-config` servers load |

Sources for the table are [T1] and [T2]. The tests read the `system`/`init` event of `--output-format stream-json --verbose`. Auto memory shows there as `memory_paths.auto`, and that field was `null` with either memory switch. The connectors appear in `mcp_servers` with `"source": "claudeai"`, and their tools appear in `tools` as `mcp__claude_ai_<server>__<tool>`. The baseline run listed Google Drive tools that include `share_file` and `trash_file` [T1].

In the run with `autoMemoryEnabled: false`, the connectors showed as `pending` in the `init` event instead of `connected`. Connectors finish connecting after the event, so an `init` event alone can understate them [T1].

A planted marker in the test repo's `MEMORY.md` confirmed that the switches change what the model sees. The baseline run recited the marker. Runs with either memory switch answered `NONE` [T2].

### How the switches combine

- `CLAUDE_CODE_DISABLE_AUTO_MEMORY` outranks `autoMemoryEnabled` for one session, in either direction. A value of `0` forces auto memory on [S2][S7][S9].
- `disableClaudeAiConnectors` takes `true` from any settings source. A project-level `false` can't re-enable connectors, and whichever of the key or `ENABLE_CLAUDEAI_MCP_SERVERS=false` turns connectors off, the other can't turn them back on [S2][S8].
- `--strict-mcp-config` also drops the repo's `.mcp.json` servers, so every server a session needs has to come through `--mcp-config` [S11].
- A `setup-token` credential can't fetch connectors at all [S15].

### A repo's `env` block outranks the runner's environment

A settings file's `env` block overwrites the same variable exported in the shell. When several settings files set it, the highest-precedence file wins [S2]. Project settings can't set some variables, such as `CLAUDE_CONFIG_DIR`, `TMPDIR`, and the telemetry exporters, but `CLAUDE_CODE_DISABLE_AUTO_MEMORY` isn't on that list [S2].

[T3] tested this with a repo `.claude/settings.json` holding `"env": {"CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0"}`:

| How the runner tried to turn auto memory off | Result |
| :- | :- |
| `--settings '{"autoMemoryEnabled": false}'` | Auto memory loaded |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the process environment | Auto memory loaded |
| `--settings '{"env": {"CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1"}}'` | Off |

The same repo file also set `ENABLE_CLAUDEAI_MCP_SERVERS=true`, and connectors stayed off under `--settings '{"disableClaudeAiConnectors": true}'` [T3].

### Other inputs `project,local` still pulls in

- **The main checkout's local settings.** In a worktree, Claude Code reads `.claude/settings.local.json` at the main checkout's root, alongside any copy in the starting folder [S3]. [T4] confirmed it. A `.claude/settings.local.json` in the main checkout turned auto memory off for a session running in a worktree under `/tmp/.../data/`, and it stopped doing so when `local` was left out of `--setting-sources`. The "don't ask again" approvals a maintainer gives in interactive sessions save to that file [S3].
- **Allow rules in local settings.** `.claude/settings.local.json` applies its allow rules without workspace trust when git reports it as untracked [S4].
- **Synced claude.ai skills.** Claude Code doesn't sync them in a session whose `--setting-sources` list leaves out `user` [S10]. Skills an earlier session synced stay on disk [S10]. The `init` event in [T1] listed skills named `deep-research` and `dataviz`. Whether those came from an earlier sync or ship with Claude Code is **Unconfirmed**.

## 2. The Bash sandbox and the filesystem

### Paths the sandbox denies writes to inside the working directory

The sandbox keeps a protected-path list that no `allowWrite` entry or `Edit` allow rule lifts. Only `sandbox.filesystem.disabled` turns it off, and that turns off all filesystem isolation [S1]. The list covers:

- In the working directory and the folders above it: the `.claude` settings files, the `.claude/skills`, `.claude/agents`, `.claude/commands`, and `.claude/hooks` folders, `.mcp.json`, and files Claude Code runs on its own, such as `.claude/workflows` [S1]
- In the working directory only: shell startup files such as `.bashrc` and `.zshrc`, `.gitconfig`, `.vscode`, `.idea`, and `hooks` and `config` inside `.git` [S1]
- Files that would make the working directory a bare repo: top-level `HEAD`, `objects`, `refs`, and `config` [S1]
- Most of `~/.claude`, plus `~/.claude.json` and `.credentials.json` [S1]

A symlink that appears at a protected settings path during the session makes its target write-denied too, from the next command on [S1].

[T5] ran one script through sandboxed Bash, in a worktree, with the runner-like settings listed under [How the local tests ran](#how-the-local-tests-ran):

| Write | Result |
| :- | :- |
| An ordinary file, `CLAUDE.md`, `AGENTS.md`, `package.json` | Allowed |
| `.husky/pre-commit`, `.npmrc`, `.envrc` | Allowed |
| `.claude/settings.json`, `.claude/settings.local.json` | Denied |
| `.claude/hooks/`, `.claude/skills/`, `.claude/agents/`, `.claude/commands/` | Denied |
| `.mcp.json`, `.zshrc`, `.bashrc`, `.gitconfig`, `.vscode/` | Denied |
| The worktree's `.git` file, rewritten with its own content | Denied |
| A file in the main checkout, including its `.claude/settings.local.json` | Denied |
| A file elsewhere under `/tmp`, and a file in `~` | Denied |
| `$TMPDIR`, which the sandbox sets to `/tmp/claude-501` | Allowed |

`.husky`, `.npmrc`, and `.envrc` are on the permission system's protected list for Claude's file tools [S5], but not on the sandbox's list. Sandboxed Bash wrote all three [T5].

### Git in a worktree whose common dir is outside the working directory

The docs say that in a linked worktree, the sandbox allows writes to the main repo's shared `.git` folder so `git commit` can update refs and the index, while `hooks/` and `config` there stay denied [S1]. [T5] matched that and found more:

| Action from sandboxed Bash in the worktree | Result |
| :- | :- |
| `git add` and `git commit` | Worked |
| Write `<common dir>/hooks/pre-commit` | Denied |
| Append to `<common dir>/config`, or run `git config --local` | Denied |
| Write `<common dir>/worktrees/wt1/config.worktree` | Denied |
| Append to `<common dir>/info/exclude` | Allowed |
| `git update-ref refs/heads/main HEAD` | Allowed. The local `main` branch moved |

[T6] used git plumbing to commit a file the sandbox won't let a command write. `git hash-object -w`, `git update-index --add --cacheinfo`, and `git commit` produced a commit that adds `.claude/settings.json`, while a direct write to that path failed with `Operation not permitted`.

The standalone runtime differs. On macOS, `srt` anchors its `.git/hooks` and `.git/config` denies to the directory it starts in and never reads `gitdir` or `commondir`. The source handles no common dir outside that directory [S16]. Whether the common dir is then writable depends on its `allowWrite` list. This note didn't test it. **Unconfirmed.**

### `denyRead` with an `allowRead` carve-out

`sandbox.filesystem.allowRead` re-opens reading inside a `denyRead` region, and the narrower rule wins. The docs' own example is `"denyRead": ["~/"]` with `"allowRead": ["."]` in project settings, which blocks the home folder except the project [S1][S2]. A deny inside a wider allow still holds, so `"allowRead": ["~/"]` with `"denyRead": ["~/.env"]` keeps `~/.env` blocked [S1].

[T5] confirmed the carve-out on a folder under `/tmp`. Sandboxed `cat` failed on `secret/dummy.txt` and read `secret/public/ok.txt`. The test didn't deny `~` itself.

Things that change how these lists merge:

- Paths merge across every settings scope the session loads. They aren't replaced [S1].
- A `denyRead` entry or `Read(...)` deny rule in `--settings` makes Claude Code ignore a repo's `allowRead`, `allowWrite`, `Edit(...)` allow, or `additionalDirectories` entry at or under the denied path [S1]. [T9] confirmed this for `allowRead`.
- `permissions.blockReadsOutsideWorkingDirectories` denies sandboxed commands reads of `/Users`, `/Volumes`, and the other user-file roots, then re-opens the working directories, the session temp folder, the worktree's common `.git` folder, and the global git config files. It also makes the file tools refuse reads outside the working directories in every mode [S2].
- `sandbox.credentials` entries with `"mode": "deny"` block a file or unset an environment variable for sandboxed commands. There is no built-in credential deny list [S1].

### Claude's file tools follow permission rules, not sandbox settings

The docs say the Read, Edit, and Write tools run outside the sandbox and follow permission rules, and that a `denyRead` entry doesn't stop the Read tool [S1]. [T7] confirmed it in `dontAsk` mode:

| Call | Settings | Result |
| :- | :- | :- |
| Read a file inside the working directory that sandbox `denyRead` covers | Sandbox on | Read succeeded |
| Read the same file | `Read(./private/**)` deny rule | Denied |
| Write a file elsewhere under `/tmp` | Bare `Write` allow rule | Written |
| Write `.claude/settings.local.json` | Bare `Write` allow rule | Denied |

Rules flow one way into the sandbox. `Read(...)` deny rules join `denyRead`, and `Edit(...)` allow and deny rules join `allowWrite` and `denyWrite` [S2]. A bare `Edit` or `Write` allow rule, or `Edit(./**)`, didn't let sandboxed Bash write outside the working directory [T7].

In `dontAsk`, writes to protected paths are denied, and allow rules don't pre-approve them [S5].

### Symlinks

- **Permission rules.** Claude Code checks both the requested path and the file it resolves to. An allow rule applies only when both match, and a deny rule applies when either matches [S4]. [T7] confirmed that `Read(//tmp/.../secret/**)` blocked a symlink inside the worktree that points at a file in `secret/`. Without any rule, `dontAsk` denied the Read tool on that symlink, because its target sits outside the working directory.
- **Edit and Write.** Both refuse to write when the path itself is a symlink [S4].
- **Sandboxed Bash.** Seatbelt checks the resolved path. `cat` through the same symlink failed with `Operation not permitted` [T5].

## 3. The Bash sandbox, network, and Keychain

### A domain allowlist can split GitHub from a package registry

Sandboxed commands reach the network only through a proxy on the machine. On macOS, Seatbelt blocks every other outbound connection [S1]. The proxy checks hostnames and doesn't inspect TLS, so an allowed host can carry anything [S1].

[T5] set `allowedDomains` to `registry.npmjs.org` and `deniedDomains` to `github.com` and `*.github.com`:

| Command | Result |
| :- | :- |
| `curl https://registry.npmjs.org/` | 200 |
| `curl https://github.com/`, `curl https://api.github.com/` | The proxy answered 403 |
| `git ls-remote https://github.com/...` | Failed at the proxy |
| `curl https://example.com/`, a host on neither list | The proxy refused it, because `dontAsk` refuses unlisted hosts [S1] |
| `nc -z github.com 22`, `nc -z registry.npmjs.org 443` | Failed on name lookup |

A `deniedDomains` entry blocks in every permission mode, even under a wider `allowedDomains` wildcard [S1]. `strictAllowlist` refuses unlisted hosts in every mode too, and a repo's settings can't set it [S1].

### Git over SSH

Sandboxed commands get a `GIT_SSH_COMMAND` whose `ProxyCommand` tunnels through the same proxy [T8]. With `github.com` denied, the proxy refused the SSH tunnel with `host is on the deny list` [T8]. With `github.com` allowed, the proxy refused it with `This proxy requires authentication, and this client did not offer an authentication method` [T8]. That run overrode ssh's config and offered only a dummy key, so that none of the maintainer's keys reached GitHub. On its own, it doesn't prove that an unmodified command fails. The docs say it does. On macOS, git over SSH fails in the sandbox even when the host is allowed, because the macOS tunnel can't authenticate to the proxy [S1].

Plain `ssh` and other tools that ignore proxy variables can't connect at all [S1].

### The Keychain stays reachable

[T5] created a dummy generic password and a dummy credential stored through `git credential-osxkeychain`, then read both from sandboxed Bash:

- `security find-generic-password -s flight-deck-test -w` printed the dummy value.
- `git credential-osxkeychain get` returned the dummy username and password.

The sandbox reported no violation for either. The sandbox runtime's Seatbelt profile allows Mach lookups of `com.apple.securityd.xpc` and `com.apple.SecurityServer` [S16]. Claude Code's docs say nothing about the Keychain and the sandbox, and list no setting that removes those lookups. `allowMachLookup` only adds services [S2]. Which other items a sandboxed command can read depends on each item's access list. This note didn't test the maintainer's real items, including Claude Code's own login, which lives in the login Keychain [S15]. **Unconfirmed.**

`gh` stores its token "in the system credential store" by default and falls back to a plain text file. `--insecure-storage` forces the file [S34]. Whether a sandboxed command can read a token that `gh` stored this way is **Unconfirmed**.

## 4. The sandbox and `dontAsk` together

### Sandboxed commands run with no allow rules

`sandbox.autoAllowBashIfSandboxed` is still the key's name, and it defaults to `true` [S2]. Auto-allow works independently of the permission mode, except in plan mode and in two auto-mode cases [S1]. [T5] ran a script through sandboxed Bash in a `-p` run with `--permission-mode dontAsk` and no allow rules, and the result held no permission denials.

Some sandboxed commands still go through the regular permission flow, which denies them in `dontAsk` unless an allow rule matches [S1]:

- A command with a variable assignment in front, such as `FOO=bar npm test`
- `make CC=clang` and `eval`
- `rm` or `rmdir` on a critical path
- Commands that match a content-scoped ask rule such as `Bash(git push *)`
- Monitor tool commands

Deny rules still apply to sandboxed commands [S1].

### What the three sandbox keys do

| Key | Effect |
| :- | :- |
| `allowUnsandboxedCommands: false` | Claude Code ignores the `dangerouslyDisableSandbox` retry, so commands stay sandboxed unless they match `excludedCommands`. From `--settings` or managed settings, it also makes the sandbox admin-required [S1][S2]. In `dontAsk`, the retry is denied anyway [S1] |
| `excludedCommands` | Commands that match run outside the sandbox and go through the regular permission flow. A call leaves the sandbox only when every command in it matches, and calls with `cd`, a redirect, or `$(...)` stay sandboxed [S1][S2] |
| `failIfUnavailable: true` | Claude Code exits at startup when `sandbox.enabled` is `true` but the sandbox can't start. Without it, commands run unsandboxed [S2] |

[T13] saw `failIfUnavailable` fail closed in a second way. Inside `srt`, Claude Code started, and the first Bash call failed with `Sandbox is required but failed to initialize`. The command didn't run.

### What a repo's settings can and can't change

`--settings` ranks above project and local settings, and only managed settings rank above it [S3]. List keys merge across scopes instead [S3]. While the sandbox is admin-required, Claude Code ignores a repo's loosening keys, including `excludedCommands`, `allowedDomains`, `allowWrite`, `Edit(...)` allow rules, `additionalDirectories`, and `allowMachLookup`. It also ignores a repo's `enabled: false` when the user's `~/.claude/settings.json` sets `true` [S1]. A `true` in `--settings` outranks the repo's value anyway [S3]. A repo can never set `filesystem.disabled`, `allowAppleEvents`, `strictAllowlist`, or the `mask` credential keys [S1].

[T9] gave a worktree's `.claude/settings.json` this content:

- `sandbox.enabled: false`
- `excludedCommands: ["touch *"]`
- `allowWrite` covering `/tmp/fd-guard-*` and `~/`
- `allowRead` covering a folder that `--settings` denies
- `filesystem.disabled: true`
- A `Bash(touch *)` allow rule

| `--settings` | Sandbox on | `touch` outside the working directory | Script writes to `/tmp` and `~` | Denied read |
| :- | :- | :- | :- | :- |
| `enabled`, `allowUnsandboxedCommands: false`, `denyRead` | Yes | Ran sandboxed and failed | Denied | Denied |
| `enabled`, `denyRead` only | Yes | Left the sandbox, then `dontAsk` denied it | Allowed | Denied |
| None | No | Denied by `dontAsk` | Denied by `dontAsk` | Not run |

Without the admin-required lock, the repo's `allowWrite` let sandboxed Bash write to `~`, and its `excludedCommands` took `touch` out of the sandbox. Its `filesystem.disabled` and `allowRead` didn't apply in any run [T9].

The repo's `Bash(touch *)` allow rule didn't apply either. In a `-p` run, Claude Code doesn't use `permissions.allow` rules or `additionalDirectories` from `.claude/settings.json`, unless `~/.claude.json` marks the folder trusted by hand. Hooks, the `env` block, and `.mcp.json` servers from the same file do apply [S4].

## 5. Settings that change mid-session

### Edits apply to the running session

Claude Code watches its settings files and applies most edits, including `permissions` and `hooks`, without a restart. It also loads a project `.claude/` folder created mid-session [S3]. A `ConfigChange` hook fires for each settings-file change it detects [S3].

[T11] ran with the sandbox off and only `Bash(python3 *)` allowed. A Python script wrote a `Bash(touch *)` allow rule to `.claude/settings.local.json` and a `PostToolUse` hook to `.claude/settings.json`. The next command, `touch`, ran, and the new hook fired on it. In the control run, the script wrote nothing and `dontAsk` denied `touch`.

With the sandbox on, sandboxed Bash couldn't write either file [T5], and the Write tool's write to `.claude/settings.local.json` was denied in `dontAsk` [T7]. A sandboxed command could still commit `.claude/settings.json` with git plumbing [T6].

### Project hooks run unprompted and outside the sandbox

A `-p` run never shows the trust dialog, and it uses hooks from the repo's settings files [S4]. Command hooks run outside the sandbox with the user's full access [S1]. In [T10], a `PreToolUse` hook from a worktree's `.claude/settings.json` ran on the first Bash call with no prompt. The sandbox was on and admin-required. The hook wrote a file in `~` and read the dummy Keychain item.

`--settings '{"disableAllHooks": true}'` turns hooks off for one run, whatever the project's settings say. It can't turn off managed hooks [S12].

## 6. Wrapping the whole `claude` process with the sandbox runtime

`@anthropic-ai/sandbox-runtime` wraps a whole process in the same Seatbelt or bubblewrap isolation the Bash sandbox uses. Under it, Claude's file tools, hooks, and MCP servers are confined too [S13]. Status as of 2026-10-17:

- The README calls it a "Beta Research Preview" and warns that "APIs and configuration formats may evolve" [S16].
- Version 0.0.80 was published to npm on 2026-10-16 [S17].
- The repo moved from `anthropic-experimental/sandbox-runtime` to `anthropics/sandbox-runtime` [S16].

[T13] ran `srt --settings <file> -- claude -p ...` with a subscription login and no API key in the environment:

- `claude auth status` inside `srt` reported `"authMethod": "claude.ai"`, and a `-p` run returned its answer. This Mac has no `~/.claude/.credentials.json` fallback file, so the login came from the Keychain.
- The Read tool refused a file in the runtime's `denyRead` list. The Write tool got `EPERM` on a path outside `allowWrite`, even with a bare `Write` allow rule.
- The first attempt also allowed writes to all of `/private/tmp`, the setting the docs name for Claude Code's runtime files [S13], and the Write tool then wrote a test file elsewhere under `/tmp`. Narrowing it to `/private/tmp/claude-501` closed that.

Some details caught the test:

- `srt` reads `--settings` anywhere on its command line, including after the wrapped command. Put `--` before `claude`.
- `srt` refused a config file with no `network.deniedDomains` key and printed `Refusing to run with the built-in defaults`. The docs say an empty, unreadable, or invalid settings file stops it from starting. A missing `~/.srt-settings.json` starts it with defaults that block the network [S13].
- The built-in Bash sandbox inside `srt` failed to start, as described under section 4.

The runtime always denies writes to `.git/hooks`, to `.git/config` unless `allowGitConfig` is set, to `.mcp.json`, `.claude/commands`, `.claude/agents`, and to shell startup files at the project root [S13][S16]. Its list doesn't include `.claude/settings.json`. The docs say to add Claude Code's other configuration paths to `denyWrite` [S13].

On SIGINT and SIGTERM, `srt` forwards the signal to its one child process. The source has no process-group kill [S16].

## 7. MCP tool permissions

The rule forms are documented [S4]:

- `mcp__<server>` and `mcp__<server>__*` match every tool on the server.
- `mcp__<server>__<tool>` matches one tool.
- Allow rules take a glob only after a literal `mcp__<server>__` prefix. `mcp__*` works as a deny rule but not as an allow rule.
- A bare-name deny rule removes the tool from Claude's context.
- A settings file skips any `mcp__` rule with parentheses. Parameter matching for MCP tools works only through `--disallowedTools` [S4].

[T12] ran a fake stdio server named `linear` with tools `get_issue` and `merge_diff`, in `dontAsk`. The server logged every call it received.

| Rules | Tools in the session | Calls that reached the server |
| :- | :- | :- |
| None | Both | None. Both were denied |
| Allow `mcp__linear` | Both | Both |
| Allow `mcp__linear`, deny `mcp__linear__merge_diff` | `get_issue` only | `get_issue` |
| Allow `mcp__linear__*` | Both | Both |

A `PreToolUse` hook with matcher `mcp__linear__.*` received JSON with `"tool_name": "mcp__linear__merge_diff"`, `"tool_input": {"id": "FLD-1"}`, and `"mcp_server": {"name": "linear", "source": "dynamic"}` [T12]. The docs say to base trust decisions on `mcp_server.source` rather than the name prefix [S12].

`dontAsk` also denies MCP tools marked `requiresUserInteraction` and connector tools an organization set to `ask`, even when an allow rule matches [S5].

## 8. Stopping sessions

### What each signal reached

[T14] started `claude -p` as a session leader with the sandbox on, the fake MCP server, and two `run_in_background` commands, `python3 -m http.server` and `sleep`. Each background command ran under its own `zsh`, whose process group was its own PID, not `claude`'s. The MCP server shared `claude`'s process group.

| Signal | `claude` | MCP server | Background commands |
| :- | :- | :- | :- |
| SIGTERM to the `claude` PID | Exited 143 | Stopped | Stopped |
| SIGTERM to the process group | Exited 143 | Stopped | Stopped |
| SIGKILL to the `claude` PID | Killed, 137 | Exited when its stdin closed | Kept running, with parent PID 1 |
| SIGKILL to the process group | Killed, 137 | Killed | Kept running, with parent PID 1 |

The fake server exits when its stdin closes. Whether a real MCP server does the same is **Unconfirmed**.

The docs say SIGTERM makes Claude Code end the process tree of any Bash command still running, run `SessionEnd` hooks, and exit with 143 [S6]. When Claude Code stops an MCP server itself, it sends SIGINT, then SIGTERM 100 ms later, then SIGKILL 400 ms after that [S8]. Whether a command that a foreground Bash call left running with `&` dies on SIGTERM is **Unconfirmed**.

### Related limits

- When launchd's job dies, launchd kills remaining processes with the job's process group ID unless `AbandonProcessGroup` is `true` [S33]. Background commands in their own process groups fall outside that cleanup.
- After its result, a `-p` run waits for background commands it started. When the prompt is passed as text, each background command gets 10 minutes before Claude Code stops it. Otherwise the limit is 30 minutes, or up to 2 hours when Claude passes a `timeout` [S6][S14]. [T14] saw both background commands stopped "after reaching its background time limit" about 10 minutes in.
- Claude Code blocks a standalone `sleep` command and tells Claude to use `run_in_background` or Monitor instead [T14].

## 9. GitHub rulesets

### Plans and who can bypass

- Rulesets are available "in public repositories with GitHub Free and GitHub Free for organizations, and in public and private repositories with GitHub Pro, GitHub Team, and GitHub Enterprise Cloud" [S18].
- People with admin access, or a custom role with "edit repository rules", can create and edit rulesets [S18].
- The settings UI lists these bypass actors [S19]:
	- Repository admins, organization owners, and enterprise owners
	- The maintain or write role, or custom repository roles based on the write role
	- Teams, excluding secret teams
	- GitHub Apps
	- Dependabot
- The REST API's `actor_type` accepts `Integration`, `OrganizationAdmin`, `RepositoryRole`, `Team`, `DeployKey`, and `User` [S21]. The UI page names neither deploy keys nor individual users [S19].
- "OrganizationAdmin is not applicable for personal repositories" [S21].
- `bypass_mode` is `always`, `pull_request`, or `exempt`. `pull_request` doesn't apply to deploy keys, and `exempt` skips the rules without an audit entry [S21]. With "For pull requests only", the actor has to open a pull request and can then merge it past the rules [S19].

A repo owned by a personal account has two permission levels, the owner and collaborators, and every collaborator can push and merge [S23]. Which bypass actors a personal-account repo's ruleset accepts in practice, such as whether `User` and `DeployKey` work there, is **Unconfirmed**. A GitHub App installation token's activity is attributed to the app [S26]. That such a token matches an `Integration` bypass entry follows from that attribution, but no page says it. **Unconfirmed.**

### Rules on a branch pattern

Branch rulesets target names with `fnmatch` patterns. `qa/*` matches branches with one slash after `qa`, not `qa/foo/bar` [S19]. For a pattern such as `flight-deck/*` [S20]:

- **Restrict creations.** Only bypass actors "can create branches or tags whose name matches the pattern."
- **Restrict updates.** Only bypass actors "can push to branches or tags whose name matches the pattern." The REST rule `update` takes `update_allows_fetch_and_merge` [S21].
- **Restrict deletions.** Only bypass actors "can delete branches or tags whose name matches the pattern." It's selected by default.
- **Block force pushes.** It's on by default.
- **Require a pull request before merging** and **Require status checks** also exist. A required pull request "doesn't necessarily have to be approved, but it must be opened."

### What Write can do without a rule

- The Write role can merge a pull request and push to the repo. It can't push to a protected branch, and GitHub notes that this "doesn't apply to rulesets as these have a different bypass model" [S22].
- "You must have write access to a repository to create a branch, open a pull request, or delete and restore branches in a pull request" [S25].
- "By default, you cannot delete a protected branch" [S24].

No page says outright that Write can delete any branch, or push to the default branch, when no rule or protection covers it. It follows from the push permission. **Unconfirmed.**

## 10. The Linear MCP server's `merge_diff`

- The tool's description reads "Merge a Linear diff or add it to the repository's merge queue". It takes `urlOrId`, described as "Linear review URL, diff slug, pull request ID, Linear full identifier, or GitHub PR URL", and an optional `mergeMethod` of `MERGE`, `REBASE`, or `SQUASH` [S32].
- A diff is a GitHub pull request reviewed in Linear: "Linear Diffs is a performant PR review tool". Review activity syncs with GitHub [S27]. Diffs launched on 2026-05-28 on all plans [S29].
- Linear's docs say "Once a pull request is ready and you have permission, you can merge it directly from Linear." They don't say whose permission [S27].
- Repository settings still decide which merge methods are available, and a method GitHub disables or a merge queue restricts can't be used [S28].
- Review actions happen "as the authenticated GitHub user", and personal GitHub connections are required to reach pull requests [S27]. Neither statement names merges.
- Since 2026-10-08, Linear asks for confirmation before merging "when you are not responsible for merging it" [S30].

Which GitHub identity performs a `merge_diff` merge, the Linear GitHub App or the connected user, isn't stated in Linear's docs or changelog. **Unconfirmed.** Neither is whether GitHub rulesets apply to it, or whether the MCP tool needs a connected personal GitHub account.

Linear's MCP server can be narrowed in two documented ways. `https://mcp.linear.app/mcp/readonly` "only ever exposes read tools", and a token with only the `read` OAuth scope can't reach write APIs. The server also accepts a bearer token or API key, including for an app user [S31]. No Linear page lists a way to drop single write tools. A Claude Code deny rule removes `merge_diff` from the session, as section 7 shows [T12].

## Facts by limit

This table sorts the findings above by the limits FLD-12 names. It records what exists and what got through in the tests. It doesn't choose among them.

| Limit | Mechanisms the sources and tests show | What got through in a test, or stays open |
| :- | :- | :- |
| Merge a pull request | A ruleset's pull-request rule on the default branch, with a bypass list [S19][S20]. A deny rule for `mcp__linear__merge_diff` [T12]. A sandbox deny list for `api.github.com` [T5] | Which identity `merge_diff` merges as. **Unconfirmed** |
| Push to the default branch | A ruleset's restrict-updates or pull-request rule [S20]. Denying `github.com` in the sandbox blocks HTTPS and SSH git [T5][T8] | Sandboxed Bash moved the local `main` ref [T5] |
| Publish a package | The sandbox's hostname allowlist [S1] | The proxy checks hostnames only [S1]. Whether a registry allowed for installs also takes publishes on the same host is **Unconfirmed** |
| Read secrets | `denyRead` and `credentials` for Bash [S1]. `Read(...)` deny rules for the file tools [T7]. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` for every subprocess [S1] | The Keychain from sandboxed Bash [T5]. Hooks and MCP servers run outside the sandbox [S1][T10]. The Read tool ignores sandbox `denyRead` [T7] |
| Delete branches | Ruleset restrict-deletions on a pattern [S20] | Local branch refs are writable from the sandbox [T5]. Write's power over uncovered branches is **Unconfirmed** |
| Use the maintainer's own accounts | `disableClaudeAiConnectors`, `autoMemoryEnabled`, and an `env` block in `--settings` [T1][T3]. Leaving `local` out of `--setting-sources` [T4] | Keychain items readable by `security` and `git credential-osxkeychain` [T5]. The main checkout's `settings.local.json` [T4]. A repo `env` block over the shell's variables [T3] |
| Change its own settings | Sandbox protected paths [T5]. `dontAsk` denies protected-path writes from file tools [T7]. `ConfigChange` hooks [S3] | A git plumbing commit of `.claude/settings.json` [T6]. A repo's `allowWrite` and `excludedCommands` unless the sandbox is admin-required [T9] |

## How the local tests ran

All tests used Claude Code 2.1.302 at `~/.local/bin/claude`, macOS 26.6.2, `git` 2.55.0, and the maintainer's subscription login. `claude auth status` reported `"authMethod": "claude.ai"`. Each run started `claude -p` with `--model haiku`, `--max-turns` of 3 or less, and `--setting-sources project,local`. The environment was reduced with `env -i` to `HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH`, `TMPDIR`, and `LANG`, to approximate what a launchd job gets.

The test repo was `/tmp/fd-guard-XWHL6l/repo`. Worktrees came from `git worktree add` under `/tmp/fd-guard-XWHL6l/data/`, so each worktree's common dir sat outside its working directory. Runs that needed an MCP server passed `--mcp-config` with a fake stdio server named `linear`, a Python script that logged every call. Most runs also set `--strict-mcp-config`. The other [T1] runs and the first [T3] run left it out, because they checked the connectors.

The runner-like settings, passed with `--settings`, were:

```json
{
	"sandbox": {
		"enabled": true,
		"failIfUnavailable": true,
		"allowUnsandboxedCommands": false,
		"filesystem": { "denyRead": ["/tmp/fd-guard-XWHL6l/secret"], "allowRead": ["/tmp/fd-guard-XWHL6l/secret/public"] },
		"network": { "allowedDomains": ["registry.npmjs.org"], "deniedDomains": ["github.com", "*.github.com"] }
	}
}
```

| ID | What ran |
| :- | :- |
| T1 | Seven runs that read the `system`/`init` event: baseline, then each switch from section 1, then both settings keys together |
| T2 | A dummy `MEMORY.md` marker in the test repo's auto memory folder, recited or not in three runs |
| T3 | A repo `env` block setting `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` and `ENABLE_CLAUDEAI_MCP_SERVERS=true`, against three ways of turning memory off |
| T4 | `autoMemoryEnabled: false` placed in the main checkout's `.claude/settings.local.json`, then in the worktree's, read from a worktree session |
| T5 | One sandboxed script in `dontAsk` with the runner-like settings, running 44 probes of writes, reads, Keychain lookups, and network calls |
| T6 | A sandboxed script that committed `.claude/settings.json` with `git hash-object`, `git update-index`, and `git commit` |
| T7 | Read and Write tool calls under sandbox `denyRead`, `Read(...)` deny rules, and bare `Write` allow rules, plus three runs checking whether `Edit`, `Write`, and `Edit(./**)` allow rules widened sandboxed writes |
| T8 | `git ls-remote ssh://git@github.com/...` from the sandbox with `github.com` allowed, then denied, with ssh config ignored and only a dummy key offered |
| T9 | A loosening repo `.claude/settings.json` against admin-required `--settings`, non-admin `--settings`, and no `--settings` |
| T10 | A `PreToolUse` hook in a worktree's `.claude/settings.json`, with the runner-like settings |
| T11 | A mid-session write of an allow rule and a hook, against a control run that wrote nothing |
| T12 | Four runs calling the fake `get_issue` and `merge_diff` under different MCP rules, one with a logging `PreToolUse` hook |
| T13 | `@anthropic-ai/sandbox-runtime` 0.0.80, installed with `--ignore-scripts` into its own `/tmp` folder, wrapping `claude auth status` and `claude -p` |
| T14 | Four runs that started two `run_in_background` commands, then sent SIGTERM or SIGKILL to the `claude` PID or its process group, and listed survivors with `ps` |

Cleanup removed the dummy Keychain items, the test repo, the dummy memory file, the runtime install, and the transcript folders the test sessions created under `~/.claude/projects/`.

## Sources

| ID | Source |
| :- | :- |
| S1 | [Configure the sandboxed Bash tool](https://code.claude.com/docs/en/sandboxing) |
| S2 | [Settings reference](https://code.claude.com/docs/en/settings-reference) |
| S3 | [Settings files and precedence](https://code.claude.com/docs/en/settings) |
| S4 | [Configure permissions](https://code.claude.com/docs/en/permissions) |
| S5 | [Choose a permission mode](https://code.claude.com/docs/en/permission-modes) |
| S6 | [Run Claude Code programmatically](https://code.claude.com/docs/en/headless) |
| S7 | [Environment variables](https://code.claude.com/docs/en/env-vars) |
| S8 | [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp) |
| S9 | [Manage Claude's memory](https://code.claude.com/docs/en/memory) |
| S10 | [Extend Claude with skills](https://code.claude.com/docs/en/skills) |
| S11 | [CLI reference](https://code.claude.com/docs/en/cli-reference) |
| S12 | [Hooks reference](https://code.claude.com/docs/en/hooks) |
| S13 | [Choose a sandbox environment](https://code.claude.com/docs/en/sandbox-environments) |
| S14 | [Tools reference](https://code.claude.com/docs/en/tools-reference) |
| S15 | [Authentication](https://code.claude.com/docs/en/authentication) |
| S16 | [anthropics/sandbox-runtime](https://github.com/anthropics/sandbox-runtime) at commit `626a596`, 2026-10-16: `README.md`, `src/sandbox/sandbox-utils.ts`, `src/sandbox/macos-sandbox-utils.ts`, `src/sandbox/sandbox-config.ts`, and `src/cli.ts` |
| S17 | [`@anthropic-ai/sandbox-runtime` on npm](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime), version 0.0.80, published 2026-10-16 |
| S18 | [GitHub Docs, About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets) |
| S19 | [GitHub Docs, Creating rulesets for a repository](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository) |
| S20 | [GitHub Docs, Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) |
| S21 | [GitHub REST API, Repository rules](https://docs.github.com/en/rest/repos/rules) |
| S22 | [GitHub Docs, Repository roles for an organization](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization) |
| S23 | [GitHub Docs, Permission levels for a personal account repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/permission-levels-for-a-personal-account-repository) |
| S24 | [GitHub Docs, About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) |
| S25 | [GitHub Docs, Branches](https://docs.github.com/en/pull-requests/reference/branches) |
| S26 | [GitHub Docs, Authenticating as a GitHub App installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation) |
| S27 | [Linear Docs, Diffs](https://linear.app/docs/diffs) |
| S28 | [Linear Docs, Code and reviews](https://linear.app/docs/code-and-reviews) |
| S29 | [Linear Changelog, Linear Diffs](https://linear.app/changelog/2026-05-27-linear-diffs), dated 2026-05-28 on the page |
| S30 | [Linear Changelog, Stacked pull requests](https://linear.app/changelog/2026-10-08-stacked-pull-requests), 2026-10-08 |
| S31 | [Linear Docs, MCP server](https://linear.app/docs/mcp) |
| S32 | The Linear MCP server's tool list, read through Claude Code's MCP client on 2026-10-17. No tool was called |
| S33 | `man launchd.plist`, macOS 26.6.2 |
| S34 | [GitHub CLI manual, `gh auth login`](https://cli.github.com/manual/gh_auth_login) |
