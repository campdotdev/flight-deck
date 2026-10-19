# How can launch tell that a release shipped, and how can it undo one?

Research for the `/flight-launch` review in [FLD-21](https://linear.app/campdotdev/issue/FLD-21/review-flight-launch-for-repos-that-dont-ship-to-npm). Sources were read on 2026-10-18. Each claim cites a source from the list at the end, such as [S1]. A claim marked **Unconfirmed** is one I could not settle from a primary source. A claim marked **Inference** follows from the sources, but no source states it. I changed nothing in Linear, GitHub, npm, or Vercel. Every Linear call was a read, and every `gh` call was a GET.

## Answer

- **Linear Releases.** Linear can record which issues shipped in which release, and an issue then shows its release. A release belongs to a pipeline, and its stage is `planned`, `started`, `completed`, or `canceled` [S1][S6]. Linear doesn't read releases from GitHub. A CI job reports each release with Linear's `linear-release` CLI and a pipeline access key, or any client calls GraphQL `releaseSync` with PR numbers [S1][S6][S7]. Linear Agent writes release notes [S1]. Releases need Business or Enterprise, not Free or Basic [S1][S9]. I could not confirm that an `actor=app` user may call the release mutations. campdotdev has no pipelines [S12].
- **Noticing a release.** No single GitHub signal means "released". For a package that publishes with Changesets, the GitHub Release that `changesets/action` creates after publishing is the closest signal. The Version Packages merge comes earlier, 40 minutes earlier in one observed case [S54][S26]. For an app on Vercel, Vercel creates a GitHub deployment and one status when the deploy finishes. Its environment is `Production` or `Production – <project>`, and its `production_environment` flag is false [S24][S26]. Conditional requests that return 304 cost no rate limit [S14].
- **Mapping a release to PRs.** Compare the two release commits, then read the `(#123)` in each squash-merge subject or ask `commits/{sha}/pulls` [S21]. `@changesets/changelog-github` links PRs in the changelog, but only PRs that carried a changeset [S53][S26].
- **Rollback.** An npm version number can never be reused. A rollback means deprecating the bad version, pointing `latest` at the previous one, and shipping a fix [S27][S29][S32]. Unpublishing works within 72 hours if nothing in the registry depends on the package. After 72 hours it also needs fewer than 300 weekly downloads and a single owner [S29]. Trusted publishing can move dist-tags only when **Allow npm dist-tag** is on. It can't deprecate or unpublish [S33][S41]. Vercel's Instant Rollback switches domains without a rebuild. Hobby can step back one deployment only, and the CLI runs it with `vercel rollback` [S42][S43]. One person can do all of it alone, apart from an unpublish outside policy, which needs npm support.
- **Changesets.** A changeset marks a major in its frontmatter. `changesets/action` opens a "Version Packages" PR from `changeset-release/<base>`, and after it merges, publishes, tags, and creates GitHub Releases [S49][S54]. On a `0.x` package, a major goes to 1.0.0. Changesets has no special case below 1.0, so a breaking change there is marked `minor` by convention [S52][S55][S56].
- **Surprises.** Trusted-publisher configurations created after 2026-09-03 allow only staged publishing, and Changesets says staged publishing does not work with Changesets [S33][S50]. Changesets v3 and `changesets/action@v2` shipped in August 2026 and renamed the action's inputs and outputs [S51][S54]. A Version Packages PR opened with the default `GITHUB_TOKEN` triggers no CI [S50].

## Linear Releases

### What a release is

Linear Releases groups issues by the release that delivered them, so a team can see what reached customers and not only what merged. The docs open on the same gap Flight Deck has: "An issue's Done status does not always mean delivered to your customers" [S1]. Linear announced Releases on 2026-04-30 [S2].

A **release pipeline** stands for one product and environment, such as "iOS (production)" or "Linear App" [S1]. Each pipeline is one of two types [S1][S6]:

- **Continuous.** Every sync creates a release that is already completed. One deploy is one release.
- **Scheduled.** A started release collects issues over time, moves through stages such as "code freeze" and "qa", and then completes. The CLI's README calls this a release train [S7].

A pipeline has teams, which set ownership but don't limit which issues it can hold, and optional path filters, which keep only commits that touch matching files [S1]. It also has an `isProduction` flag, which defaults to true [S6].

A **release** has a name, a version, a commit SHA, a description, links, documents, and a set of issues [S1][S6]. The version must be unique within its pipeline [S6].

### Stages and states

A release's state is its **stage**. Every stage has one of four lifecycle types: `planned`, `started`, `completed`, or `canceled` [S6]. `startedAt` records when the release first entered a `started` stage. Entering a `completed` or `canceled` stage sets `completedAt` or `canceledAt`, and leaving it clears them [S6]. The schema gives "Planned, In Progress, Completed, Canceled" as example stage names [S6].

- Teams can add, rename, and freeze `started` stages. Each of the other three types has at most one stage, with its default name and color [S6].
- A `started` stage can be **frozen**. Automated syncs then skip releases in that stage, and no new issues are added to them automatically [S1][S6].
- `releaseCreate` defaults a new release to the first `completed` stage in a continuous pipeline, or the first `started` stage in a scheduled one [S6].
- In a scheduled pipeline, completing a release moves its open issues to the next release, and Linear creates that release if none exists. The pipeline setting **Move open issues to the next release** turns this off [S1].

### How issues get attached

The docs describe no way for Linear to read GitHub releases, tags, or deployments itself. They describe one route, in which a CI job reports each release to Linear [S1].

- Linear's open-source CLI, `linear-release`, and its GitHub Action wrapper do the reporting [S7][S8]. The CLI scans the commits since the pipeline's last release for issue identifiers, such as `ENG-123` in branch names and commit messages. It also collects PR numbers from GitHub's `Title (#42)` and `Merge pull request #42` subjects [S7].
- Linear resolves each PR number back to the issues linked to that PR, so an issue linked only through its PR still lands in the release [S7].
- The CLI has three commands. `sync` creates a release or adds issues to the current one. `update --stage` moves a scheduled release to another stage. `complete` completes it [S7].
- On a pipeline's first sync, the CLI scans only the current commit. `--base-ref` sets a different starting point [S7].
- The CLI authenticates with a **pipeline access key** that is generated in the pipeline's settings. "You cannot use a personal API key in place of a pipeline access key" [S1][S7]. The schema has no mutation that creates an access key [S6].
- The CLI is a binary for Linux and macOS, and it shells out to `git` inside a full clone. Its latest release is v0.18.0, from 2026-09-15 [S7].

The GraphQL API also attaches issues with an ordinary OAuth token or API key, without the CLI or a pipeline access key [S6]:

- `releaseSync` takes a `pipelineId`, a `commitSha`, `issueReferences`, `pullRequestReferences` with owner, repo, and PR number, a version, links, documents, and release notes. In a continuous pipeline it creates a completed release. In a scheduled pipeline it adds to the started release. The CLI calls the access-key twin, `releaseSyncByAccessKey`.
- `releaseCreate`, `releaseUpdate`, and `releaseComplete` manage a release by hand.
- `issueToReleaseCreate` links one issue to one release, and `issueToReleaseDelete` removes the link.
- Since 2026-05-14, release inputs accept `createdAt`, `startedAt`, and `completedAt` for backdating [S3].

### What an issue shows

An issue shows its release in the properties sidebar. Views can show it as a display option and filter by release, stage, or pipeline [S1]. In the API, `Issue.releases` lists the releases, `IssueFilter.releases` filters by them, and the `Issue` webhook payload carries them [S6]. So an issue can show which release delivered it. **Unconfirmed:** the exact wording on screen. campdotdev has no releases to look at.

Workflow automations can move issues when a release completes, optionally only for chosen pipelines [S1]. The docs suggest moving an issue to a started "Merged" status when its PR merges, and to Done when its release completes [S1]. That rule touches an issue when it has no linked PRs, or when its closing PR merged and no linked closing or contributing PR is still open. An issue linked only to contributing PRs is not moved [S1].

### Release notes

Release notes cover one release or a range of releases in one pipeline [S1][S6].

- A person writes them, or Linear Agent generates them from the release's issues [S1][S2]. A pipeline's release-note template sets the format of generated notes [S1][S6].
- A pipeline setting, `autoGenerateReleaseNotesOnCompletion`, generates notes each time a release completes [S1][S6]. `ReleaseNote.generationStatus` reads `pending` while the model runs and `completed` once the notes land [S6].
- Each pipeline has a changelog tab that lists its release notes in order. Linear added it on 2026-06-18 [S4].
- The API can create and update release notes with `releaseNoteCreate` and `releaseNoteUpdate`. It has no mutation that asks Linear to generate them. Generation happens only through the pipeline setting or the app [S6].
- `linear-release` can upload notes from a file, such as `--release-notes-file ./CHANGELOG.md` [S7].

### Plans

Releases need Business or Enterprise. Business allows 15 pipelines, and Enterprise has no limit [S1][S2]. The pricing page marks Releases as unavailable on Free and Basic [S9]. Business costs $16 per user per month, billed yearly [S9].

`releasePipelineCreate` is "subject to plan entitlement and quota limits" [S6]. campdotdev has no release pipelines and no releases today [S12]. **Unconfirmed:** campdotdev's plan. The MCP server does not report it.

### App users and the MCP server

The schema puts release mutations beside every other mutation and states no scope or role for them [S6]. Linear's OAuth docs list the scopes `read`, `write`, `issues:create`, `comments:create`, `timeSchedule:write`, and `admin`. They say an `actor=app` token performs "all mutations such as creating issues, comments, and status changes", and they name no mutation an app may not call [S10][S11]. Linear publishes no developer guide for the release API. Its sitemap lists only the product page [S1].

**Unconfirmed:** whether an `actor=app` token with `write` can call `releaseSync`, `releaseCreate`, `releaseUpdate`, or `issueToReleaseCreate`. Nothing I read says no, and nothing says yes. The test is one `releaseCreate` call with the Flight Deck app user's token against a pipeline on a Business workspace.

The MCP server gained release tools on 2026-07-02 [S5]. They are `list_release_pipelines`, `list_releases`, `get_release`, `save_release`, `list_release_notes`, `get_release_note`, and `save_release_note`, plus `addReleases`, `removeReleases`, and `setReleases` on `save_issue` and a `release` filter on `list_issues` [S12]. `save_release` takes a stage by ID, name, or lifecycle type [S12]. No MCP tool creates a pipeline [S12].

## Notice that a release shipped

### Each signal proves something different

A poller on the Mac can read five signals through `gh` and the GitHub REST API. They fire at different moments. On `changesets/changesets`, the Version Packages PR merged at 14:47, and the GitHub Releases appeared 40 minutes later, after an approval gate [S26].

| Signal | How to read it | What it proves | Watch out for |
|---|---|---|---|
| Version Packages PR merged | `gh pr list --head changeset-release/main --state merged --json number,mergedAt,mergeCommit` | The versions and changelogs reached the default branch. | It does not mean the package was published [S26]. |
| Workflow run finished | `gh run list --workflow <file> --commit <sha> --json status,conclusion,headSha` | The release job ran on that commit and ended with this conclusion. | A run on an ordinary push ends `success` too, after it only updates the PR. **Inference** from the action's two paths [S54]. |
| GitHub Release published | `gh release list --json tagName,publishedAt,isPrerelease,isDraft` | `changesets/action` creates one per package after a publish succeeds [S54]. | Use `published_at`. `releases/latest` sorts by the date of the release's commit [S13]. |
| Tag pushed | `GET /repos/{o}/{r}/git/matching-refs/tags/<prefix>` | A ref named after the version exists. | A lightweight tag has no date [S17]. |
| Deployment status | `GET /repos/{o}/{r}/deployments?environment=...` then its `statuses` | A deploy to that environment reached `success` or `failure`. | Vercel's naming and flags, below. |

**Releases.** `GET /repos/{o}/{r}/releases` returns `tag_name`, `target_commitish`, `draft`, `prerelease`, `created_at`, and `published_at`, up to 100 per page. It leaves out tags that have no release [S13]. `releases/latest` returns "the most recent non-prerelease, non-draft release, sorted by the created_at attribute", and `created_at` "is the date of the commit used for the release" [S13]. In a monorepo every package released from one commit shares that date. On `changesets/changesets`, three releases share a `created_at`, and their `published_at` values differ by seconds [S26]. `gh release list --json` offers `tagName`, `publishedAt`, `isPrerelease`, `isDraft`, and `isLatest` [S23].

**Tags.** `GET /repos/{o}/{r}/tags` returns names and commit SHAs, with no dates and no documented order [S17]. `git/matching-refs/tags/<prefix>` filters by prefix. A ref whose `object.type` is `tag` is annotated and has a `tagger.date`. A ref whose type is `commit` is lightweight and has no date [S17]. `changesets/action@v2` pushes tags through the API by default, with `createRef` pointed at the merge commit, so its tags are lightweight. **Inference** from the action's source [S54]. The `@changesets/cli@3.0.x` tags are lightweight refs, which matches [S26]. The tag format is `<pkg>@<version>` in a monorepo and `v<version>` in a single-package repo [S49][S52].

**The Version Packages PR.** The action's branch is always `changeset-release/<base>`, and the PR title defaults to "Version Packages" [S54]. `gh pr list --head changeset-release/main --state merged` on `changesets/changesets` returned #2291, merged at 2026-09-14T14:47:01Z, with merge commit `c9269c0`, opened by `app/changesets-org-version-bot` [S26]. `GET /repos/{o}/{r}/commits/{sha}/pulls` on that merge commit returned the same PR [S21][S26].

**Workflow runs.** `GET /repos/{o}/{r}/actions/workflows/{file}/runs` filters by `branch`, `event`, `status`, `created`, and `head_sha`. Anyone with read access may call it [S18]. A finished run's `conclusion` is one of `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, or `action_required` [S18]. `gh run list -w <file> -c <sha> --json conclusion,headSha,status` reads the same data [S23]. On `changesets/changesets`, the Publish run for `c9269c0` ran from 14:47:03 to 15:27:21 and ended `success` [S26]. The action's `published` output says whether it published. The REST runs API does not return step outputs. **Inference:** reading `published` means reading the job log, or a release or tag that the publish leaves behind.

**Deployments from GitHub Actions.** "By default, when a workflow job references an environment, GitHub creates a deployment object" [S20]. A publish job that runs in an environment therefore leaves deployment statuses behind. On `changesets/changesets`, the `publish` job runs in `environment: npm`. Its deployment moved from `waiting` at 14:48 to `queued`, then `in_progress`, then `success` at 15:27 [S26]. On GitHub Free, Pro, and Team, required reviewers on an environment work only in public repos [S20].

### Vercel posts GitHub deployments, with quirks

"Vercel for GitHub uses the deployment API", and "you will see all of your deployments, production or preview, from within GitHub" [S24]. It holds the Deployments permission "to synchronize deployment status between GitHub and the Vercel infrastructure" [S24]. By default it also sends the `deployment_status` webhook event. A project setting turns that event off [S24].

What the deployments look like on two public repos that deploy on Vercel [S26]:

- The creator is `vercel[bot]`, the `task` is `deploy`, and `ref` is a commit SHA.
- `production_environment` is `false`, even for production. A poller can't filter on it.
- The environment is `Production` or `Preview`, or `Production – <project>` and `Preview – <project>` with an en dash (U+2013). `vercel/ai-chatbot` uses `Production` and `Preview`, and `shadcn-ui/ui` uses `Production – ui`. The en dash must be URL-encoded in the `environment` query.
- Each sampled deployment had one status, created in the same second as the deployment. It was `success` ("Deployment has completed") or `failure`, with a `vercel inspect` hint in the description. In `shadcn-ui/ui`, 23 of 25 were `success`.
- `environment_url` is the deployment's own URL, such as `ui-6woqddpeh-shadcn-pro.vercel.app`, not the production domain.

Deployment status states are `error`, `failure`, `inactive`, `in_progress`, `queued`, `pending`, and `success` [S19]. Read access is enough to list them [S19].

Vercel also sends `repository_dispatch` events, such as `vercel.deployment.success` and `vercel.deployment.promoted`, with the deployment URL and environment in the payload [S24][S25]. They trigger only workflows whose file is on the default branch [S24]. A poller sees them only as workflow runs with `event=repository_dispatch`, and only if the repo has such a workflow. Vercel added the enriched payload on 2025-04-07 and the toggle for `deployment_status` events on 2025-05-01 [S25].

**Unconfirmed:** whether Vercel posts a GitHub deployment for `vercel deploy --prod` from a laptop, for a promote, or for an Instant Rollback. Only the `vercel.deployment.promoted` dispatch event is documented. Also unconfirmed: when Vercel adds the `– <project>` suffix to an environment name, and whether turning off `deployment_status` events also stops the deployment objects.

### Poll cheaply

GitHub tells integrations to "subscribe to webhook events instead of polling", and to poll "only as often as you need to, on a fixed schedule" when they must [S14]. A conditional request with the saved `etag` in `if-none-match` "does not count against your primary rate limit if a 304 response is returned" [S14]. Two repeat calls to `releases/latest` with `If-None-Match` returned 304 and left `X-Ratelimit-Used` unchanged [S26]. On a 304, `gh api` prints `gh: HTTP 304` and exits 1, so a poller has to read that exit as "unchanged" [S26].

A personal access token gets 5,000 REST requests an hour. Secondary limits allow 900 points a minute, where a GET costs 1 [S15]. GraphQL allows 5,000 points an hour [S16]. Five endpoints polled once a minute come to 300 requests an hour, or 6% of the REST budget, before 304s make most of them free. The repo events API is no shortcut. GitHub says it is "not built to serve real-time use cases", with a delay of 30 seconds to 6 hours [S22].

### Map a release back to its PRs

- **Compare two tags.** `GET /repos/{o}/{r}/compare/BASE...HEAD` matches `git log BASE..HEAD`. It returns at most 250 commits unless the caller pages with `per_page` and `page` [S21]. A squash merge's subject ends in `(#123)`, so each commit names its PR [S26].
- **Ask GitHub which PR made a commit.** `GET /repos/{o}/{r}/commits/{sha}/pulls` returns the merged PR that introduced a commit on the default branch [S21].
- **Generate notes without saving them.** `POST /repos/{o}/{r}/releases/generate-notes` takes `tag_name` and `previous_tag_name`, and "the generated release notes are not saved anywhere" [S13]. **Unconfirmed:** which token permission it needs. I did not call it, because it is a POST.
- **Read the changelog.** With `@changesets/changelog-github`, each changelog line links its PR [S53]. A GitHub Release body made by `changesets/action` is that changelog entry [S54]. The release `@changesets/cli@3.0.3` lists `#2297` and `#2276` [S26]. That list holds only PRs that carried a changeset. The compare between the two Version Packages merges held 13 commits, including dependency bumps and test-only PRs [S26].

Linear's `releaseSync` accepts PR numbers as `pullRequestReferences` and finds the issues linked to them [S6]. A runner that compares two tags and collects the PR numbers already has the input Linear needs.

## Roll back a release

### npm

npm has three tools. None of them removes the bad version from installs that already have it.

**Deprecate.** `npm deprecate <pkg>@<range> "<message>"` makes installs of the matching versions print the message. The range can be one version. An empty message, `""`, undeprecates [S27]. Only a package owner can deprecate [S27]. The website can deprecate a whole package, which also drops it from npm search. A single version or a range needs the CLI [S28]. npm "strongly recommend[s]" deprecating over unpublishing [S28].

**Unpublish.** The policy has two windows [S29]:

- Within 72 hours of publishing, an owner can unpublish "as long as no other packages in the npm Public Registry depend on your package."
- After 72 hours, three things must all hold: "no other packages in the npm Public Registry depend on it", "it had less than 300 downloads over the last week", and "it has a single owner/maintainer."

Other unpublish rules [S29][S30][S31]:

- "Once `package@version` has been used, you can never use it again." A fix ships under a new version number.
- Unpublishing every version removes the package entry. No one can publish the name again for 24 hours. The CLI refuses to delete the last version without `--force`.
- A single version can be unpublished only through the CLI. When the policy blocks an unpublish, the website hides **Delete** and offers deprecation.
- Outside the policy, the only route is npm support [S29].

I found no change to these rules from 2024 through 2026. The policy page carries no date and cites npm's January 2020 policy change [S29].

**Move `latest`.** `npm install <pkg>` installs the version tagged `latest` [S32]. `npm dist-tag add <pkg>@<previous> latest` points new installs at the previous version [S32]. A lockfile or an exact pin that already names the bad version keeps it. **Inference:** a dist-tag names one version, and a lockfile records the resolved version. When the version tagged `latest` is unpublished, the npm CLI resets `latest` to the highest remaining version [S41].

**What trusted publishing changes.** Trusted publishing reached general availability on 2025-07-31. It needs npm CLI 11.5.1 or later, and it runs on GitHub-hosted runners and GitLab.com shared runners [S34].

- OIDC covers `npm publish`, `npm stage publish`, and dist-tag operations. "Other npm commands such as `install`, `view`, or `access` still require traditional authentication methods" [S33].
- Dist-tag operations need **Allow npm dist-tag** on the trusted publisher. It is off by default, and publishing rights don't grant it. It needs CLI 11.21.0 or 12.2.0 or later [S33][S35]. GitHub added it on 2026-09-30, with "promoting a version to `latest`" as the example [S35].
- `npm deprecate` and `npm unpublish` have no OIDC path. In the CLI source, `dist-tag.js` and `publish.js` call `oidc()`, while `deprecate.js` and `unpublish.js` call only `otplease()` [S41]. Both commands need a login or a token, plus a second factor.
- Self-hosted runners are not supported [S33].

npm tightened authentication in late 2025:

- Classic tokens are gone. npm stopped creating them on 2025-11-05 and revoked the rest on 2025-12-09 [S36][S37].
- `npm login` now issues a two-hour session token, and new packages get 2FA turned on by default [S37].
- New write tokens enforce 2FA unless created with **Bypass 2FA**, and write tokens last at most 90 days [S36].
- The default 2FA mode, authorization and writes, asks for a one-time password on publish, unpublish, deprecate, and `dist-tag` [S32][S39].
- The publishing-access option **Require two-factor authentication and disallow tokens** affects only token authentication, so OIDC keeps working [S33][S38].

**Staged publishing.** Since 2026-05-22, `npm stage publish` holds a version until "a human maintainer with a 2FA challenge" approves it. Approval and rejection "require interactive authentication and cannot use OIDC tokens" [S40][S33]. Trusted-publisher configurations created after 2026-09-03 allow only `npm stage publish` unless someone changes them [S33]. Changesets says "Staged Publishing does not work with Changesets" [S50].

### Vercel

Instant Rollback points the production domains at an earlier production deployment without a rebuild, and Vercel says the switch is instant [S42]. It became generally available on 2023-05-11 [S47].

- **Hobby:** "Hobby users can roll back to the immediately previous deployment" [S42].
- **Pro and Enterprise:** Owners, Members, and Developers can roll back to any deployment that once held a production domain. So can a Project Administrator, or anyone with the Full Production Deployment permission [S42].
- A preview that never held a production domain is not eligible [S42].

A rollback leaves some things behind [S42]:

- The old build runs with the environment variables and configuration it was built with. Changes made in project settings since then don't apply.
- Cron jobs revert to the rolled-back deployment's schedule.
- Custom aliases come along only if the old deployment had them.
- One project runs one rollback at a time.

After a rollback, Vercel turns off auto-assignment of production domains. New pushes to the production branch don't replace the rolled-back deployment. Undo it with **Undo Rollback** in the dashboard or `vercel promote <deployment>`, which promotes a deployment and turns auto-assignment back on [S42][S43].

The CLI runs a rollback with `vercel rollback [deployment-id or url]` and checks it with `vercel rollback status`. It accepts `--token` and `--non-interactive` [S43]. On Hobby, naming an older deployment fails with "To roll back further than the previous production deployment, upgrade to pro" [S43]. The REST API has `POST /v1/projects/{projectId}/rollback/{deploymentId}` [S44].

Retention limits what a rollback can reach:

- Production deployments are kept for 30 days on Hobby and 1 year on Pro [S45].
- Since 2026-09-16, a Hobby project keeps its 3 newest production deployments and its 3 newest deployments of any type, whatever their age. The current production deployment is never deleted [S45][S46].
- Since 2026-08-21, "a deleted deployment can no longer be rolled back to" [S48].

### What one person can do alone

No source names an approval step for any of these actions. Each needs only the maintainer's own account:

- npm deprecate, unpublish within policy, and `dist-tag add` each take an `npm login` and a one-time password [S27][S29][S32][S37].
- A Vercel rollback or promote takes the dashboard, the CLI, or the API [S42][S43][S44].
- Unpublishing outside the policy needs npm support [S29].
- Approving a staged npm publish needs a human 2FA challenge. **Unconfirmed:** whether the maintainer who started a staged publish may approve it, which decides whether one person can do it alone.

## Mark breaking changes with Changesets

### Versions in use

Both tools had a major release this summer. Changesets v3 came out on 2026-08-11. It is ESM-only and needs Node `^22.11 || ^24 || >=26` [S51]. `changesets/action@v2` is required for Changesets v3, and "the v1 action will only work with Changesets v2" [S49]. The action checks the CLI version at runtime and fails on v2 [S54]. Its latest release is v2.1.2, from 2026-09-07 [S54]. The `docs/` folder in the Changesets repo now says "This documentation is outdated". The current docs live in `site/`, published at changesets.dev [S49].

### A changeset marks a major bump in its frontmatter

A changeset is a Markdown file in `.changeset/`. Its YAML frontmatter maps each package to a bump type, and its body is the changelog text [S49]:

```markdown
---
"@scope/pkg": major
---

Remove `foo()`. Call `bar()` instead.
```

- The parser accepts `major`, `minor`, `patch`, and `none`, and throws on anything else [S52].
- Several changesets for one package collapse into one bump at the highest type [S49].
- `changeset version` consumes the files and deletes them [S49].
- `changeset add` asks which packages get a major bump, then which get a minor, and gives the rest a patch. After a major, it urges the author to say what broke, why, and how a consumer updates [S52].
- v3 adds flags for scripts: `--major <pkg>`, `--minor <pkg>`, `--patch <pkg>`, and `-m` for the message [S49][S52].
- `--empty` writes a changeset that releases nothing, for repos whose CI demands a changeset on every PR [S49][S52].

### The action opens a Version Packages PR, then publishes when it merges

In the usual setup, `changesets/action` runs on each push to the base branch and picks one of two paths [S54]:

1. **Changesets are present.** It runs `version-script`, which defaults to `changeset version`, on the branch `changeset-release/<base>`. It commits with the message "Version Packages" and opens or updates a PR titled "Version Packages". The PR body has one `## <pkg>@<version>` section per package with that version's changelog entry. In prerelease mode the title gains ` (<tag>)`.
2. **No changesets are present.** That is the state right after the Version Packages PR merges. If `publish-script` is set, the action runs it, pushes the new tags, and creates GitHub Releases. If not, it logs "Not publishing because publish-script is not set" and exits.

Details that matter for detecting a release:

- `create-github-releases` and `push-git-tags` both default to true. Each GitHub Release takes the tag as its name and the version's changelog entry as its body. It is marked as a prerelease when the version contains `-` [S54].
- Tags are `<pkg>@<version>` in a monorepo and `v<version>` in a single-package repo [S49].
- v2 outputs are `published`, `published-packages` as JSON `[{name, version}]`, `has-changesets`, and `pr-number`. v1 used camelCase names, such as `publishedPackages` and `pullRequestNumber` [S54].
- `changeset publish` publishes every package whose version is not yet on npm, to the `latest` dist-tag unless `--tag` says otherwise [S49].

Setup requirements:

- The action needs `contents: write` and `pull-requests: write`. Trusted publishing adds `id-token: write`, which the Changesets guide puts on the publish job only [S50][S54].
- The repo setting **Allow GitHub Actions to create and approve pull requests** must be on [S50].
- A PR opened with the default `GITHUB_TOKEN` triggers no workflows. CI on the Version Packages PR needs a personal token or a GitHub App token passed as `github-token` [S50].
- Changesets recommends trusted publishing and calls token publishing "no longer recommended". It also says "Staged Publishing does not work with Changesets" [S50].
- A package's first publish can't use trusted publishing. The maintainer publishes it once by hand, such as a `0.0.0` stub, and then configures the trusted publisher [S49].

### Below 1.0.0, a major goes to 1.0.0

Changesets does not remap bump types for `0.x` packages. It passes the type to `semver.inc` [S52], and node-semver's `major` increment turns `0.4.2` into `1.0.0` [S55]. The prerelease docs show `0.0.0` going to `1.0.0-next.0` on a major [S49]. **Inference:** I read the code path but did not run it.

- The interactive `changeset add` asks "Are you sure you want to release the first major version?" when a major would take a package to 1.0.0. The source says the prompt exists because sweeping changes "have mistakenly release first majors" [S52].
- `--major` on the command line and a hand-written file skip that prompt. **Inference** from the code: the flag path never calls the confirmation [S52].
- To ship a breaking change on `0.x` without reaching 1.0.0, the author marks it `minor`. Semver allows that: "Major version zero (0.y.z) is for initial development. Anything MAY change at any time" [S56].
- An issue that asked Changesets to treat a `0.x` minor as a major was closed on 2026-04-29 without a change [S57].

Caret ranges make a `0.x` minor a breaking change for dependents. `^0.2.3` means `>=0.2.3 <0.3.0-0` [S55]. When a new version leaves a dependent's range, Changesets gives the in-repo dependent a patch bump and a new range [S52]. "All updating of dependencies is done as a patch bump" [S49]. In v3, peer dependents also get a patch, where v2 gave them a major. That change closed two issues about `0.x` packages jumping to 1.0.0 [S49][S57]. The `technical-decisions` page still says a peer dependency causes a major, and it looks out of date [S49].

`changeset pre enter <tag>` puts the repo in prerelease mode. `version` then writes `X.Y.Z-<tag>.N`, and `publish` uses `<tag>` as the dist-tag. The mode covers every package, and it blocks stable releases from that branch until `changeset pre exit` [S49].

### Where a breaking change is visible before release

- The `.changeset/*.md` files on the default branch hold each pending bump type [S49].
- `changeset status --output <file>` writes the release plan as JSON. Each entry in `releases` has `name`, `type`, `oldVersion`, `newVersion`, and the changeset IDs [S52]. The flag takes a file path. It has no `--output=json` mode [S52].
- The open Version Packages PR shows the resulting versions and changelog entries [S54].
- The changelog groups entries under `### Major Changes`, `### Minor Changes`, and `### Patch Changes` [S52].

### Changelogs and PR links

- The default generator, `@changesets/changelog-git`, writes `- <short sha>: <summary>`. It adds no PR number and no link, although the config docs say it "adds related commit links" [S49][S52].
- `@changesets/changelog-github` writes the PR link, the commit link, and "Thanks @user!" on each line. It finds the PR through GitHub's GraphQL `associatedPullRequests` for the commit that added the changeset. It needs a `GITHUB_TOKEN` and the repo name [S52][S53].
- A summary line such as `pr: #123` overrides the PR lookup [S53].

## Unconfirmed

- Whether an `actor=app` token can call `releaseSync`, `releaseCreate`, `releaseUpdate`, or `issueToReleaseCreate`. No doc states a scope or role for them.
- campdotdev's Linear plan.
- The words Linear shows on an issue that belongs to a completed release.
- Whether Vercel posts a GitHub deployment for `vercel deploy --prod`, a promote, or an Instant Rollback.
- When Vercel adds the `– <project>` suffix to an environment name, and whether turning off `deployment_status` events also stops the deployment objects.
- Which token permission `POST /releases/generate-notes` needs.
- Whether the maintainer who started a staged npm publish may approve it.
- Whether **Require two-factor authentication and disallow tokens** also blocks token-based `deprecate`, `unpublish`, or `dist-tag`.
- Whether **Allow npm dist-tag** limits which tags a workflow may move.
- Whether the registry refuses `npm dist-tag rm <pkg> latest`.
- That `semver.inc("0.4.2", "major")` returns `1.0.0` at runtime. I read the code and did not run it.

## What this means for Flight Deck

These facts constrain the decisions in [FLD-21](https://linear.app/campdotdev/issue/FLD-21/review-flight-launch-for-repos-that-dont-ship-to-npm). They don't make them.

- **Launch can't rely on Linear Releases.** Releases need Business, and a Free workspace can hold a factory today (`docs/adr/0006-the-factory-routes-work-by-its-own-statuses-in-one-team-per-repo.md`). On Free or Basic, "merged but not released" has to live in something Flight Deck owns, such as a status, a comment, or a link on the issue.
- **On Business, the runner could record releases without CI.** `releaseSync` takes PR numbers and finds their issues. The runner already polls GitHub, so it could compare two release commits and send the PR numbers. That needs no repo code, no `linear-release` binary, and no pipeline access key. It does depend on the app user being allowed to call the mutation, which is unconfirmed. The other route is `linear-release-action` in the repo's CI, which puts a pipeline access key in the repo's secrets.
- **Done can mean merged or released, not both.** Linear's suggested pattern moves an issue to a started "Merged" status on merge, and to Done when its release completes [S1]. ADR 0006 keeps Linear's Merge → Done automation on. Using release automations would change that consequence, and it works only on Business.
- **For a package, the GitHub Release is the signal.** `changesets/action` creates one per package after it publishes, with the changelog entry as its body [S54]. The Version Packages merge can precede the publish by a long gap when the publish job waits on an environment approval [S26]. A poller can watch `GET /releases` with an ETag at no rate-limit cost.
- **For an app on Vercel, the deployment status is the signal.** The runner looks for a `success` status on a deployment whose environment name starts with `Production`, created by `vercel[bot]` for the merge commit's SHA. It can't use `production_environment`, and `environment_url` is not the production domain [S26]. Whether a rollback shows up there is unconfirmed.
- **A repo that never releases has nothing to detect.** Done on merge is final.
- **The runner can't run every rollback step unattended.** `npm deprecate` and `npm unpublish` have no OIDC path and ask for a second factor, so they need the maintainer at the keyboard or a stored token [S37][S41]. Moving `latest` can run in CI under OIDC, but only after the maintainer turns on **Allow npm dist-tag** [S33]. The factory has accounts only in Linear and GitHub (`docs/adr/0005-the-factory-acts-under-its-own-accounts.md`), so a Vercel rollback from the runner would need a new credential.
- **A rollback runbook has to undo the rollback too.** On Vercel, a rollback stops new production pushes from going live until someone runs `vercel promote` or **Undo Rollback** [S42]. Hobby can step back only one deployment [S42][S43]. On npm, the fix ships as a new version, because the old number is gone for good [S29].
- **Changesets already records breaking changes in machine-readable form.** The bump type sits in each `.changeset/*.md` file, and `changeset status --output <file>` writes the plan as JSON [S52]. A `breaking` label would duplicate it on Changesets repos. Plan's brief records which breaking changes the maintainer accepted, so launch can compare the two.
- **On a `0.x` package, "breaking" and "major" differ.** A breaking change there is a `minor` by convention. A `major` takes the package to 1.0.0, and `changeset add --major` or a hand-written file skips the prompt that would catch a mistake [S52]. A factory session that writes the file directly, or passes `--major`, never sees the prompt.
- **Setup has two npm traps.** A trusted-publisher configuration created after 2026-09-03 allows only `npm stage publish` unless setup changes it, and Changesets can't stage [S33][S50]. A brand-new package's first publish must be done by hand before trusted publishing applies [S49].
- **The Version Packages PR gets no CI by default.** The action opens it with `GITHUB_TOKEN`, which triggers no workflows [S50]. If the repo's ruleset requires checks, they never start on that PR unless the action gets a personal or App token, or someone starts the workflow by hand [S50].

## Sources

All sources were read on 2026-10-18. I read Linear's product docs through the MCP server's `search_documentation` tool and on the web. Local `gh` is 2.96.0.

Linear:

- [S1] Linear Docs, [Releases](https://linear.app/docs/releases). Linear's [sitemap](https://linear.app/sitemap.xml) has no other page about releases.
- [S2] Linear Changelog, [Releases](https://linear.app/changelog/2026-04-30-releases), 2026-04-30
- [S3] Linear Changelog, [Code Intelligence](https://linear.app/changelog/2026-05-14-code-intelligence), 2026-05-14: release fixes and backdating inputs
- [S4] Linear Changelog, [Agent assisted project updates](https://linear.app/changelog/2026-06-18-agent-assisted-project-updates), 2026-06-18: release pipeline changelogs
- [S5] Linear Changelog, [Initiative properties](https://linear.app/changelog/2026-07-02-initiative-properties), 2026-07-02: MCP support for releases
- [S6] Linear GraphQL schema, [`packages/sdk/src/schema.graphql`](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql) in `linear/linear`, last changed in commit `9dd2ed8` on 2026-10-15: `Release`, `ReleaseStage`, `ReleasePipeline`, `ReleaseNote`, `IssueToRelease`, `Issue.releases`, and the release mutations
- [S7] [`linear/linear-release`](https://github.com/linear/linear-release): README, `src/index.ts`, and `examples/`, at v0.18.0 (2026-09-15)
- [S8] [`linear/linear-release-action`](https://github.com/linear/linear-release-action): README
- [S9] Linear [Pricing](https://linear.app/pricing), read as HTML. The Releases row has a cross for Free and Basic, "15 pipelines" for Business, and "Unlimited" for Enterprise.
- [S10] Linear Developers, [OAuth 2.0 authentication](https://linear.app/developers/oauth-2-0-authentication)
- [S11] Linear Developers, [OAuth actor authorization](https://linear.app/developers/oauth-actor-authorization)
- [S12] The Linear MCP server's tool schemas, loaded in this session, and these read-only calls against campdotdev: `get_workspace`, `list_release_pipelines` and `list_releases` with archived items included (both empty), `list_issues`, and `get_issue` on FLD-21 and FLD-25

GitHub and Vercel's GitHub integration:

- [S13] GitHub REST, [Releases](https://docs.github.com/en/rest/releases/releases): list, latest, and generate release notes
- [S14] GitHub REST, [Best practices for using the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- [S15] GitHub REST, [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [S16] GitHub GraphQL, [Rate limits and query limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)
- [S17] GitHub REST, [Git tags](https://docs.github.com/en/rest/git/tags) and [List repository tags](https://docs.github.com/en/rest/repos/repos#list-repository-tags)
- [S18] GitHub REST, [Workflow runs](https://docs.github.com/en/rest/actions/workflow-runs)
- [S19] GitHub REST, [Deployments](https://docs.github.com/en/rest/deployments/deployments) and [Deployment statuses](https://docs.github.com/en/rest/deployments/statuses)
- [S20] GitHub Docs, [Control deployments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments) and [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [S21] GitHub REST, [Commits](https://docs.github.com/en/rest/commits/commits): compare two commits, and list pull requests associated with a commit
- [S22] GitHub REST, [Events](https://docs.github.com/en/rest/activity/events)
- [S23] `gh release list --help`, `gh release view --help`, `gh run list --help`, and `gh pr list --help` on `gh` 2.96.0
- [S24] Vercel Docs, [Deploying GitHub Projects with Vercel](https://vercel.com/docs/git/vercel-for-github), last updated 2026-09-17
- [S25] [`vercel/repository-dispatch` types](https://github.com/vercel/repository-dispatch/blob/main/packages/repository-dispatch/src/types.ts). Vercel Changelog, [Trigger GitHub Actions with enriched deployment data from Vercel](https://vercel.com/changelog/trigger-github-actions-with-enriched-deployment-data-from-vercel), 2025-04-07, and [Optionally disable deployment_status webhook events](https://vercel.com/changelog/optionally-disable-deployment_status-webhook-events-for-github-actions), 2025-05-01
- [S26] Read-only `gh` calls: on `changesets/changesets`, PR #2291, `commits/c9269c0/pulls`, workflow run 34857872778, deployment 6439661359 and its statuses, the compare `d7e4a2d...c9269c0`, the release `@changesets/cli@3.0.3`, and tag refs. On `changesets/action`, its tag refs. Deployments and statuses on `shadcn-ui/ui` and `vercel/ai-chatbot`. Two conditional `releases/latest` calls that returned 304.

npm:

- [S27] npm Docs, [`npm deprecate`](https://docs.npmjs.com/cli/v11/commands/npm-deprecate)
- [S28] npm Docs, [Deprecating and undeprecating packages or package versions](https://docs.npmjs.com/deprecating-and-undeprecating-packages-or-package-versions)
- [S29] npm Docs, [npm Unpublish Policy](https://docs.npmjs.com/policies/unpublish)
- [S30] npm Docs, [`npm unpublish`](https://docs.npmjs.com/cli/v12/commands/npm-unpublish)
- [S31] npm Docs, [Unpublishing packages from the registry](https://docs.npmjs.com/unpublishing-packages-from-the-registry)
- [S32] npm Docs, [`npm dist-tag`](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag)
- [S33] npm Docs, [Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers)
- [S34] GitHub Changelog, [npm trusted publishing with OIDC is generally available](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/), 2025-07-31
- [S35] GitHub Changelog, [Opt-in dist-tag permissions for npm trusted publishing](https://github.blog/changelog/2026-09-30-opt-in-dist-tag-permissions-for-npm-trusted-publishing), 2026-09-30
- [S36] GitHub Changelog, [npm security update: classic token creation disabled and granular token changes](https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes/), 2025-11-05
- [S37] GitHub Changelog, [npm classic tokens revoked, session-based auth and CLI token management now available](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/), 2025-12-09
- [S38] npm Docs, [Requiring 2FA for package publishing and settings modification](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification)
- [S39] npm Docs, [About two-factor authentication](https://docs.npmjs.com/about-two-factor-authentication)
- [S40] GitHub Changelog, [Staged publishing and new install-time controls for npm](https://github.blog/changelog/2026-05-22-staged-publishing-and-new-install-time-controls-for-npm), 2026-05-22
- [S41] `npm/cli` source at v12.2.1 (2026-10-15): `lib/commands/deprecate.js`, `unpublish.js`, `dist-tag.js`, and `publish.js`, and `workspaces/libnpmpublish/lib/unpublish.js`

Vercel:

- [S42] Vercel Docs, [Performing an Instant Rollback on a Deployment](https://vercel.com/docs/instant-rollback), last updated 2026-07-07
- [S43] Vercel Docs, [`vercel rollback`](https://vercel.com/docs/cli/rollback), last updated 2026-03-17
- [S44] Vercel REST API, [Point production traffic to a previous production deployment](https://vercel.com/docs/rest-api/projects/point-production-traffic-to-a-previous-production-deployment-by-id)
- [S45] Vercel Docs, [Deployment Retention](https://vercel.com/docs/deployment-retention), last updated 2026-09-16
- [S46] Vercel Changelog, [Hobby projects now retain fewer deployments to free up storage](https://vercel.com/changelog/hobby-projects-now-retain-fewer-deployments-to-free-up-storage), 2026-09-16
- [S47] Vercel Changelog, [Instant Rollback is now generally available](https://vercel.com/changelog/instant-rollback-is-now-available-to-revert-deployments), 2023-05-11
- [S48] Vercel Changelog, [Deployment Storage keeps your deployments rollback-ready](https://vercel.com/changelog/deployment-storage-keeps-your-deployments-rollback-ready), 2026-08-21

Changesets and semver:

- [S49] Changesets docs in [`site/`](https://github.com/changesets/changesets/tree/main/site) of `changesets/changesets` at `e2ee472` (2026-10-16), published at [changesets.dev](https://changesets.dev): `faq.md`, `guide/cli.md`, `guide/config.md`, `guide/versioning-and-publishing.md`, `guide/prereleases.md`, `guide/migration.md`, and `guide/technical-decisions.md`
- [S50] Changesets docs, [`site/guide/automating.md`](https://github.com/changesets/changesets/blob/main/site/guide/automating.md)
- [S51] Changesets blog, [Announcing Changesets v3](https://github.com/changesets/changesets/blob/main/site/blog/announcing-changesets-v3.md), 2026-08-11
- [S52] Changesets source at `e2ee472`: `packages/parse`, `packages/cli` (`commands/add`, `commands/status`, `utils/gitTags.ts`), `packages/assemble-release-plan` (`increment.ts`, `determine-dependents.ts`), `packages/apply-release-plan` (`get-changelog-entry.ts`), `packages/changelog-git`, and `packages/types`
- [S53] [`@changesets/changelog-github` README](https://github.com/changesets/changesets/blob/main/packages/changelog-github/README.md) and source
- [S54] [`changesets/action`](https://github.com/changesets/action) at `615034b` (2026-10-02): README, `action.yml`, `src/index.ts`, `src/run.ts`, `src/github.ts`, `src/utils.ts`, and `CHANGELOG.md`. Latest release v2.1.2, 2026-09-07.
- [S55] `npm/node-semver`: [`classes/semver.js`](https://github.com/npm/node-semver/blob/main/classes/semver.js) and the README section on caret ranges
- [S56] [Semantic Versioning 2.0.0](https://semver.org/), item 4
- [S57] Changesets [issue #954](https://github.com/changesets/changesets/issues/954), closed 2026-04-29, and [PR #2090](https://github.com/changesets/changesets/pull/2090), merged 2026-06-24
