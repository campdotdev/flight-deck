# The factory acts under its own accounts

Unattended factory work never runs under the maintainer's accounts. In GitHub, the factory is a machine user: a second account the maintainer creates and invites to each repo with a factory, with the Write role and a classic token scoped to `repo`. In Linear, the factory is an app user: an OAuth app named Flight Deck that the maintainer creates in each workspace with `actor=app`, whose tokens the runner mints with the client-credentials grant. With its own accounts, the factory can't approve or merge its own PR once a ruleset requires one approval. Its PRs also show that an agent wrote them, without an attribution line. A flow the maintainer runs by hand acts as the maintainer, because the maintainer watched it.

## Considered options

- **The maintainer's accounts.** Setup would need no second account. A PR author can't approve their own PR, and the maintainer's account can bypass every ruleset, so nothing at GitHub would stop an unattended merge. Linear skips view-subscription notifications for a user's own actions, and every factory comment would read as the maintainer's. The factory would also hold the maintainer's admin rights on every repo they own.
- **A GitHub App.** It is the usual identity for automation, with short-lived tokens and a `name[bot]` author. `gh --attach` rejects App installation tokens, and the `gh` maintainers call that intended, so build couldn't upload screenshots to the PR. On private repos, CodeRabbit never seats an App on its own, and Copilot bills a bot's PR only to an organization on Copilot Business or Enterprise.
- **One shared Flight Deck app in Linear.** Every maintainer would authorize one app instead of creating their own. Other workspaces can install it only after Linear's integration directory lists it, and the directory says it generally doesn't accept apps built by hobbyists. If its owner removed it, every factory would lose its Linear identity at once.

## Consequences

- A private repo needs GitHub Pro or Team, because GitHub Free enforces rulesets on public repos only. Setup adds a factory only where a ruleset can require one approval. The maintainer stays on the bypass list.
- On a private repo, the machine user may need its own review-bot seats. Copilot's automatic review bills the PR author, and CodeRabbit reviews only authors with a seat.
- The machine user's token is a classic one, because a fine-grained token can't reach a repo where its owner is only a collaborator. The `repo` scope reaches only the repos the machine user is invited to.
- An `actor=app` app can't hold the admin scope. Setup creates statuses and changes team settings under the maintainer's own Linear login.
- An extra MCP server, such as Figma's, may use the maintainer's own sign-in. Factory accounts are required only where the factory writes under its own name, in Linear and GitHub.
- Flight Deck never reads, stores, or passes on the maintainer's Claude login. Anthropic's terms bar third-party developers from collecting, storing, or intermediating Claude.ai credentials, so each session's `claude` binary reads the login itself. Every other tool keeps its own sign-in where it can, and the rest goes in `~/.config/flight-deck/credentials.env` with mode `0600`.
