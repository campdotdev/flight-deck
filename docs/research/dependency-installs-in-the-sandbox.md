# Why `pnpm install` fails in the sandbox, and what an install runs with scripts off

Research note for [FLD-41](https://linear.app/campdotdev/issue/FLD-41/how-does-a-factory-session-install-a-repos-dependencies-inside-the). It builds on [What can stop an unattended session from merging, pushing, or reading secrets](unattended-session-guardrails.md) and corrects that note's list of the runtime's protected paths. Sources were read on 2026-10-21 and are listed under [Sources](#sources), such as [S1]. Local tests ran on 2026-10-21, US time, on macOS 26.6.2 with `@anthropic-ai/sandbox-runtime` 0.0.81, Node 26.5.0, and the package-manager versions each test names. They are listed under [How the local tests ran](#how-the-local-tests-ran), such as [T1].

Each claim carries one of three tags, or a citation that implies it:

- **Confirmed by local test** means a test in this note produced the result.
- **Documented** means a primary source says it.
- **Unconfirmed** means neither a test nor a primary source settles it.

No test started a `claude` session. The tests ran `srt` and plain commands only, so no result here comes from Claude Code's built-in sandbox at run time. [T8] read Claude Code's installed binary as a file.

## Answer

1. **The runtime's protected names.** `srt` denies writes to nine file names and four folder names: `.gitconfig`, `.gitmodules`, `.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile`, `.profile`, `.ripgreprc`, `.mcp.json`, and `.vscode`, `.idea`, `.claude/commands`, `.claude/agents`, plus `.git/hooks` and `.git/config`. On macOS each name is denied at the working directory's top level and, through a Seatbelt regex, at any depth below it, `node_modules` included. On Linux a ripgrep scan finds them down to `mandatoryDenySearchDepth`, 3 by default, and skips `node_modules`. `allowGitConfig` lifts only `.git/config`, and `filesystem.disabled` lifts all of them. No other key changes the list on macOS. **Documented** [S1] and **Confirmed by local test** [T1].
2. **Claude Code's sandbox runs the same code.** Claude Code 2.1.306 embeds the runtime's two lists and its macOS deny function unchanged, and adds its own `.claude` and bare-repo denies on top. Its settings expose `filesystem.disabled` but neither `allowGitConfig` nor `mandatoryDenySearchDepth`. The docs' "in your working directory only" means not in the folders above it. It doesn't mean the top level only. **Confirmed by local test** [T8], and **Documented** [S3][S4].
3. **A `node_modules` symlink to a folder outside the working directory.** Under `srt`, writes into `.idea` and `.vscode` deep inside `node_modules/.pnpm/...` failed with a real `node_modules` folder and succeeded through the symlink. `pnpm install` of `javascript-natural-sort@0.7.1` failed with `EPERM` in the first layout and installed in the second, if the target folder wasn't empty. Against an empty target, pnpm deleted the target and failed with `ENOTDIR`, with or without `srt`. Node resolved a package that only the project's top level holds from inside the symlinked virtual store, and failed to from a virtual store placed elsewhere. A `.gitignore` entry of `node_modules/` doesn't match the symlink. **Confirmed by local test** [T1][T2][T3][T4][T5]. The same layout under Claude Code's built-in sandbox is **Unconfirmed**.
4. **Repo-chosen code with scripts off.** All four package managers run some repo-chosen code or reach repo-chosen hosts with scripts off:
	- pnpm runs `.pnpmfile.cjs` and `configDependencies` plugins at config load and switches to the pnpm version the repo pins. It can download Node, and it fetches lockfile tarball URLs as written in v10 and while verifying them in v11. `pnpm fetch` loads the same config, pnpmfile included. Only `--ignore-pnpmfile` stops the pnpmfile.
	- npm 10 and 11 run the program the repo's `.npmrc` names in `git` whenever a git dependency exists. npm 11 also runs its `node-options` through the git dependency's `npm install`. npm 12 blocks git and off-registry tarballs by default, but the repo's `.npmrc` can reopen both.
	- Yarn Berry has no `--ignore-scripts`. It runs `yarnPath`, plugins, and git-dependency packing whatever the script settings say.
	- Bun imports a `bunfig.toml` security scanner on every install and reads the repo's `.env` files.

	**Confirmed by local test** [T9][T10][T11][T12], and **Documented** [S21] to [S32].
5. **The slow proxy.** No issue in `anthropics/claude-code` or `anthropics/sandbox-runtime` reports slow downloads through the sandbox proxy. Through `srt` 0.0.81 under Node, a 43.7 MB tarball downloaded at the direct speed, and a cold `pnpm install` of 154 packages took 11 seconds against 10 seconds direct. Claude Code runs the same proxy code inside its own process, on Bun 1.4.4. Why the prototype's installs ran at 23 to 48 KiB/s is **Unconfirmed**. The only settings that touch the proxy replace it: `network.httpProxyPort` and `network.socksProxyPort`. **Confirmed by local test** [T6][T7][T8], and **Documented** [S3][S4].

## 1. The runtime's protected names

### The runtime has two lists

`src/sandbox/sandbox-utils.ts` defines both lists [S1]:

```ts
export const DANGEROUS_FILES = ['.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json'] as const
export const DANGEROUS_DIRECTORIES = ['.git', '.vscode', '.idea'] as const
```

`getDangerousDirectories()` drops `.git` and adds `.claude/commands` and `.claude/agents`. `.git` gets two narrower entries instead, `.git/hooks` and `.git/config`, so git can still write the rest of it [S1]. The README's "Mandatory Deny Paths" section lists the same names [S1].

The guardrails note's section 6 named `.git/hooks`, `.git/config`, `.mcp.json`, `.claude/commands`, `.claude/agents`, and shell startup files "at the project root". It left out `.vscode`, `.idea`, `.gitconfig`, `.gitmodules`, and `.ripgreprc`, and on macOS the denies aren't limited to the project root.

### How deep the denies reach

| Platform | How the deny is built | Depth | `node_modules` |
| :- | :- | :- | :- |
| macOS | `macGetMandatoryDenyEntries()` emits, per name, a literal path in the working directory and a glob anchored at it: `**/<file>` for a file, `**/<dir>/**` for a folder. The runtime compiles the glob into a Seatbelt `regex` filter [S1] | Any depth below the working directory | Matched |
| Linux | `linuxGetMandatoryDenyPaths()` denies the names in the working directory, then runs one `rg --files --hidden --no-ignore --max-depth <n+1>` scan for nested matches [S1] | `mandatoryDenySearchDepth`, default 3, range 1 to 10. A folder name counts one level shallower than a file name [S1] | Skipped. The scan passes `-g '!**/node_modules/**'` [S1] |

Three details come from the macOS code:

- The anchor is `process.cwd()` when the profile is built. A path outside that folder never matches the glob, even inside an `allowWrite` root [S1]. Issue #432 in the runtime's repo reports the same anchoring [S15].
- The regex for `**/.idea/**` needs a path below `.idea`. Creating the folder `.idea` deep in the tree succeeds, and creating anything inside it fails. At the top level, the literal entry denies the folder itself [S1]. [T1] saw both.
- Seatbelt matches the resolved path. A write through a symlink is checked at the place the symlink leads to [T1].

[T1] ran the same probe script under `srt` from two test worktrees whose `allowWrite` covered the worktree and a separate `outside` folder. `D` is `node_modules/.pnpm/pkg@1.0.0/node_modules/pkg`.

| Write | Real `node_modules` | `node_modules` symlinked to `outside/node_modules` |
| :- | :- | :- |
| `mkdir -p $D/lib`, `touch $D/lib/index.js` | Allowed | Allowed |
| `mkdir -p $D/.idea` | Allowed | Allowed |
| `touch $D/.idea/x` | Denied | Allowed |
| `touch $D/.vscode/x` | Denied | Allowed |
| `touch $D/.gitmodules`, `touch $D/.profile` | Denied | Allowed |
| `mkdir .idea` at the worktree's top level | Denied | Denied |
| `mkdir -p src/.idea`, then `touch src/.idea/x` | Folder allowed, file denied | Folder allowed, file denied |
| `outside/direct/.idea/x`, written by its real path | Allowed | Allowed |

A package that ships `.gitmodules`, a shell startup file such as `.profile`, or `.mcp.json` fails the same way as one that ships `.idea` [T1].

### Settings that change the list

| Key | Effect on the protected names | In Claude Code's settings |
| :- | :- | :- |
| `filesystem.allowGitConfig` | Lifts `.git/config` only. `.git/hooks` stays denied [S1] | Not listed [S4] |
| `mandatoryDenySearchDepth` | Sets the Linux scan depth. The macOS code doesn't read it [S1] | Not listed [S4] |
| `filesystem.disabled` | Drops every filesystem rule. The schema says the built-in protections "are NOT applied" [S1] | `sandbox.filesystem.disabled`, user or managed scope only, Claude Code v2.1.216 or later [S4] |
| `allowWrite` | Doesn't lift a protected name [S1][S3] | Same [S3] |

The macOS code has no exemption for `node_modules` and no per-name switch [S1]. Issue #540 in the runtime's repo asks for the Linux `node_modules` exemption on macOS. Pull request #541 adds it. Both are open [S12][S13]. Pull request #518, also open, would apply the protected names to every `allowWrite` root instead of the working directory alone [S14]. If it merges as written, the `outside` folder in [T1] gets the same denies. Issue #159, open since 2026-03-01, reports the `.idea` deny breaking git operations [S16].

### Claude Code's built-in sandbox bundles the same code

The docs say "Claude Code builds the sandbox on the open source `@anthropic-ai/sandbox-runtime` package" [S3]. [T8] found the runtime's code inside the Claude Code 2.1.306 binary:

- `[".gitconfig",".gitmodules",".bashrc",".bash_profile",".zshrc",".zprofile",".profile",".ripgreprc",".mcp.json"]` and `[".git",".vscode",".idea"]`, followed by the same `.claude/commands` and `.claude/agents` additions.
- The macOS function, minified, with the same `**/${name}` and `**/${name}/**` globs and `.git/hooks` and `.git/config` entries.
- The Linux scan with `"!**/node_modules/**"` and `--max-depth`.

Claude Code adds more denies of its own: the `.claude` settings files, `.claude/skills`, `.claude/hooks`, and `.claude/workflows` in the working directory and the folders above it, the files that would make the working directory a bare repo, and most of `~/.claude` [S3]. It lists the `.vscode` and `.idea` folders under "In your working directory only", next to "In your working directory and the directories above it" [S3]. The runtime's code shows that "only" excludes the folders above. It doesn't limit the deny to the top level.

The docs also say that on macOS, "when a denied path passes through a symlink ... the sandbox also denies the path's real location", for the sandbox's own denials and literal `denyWrite` and `denyRead` entries [S3]. The `node_modules` symlink in [T1] sits under a glob, not a literal path, and `srt` didn't deny through it. Whether Claude Code expands its glob denies through such a symlink is **Unconfirmed**.

Claude Code issues #61401, #80077, and #62404 report the `.idea` and `.vscode` denies breaking `pnpm install` and ask for an override. A bot closed all three as stale, with the reason "not planned" [S6][S7][S8].

## 2. A `node_modules` symlink that leaves the working directory

### pnpm installs through the symlink

[T2] ran `pnpm install --ignore-scripts` for a `package.json` that depends on `javascript-natural-sort@0.7.1`, whose tarball ships `.idea/scopes/scope_settings.xml` and seven other `.idea` files. `HOME` and the XDG folders pointed into the scratch folder, so the run used a fresh store and none of the maintainer's config.

| Layout under `srt` | Result |
| :- | :- |
| Real `node_modules` in the worktree | `ERR_PNPM_EPERM ... mkdir '.../javascript-natural-sort_tmp_4747_2/.idea/scopes'` |
| `node_modules` symlinked to a non-empty folder outside the worktree | Installed. The `.idea` files landed in the outside folder, and `require('javascript-natural-sort')` from the worktree worked |
| Real `node_modules`, with `--config.enable-global-virtual-store=true` | Installed. `node_modules/javascript-natural-sort` linked into the store, outside the worktree |

[T3] found one trap. When the symlink pointed at an empty folder, pnpm 11.15.1 deleted that folder and then failed with `ENOTDIR: not a directory, mkdir '.../node_modules'`. It did the same without `srt`, so the sandbox isn't the cause. A placeholder file in the target folder, `.keep` in the test, avoided it.

pnpm's docs call the global virtual store experimental and off by default for project installs. They warn that the store is "shared writable state" for "projects, users, and jobs that trust each other", and that hoisted dependencies resolve through `NODE_PATH`, which Node ignores for ESM imports [S18]. pnpm's guide to git worktrees for parallel agents recommends the global virtual store and says it "assumes the worktrees and agents share the same trust boundary" [S19]. The setting is spelled `virtualStoreType: global` from pnpm 11.23.0 on [S18].

### Module resolution survives moving the whole folder

The prototype's `--virtual-store-dir` run failed typecheck because `@testing-library/jest-dom` couldn't resolve `vitest`. [T4] rebuilt both layouts by hand, each with a `jest-dom` package in the virtual store that calls `require('vitest')`, and `vitest` reachable from the project's top-level `node_modules`:

| Layout | `require('jest-dom')` from the worktree |
| :- | :- |
| Whole `node_modules` symlinked out, virtual store inside it | Resolved `vitest` |
| `node_modules` in the worktree, virtual store elsewhere | `MODULE_NOT_FOUND` for `vitest` |

Node resolves a module from its real path and walks up through the `node_modules` folders above it. With the whole folder moved, the walk from `.pnpm/...` still reaches the project's top-level packages. With the virtual store moved alone, it never does. [T4] used plain Node only. Whether `tsc`, Vitest, and the rest of the Shaders toolchain behave the same with a symlinked `node_modules` is **Unconfirmed**.

### Git sees the symlink

git's docs say "If there is a separator at the end of the pattern then the pattern will only match directories" [S20]. A symlink isn't a directory to git. [T5] checked three `.gitignore` entries against a `node_modules` symlink:

| `.gitignore` entry | `git status --porcelain` |
| :- | :- |
| `node_modules/` | `?? node_modules` |
| `node_modules` | Ignored |
| `/node_modules` | Ignored |

With `node_modules/`, a `git add -A` in the session would commit the symlink.

### The outside folder needs an `allowWrite` entry from `--settings`

The outside folder has to be writable by sandboxed commands. When `--settings` sets `allowUnsandboxedCommands: false`, the sandbox is admin-required and Claude Code ignores a repo's `allowWrite` entries, so the entry has to come from `--settings`, user settings, or managed settings [S3]. Test T9 in the guardrails note confirmed that Claude Code ignored a repo's `allowWrite` in that mode.

## 3. Code an install runs with scripts off

"Scripts off" here means `--ignore-scripts` for pnpm, npm, and Bun. Yarn Berry has no such flag. Its nearest equivalents are `enableScripts: false` and `yarn install --mode=skip-build` [S28]. [T9] to [T12] ran each mechanism below against local fixtures, a local HTTP logger, and a local git daemon, with the versions each table names.

### pnpm 10 and 11

Tested on 10.34.7 and 11.15.1 [T9].

| Mechanism | What runs, or which host | Stops it | Source |
| :- | :- | :- | :- |
| `.pnpmfile.cjs`, and in v11 `.pnpmfile.mjs` | Top-level code and hooks run at config load, before the command. `--ignore-scripts` and `--frozen-lockfile` don't stop it. A frozen install whose `pnpmfileChecksum` doesn't match fails, after the file has run. The repo can point `pnpmfile` at another file, through `.npmrc` or `pnpm-workspace.yaml` in v10 and the YAML file only in v11 | `--ignore-pnpmfile`, which wins in both majors. In v10 a repo's `ignorePnpmfile: false` in YAML beats the environment variable. In v11 `pnpm_config_ignore_pnpmfile=true` beats the YAML | [S21] `cli/cli-utils/src/getConfig.ts`, [S22], [S23] `version-11.x/settings/build.md`: "This flag does not prevent the execution of .pnpmfile" |
| `configDependencies` | Installed at config load, before the pnpmfile, whatever `--ignore-scripts` or `--ignore-pnpmfile` say. A config dependency named `pnpm-plugin-*`, `@*/pnpm-plugin-*`, or `@pnpm/plugin-*` has its `pnpmfile.cjs` loaded. The tarball comes from the repo's registry, or from any URL in the `{tarball, integrity}` form | `--ignore-pnpmfile` stops the plugin pnpmfiles only. Nothing stops the download | [S21] `config/deps-installer/src/normalizeConfigDeps.ts`, [S22] `installing/env-installer/src/resolveAndInstallConfigDeps.ts` |
| `packageManager`, and in v11 `devEngines.packageManager` | pnpm downloads and runs the pinned pnpm, older versions included. 11.15.1 switched to 10.34.6. v10's `managePackageManagerVersions` defaults to `true`. v11's `pmOnFail` defaults to `download`. v10 switches after the pnpmfile has run, v11 before it. The download uses only CLI, environment, user, and global config, so a repo's registry and proxy settings don't steer it, and pnpm checks the package's npm signature | v10: `--config.manage-package-manager-versions=false`. The environment variable loses to a repo's YAML `true`. v11: `--pm-on-fail=ignore` or `pnpm_config_pm_on_fail=ignore`, which beats the YAML | [S21] `pnpm/src/switchCliVersion.ts`, [S22] `config/reader/src/index.ts`, [S23] `version-11.x/settings/cli.md` |
| Node download | v10 downloads Node for every command, install included, when `.npmrc` sets `use-node-version` or the YAML sets `useNodeVersion`. The mirror comes from the repo's `node-mirror:<channel>`. `devEngines.runtime` with `onFail: download` also downloads. v11 dropped `useNodeVersion` and downloads for `devEngines.runtime` and `engines.runtime`, from the repo's `nodeDownloadMirrors`. Since 10.34.2, pnpm checks the release channel's `SHASUMS256.txt` against Node release keys built into pnpm. Other channels go unchecked | v11: `pnpm_config_runtime_on_fail=ignore` | [S21] `env/node.resolver/src/getNodeMirror.ts`, [S23] `blog/releases/11.0.md` |
| Lockfile `resolution.tarball` | v10 fetches an absolute URL as written. It needs an `integrity` field, which the repo writes too. v11 checks each URL against the registry's metadata and fails with `ERR_PNPM_TARBALL_URL_MISMATCH`, but fetching overlaps the check, and the lockfile's host still got the request | Nothing stops the request. v11's check then fails the install, unless the repo sets `trustLockfile: true` | [S21] `lockfile/utils/src/pkgSnapshotToResolution.ts`, [S22] `resolving/npm-resolver/src/createNpmResolutionVerifier.ts` |
| Git dependency `prepare` | Skipped under `--ignore-scripts`, with a warning, even when the repo allowlists the dependency. pnpm runs `git` from `PATH`, and no setting changes which binary | `--ignore-scripts` | [S21] `exec/prepare-package/src/index.ts` |
| Registry, proxy, and TLS settings | Repo-chosen hosts for every request. v10 reads every setting from the project's `.npmrc`. v11 reads only auth, registry, and network keys from it and the rest from `pnpm-workspace.yaml`. Since 10.34.2 and 11.5.3, pnpm drops a `${VAR}` in a project file's registry values. `storeDir` and `cacheDir` stay settable from the YAML, so a repo can move writes outside the worktree | CLI flags and, in v11, `pnpm_config_*` variables | [S21] `config/config/src/index.ts`, [S22] `config/reader/src/localConfig.ts` |

Claude Code issue #98938, open, reports that pnpm 12 hangs on every command in the sandbox when the repo pins another pnpm version. The switch takes a lock under `~/Library/pnpm`, the sandbox denies the write, and pnpm waits forever [S33].

**`pnpm fetch`.** It loads the same config as `pnpm install`: `.npmrc`, `pnpm-workspace.yaml`, and the root `package.json`, with the version switch, the `configDependencies`, and the pnpmfile. In [T9] both its top-level code and its `afterAllResolved` hook ran. v10's `pnpm fetch` also honors `use-node-version`. It takes the dependency list from the lockfile, not from the projects' manifests, and v11 runs it with `virtualStoreOnly: true`, which runs no lifecycle scripts [S21][S22][S23].

Other pnpm mechanisms the sources show:

- In v11, a config dependency named `pacquet` or `@pnpm/pacquet` hands the install to that native binary, after pnpm checks its npm signature [S22].
- From v11.25, `pnprServer` with `sideEffectsCache.remote` in the YAML names a server for prebuilt artifacts [S23].
- `overrides`, `packageExtensions`, and `patchedDependencies` can point a dependency at any URL or git host, or patch installed files [S21].

### npm 10, 11, and 12

Tested on 10.9.9, 11.21.1, and 12.0.2 [T10].

| Mechanism | 10 | 11 | 12 | Source |
| :- | :- | :- | :- | :- |
| Project `.npmrc` sets `ignore-scripts=false` | The CLI flag and `npm_config_ignore_scripts=true` both win | Same | Same | [S26] `workspaces/config/lib/index.js` |
| `git` key, a path to any program | Run for `ls-remote` and `clone` whenever the tree has a git dependency, with scripts off | Same | Blocked first, because `allow-git` defaults to `none`. The repo's `.npmrc` can set `allow-git=all`. `--allow-git=none` on the CLI wins | [S26] `node_modules/@npmcli/git/lib/which.js`, `workspaces/config/lib/definitions/definitions.js` |
| Git dependency under `--ignore-scripts` | `prepare` runs, through the repo's `script-shell` | `prepare` doesn't run, but npm still starts `npm install --force` in the clone. That child gets the repo's `node-options` as `NODE_OPTIONS`, and a `--import=data:...` value ran code | Neither runs. pacote 22 checks `ignoreScripts` | [S24] `node_modules/pacote/lib/dir.js`, [S25] `node_modules/pacote/lib/git.js`, [S26] the same file |
| `file:` dependency `prepare` under `--ignore-scripts` | Runs | Doesn't run. Fixed in 11.0.0 | Doesn't run | [S24] `workspaces/arborist/lib/arborist/rebuild.js` |
| Lockfile `resolved` on another host | Fetched as written. The default `replace-registry-host=npmjs` rewrites only `registry.npmjs.org` | Same | Blocked with `EALLOWREMOTE`, because `allow-remote` defaults to `none`. The repo's `.npmrc` can set `allow-remote=all`, and the CLI flag wins | [S24] `reify.js`, [S26] `reify.js`, `definitions.js` |
| `.npm-extension.mjs` or `.cjs` | Not loaded | Not loaded | Imported while `npm install` builds the tree. `--ignore-scripts` turns it off, and `npm ci` never loads it | [S26] `workspaces/arborist/lib/arborist/build-ideal-tree.js` |
| `registry`, `@scope:registry`, proxy keys | Repo-chosen hosts. npm expands `${VAR}` in a project `.npmrc`, and a test sent an environment secret inside the registry URL | Same | Same | [S26] `workspaces/config/lib/env-replace.js` |
| `userconfig` and `globalconfig` in a project `.npmrc` | Honored, so the repo can redirect npm to config files it ships. `npm_config_userconfig` in the environment wins | Same | Same | [S26] `workspaces/config/lib/index.js` |

Refuted candidates: npm has no `npm-command` key, npm 7 removed `onload-script`, `shell` applies only to `npm explore`, and npm never reads `packageManager`. Its `devEngines` check warns or fails and downloads nothing [S26]. npm's docs still say a git dependency's `prepare` runs before install, without the `--ignore-scripts` exception [S26] `docs/lib/content/using-npm/scripts.md`.

Node stopped shipping Corepack in v25.0.0 [S27]. Node 26.5.0 on this Mac has no `corepack` binary. A separately installed Corepack 0.23.0 is at `/usr/local/bin/corepack`, and `npm` isn't a Corepack shim [T10].

### Yarn Berry 4

Tested on 4.18.1, run as `node yarn-4.18.1.js`, plus Yarn classic 1.22.19 and Corepack 0.23.0 [T11].

| Mechanism | What runs, or which host | Stops it | Source |
| :- | :- | :- | :- |
| Scripts off | `yarn install --ignore-scripts` fails with `Unsupported option name`. `enableScripts` defaults to `false` since 4.14 and gates third-party builds only. The workspace's own `preinstall` and `postinstall` still ran with `YARN_ENABLE_SCRIPTS=0`. `dependenciesMeta.<pkg>.built: true` in the root `package.json` turns a dependency's build back on, even against that variable | `--mode=skip-build` skips the whole build step, workspace scripts included. It doesn't skip fetch-time code | [S28] `Configuration.ts`, `Project.ts`, `plugin-pnp/sources/jsInstallUtils.ts`, [S29] |
| `yarnPath` in `.yarnrc.yml` | Every command, under any Yarn, execs `node <yarnPath>`, the repo's `.yarn/releases/*.cjs`. Yarn classic 1.22.19 and Corepack-launched Yarn both handed off. Yarn reads `.yarnrc.yml` from every folder up to `/` | `YARN_IGNORE_PATH=1`, which the repo can't override. `YARN_RC_FILENAME=<other>` skips the repo's `.yarnrc.yml` and all its settings | [S28] `packages/yarnpkg-cli/sources/lib.ts` |
| `plugins:` in `.yarnrc.yml` | Loaded on every command. The `afterAllInstalled` and `validateProject` hooks fired under `--mode=skip-build` with `YARN_ENABLE_SCRIPTS=0`. A plugin entry with a `spec:` URL and a missing file is downloaded from that URL | No switch except `YARN_RC_FILENAME` | [S28] `Configuration.ts`, `Plugin.ts` |
| `.env.yarn` | Read by default, since `injectEnvironmentFiles` defaults to `[".env.yarn?"]`. Its values reach every script's environment. A `NODE_OPTIONS=--require <file>` there ran that file in the workspace's install scripts | `--mode=skip-build`, since no script runs | [S28] `Configuration.ts`, `scriptUtils.ts` |
| `yarn.config.cjs` | Run after install when the repo sets `enableConstraintsChecks: true`, under `--mode=skip-build` too | Not setting the key | [S28] `plugin-constraints/sources/index.ts` |
| Git dependencies | Fetching one runs `yarn pack`, or `npm install` then `npm pack`, inside the clone. Neither `enableScripts` nor the install mode is checked. The dependency's `postinstall` and `prepack` ran under `YARN_ENABLE_SCRIPTS=0` and `--mode=skip-build` | `approvedGitRepositories`, which defaults to `[]`. The repo's `.yarnrc.yml` can set it. Whether it applies to `github:` dependencies, which go through `plugin-github`, is **Unconfirmed** | [S28] `plugin-git/sources/GitFetcher.ts`, `scriptUtils.ts`, `gitUtils.ts` |
| `exec:` dependencies | The generator script runs at fetch time | Gated by `enableScripts` or `built: true` | [S28] `plugin-exec/sources/ExecFetcher.ts` |
| A `yarn.lock` at version 8 or lower | Install migrates it by setting `enableScripts: true` and `approvedGitRepositories: ["**"]`, and writes both into the repo's `.yarnrc.yml`. A dependency's `postinstall` then ran | `YARN_ENABLE_SCRIPTS=0` stops the first. The second was still written | [S28] `plugin-essentials/sources/commands/install.ts` |
| Lockfile resolutions | An `__archiveUrl` or `https:` tarball resolution was fetched from its own host, with no checksum in the lockfile. Yarn added one | `--check-resolutions` or hardened mode | [S28] `NpmHttpFetcher.ts`, `plugin-http/sources/TarballHttpFetcher.ts` |
| Hosts in `.yarnrc.yml` | `npmRegistryServer`, `npmScopes`, `unsafeHttpWhitelist` for plain `http:`, `httpProxy`, `httpsProxy`, and `enableStrictSsl: false`. Rc values expand `${NAME}` from the environment and `.env.yarn` | `YARN_*` environment settings, which Yarn reads before the rc files | [S28] `Configuration.ts`, `httpUtils.ts` |

A committed `.pnp.cjs` wasn't evaluated by `yarn install` in any of three setups [T11]. Corepack downloads Yarn 2 and later from `repo.yarnpkg.com`, refuses a URL in `packageManager` unless `COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=1`, and from 0.32.0 reads a repo's `.corepack.env`, which can set that variable [S30]. The `.corepack.env` path is **Unconfirmed** by test.

Yarn's core takes its proxy only from the `httpProxy` and `httpsProxy` settings [S28] `httpUtils.ts`. `srt` sets `HTTP_PROXY` and `HTTPS_PROXY` but no `YARN_HTTPS_PROXY` [S1]. Whether Yarn Berry reaches the registry from inside the sandbox without that setting is **Unconfirmed**.

### Bun 1.x

Tested on 1.4.3 [T12].

| Mechanism | What runs, or which host | Stops it | Source |
| :- | :- | :- | :- |
| `[install.security] scanner` in `bunfig.toml` | A local module path. Bun starts itself with `--no-install -e` and imports the module on every install, `--ignore-scripts --frozen-lockfile` included | Removing the key | [S31] `src/install/PackageManager/security_scanner.rs`, [S32] |
| `.env`, `.env.local`, `.env.production`, `.env.production.local` | `bun install` loads them. `BUN_CONFIG_REGISTRY` there redirected requests, and `NODE_OPTIONS` there reached the root `postinstall` | The process environment beats `.env`. No install flag skips it | [S31] `src/install/PackageManager.rs` |
| Root and workspace scripts | Run on every install, whatever `trustedDependencies` says | `--ignore-scripts` | [S31] `src/install/lockfile/Package/Scripts.rs`, [S32] |
| Dependency scripts | Run for names in `trustedDependencies`, or in the built-in list of 367 names when the field is absent, if the tarball came from the configured registry. A fake `argon2` from a registry the repo named ran its `postinstall` | `--ignore-scripts` | [S31] `src/install/default-trusted-dependencies.txt`, `src/install/lockfile.rs` |
| `bun.lock` tarball URLs | Fetched from any host. A version 3 lockfile needs a well-formed `sha512` integrity, which the repo writes too | None found | [S31] `src/install/lockfile/bun.lock.rs` |
| Lockfile migration | With no `bun.lock`, Bun reads `package-lock.json`, `yarn.lock`, or `pnpm-lock.yaml` and fetches their URLs | A committed `bun.lock` | [S31] `src/install/migration.rs` |
| `.npmrc`, since 1.1.18 | `registry`, `@scope:registry`, `ca`, `cafile`, and auth keys, with `${NAME}` expanded | `bunfig.toml`, environment variables, and CLI flags, which rank above it | [S32] |

Refuted candidates: top-level `preload` applies to `bun run` and `[test].preload` to `bun test`, not to `bun install`. Bun ignores `packageManager`, and only `bun upgrade` downloads a Bun [S31][T12]. A git dependency's scripts run only when it's trusted, and not under `--ignore-scripts` [T12].

## 4. The slow proxy

### No issue reports slow downloads

Searches of both repos on 2026-10-21 for slow, throughput, download speed, KB/s, KiB, and pnpm or npm with the sandbox found no report of slow downloads. The proxy reports that exist are about lost bytes:

- Claude Code issue #100346, open: streaming responses through the sandbox proxy lose up to about 50 KB at the end [S10].
- Claude Code issue #81136, closed as stale: the proxy dropped part of large HTTPS bodies for Python clients, and curl was unaffected [S11].
- Claude Code 2.1.221 "Fixed sandboxed large uploads failing with TLS errors through the sandbox proxy" [S5].
- Runtime pull request #411, open: under Bun, `pipe()` on a socket from the HTTP server's `connect` event corrupts large uploads through the CONNECT tunnel. Node is unaffected [S17].

### `srt` ran at the direct speed

[T6] downloaded `next-16.4.2.tgz`, 43,679,232 bytes, from `registry.npmjs.org` three times directly and three times under `srt`:

| Path | Speed, three runs |
| :- | :- |
| Direct | 38.1, 38.5, and 36.9 MB/s |
| Through the `srt` proxy | 36.9, 37.5, and 37.8 MB/s |

[T7] ran a cold `pnpm install --ignore-scripts` of `next`, `react`, `react-dom`, `vitest`, `typescript`, and `@testing-library/jest-dom`, with an empty store each time. Both runs resolved 154 packages and downloaded 81. The direct run took 10 seconds and the `srt` run took 11.

### Claude Code runs the proxy in its own process

The runtime starts its HTTP and SOCKS proxies inside the process that calls `initialize()` [S1]. Under `srt`, that's Node. Under Claude Code, it's the Claude Code process, and the 2.1.306 binary is a Bun 1.4.4 executable [T8]. Claude Code issue #89772, open, reports Bash tool calls that block Claude Code's event loop for about 80 seconds at a time in large sessions [S9]. A proxy that runs in that process stalls while the loop is blocked. Whether either the Bun runtime or a blocked event loop caused the prototype's 23 to 48 KiB/s is **Unconfirmed**. The prototype's setup wasn't rerun here, because that needs a `claude` session.

### Settings that touch the proxy

`sandbox.network.httpProxyPort` and `socksProxyPort` point sandboxed commands at a proxy you run instead of Claude Code's. Claude Code then stops applying `allowedDomains`, `deniedDomains`, `strictAllowlist`, and its other network checks to that traffic. With an admin-required sandbox, only managed settings, `--settings`, and user settings can set a port [S3][S4]. The docs list no setting for the built-in proxy's speed [S3][S4].

## Facts by install layout

This table sorts the findings by the layouts the prototype and this note tried. It doesn't choose among them.

| Layout | Installs a package that ships `.idea` | Module resolution | Other facts |
| :- | :- | :- | :- |
| `node_modules` in the worktree | Fails on macOS [T2] | Normal | |
| `--virtual-store-dir` outside the worktree | Installed in the prototype | Undeclared lookups from the store miss the project's top level [T4] | |
| Whole `node_modules` symlinked outside | Installs under `srt` [T2] | Same walk as the default layout [T4] | Empty target deleted by pnpm [T3]. `node_modules/` in `.gitignore` doesn't match it [T5]. Claude Code untested |
| Global virtual store | Installs under `srt` [T2] | Hoisted lookups go through `NODE_PATH`, which ESM ignores [S18] | Experimental. One writable store shared by every session [S18] |
| `filesystem.disabled` | Not tested | Normal | Drops every filesystem rule, including the `.git/hooks` and `.claude` denies [S1][S3] |

## How the local tests ran

All tests ran on macOS 26.6.2. T1 to T8 shared one scratch folder under `/tmp`. `@anthropic-ai/sandbox-runtime` 0.0.81 [S2] was installed with `npm install --ignore-scripts` into its own folder there. Its `dist/sandbox/sandbox-utils.js` holds the same lists as the source at tag `v0.0.81`. In T1 to T8, pnpm was 11.15.1, Node 26.5.0, and git 2.55.0. Every pnpm run set `HOME` and the four XDG folders to a scratch home, so pnpm used a fresh store and cache and none of the maintainer's config.

Each `srt` run started from inside the test worktree, so the runtime's protected names anchored there. The settings had this shape, with the paths of each test:

```json
{
	"network": { "allowedDomains": ["registry.npmjs.org"], "deniedDomains": [] },
	"filesystem": {
		"denyRead": [],
		"allowWrite": ["<worktree>", "<outside folder>", "<scratch home>"],
		"denyWrite": []
	}
}
```

| ID | What ran |
| :- | :- |
| T1 | One `/bin/sh` probe script under `srt`, run from a worktree with a real `node_modules` and from one whose `node_modules` was a symlink to a folder outside it. 13 `mkdir` and `touch` probes each |
| T2 | `pnpm install --ignore-scripts` of `javascript-natural-sort@0.7.1` under `srt`: real `node_modules`, `node_modules` symlinked to a folder holding `.keep`, and real `node_modules` with `--config.enable-global-virtual-store=true`. Then `node -e "require('javascript-natural-sort')"` |
| T3 | The same install with `node_modules` symlinked to an empty folder, under `srt` and without it, against a `/tmp` and a `/private/tmp` target |
| T4 | Two hand-built layouts of `jest-dom` and `vitest` stub packages, one with the whole `node_modules` symlinked out and one with the virtual store elsewhere, each tested with `node -e "require('jest-dom')"` |
| T5 | A `git init` repo with a `node_modules` symlink and each of three `.gitignore` entries, read with `git status --porcelain --untracked-files=all` |
| T6 | `curl` of `https://registry.npmjs.org/next/-/next-16.4.2.tgz` three times directly and three times under `srt`, reading `%{speed_download}` |
| T7 | A cold `pnpm install --ignore-scripts` of six packages, once directly and once under `srt`, with the store and cache deleted before each, timed with `date +%s` |
| T8 | A byte search of the Claude Code 2.1.306 binary at `~/.local/share/claude/versions/2.1.306` for the runtime's lists, its macOS deny function, its Linux scan arguments, and Bun's version string. Nothing ran the binary |
| T9 | pnpm 10.34.7, fetched with `npx`, and 11.15.1: a pnpmfile that writes a marker, run under `install --ignore-scripts --frozen-lockfile --offline`, `--ignore-pnpmfile`, each settings source, and `pnpm fetch`. A `git+file://` dependency with a `prepare` marker. `packageManager: pnpm@10.34.6` with each opt-out. Lockfile tarball URLs, `configDependencies` tarballs, and Node mirrors pointed at a local HTTP logger |
| T10 | npm 10.9.9 and 11.21.1, installed with `--ignore-scripts`, and 12.0.2: a git dependency with a project `git=` program, a `node-options` import, and `script-shell`. A project `ignore-scripts=false`. `allow-git` and `allow-remote` from project and CLI. A lockfile `resolved` URL on a local port under `npm ci`. `.npm-extension.cjs`. Project `prefix`, `userconfig`, and `globalconfig`. A `file:` dependency with `prepare`. `${VAR}` in the project registry |
| T11 | Yarn 4.18.1 from `repo.yarnpkg.com`, Yarn classic 1.22.19, and Corepack 0.23.0: 14 tests covering a fake `yarnPath` release, a local plugin, workspace scripts, `.env.yarn`, `built: true`, a version 8 lockfile, constraints, a committed `.pnp.cjs`, `exec:`, a git dependency from a local `git daemon`, an `__archiveUrl` resolution, and `--ignore-scripts` |
| T12 | Bun 1.4.3 from its GitHub release: 12 tests covering `preload`, root and dependency scripts, `trustedDependencies`, a security scanner, `.env`, `.npmrc`, `packageManager`, `bun.lock` URLs at lockfile versions 1 and 3, migration from `package-lock.json`, a git dependency, and a fake `argon2` from a repo-named registry |

T9 to T12 ran in their own scratch folders, with `HOME`, the caches, and the stores inside them and the registries pointed at local servers. Nothing in them used the maintainer's config or reached a real registry except to download the package managers.

Cleanup removed every scratch folder, including the runtime install, the cloned sources, the test worktrees, the scratch pnpm stores, and the local HTTP and git servers.

## Sources

| ID | Source |
| :- | :- |
| S1 | [anthropics/sandbox-runtime](https://github.com/anthropics/sandbox-runtime) at commit `c40cf14`, tag `v0.0.81`, 2026-10-19: `README.md`, `src/sandbox/sandbox-utils.ts`, `src/sandbox/macos-sandbox-utils.ts`, `src/sandbox/linux-sandbox-utils.ts`, `src/sandbox/glob-pattern.ts`, `src/sandbox/sandbox-config.ts`, `src/sandbox/sandbox-manager.ts`, and `src/sandbox/http-proxy.ts` |
| S2 | [`@anthropic-ai/sandbox-runtime` on npm](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime), version 0.0.81, the `latest` tag on 2026-10-21 |
| S3 | [Configure the sandboxed Bash tool](https://code.claude.com/docs/en/sandboxing) |
| S4 | [Settings reference](https://code.claude.com/docs/en/settings-reference) |
| S5 | [Claude Code `CHANGELOG.md`](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) at commit `d014fc0`, entry under 2.1.221 |
| S6 | [anthropics/claude-code#61401](https://github.com/anthropics/claude-code/issues/61401), "Sandbox blocks writes to `.vscode/` and `.idea/` inside `node_modules/`, breaking `pnpm install`", closed as not planned on 2026-06-21 |
| S7 | [anthropics/claude-code#80077](https://github.com/anthropics/claude-code/issues/80077), "Sandbox .vscode write-deny breaks pnpm install of packages shipping .vscode/", closed as not planned on 2026-09-07 |
| S8 | [anthropics/claude-code#62404](https://github.com/anthropics/claude-code/issues/62404), "Sandbox: hardcoded deny on .idea/.vscode/.claude/.husky writes has no user override", closed as not planned on 2026-06-26 |
| S9 | [anthropics/claude-code#89772](https://github.com/anthropics/claude-code/issues/89772), "Bash tool dispatch blocks the event loop ~80s in a CPU spin", open |
| S10 | [anthropics/claude-code#100346](https://github.com/anthropics/claude-code/issues/100346), "Sandbox network proxy truncates the tail of streaming responses", open |
| S11 | [anthropics/claude-code#81136](https://github.com/anthropics/claude-code/issues/81136), "Sandbox HTTP proxy drops part of large HTTPS response bodies for Python clients", closed as not planned on 2026-09-06 |
| S12 | [anthropics/sandbox-runtime#540](https://github.com/anthropics/sandbox-runtime/issues/540), "macOS: mandatory-deny globs match inside node_modules", open |
| S13 | [anthropics/sandbox-runtime#541](https://github.com/anthropics/sandbox-runtime/pull/541), "fix(macos): exempt a dependency's own node_modules dotfiles from the mandatory denies", open |
| S14 | [anthropics/sandbox-runtime#518](https://github.com/anthropics/sandbox-runtime/pull/518), "fix(sandbox): auto-deny dangerous paths and .git/hooks across all allowedWrite roots", open |
| S15 | [anthropics/sandbox-runtime#432](https://github.com/anthropics/sandbox-runtime/issues/432), "macOS: location-independent deny globs ... are silently anchored to process.cwd()", open |
| S16 | [anthropics/sandbox-runtime#159](https://github.com/anthropics/sandbox-runtime/issues/159), "Hardcoded .idea in DANGEROUS_DIRECTORIES blocks legitimate git operations", open |
| S17 | [anthropics/sandbox-runtime#411](https://github.com/anthropics/sandbox-runtime/pull/411), "Replace pipe() with pull-mode relay on CONNECT sockets to avoid Bun stream corruption", open |
| S18 | [pnpm docs, Global Virtual Store](https://pnpm.io/global-virtual-store), source `docs/global-virtual-store.md` in [pnpm/pnpm.io](https://github.com/pnpm/pnpm.io) at commit `bd277d1` |
| S19 | [pnpm docs, pnpm + Git Worktrees for Multi-Agent Development](https://pnpm.io/git-worktrees), source `docs/git-worktrees.md` at the same commit |
| S20 | `man gitignore`, git 2.55.0 |
| S21 | [pnpm/pnpm](https://github.com/pnpm/pnpm) at tag `v10.34.7`, commit `f2c3feb`: `cli/cli-utils/src/getConfig.ts`, `hooks/pnpmfile/src/requirePnpmfile.ts`, `hooks/pnpmfile/src/requireHooks.ts`, `config/config/src/index.ts`, `config/deps-installer/src/normalizeConfigDeps.ts`, `pnpm/src/main.ts`, `pnpm/src/switchCliVersion.ts`, `env/node.resolver/src/getNodeMirror.ts`, `exec/prepare-package/src/index.ts`, `lockfile/utils/src/pkgSnapshotToResolution.ts`, and `pnpm/CHANGELOG.md` |
| S22 | pnpm/pnpm at tag `v11.15.1`, commit `331c26a`, under `pnpm11/`: `pnpm/src/getConfig.ts`, `pnpm/src/main.ts`, `pnpm/src/packageManagerRegistries.ts`, `hooks/pnpmfile/src/requireHooks.ts`, `installing/env-installer/src/resolveAndInstallConfigDeps.ts`, `installing/commands/src/fetch.ts`, `installing/commands/src/installDeps.ts`, `installing/deps-installer/src/install/index.ts`, `config/reader/src/index.ts`, `config/reader/src/localConfig.ts`, and `resolving/npm-resolver/src/createNpmResolutionVerifier.ts` |
| S23 | pnpm docs in [pnpm/pnpm.io](https://github.com/pnpm/pnpm.io) at commit `bd277d1`: `versioned_docs/version-10.x/settings.md`, `version-10.x/pnpmfile.md`, `version-11.x/settings/build.md`, `version-11.x/settings/cli.md`, `version-11.x/settings/node-modules.md`, `version-11.x/pnpmfile.md`, and `blog/releases/11.0.md` |
| S24 | [npm/cli](https://github.com/npm/cli) at tag `v10.9.9`, commit `65d5827`: `node_modules/pacote/lib/dir.js`, `workspaces/arborist/lib/arborist/rebuild.js`, and `workspaces/arborist/lib/arborist/reify.js` |
| S25 | npm/cli at tag `v11.21.1`, commit `1e39046`: `node_modules/pacote/lib/git.js`, `workspaces/config/lib/set-envs.js`, and `workspaces/config/lib/definitions/definitions.js` |
| S26 | npm/cli at tag `v12.0.2`, commit `b888cc9`: `workspaces/config/lib/index.js`, `workspaces/config/lib/env-replace.js`, `workspaces/config/lib/definitions/definitions.js`, `node_modules/pacote/lib/git.js`, `node_modules/pacote/lib/fetcher.js`, `node_modules/@npmcli/git/lib/which.js`, `workspaces/arborist/lib/arborist/build-ideal-tree.js`, `workspaces/arborist/lib/arborist/reify.js`, `lib/base-cmd.js`, and `docs/lib/content/using-npm/scripts.md` |
| S27 | [nodejs/node](https://github.com/nodejs/node) at tag `v25.0.0`, `doc/changelogs/CHANGELOG_V25.md`: "build: stop distributing Corepack" (#57617) and "build: remove corepack from release tarballs" (#59835) |
| S28 | [yarnpkg/berry](https://github.com/yarnpkg/berry) at tag `@yarnpkg/cli/4.18.1`, commit `75ebe06`: `packages/yarnpkg-cli/sources/lib.ts`, and under `packages/yarnpkg-core/sources/`, `Configuration.ts`, `Plugin.ts`, `Project.ts`, `scriptUtils.ts`, and `httpUtils.ts`. Also `packages/plugin-git/sources/` (`GitFetcher.ts`, `gitUtils.ts`, `index.ts`), `packages/plugin-github/sources/GithubFetcher.ts`, `packages/plugin-pnp/sources/jsInstallUtils.ts`, `packages/plugin-exec/sources/ExecFetcher.ts`, `packages/plugin-http/sources/TarballHttpFetcher.ts`, `packages/plugin-npm/sources/NpmHttpFetcher.ts`, `packages/plugin-constraints/sources/index.ts`, and `packages/plugin-essentials/sources/commands/install.ts` |
| S29 | [Yarn docs, Security](https://yarnpkg.com/features/security): "Yarn doesn't run postinstalls by default ever since 4.14" |
| S30 | [nodejs/corepack](https://github.com/nodejs/corepack) at tag `v0.36.0`, commit `7a4c30b`: `config.json`, `sources/corepackUtils.ts`, `sources/specUtils.ts`, and `CHANGELOG.md` |
| S31 | [oven-sh/bun](https://github.com/oven-sh/bun) at tag `bun-v1.4.3`, commit `c6da4a4`: `src/bunfig/bunfig.rs`, `src/install/PackageManager.rs`, `src/install/PackageManager/security_scanner.rs`, `src/install/lockfile.rs`, `src/install/lockfile/Package/Scripts.rs`, `src/install/lockfile/bun.lock.rs`, `src/install/default-trusted-dependencies.txt`, and `src/install/migration.rs` |
| S32 | Bun docs: [Security scanner API](https://bun.com/docs/pm/security-scanner-api), [Lifecycle scripts](https://bun.com/docs/pm/lifecycle), and [Bun v1.1.18](https://bun.com/blog/bun-v1.1.18) |
| S33 | [anthropics/claude-code#98938](https://github.com/anthropics/claude-code/issues/98938), "Sandbox: pnpm hangs forever when the project pins another pnpm version, and the write denial is never reported", open |
