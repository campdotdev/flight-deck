# Build drives a browser outside the sandbox, behind a dead proxy

When an acceptance criterion names the running app as its proof, and the app is a web app, a factory session has to load pages in a browser. On macOS, Chromium can't start from Claude Code's sandboxed Bash. The sandbox never grants the Mach port registration Chromium needs ([anthropics/claude-code#82660](https://github.com/anthropics/claude-code/issues/82660)), and the fix in `sandbox-runtime` (PR #598) hasn't merged. So Flight Deck ships one pinned browser MCP server, Playwright MCP, and the runner adds it to every session for a repo whose record has a web app. Build uses it for before-and-after screenshots, and check uses it to prove criteria itself.

MCP servers run outside the sandbox, so the sandbox's host list doesn't cover the browser. Playwright MCP's `--allowed-origins` misses redirects and service workers, and its README says the server "is **not** a security boundary". So the runner starts the browser with its proxy set to a dead proxy: a local port where nothing listens. Playwright sends loopback addresses through the proxy too, unless `--proxy-bypass` names a loopback host, so the runner passes `--proxy-bypass localhost,127.0.0.1`. The app on the session's localhost port then loads. Every other request goes to the dead proxy and fails at the network layer, including redirects and WebSockets. `--allowed-origins`, limited to the session's port, stays on as a second layer. The runner prototype tested both layers. `--allowed-origins` blocked a fetch, an image, and a navigation to other hosts. The dead proxy blocked a WebSocket and a redirect, which `--allowed-origins` let through.

## Considered options

- **No browser in v1.** The running app would prove only what sandboxed Bash can reach: CLIs, and HTTP APIs through `curl`. Web UI criteria would become "unproven", and PRs would carry no screenshots. The Shaders dry runs would prove almost nothing visual.
- **The repo's own Playwright, run outside the sandbox through `excludedCommands`.** The command would run with the maintainer's full access, and the repo's code would decide what it does. ADR 0007 rules that out.
- **Wait until the sandbox can start Chromium.** Flight Deck doesn't control when that ships.
- **Chrome DevTools MCP or agent-browser.** Each has a host allowlist that covers more than Playwright MCP's. Chrome DevTools MCP sends usage statistics by default. In agent-browser's MCP mode, each tool call carries its own domain list, and nobody has confirmed whether the model can widen it. The dead proxy works under all three, so the choice of server can change later.

## Consequences

- ADR 0003's platform list gains Node and Chrome for a repo with a web app. Flight Deck pins the Playwright MCP version, because `npx` fetches it outside the sandbox.
- The runner starts the server headless, with `--isolated`, `--block-service-workers`, and `--output-dir` in the session's outbox. The record's tool list for it never includes `browser_run_code_unsafe`, which runs arbitrary JavaScript in the server process, outside the sandbox.
- The sandbox sets `allowLocalBinding: true`, so the app can listen on the session's port.
- The server saves a screenshot with a relative filename in its workspace root, which is the worktree, where build could commit it. Flows name an absolute path in the outbox.
- Build attaches video, as `.webm`, only when a still image can't show the behavior. Video needs the server's `devtools` capability, and the tool list allows only its start and stop tools. The runner uploads media with `gh pr create --attach`, which needs `gh` 2.99.0 or later.
- A repo's own browser tests, such as end-to-end or visual tests, can't run inside a session. Setup's trial run sees them fail and marks them CI-only. A sub-issue of a spec gets no CI, so those tests first run on the spec PR.
- Check proves a running-app criterion against the app it starts on the session's port, never against the repo's preview deployment, such as a Vercel preview. The browser would need a hole in the dead proxy for the preview's host. Vercel puts previews behind a login by default, so the session would also need the host's bypass secret, and a read credential in a session could leave through any host on the record's list (ADR 0018). A sub-issue has no PR, so it has no preview to prove against. The preview is for the maintainer.
- When the sandbox can start Chromium, the browser can move inside it and take the sandbox's host list. The flows don't change.
