# Flight Deck installs from a script into versioned folders and updates only by hand

Flight Deck ships a runner that launchd keeps alive, so a Claude Code plugin can't install it on its own (ADR 0002). Instead, one command installs Flight Deck: `curl -fsSL https://github.com/campdotdev/flight-deck/releases/latest/download/install.sh | sh`. The script downloads one version's tarball from GitHub Releases, checks its SHA-256, and unpacks it into `~/.local/share/flight-deck/versions/<version>/`. The tarball holds everything that version runs: the runner, compiled from TypeScript with Bun into one binary, the menu bar app (ADR 0024), every flow and skill file, a pinned Playwright MCP with its dependencies, a pinned `sandbox-runtime` for refreshing dependency caches (ADR 0018), and a pinned Betterleaks binary. A `current` link names the version in use, and `~/.local/bin/flight-deck` links to its binary. Nothing updates on its own. A new version changes what every factory session does, so it reaches a Mac only when the maintainer runs `flight-deck update`, the same rule ADR 0014 sets for upstream skills.

## Considered options

- **A Homebrew tap.** Homebrew would handle the download, `PATH`, and uninstall. `brew upgrade` deletes the old version's files at once, while a running session may still read its flows from them, and it doesn't restart services. It would also make Homebrew a requirement.
- **An npm package.** Every Mac would need Node, which ADR 0003 requires only for repos with a web app.
- **Plugin first.** `claude plugin install` would come first, then a skill would copy the runner to a stable path. Every flow would exist twice, once in the plugin cache and once in the runner's copy, and the two could drift apart. The plugin cache path also changes on every update.
- **Automatic updates,** the way Claude Code updates itself. Fixes would arrive sooner, but a version nobody chose would change what every running factory does.

## Consequences

- v1 runs on Apple Silicon only. Bun's arm64 binary is ad-hoc signed and runs, but a cross-compiled Intel binary carries a broken signature. Files that `curl` downloads get no quarantine flag, so the binary needs no notarization. An ad-hoc signature gives each build a new identity, so a macOS privacy grant to the runner doesn't survive an update. ADR 0007 drops the setting that triggered one, and its watchdog catches a session that another prompt blocks.
- `flight-deck update [<version>]` switches `current`. The runner then drains: it starts no new session, lets running ones finish in their own version folder, and restarts on the new version. Naming an older version rolls back. The runner keeps the current version, the previous one, and any version a session still uses.
- Each outbox names the version that wrote it, and `flight-deck apply` refuses an outbox from another version.
- The hand-run skills are a user-scope plugin installed from a local-folder marketplace at `~/.local/share/flight-deck/current/plugin`. Claude Code follows the `current` link each time a session loads the plugin, so an update reaches the maintainer's own sessions without a plugin command. Factory sessions get `--plugin-dir` with the exact version folder instead.
- Install checks for Claude Code, git, and `gh`, and never installs them. Each Flight Deck version names the oldest Claude Code version it was tested on, and sets no maximum.
- `flight-deck update --from <folder>` installs a local build, for building Flight Deck itself and for dry runs.
