# What a factory branch can reach on CI, and what stops it

Research note for [FLD-52](https://linear.app/campdotdev/issue/FLD-52/what-can-a-factory-branch-reach-on-ci-and-what-stops-it). It builds on [What can stop an unattended session from merging, pushing, or reading secrets](unattended-session-guardrails.md), whose section 9 covers rulesets, and doesn't repeat that note. Sources were read on 2026-10-27 and are listed under [Sources](#sources), such as [S1]. Where GitHub's docs are silent, the note cites GitHub Community discussions and one third-party pull request, marked non-primary, such as [N1]. Four local tests ran on 2026-10-27 and 2026-10-28 and are listed under [How the local tests ran](#how-the-local-tests-ran), such as [T1].

Each claim carries one of three tags, or a citation that implies it:

- **Confirmed by local test** means a test in this note produced the result.
- **Documented** means a primary source says it.
- **Unconfirmed** means neither a test nor a primary source settles it.

The setting is the one ADR 0005 and ADR 0007 describe. The machine user `flightdeckbot` has the Write role and a classic token with only `repo` and `read:org`. The runner pushes each factory branch to the repo itself over HTTPS with that token and opens the PR as a draft. A ruleset on the default branch requires one approval. The repo's CI then runs the branch's code before anyone reviews it. In this note, a PR job is a job that a `pull_request` event on the factory PR starts.

## Answer

1. **Pushes the `workflow` scope stops.** The scope "Grants the ability to add and update GitHub Actions workflow files", and a workflow file "can be committed without this scope if the same file (with both the same path and contents) exists on another branch in the same repository". So a push that adds or edits a file under `.github/workflows/` fails unless another branch holds the identical file. No GitHub page covers deletions, merge commits, or a new branch at an existing commit, and none quotes the error. A push test as the machine user on a scratch repo settled them. A merge of the default branch that brought in its change to a workflow file pushed. So did a commit that deleted a workflow file, a commit that touched no workflow on a branch whose copy matched no other branch, and a new branch at an existing branch's tip. An edit to the workflow on the branch failed with "refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope", and so did a new branch at an older commit whose copy matched no branch. **Documented** [S1] for adds and edits, and **Confirmed by local test** [T4] for every case above.
2. **Which workflow definition runs.** A run uses the workflow file "present in the associated commit SHA or Git ref of the event". For `pull_request`, that is the merge commit on `refs/pull/<number>/merge`. For `push`, it is the pushed tip. `pull_request_target` and `workflow_run` use the default branch's copy. So the repo's existing workflows run a factory branch's tests, package scripts, and local actions without any workflow edit. A `push` run on a branch cut before the default branch changed a workflow still runs the old copy. No page says whether drafts start `pull_request` runs. The default activity types are `opened`, `synchronize`, and `reopened`, and ADR 0022's Shaders dry run saw CI run on a draft. **Documented** [S2][S3], with drafts **Unconfirmed** in the docs.
3. **Secrets.** Only runs from forks and Dependabot lose secrets, so PR jobs on a factory branch and `push` runs on any branch get every repository and organization secret their workflow names. "Any user with write access to your repository has read access to all secrets configured in your repository." Environment secrets reach only jobs that reference the environment, and only after a required reviewer approves. A deployment branch rule matches `GITHUB_REF`, which is `refs/pull/<number>/merge` for a PR job. Write can't configure an environment, can approve a deployment only when named as a required reviewer, and can't bypass protection rules. Write can create, update, and delete repository secrets, though no endpoint returns a value. On GitHub Free, Pro, and Team, required reviewers work only in public repos. **Documented** [S4][S5][S7][S8][S9][S11][S13], with a contradiction on who may set environment secrets.
4. **`GITHUB_TOKEN`.** The repo's default sets the token's starting permissions, and the workflow's `permissions` block then changes them in either direction. Only fork PRs and Dependabot runs get write turned into read. `actions/checkout` defaults to `persist-credentials: true`, and since v6 it writes the token into a file under `$RUNNER_TEMP` that `.git/config` includes, so any later step's code can read it. Events the token causes start no workflow runs, except `workflow_dispatch`, `repository_dispatch`, and, since 2026-06-11, `pull_request` runs that wait for a Write user's approval. **Documented** [S15][S17][S19][S26][S43].
5. **"Allow GitHub Actions to create and approve pull requests".** With it on, `GITHUB_TOKEN` can create and approve pull requests. One checkbox and one REST boolean, `can_approve_pull_request_reviews`, cover both, so creating can't be allowed without approving. GitHub's 2022 changelog says the setting exists to stop Actions from satisfying "Required approvals" in branch protection, so an Actions approval counts there. No page says whether it counts toward a ruleset's `required_approving_review_count`. **Documented** [S19][S22][S24][S25] for branch protection and the single setting. Rulesets are **Unconfirmed**.
6. **`require_extra_approval_for_unattributed_changes`.** "When Copilot opens a pull request without a human collaborator, require one more approving review if a non-zero approval count is required." It is in public preview and on by default for new and existing rulesets. It names only Copilot, so it adds no approval to the machine user's PRs. **Documented** [S28][S29].
7. **Approval for a collaborator's same-repo branch.** GitHub has no such setting. Every approval setting sits under fork pull request workflows. Public repos pick a contributor class, and private repos can require approval for "collaborators without write permission". Runs on a same-repo branch start at once. The only per-job gate is an environment with required reviewers. The repo and enterprise pages describe "external contributors" and "outside collaborators" differently. **Documented** [S8][S19][S20][S21][S23], with that wording contradiction.
8. **Fork PRs.** A fork PR's runs get no secret except a read-only `GITHUB_TOKEN`, and the approval settings in item 7 apply to them. No page says whether `id-token: write` survives for a fork PR. A Write collaborator's fork PR can still have reviewers requested by its author. The machine user can still mark it ready, and `gh pr create --attach` uploads against the base repo with Write. Statuses need push access to the base repo, and no page says whether a fork's head SHA is accepted. Copilot code review's docs don't mention forks. CodeRabbit reviews a fork PR with the target branch's configuration and turns off two features for it. The machine user keeps Write on the base repo, so a fork changes what CI holds, not what the runner's token can do. **Documented** [S3][S13][S17][S35][S40][S44][S47], with OIDC, fork-head statuses, and `--attach` on a fork PR **Unconfirmed**.
9. **OIDC.** A same-repo PR job can mint an OIDC token when its workflow grants `id-token: write`. Unless the job names an environment, the token's `sub` is `repo:OWNER/REPO:pull_request`. Its `ref` claim is the PR's merge ref, `refs/pull/<number>/merge`, so a trust policy on `ref:refs/heads/main` or on an environment refuses it. npm trusted publishing checks the owner, the repo, the workflow filename, and an optional environment, and it never checks the branch. So npm refuses a non-default branch only through an environment the branch can't enter. **Documented** [S36][S48].
10. **Who a `GITHUB_TOKEN` status comes from.** `GITHUB_TOKEN` is an installation token of the GitHub Actions app, whose id is 15368. A required status check can be pinned only to a GitHub App, or left at any source. The machine user isn't an app, so no setting keeps a `GITHUB_TOKEN` status from satisfying `flight-deck/check`, and pinning that check to an app would reject the machine user's own status. **Documented** [S15][S28][S29][S34], with the app id **Confirmed by local test** [T1]. Whether GitHub records app 15368 as the source of a `GITHUB_TOKEN` status is **Unconfirmed**.
11. **Rulesets on GitHub Free.** Branch rulesets work in public repos for personal accounts and for organizations on GitHub Free. Restrict creations and Restrict updates on `flight-deck/*` let only bypass actors create or push matching branches. Since 2026-05-07, a repository ruleset accepts an individual user as a bypass actor, though the docs page's list still omits users. A `GITHUB_TOKEN` push to the pattern should then fail, because the GitHub Actions app isn't on the list, but no page names `GITHUB_TOKEN` in a ruleset's terms. Push rulesets, which could restrict `.github/workflows/**`, exist only for private and internal repos on GitHub Team. **Documented** [S28][S30][S31][S32], with user bypass on a personal-account repo and the `GITHUB_TOKEN` push **Unconfirmed**.
12. **What the machine user can read, and what Shaders holds.** The machine user's token reads a repo's workflow files, environments, and rulesets, and gets a 403 on its Actions permissions, its default workflow permissions, and its self-hosted runners. So only an admin's login reads the create-and-approve setting. On Shaders, no job a factory branch starts names a secret, but React Doctor's job holds `pull-requests: write` while create-and-approve is on. **Confirmed by local test** [T2][T3].

## Where the docs disagree

- **Who sets environment secrets.** The Actions guide says "To create secrets or variables for an environment in a personal account repository, you must be the repository owner", and admin access in an organization [S4]. The REST page's environment-secret endpoints say "Authenticated users must have collaborator access to a repository to create, update, or read secrets" [S11]. Which one GitHub enforces for a Write collaborator is **Unconfirmed**.
- **Who counts as an external contributor.** The repo and org pages define "Require approval for all external contributors" as "All users that are not a member or owner of this repository and not a member of the organization" [S19][S20]. The enterprise page calls it "Require approval for all outside collaborators" and defines it as "all users who are not organization members" [S21]. A collaborator on the repo who isn't an org member falls outside the first wording and inside the second.
- **Who can request a review.** The review pages say "To request a review, you need write access to the repository" [S40][S41]. The organization roles table gives the Triage role "Request pull request reviews" [S13]. The machine user has Write, so the factory meets both.
- **Who can be a ruleset bypass actor.** The ruleset guide lists roles, teams, GitHub Apps, and Dependabot [S31]. The 2026-05-07 changelog says individual users can be added "through the UI, REST API, and GraphQL" on repository-level rulesets [S32], and the REST API's `actor_type` accepts `User` [S29].
- **What the approve setting is called.** The UI and guides say "create and approve pull requests" [S19]. The REST field is `can_approve_pull_request_reviews`, described only as "Whether GitHub Actions can approve pull requests" [S22]. The 2022 changelog says the one setting covers both [S25].

## 1. Pushes the `workflow` scope stops

### The documented rule

The scope table says the `workflow` scope "Grants the ability to add and update GitHub Actions workflow files. Workflow files can be committed without this scope if the same file (with both the same path and contents) exists on another branch in the same repository" [S1]. That is the whole rule in GitHub's docs. No page lists the push cases, defines "exists on another branch", or quotes the rejection.

| Push with `repo` and no `workflow` | What the rule implies | Tag |
| :- | :- | :- |
| A commit adds or edits a file under `.github/workflows/` with content no branch holds | Refused | **Documented** [S1], **Confirmed by local test** [T4] |
| A commit adds or edits a workflow file to content that sits at the same path on another branch | Allowed | **Documented** [S1] |
| A commit deletes a workflow file | Docs silent. The test's deletion pushed | **Confirmed by local test** [T4] |
| A merge of the default branch into a branch that never touched workflow files, after the default branch changed one | Allowed, because the merged file equals the default branch's copy. The test's merge pushed | **Confirmed by local test** [T4] |
| The same merge pushed after the default branch changed that file again | Refused, if "exists on another branch" means a branch's current tip | **Unconfirmed** |
| A commit that touches no workflow file, on a branch whose workflow copy no other branch holds | Docs silent. The test's commit pushed | **Confirmed by local test** [T4] |
| A new branch at the tip of an existing branch | Allowed, because every workflow file matches that branch. The test's new branch pushed | **Confirmed by local test** [T4] |
| A new branch or tag at an older commit whose workflow file no longer matches any branch tip | Refused in community reports. The test's new branch was refused | **Confirmed by local test** [T4] for a branch [N2][N3] |

### What a push test showed

On 2026-10-28, the maintainer made `hunterbecton/fd-scratch`, a public repo with one workflow file, `.github/workflows/ci.yml`, and invited the machine user with Write. The machine user cloned it over HTTPS with only its own token, with scopes `repo` and `read:org`, and pushed under that token. GitHub's activity log credits each push to `flightdeckbot` and each push to `main` to the maintainer [T4]. In order:

| Step | Who | What was pushed | Result |
| :- | :- | :- | :- |
| 1 | Machine user | New branch `factory-test` with a README change | Pushed |
| 2 | Maintainer | `main` changes `ci.yml` | Pushed |
| 3 | Machine user | A merge of `main` into `factory-test`, which brings in the changed `ci.yml` | Pushed |
| 4 | Machine user | A commit that edits `ci.yml` on `factory-test` | Refused: "refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope" |
| 5 | Machine user | A commit that deletes `ci.yml` on `factory-test` | Pushed |
| 6 | Maintainer | `main` changes `ci.yml` a second time | Pushed |
| 7 | Machine user | A new branch at step 1's commit, whose `ci.yml` matched no branch by then | Refused, with the same message |
| 8 | Machine user | A merge of `main` that restores `main`'s `ci.yml` to `factory-test` | Pushed |
| 9 | Maintainer | `main` changes `ci.yml` a third time | Pushed |
| 10 | Machine user | A README commit on `factory-test`, whose `ci.yml` now matched no other branch | Pushed |
| 11 | Machine user | A new branch at `factory-test`'s tip | Pushed |

Two more pushes by the machine user, made while `factory-test` had no `ci.yml`, went through and are left out, because they test nothing about the rule.

So GitHub tests the workflow files that a push adds or changes against the files on other branches. It doesn't test files a push leaves alone, and it doesn't stop a deletion. A new branch counts as adding every file it holds.

### What the community reports show

These sources are non-primary. They report what users saw, not what GitHub documents.

- The rejection text depends on the credential. For a classic token over HTTPS: `` ! [remote rejected] ok -> ok (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/checks.yaml` without `workflow` scope) `` [N1]. For an OAuth app token: "refusing to allow an OAuth App to create or update workflow '.github/workflows/ci.yml' without workflow scope" [N4]. For a GitHub App token, including `GITHUB_TOKEN`: "refusing to allow a GitHub App to create or update workflow `.github/workflows/deploy-to-production.yml` without `workflows` permission" [N3]. In 2020 the same case read "refusing to allow a bot to create or update workflow" [N2].
- A ref that points at an older commit can fail even though the push changes no file. A tag pushed with `GITHUB_TOKEN` at an older commit failed, while deleting tags worked [N2]. A job that moved a release branch onto a 4-hour-old commit on `main` failed whenever `main` had since changed the workflow file, and worked again after someone pushed the newer file to that branch by hand [N3]. Both used App tokens, not a classic token. They fit a reading where "exists on another branch" means a branch's tip, not its history.
- No GitHub Community discussion found covers a `git push` of a merge that brings the default branch into a feature branch. The closest cases are API merges. Merging a pull request that changes a workflow file from GitHub's mobile app failed with the OAuth app message [N4]. The update-branch endpoint failed for a fork pull request that changed a workflow file, for an app that held the Workflows write permission [N5].
- A third-party pull request compared 38 merges of workflow-touching pull requests made without the scope. The one refusal came when the pull request and `main` had both changed the same workflow file since the branch point, so the merge would have produced a file nobody had pushed. Every merge whose workflow files matched the head's went through [N6]. That fits the documented rule. The same pull request reports that its pushes over SSH carried workflow changes without the scope [N6].

### What the scope doesn't cover

- `GITHUB_TOKEN` can't edit workflow files either. The `permissions` key has no workflows permission [S17], and the GitHub Actions app's own permission list has no `workflows` entry [T1].
- The scope's wording covers workflow files only. A local action such as `.github/actions/<name>/action.yml`, a `package.json` script, or a test config isn't a workflow file. Whether GitHub's check reaches local actions is **Unconfirmed**. A workflow resolves a `$/` action at the running commit and a `./` action from the checked-out workspace [S17], so a branch's edit to a local action runs in that branch's jobs.
- Scopes belong to tokens. The docs don't say what an SSH push by the machine user gets. The only report says SSH pushes carried workflow changes [N6]. **Unconfirmed.**

## 2. Which workflow definition runs

"Each workflow run will use the version of the workflow that is present in the associated commit SHA or Git ref of the event" [S2]. The events reference gives that commit for each event [S3]:

| Event | `GITHUB_SHA` | Copy of the workflow that runs | Runs branch code? |
| :- | :- | :- | :- |
| `pull_request` | "Last merge commit on the `GITHUB_REF` branch", with `GITHUB_REF` set to `refs/pull/<number>/merge` | The merge commit's. For a branch that never touched the file, the base branch's current copy | Yes. "Your CI tests run against the merged result" |
| `push` | "Tip commit pushed to the ref" | The pushed commit's. "This includes workflows that are not merged into the default branch" | Yes |
| `pull_request_target` | "Last commit on default branch" | The default branch's | Only if a step checks out the head |
| `workflow_run` | "Last commit on default branch" | The default branch's. It "will only trigger a workflow run if the workflow file exists on the default branch" | Only if a step checks out the head or uses its artifacts |
| `workflow_dispatch` | "Last commit on the `GITHUB_REF` branch or tag" | The dispatched ref's | Yes, when dispatched against the factory branch |

So existing workflows run a factory branch's code without any edit to them. Four details matter here:

- A `push` run uses the branch's own copy, which can be older than the default branch's. If the default branch tightened a workflow after the factory branch was cut, `push` runs on the branch still use the old copy. `pull_request` runs use the merge commit, so they get the new copy [S2][S3].
- `pull_request` runs don't start while the pull request has a merge conflict. `pull_request_target` runs do [S3].
- `actions/checkout` v7 refuses to fetch fork pull request code in `pull_request_target` and `workflow_run` workflows, and the backport reached every supported major version except v1 on 2026-07-20. "Same-repository pull requests aren't affected" [S27][S43]. A `pull_request_target` workflow that checks out the head therefore runs a factory branch's code with the default branch's secrets and a write token [S17].
- Once a workflow has run, "you can dispatch it against any branch or tag via the GitHub API or GitHub CLI" [S3]. Running a workflow by hand needs write access [S37]. A dispatch made with `GITHUB_TOKEN` starts a run [S15], and the dispatch endpoint needs the Actions write permission for an app [S38].

### Draft pull requests

No page says whether `pull_request` runs start on a draft. By default a workflow runs on the `opened`, `synchronize`, and `reopened` activity types [S3]. The webhook defines `opened` as "A pull request was created" [S51]. The draft docs say drafts can't be merged and don't request code owners, and they say nothing about CI [S42]. ADR 0022 records a Shaders draft PR whose CI ran and failed in one shard. **Unconfirmed** in the docs.

## 3. Secrets

### Repository and organization secrets

The docs name two cases that lose secrets: "With the exception of `GITHUB_TOKEN`, secrets are not passed to the runner when a workflow is triggered from a forked repository", and "Secrets are not available to workflows triggered by Dependabot events" [S4]. No page names a same-repo `pull_request` or a `push` as a case that loses them. The security guide states the consequence: "Any user with write access to your repository has read access to all secrets configured in your repository" [S7].

A job gets only the secrets its workflow names. "To make a secret available to an action, you must set the secret as an input or environment variable in your workflow file" [S5]. Secrets don't pass to reusable workflows unless the caller passes them [S4]. Composite actions can't read the `secrets` context, but they can read `github.token` [S18]. Organization and repository secrets are read when the run is queued [S6].

So a factory branch's PR job holds exactly the secrets its existing workflow passes in, and code in any step of that job can read them. Setup can find them by listing the `secrets.` references, including `secrets: inherit`, in the jobs that `pull_request` and `push` events start.

### Environment secrets and protection rules

- "Secrets stored in an environment are only available to workflow jobs that reference the environment. If the environment requires approval, a job cannot access environment secrets until one of the required reviewers approves it" [S8]. Environment secrets are read when the job starts [S6].
- Required reviewers: up to six users or teams, any one of whom approves. An option stops the person who started the run from approving it [S8]. On GitHub Free, Pro, and Team, required reviewers and wait timers work only in public repos [S8].
- Deployment branches and tags: "The deployment branch or tag rule is matched against the `GITHUB_REF` of the workflow run". A pattern such as `releases/*` admits only matching refs. "Adding another branch rule for `refs/pull/*/merge` would also allow workflows triggered by `pull_request` events to deploy to the environment" [S8]. So an environment limited to `main` refuses a PR job and a `push` run on a factory branch.
- "Protected branches only" admits branches with branch protection rules, and "If no branch protection rules are defined for any branch in the repository, then all branches can deploy" [S8]. No page says whether a ruleset counts as a branch protection rule here. A repo protected only by rulesets may let every branch deploy under that option. **Unconfirmed.**
- "By default, administrators can bypass the protection rules and force deployments". An environment can turn that off [S8]. Bypass works only on a pending job [S10].
- A workflow that names a missing environment creates it with no protection rules or secrets. "Anyone that can edit workflows in the repository can create environments via a workflow file, but only repository admins can configure the environment" [S9].

### What the Write role can do

| Action | Write role | Source |
| :- | :- | :- |
| Configure an environment, its reviewers, or its branch rules | No. Owner of a personal repo, admin of an org repo | [S9] |
| Approve a waiting deployment | Only when named as a required reviewer. The REST endpoint takes "Required reviewers with read access to the repository contents and deployments" | [S8][S12] |
| Bypass an environment's protection rules | No. Administrators only | [S8][S10] |
| Create, update, or delete repository secrets | Yes. "To create secrets or variables on GitHub for an organization repository, you must have `write` access. For a personal account repository, you must be a repository collaborator" | [S4][S11][S13] |
| Read a secret's value through the API | No. "Get a repository secret" returns it "without revealing its encrypted value" | [S11] |
| Read a secret's value through a workflow | Yes, for any secret a workflow passes into a job it runs | [S7] |
| Create or update environment secrets | The docs contradict each other. See [Where the docs disagree](#where-the-docs-disagree) | [S4][S11] |

## 4. `GITHUB_TOKEN`

### What the `permissions` block gets

"The permissions for the `GITHUB_TOKEN` are initially set to the default setting for the enterprise, organization, or repository... The permissions are then adjusted based on any configuration within the workflow file, first at the workflow level and then at the job level. Finally, if the workflow was triggered by a pull request event other than `pull_request_target` from a forked repository, and the **Send write tokens to workflows from pull requests** setting is not selected, the permissions are adjusted to change any write permissions to read only" [S17].

- "Anyone with write access to a repository can modify the permissions granted to the `GITHUB_TOKEN`, adding or removing access as required, by editing the `permissions` key in the workflow file" [S19]. So a same-repo PR job gets what its workflow's `permissions` block asks for, whatever the repo default. The factory branch can't edit that block, as section 1 shows.
- Without a block, the default applies. A new personal-account repo starts with read access to `contents` and `packages` only [S19]. An organization or enterprise created on or after 2023-02-02 defaults to read-only, and one created earlier defaults to read and write [S21].
- Naming any permission sets the rest to `none` [S17].
- "Send write tokens to workflows from pull requests" exists only for private repos [S19].
- A `pull_request_target` run gets "read/write repository permission, even when it is triggered from a public fork" [S17].
- The token lives until the job ends, up to 6 hours on GitHub-hosted runners [S15]. A copy that leaves the runner works until then.

### Where a job's code finds the token

- `actions/checkout`'s `persist-credentials` input defaults to `true`, described as "Whether to configure the token or SSH key with the local git config" [S43].
- Since v6, "`persist-credentials` now stores credentials in a separate file under `$RUNNER_TEMP` instead of directly in `.git/config`" [S43]. The source writes `http.https://github.com/.extraheader` with `AUTHORIZATION: basic` and the base64 of `x-access-token:<token>` into that file, and adds an `includeIf.gitdir:<path>.path` entry to the repo's git config that points at it. The token stays until post-job cleanup [S43]. Any later step runs as the same user, so its code can read the file or ask git for the header. That last step follows from the source and wasn't tested here.
- "An action can access the `GITHUB_TOKEN` through the `github.token` context even if the workflow does not explicitly pass the `GITHUB_TOKEN` to the action" [S16]. A local composite action the branch edits gets it this way [S18].
- With `persist-credentials: false`, the docs name no other place a `run` step finds the token unless the workflow passes it in.

### What the token's events start

"When you use the repository's `GITHUB_TOKEN` to perform tasks, events triggered by the `GITHUB_TOKEN` will not create a new workflow run", with these exceptions [S15]:

- "`workflow_dispatch` and `repository_dispatch` events always create workflow runs."
- When a workflow creates or updates a pull request with the token, the `opened`, `synchronize`, and `reopened` events create runs "in an **approval-required** state", which a user with write access starts. GitHub announced this on 2026-06-11 [S15][S26].

So a push or a tag push made with `GITHUB_TOKEN` starts no `push` run. The example in the docs is a workflow that "pushes code using the repository's `GITHUB_TOKEN`" with no new run following [S15].

## 5. "Allow GitHub Actions to create and approve pull requests"

- The setting configures "whether `GITHUB_TOKEN` can create and approve pull requests". It is off by default in a new personal-account repo and a new organization. An org repo inherits the org's value [S19][S20]. The enterprise policy says "If you enable this setting, `GITHUB_TOKEN` can create and approve pull requests" [S21].
- The REST API sets it with `can_approve_pull_request_reviews`: "Whether GitHub Actions can approve pull requests. Enabling this can be a security risk" [S22].
- In January 2022, GitHub added the approve control because it "protects against a user using Actions to satisfy the 'Required approvals' branch protection requirement and merging a change that was not reviewed by another user". It shipped as "Allow GitHub Actions reviews to count towards required approval", on by default [S24]. In May 2022, the same setting "has been extended to also limit Actions from creating pull requests" [S25]. So an Actions approval counts toward branch protection's required approvals, and no page offers creating without approving. **Documented.**
- For rulesets, the pull-request rule says "You can require approving reviews from people with write permissions in the repository or from a designated code owner" [S28]. No page says whether an approval from `github-actions[bot]` counts toward `required_approving_review_count`, or whether it satisfies "the most recent reviewable push must be approved by someone other than the person who pushed it" [S29]. **Unconfirmed.**
- The changesets action asks for `contents: write`, `pull-requests: write`, and this setting to open its Version Packages pull request [S50]. A repo that uses it with `GITHUB_TOKEN` has the setting on for every workflow, not only the release workflow.

Put together, if the setting is on and a PR job's token holds `pull-requests: write`, the factory branch's code can approve its own pull request as `github-actions[bot]`. If the token also holds `contents: write`, the same code could merge it once the approval counts. Each piece is documented, and the chain against a ruleset is **Unconfirmed**. With the restricted default, a PR job holds neither permission unless its workflow asks for it.

## 6. `require_extra_approval_for_unattributed_changes`

The REST parameter on the `pull_request` rule reads "When Copilot opens a pull request without a human collaborator, require one more approving review if a non-zero approval count is required" [S29]. The rulesets page adds [S28]:

- It is in public preview and "enabled by default, for both new and existing rulesets".
- "When Copilot opens a pull request that isn't attributed to a person, the ruleset requires one more approval than the number you configured." A ruleset that requires one approval then requires two "from people with write access".
- It covers Copilot opening a pull request under its own app identity, "for example when you prompt it from a shared context such as a group thread or channel".
- It has no effect when the ruleset requires zero approvals.
- With the setting off and "require an approval from someone other than the last person to push" on, "at least one approval must cover the last push and come from someone other than Copilot".

Neither page applies it to pull requests from other apps or machine users.

## 7. Approval before a collaborator's runs

No setting requires approval before runs on a same-repo branch. **Documented** by what the settings cover:

- Public repos: "Approval for running fork pull request workflows from contributors" sits under "Controlling changes from forks to workflows in public repositories". It checks "Both the pull request author and the actor of the pull request event". Its options are first-time contributors who are new to GitHub, first-time contributors, and all external contributors. The default requires approval for all first-time contributors [S19][S20].
- Private repos: "Require approval for fork pull request workflows" covers "Workflow runs on pull requests from collaborators without write permission" [S19][S20][S21].
- `pull_request_target` runs "will always run, regardless of approval settings" [S19][S21].
- The approval guide covers "Workflow runs triggered by a contributor's pull request from a fork" [S23].

On "outside collaborator": the enterprise heading is "Fork pull request workflows from outside collaborators" and its option covers "all users who are not organization members" [S21]. The setting is still about fork pull requests, so a same-repo branch that an outside collaborator pushes gets no approval step. Whether the repo-level option counts that collaborator as an external contributor is the contradiction listed above.

Two documented approval steps do exist, and neither covers the machine user. Pull requests created or updated with `GITHUB_TOKEN` wait for approval [S15][S26], and so do Copilot's [S26]. The one per-job gate is an environment with required reviewers, which section 3 covers. A private repo on GitHub Free, Pro, or Team can't have required reviewers [S8].

## 8. Pull requests from the machine user's fork

### What the runs get

| | Same-repo branch | Machine user's fork |
| :- | :- | :- |
| Repository and organization secrets | Those the workflow names [S4][S5] | None. "With the exception of `GITHUB_TOKEN`, secrets are not passed" [S3][S4] |
| `GITHUB_TOKEN` | What the `permissions` block asks for [S17] | Read-only, unless a private repo's admin sends write tokens [S3][S17][S19] |
| OIDC token | Available with `id-token: write` [S36] | Docs silent. Write permissions become read, and `id-token` has only `write` and `none` [S17]. **Unconfirmed** |
| Approval before runs | None [S19] | Public repo: the contributor setting applies, so by default the machine user waits until one of its commits or pull requests has merged into the repo. Private repo: workflows run only when enabled, and the approval option skips collaborators with write [S3][S19] |
| Cache writes | Scoped to the merge ref [S39] | The same [S39] |
| `pull_request_target` checkout of the head | Allowed [S27] | Refused by `actions/checkout` v7 unless `allow-unsafe-pr-checkout: true` [S27][S43] |

### What the runner can still do on a fork PR

- **Set `flight-deck/check`.** "Users with push access in a repository can create commit statuses for a given SHA" [S35]. The machine user has push access to the base repo. No page says whether the base repo accepts a status on a SHA that only a fork's branch holds. **Unconfirmed.**
- **Mark the PR ready.** The org roles table gives Write "Mark a draft pull request as ready for review" [S13].
- **Request reviewers.** "Pull request authors can request reviews only if they are repository owners or collaborators with write access" [S40]. The machine user is both author and Write collaborator.
- **Attach media.** `gh` builds its uploader against the base repo's database id and refuses unless the viewer's permission there is `ADMIN`, `MAINTAIN`, or `WRITE`. Its comment says READ and TRIAGE "get a 404" [S44]. A fork's author with Write on the base repo passes. That this covers fork pull requests follows from the source and wasn't tested. **Unconfirmed.**

### What breaks or changes

- CI jobs that need a secret fail or skip, and jobs that write with `GITHUB_TOKEN`, such as posting a comment or a label, fail [S3][S17].
- A private repo needs "Run workflows from fork pull requests" turned on [S3][S19]. Removing a collaborator deletes their fork of a private repo [S14].
- The base repo's rulesets don't cover branches in the fork. In its own fork, the machine user is the owner. Push rulesets do cover a fork network, but only for private and internal repos on GitHub Team [S30].
- The machine user keeps Write on the base repo, so its token can still push branches there. A fork narrows what CI holds, not the runner's token.
- Copilot code review: the concept page doesn't mention forks [S45]. Asking `@copilot` to change a pull request doesn't support forks: "Pull requests from forks are not currently supported" [S46]. That feature isn't review.
- CodeRabbit reviews fork pull requests: "Pull requests from forks use the target branch's configuration". It rejects guideline entries in a fork's description, and its Simplify option to commit to the branch is "Not available for fork PRs" [S47].

## 9. OIDC

- "The job or workflow must grant the `id-token: write` permission" to request a token [S36]. No page adds a limit for a same-repo `pull_request` run. Steps request the token through `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, and a custom audience is allowed [S36]. So code in any step of such a job can mint tokens for any audience.
- Claims that separate a PR job from a default-branch run [S36]:
	- `sub` is `repo:OWNER/REPO:pull_request` for a pull request event, "but only if the job doesn't reference an environment". It is `repo:OWNER/REPO:environment:NAME` when the job references one. A branch subject such as `repo:OWNER/REPO:ref:refs/heads/main` appears only "if the job doesn't reference an environment, and if the workflow is not triggered by a pull request event". Repos created after 2026-07-15 put owner and repo ids in `sub`.
	- `ref` is "The git ref that triggered the workflow run", which is `refs/pull/<number>/merge` for `pull_request` [S3].
	- `workflow_ref` is "The ref path to the workflow", such as `octocat/hello-world/.github/workflows/my-workflow.yml@refs/heads/my_branch`. The page shows no example for a pull request run.
	- `environment`, `event_name`, `head_ref`, `base_ref`, and `job_workflow_ref` are also present.
- npm trusted publishing for GitHub Actions takes the owner, the repository, the workflow filename, an optional environment name, and the allowed actions [S48]. It has no branch or ref field. Troubleshooting says "validation checks the calling workflow's name" for `workflow_call` and `workflow_dispatch` [S48]. So npm accepts a publish from any ref that runs the named workflow file, unless the configuration names an environment whose branch rule the ref can't meet [S8].
- A configuration created after 2026-09-03 allows `npm stage publish` by default, and direct `npm publish` only when chosen [S48]. A staged package goes live only after a maintainer approves it with 2FA [S49].

These pieces combine into one path that no page describes as a whole. A release workflow with a `workflow_dispatch` trigger can be dispatched against a factory branch by a PR job whose token has `actions: write`, as section 2 shows. The run then executes the branch's code under the named workflow file, and npm would accept its OIDC token unless an environment or staged publishing stands in the way. **Unconfirmed** as a chain.

## 10. Commit statuses from `GITHUB_TOKEN`

- "The `GITHUB_TOKEN` secret is a GitHub App installation access token", used "on behalf of the GitHub App installed on your repository" [S15]. The public API returns that app as `github-actions`, named GitHub Actions, id 15368, owned by `github`. Its bot user is `github-actions[bot]`, id 41898282 [T1].
- The token sets statuses only with `statuses: write` [S17].
- "Any person or integration with write permissions to a repository can set the state of any status check in the repository" [S33].
- A ruleset's required status check takes an optional `integration_id`, "The optional integration ID that this status check must originate from" [S29]. In the UI, "you can select an app as the expected source", and that app "must be installed in the repository with the `statuses:write` permission, must have recently submitted a check run". "If the status is set by any other person or integration, merging won't be allowed" [S28]. Branch protection's `app_id` takes an app id, or `-1` for any app [S34].

The source can be a GitHub App or any source, nothing else. The machine user's classic token isn't an app, so a check its token sets can only be required from any source. A `GITHUB_TOKEN` status with the same context then satisfies it. Pinning `flight-deck/check` to an app rejects the machine user's own status. **Documented** by what the fields accept. The docs don't say a `GITHUB_TOKEN` status is recorded as coming from app 15368, though branch protection's "automatically select the GitHub App that has recently provided this check" implies GitHub records an app for statuses [S34]. **Unconfirmed.**

## 11. Rulesets on a branch pattern

- "Rulesets are available in public repositories with GitHub Free and GitHub Free for organizations, and in public and private repositories with GitHub Pro, GitHub Team, and GitHub Enterprise Cloud" [S30].
- Restrict creations: "only users with bypass permissions can create branches or tags whose name matches the pattern". Restrict updates: "only users with bypass permissions can push to branches or tags whose name matches the pattern". Restrict deletions is selected by default [S28]. The REST `update` rule takes `update_allows_fetch_and_merge`, "Branch can pull changes from its upstream repository" [S29]. Ref conditions accept `~ALL` and `~DEFAULT_BRANCH` [S29].
- Bypass actors, per the guide: repository admins, organization owners, enterprise owners, the maintain or write role, teams, GitHub Apps, and Dependabot [S31]. The REST API also takes `User` and `DeployKey`, and "OrganizationAdmin is not applicable for personal repositories" [S29]. The 2026-05-07 changelog adds individual users on repository-level rulesets in the UI, REST, and GraphQL [S32]. Neither page mentions personal-account repos for user bypass. **Unconfirmed** there.
- A `GITHUB_TOKEN` push is a push by the GitHub Actions app [S15]. With only the machine user and the maintainer on the bypass list, the rules above leave it out, so the push should fail. No page names `GITHUB_TOKEN` in ruleset terms. **Unconfirmed.** A second ruleset on `~ALL` with Restrict creations would keep the token from creating any branch, on the same reasoning.
- Push rulesets, which restrict file paths such as `.github/workflows/**`, "are available for the GitHub Team plan in internal and private repositories, and forks of repositories that have push rulesets enabled" [S30]. A public repo on GitHub Free can't have one. **Documented.**

## 12. What the machine user can read, and what Shaders holds

### What the machine user's token reads

Under `flightdeckbot`'s own `gh` login, with the scopes `repo` and `read:org`, three reads on Shaders returned 403 with "You must have repository read permissions or have the repository Actions policies fine-grained permission", or the runners permission for the third [T2]:

- `GET /repos/campdotdev/shaders/actions/permissions`
- `GET /repos/campdotdev/shaders/actions/permissions/workflow`, which holds the default token permissions and `can_approve_pull_request_reviews`
- `GET /repos/campdotdev/shaders/actions/runners`

`GET .../environments` and `GET .../rulesets` returned 200, and the workflow files are readable to anyone with read access. The REST reference names only the `repo` scope for the two permission endpoints and no role [S22]. **Confirmed by local test.**

### What Shaders' CI holds

As of 2026-10-27, under the maintainer's admin login [T3]:

- The default workflow permissions are `read`, and create-and-approve is on.
- `ci.yml` runs on pushes to `main`, on PRs into `main`, and in the merge queue. It has no top-level `permissions` block, so its jobs get the `read` default, and it names no secret. Its jobs run `pnpm install --frozen-lockfile`, the tests, and the visual tests on the PR's merge commit.
- `react-doctor.yml` runs on every PR with `contents: read`, `pull-requests: write`, `issues: write`, and `statuses: write`. It checks out the PR and runs `millionco/react-doctor@v2`, whose npm steps run with the checkout as the working folder.
- `release.yml` runs only on pushes to `main`, with `contents: write`, `pull-requests: write`, and `id-token: write`. `changesets/action` opens the Version Packages PR with `GITHUB_TOKEN`, which needs create-and-approve, and publishes to npm through trusted publishing.
- One repository secret, `NPM_TOKEN`, exists, and no workflow names it.
- One environment, `copilot`, has no protection rules.
- Three rulesets cover the default branch. One requires one approval and dismisses stale approvals on push. Another requires four status checks from the GitHub Actions app, id 15368, and a merge queue. The Organization admin role bypasses all three.

So a factory branch reaches no secret on Shaders. React Doctor's job runs npm in the checkout while it holds `pull-requests: write` with create-and-approve on, which by section 5 lets the branch's code approve its own PR. **Confirmed by local test.**

## What a PR job holds, by default and at most

This table sorts the findings by what a factory branch's PR job can use. It records what exists. It doesn't choose among the candidates FLD-52 names.

| What the job holds | By default | What widens it | What narrows it |
| :- | :- | :- | :- |
| Repository and organization secrets | Those the workflow names [S5] | A job that passes a deploy or registry token to tests or scripts | Fork PRs [S4]. Moving the secret into an environment [S8] |
| Environment secrets | None. Only jobs that name the environment [S8] | An environment with no branch rule or reviewers [S8]. "Protected branches only" in a repo with no branch protection rules [S8] | A branch rule limited to the default branch. Required reviewers, public repos only on Free, Pro, and Team [S8] |
| `GITHUB_TOKEN` | Read `contents` and `packages` in a new personal repo [S19] | The workflow's `permissions` block, or a permissive default [S17][S19] | Fork PRs [S17]. `persist-credentials: false` [S43] |
| Approving its own PR | No | "Allow GitHub Actions to create and approve pull requests" plus `pull-requests: write` [S19][S24] | Leaving the setting off. It is off by default in personal repos [S19] |
| Pushing branches with `GITHUB_TOKEN` | No | `contents: write` | A ruleset with Restrict creations and Restrict updates [S28]. **Unconfirmed** for the token |
| Starting other workflows | No | `actions: write` dispatches a workflow against any ref [S3][S15][S38] | No dispatch trigger on secret-bearing workflows |
| OIDC tokens | No | `id-token: write` [S36] | Trust policies on `sub`, `ref`, or environment [S36]. npm environment or staged publishing [S48][S49] |
| Workflow file edits | No, without the `workflow` scope [S1] | The `workflow` scope on the machine user's token. Content identical to another branch's file passes without it [S1] | Keeping the scope off the token |
| Local actions and package scripts | Yes, the branch controls them [S17] | Any step that runs them | Nothing in GitHub's settings |

## How the local tests ran

| ID | What ran |
| :- | :- |
| T1 | `gh api /apps/github-actions` and `gh api /users/github-actions%5Bbot%5D`, run read-only with `gh` 2.102.0 on 2026-10-27. The first returned id 15368, slug `github-actions`, name GitHub Actions, owner `github`, and a permission list with `statuses: write` and no `workflows` entry. The second returned `github-actions[bot]`, id 41898282, type `Bot` |
| T2 | `GH_CONFIG_DIR=~/.config/flight-deck/gh gh api ...` as `flightdeckbot`, scopes `repo` and `read:org`, run read-only on 2026-10-27 against `campdotdev/shaders`: `actions/permissions`, `actions/permissions/workflow`, `actions/runners`, `environments`, and `rulesets`. The first three returned 403, and the last two returned 200 |
| T3 | `gh api` as the maintainer, an admin of `campdotdev/shaders`, run read-only on 2026-10-27: `actions/permissions/workflow` returned `{"default_workflow_permissions":"read","can_approve_pull_request_reviews":true}`. Also read: `actions/permissions`, the contents of `ci.yml`, `react-doctor.yml`, and `release.yml`, the names under `actions/secrets` and `actions/variables`, `environments`, `collaborators`, and each ruleset |
| T4 | On 2026-10-28, `gh repo create hunterbecton/fd-scratch --public` and an invite to `flightdeckbot` with Write, as the maintainer. As the machine user, with `GH_CONFIG_DIR=~/.config/flight-deck/gh`, its invite was accepted and the repo cloned over HTTPS with `credential.helper` cleared and set to `!gh auth git-credential`, so no other credential could answer. The pushes are listed under [What a push test showed](#what-a-push-test-showed). `GET /repos/hunterbecton/fd-scratch/activity` named the actor of each push. Afterwards the maintainer removed the machine user from the repo |

Only T4 pushed, and only to `hunterbecton/fd-scratch`, a public repo made for it. T4 removed the machine user from that repo afterwards. No test created a token or changed a setting on Shaders.

## Sources

| ID | Source |
| :- | :- |
| S1 | [GitHub Docs, Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps) |
| S2 | [GitHub Docs, Workflows](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflows) |
| S3 | [GitHub Docs, Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) |
| S4 | [GitHub Docs, Using secrets in GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets) |
| S5 | [GitHub Docs, Secrets](https://docs.github.com/en/actions/concepts/security/secrets) |
| S6 | [GitHub Docs, Secrets reference](https://docs.github.com/en/actions/reference/security/secrets) |
| S7 | [GitHub Docs, Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use) |
| S8 | [GitHub Docs, Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) |
| S9 | [GitHub Docs, Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) |
| S10 | [GitHub Docs, Reviewing deployments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments) |
| S11 | [GitHub REST API, GitHub Actions secrets](https://docs.github.com/en/rest/actions/secrets) |
| S12 | [GitHub REST API, Workflow runs](https://docs.github.com/en/rest/actions/workflow-runs), "Review pending deployments for a workflow run" |
| S13 | [GitHub Docs, Repository roles for an organization](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization) |
| S14 | [GitHub Docs, Permission levels for a personal account repository](https://docs.github.com/en/account-and-profile/reference/permission-levels-for-a-personal-account-repository) |
| S15 | [GitHub Docs, GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token) |
| S16 | [GitHub Docs, Use GITHUB_TOKEN for authentication in workflows](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token) |
| S17 | [GitHub Docs, Workflow syntax for GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), `permissions` and `jobs.<job_id>.steps[*].uses` |
| S18 | [GitHub Docs, Contexts reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts) |
| S19 | [GitHub Docs, Managing GitHub Actions settings for a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository) |
| S20 | [GitHub Docs, Disabling or limiting GitHub Actions for your organization](https://docs.github.com/en/organizations/managing-organization-settings/disabling-or-limiting-github-actions-for-your-organization) |
| S21 | [GitHub Enterprise Cloud Docs, Enforcing policies for GitHub Actions in your enterprise](https://docs.github.com/en/enterprise-cloud@latest/admin/enforcing-policies/enforcing-policies-for-your-enterprise/enforcing-policies-for-github-actions-in-your-enterprise) |
| S22 | [GitHub REST API, GitHub Actions permissions](https://docs.github.com/en/rest/actions/permissions), "Set default workflow permissions for a repository" |
| S23 | [GitHub Docs, Approving workflow runs from forks](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks) |
| S24 | [GitHub Changelog, GitHub Actions: Prevent GitHub Actions from approving pull requests](https://github.blog/changelog/2022-01-14-github-actions-prevent-github-actions-from-approving-pull-requests/), 2022-01-14 |
| S25 | [GitHub Changelog, GitHub Actions: Prevent GitHub Actions from creating and approving pull requests](https://github.blog/changelog/2022-05-03-github-actions-prevent-github-actions-from-creating-and-approving-pull-requests/), 2022-05-03 |
| S26 | [GitHub Changelog, Bot-created pull requests can run workflows if approved](https://github.blog/changelog/2026-06-11-bot-created-pull-requests-can-run-workflows-if-approved/), 2026-06-11 |
| S27 | [GitHub Changelog, Safer pull_request_target defaults for GitHub Actions checkout](https://github.blog/changelog/2026-06-18-safer-pull_request_target-defaults-for-github-actions-checkout/), 2026-06-18, edited 2026-07-15 |
| S28 | [GitHub Docs, Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) |
| S29 | [GitHub REST API, Repository rules](https://docs.github.com/en/rest/repos/rules) |
| S30 | [GitHub Docs, About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets), including the plan note at the top of the page |
| S31 | [GitHub Docs, Creating rulesets for a repository](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository) |
| S32 | [GitHub Changelog, Repository rulesets: User bypass and branch renaming](https://github.blog/changelog/2026-05-07-repository-rulesets-user-bypass-and-branch-renaming/), 2026-05-07 |
| S33 | [GitHub Docs, About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) |
| S34 | [GitHub REST API, Protected branches](https://docs.github.com/en/rest/branches/branch-protection), `required_status_checks.checks[].app_id` |
| S35 | [GitHub REST API, Commit statuses](https://docs.github.com/en/rest/commits/statuses) |
| S36 | [GitHub Docs, OpenID Connect reference](https://docs.github.com/en/actions/reference/security/oidc) |
| S37 | [GitHub Docs, Manually running a workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow) |
| S38 | [GitHub REST API, Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps), `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` |
| S39 | [GitHub Docs, Dependency caching reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching) |
| S40 | [GitHub Docs, Pull request reviews](https://docs.github.com/en/pull-requests/reference/pull-request-reviews) |
| S41 | [GitHub Docs, Requesting a pull request review](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/requesting-a-pull-request-review) |
| S42 | [GitHub Docs, About pull requests](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-pull-requests), "Draft pull requests" |
| S43 | [actions/checkout](https://github.com/actions/checkout) at commit `f548e57`, 2026-07-20: `README.md`, `action.yml`, and `src/git-auth-helper.ts`. Latest release v7.0.1 |
| S44 | [cli/cli](https://github.com/cli/cli) at commit `93d24ce`, 2026-10-27: `internal/attachments/client.go` and `pkg/cmd/pr/create/create.go`. Also `gh pr create --help` from `gh` 2.102.0 |
| S45 | [GitHub Docs, GitHub Copilot code review](https://docs.github.com/en/copilot/concepts/agents/code-review) |
| S46 | [GitHub Changelog, Ask @copilot to make changes to a pull request](https://github.blog/changelog/2026-03-24-ask-copilot-to-make-changes-to-any-pull-request/), 2026-03-24 |
| S47 | CodeRabbit Docs, [Code review commands](https://docs.coderabbit.ai/reference/review-commands), [Code guidelines](https://docs.coderabbit.ai/knowledge-base/code-guidelines), and [Simplify code](https://docs.coderabbit.ai/finishing-touches/simplify), read through `https://docs.coderabbit.ai/llms-full.txt` |
| S48 | [npm Docs, Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers) |
| S49 | [npm Docs, Staged publishing for npm packages](https://docs.npmjs.com/staged-publishing) |
| S50 | [changesets/action](https://github.com/changesets/action) at commit `615034b`, 2026-10-02: `README.md` |
| S51 | [GitHub Docs, Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads), `pull_request` action `opened` |

Non-primary sources, cited only where GitHub's docs are silent:

| ID | Source |
| :- | :- |
| N1 | [GitHub Community discussion #26254](https://github.com/orgs/community/discussions/26254), "I cannot git push into github refusing to allow a Personal Access Token to create or update workflow", 2022-03-25 |
| N2 | [GitHub Community discussion #26164](https://github.com/orgs/community/discussions/26164), "refusing to allow a bot to create or update workflow when pushing tags on older commits", 2020-03-07 |
| N3 | [GitHub Community discussion #70491](https://github.com/orgs/community/discussions/70491), "Cannot push changes to origin if it touches the workflow being run", 2023-10-18 |
| N4 | [GitHub Community discussion #45947](https://github.com/orgs/community/discussions/45947), "refusing to allow an OAuth App to create or update workflow '.github/workflows/ci.yml' without workflow scope", 2023-01-31 |
| N5 | [GitHub Community discussion #108402](https://github.com/orgs/community/discussions/108402), "Error: refusing to allow a GitHub App to create or update workflow", 2024-02-15 |
| N6 | [aldevtools/BusinessCentral.AL.Runner pull request #4963](https://github.com/aldevtools/BusinessCentral.AL.Runner/pull/4963), "the missing workflow scope blocks pushing workflow changes, not merging them", 2026-09-29. Its author reports one observed refusal |
