# How a local agent can put screenshots, videos, and preview links on a PR

Research for [FLD-6](https://linear.app/campdotdev/issue/FLD-6/how-can-a-local-agent-put-screenshots-videos-and-preview-links-on-a-pr). Every source was fetched on 2026-10-16. A claim marked **unconfirmed** has no primary source behind it. A claim marked **inference** follows from the sources but no source states it.

## Answer

A local agent can upload images and videos to a PR with the GitHub CLI. Since `gh` v2.99.0, released 2026-09-01, `gh pr create`, `gh pr edit`, and `gh pr comment` take a repeatable `--attach` flag. The flag uploads a local PNG, JPEG, GIF, WebP, SVG, MP4, MOV, or WebM file and writes the uploaded URL into the body. If the body already references the local path, `gh` rewrites that reference in place. Otherwise it appends the file at the end. A video reference that sits alone in its paragraph renders as a player.

The ticket's premise still holds for the HTTP API. GitHub's REST reference, its OpenAPI description, and its GraphQL schema have no upload operation. `gh` posts to `uploads.github.com/user-attachments/assets`, an endpoint GitHub does not document. The supported route is to run `gh`, not to call that endpoint.

`--attach` has limits that matter here:

- It needs write access to the repo and an OAuth token or personal access token. It refuses read and triage roles before sending anything.
- It works on GitHub.com and GitHub Enterprise Cloud, not on GitHub Enterprise Server.
- Images cap at 10 MB. Videos cap at 10 MB in a repo owned by a free-plan account and at 100 MB on a paid plan.
- In a private repo, only people with access to the repo can view the files. In a public repo, anyone can, without logging in.
- It takes images and video only. A Playwright trace `.zip` or HTML report needs another home.
- The Mac this research ran on has `gh` 2.96.0, which has no `--attach`.

The other options fall into three groups:

- **Other GitHub storage.** Commit the file to a branch and link it with a relative `../blob/<ref>/<path>?raw=true` path, or upload it as a release asset. Both work in a private repo for readers with read access.
- **Storage outside GitHub.** Linear uploads and protected preview sites need a login on that service. GitHub shows inline images through its Camo proxy, and Camo can't fetch an image that needs a login, so these work as links, not as inline images.
- **A live build.** Chromatic publishes a Storybook for every commit and branch. Vercel builds a preview site for every push or `vercel deploy`. Both are private by default and ask the reader to log in.

Playwright produces the evidence but does not host it. It writes screenshots, WebM videos, and trace `.zip` files to local disk, and one of the options below has to carry them to the reader.

## Options compared

| Option | What it is | Cost | How long the link lives | Reader must log in | Works for a private repo |
| --- | --- | --- | --- | --- | --- |
| `gh` with `--attach` | `gh` v2.99.0 or later uploads an image or video to GitHub and writes its URL into the PR body or comment. | Free on all plans. 10 MB per image. 10 MB per video on a free plan, 100 MB on a paid plan. | No documented expiry. **Unconfirmed.** | Public repo, no. Private repo, yes, with a GitHub account that has repo access. | Yes. Only people with repo access can view the files. |
| Commit to a branch | Commit the file, then embed it in the PR with `../blob/<ref>/<path>?raw=true`. | Free. Git warns at 50 MiB per file. GitHub blocks files over 100 MiB and recommends repos stay under 1 GB. | As long as `<ref>` exists. A link that names a branch breaks when the branch is deleted. **Inference.** A link that names a commit SHA outlives the branch. **Unconfirmed.** | Public repo, no. Private repo, yes, with read access. | Yes. GitHub documents this path for viewers with at least read access. |
| Release asset | `gh release upload <tag> <files>` attaches files to a release. Link to the asset's `browser_download_url`. | Free. Each file under 2 GiB. Up to 1,000 assets per release. No limit on total size or bandwidth. | Until someone deletes the asset or the release. No documented expiry. | Public repo, no. Private repo, yes, with read access. | Readers with read access can view releases. Whether an asset image renders inline in a private repo's PR is **unconfirmed**. |
| GitHub Actions artifact | A CI job uploads files with `actions/upload-artifact`. Only a workflow run can create one, so the local agent can't. | Not researched. | 90 days by default. Public repos allow 1 to 90 days, private repos 1 to 400. | **Unconfirmed.** | **Unconfirmed.** |
| Linear upload | The `fileUpload` mutation, or the Linear MCP tool `prepare_attachment_upload`, stores a file on `uploads.linear.app` and links it to an issue. | Free plan: 10 MB per file and 250 issues. Basic is $10 and Business is $16 per user per month, billed yearly, with no stated file limit. | No documented expiry. A signed URL lasts the number of seconds set in the `public-file-urls-expire-in` request header. | Yes, Linear auth. A signed URL works without login until it expires. | It isn't GitHub storage. Camo can't show it inline in a PR. |
| Linear link attachment | `attachmentCreate` links an external URL to an issue. It stores a link, not a file. | Included in every Linear plan. | As long as the target URL lives. | Whatever the target needs. | Depends on the target. |
| Chromatic Storybook | `npx chromatic --project-token <token>` builds the Storybook and publishes it. Permalinks are `https://<branch>--<appid>.chromatic.com` and `https://<commithash>--<appid>.chromatic.com`. | Free plan: 5,000 snapshots a month, unlimited projects and users. Starter is $179 a month. Whether a publish with no visual tests uses snapshots is **unconfirmed**. | No documented retention. **Unconfirmed.** | Private by default. The reader signs in to Chromatic with a profile that has project access. A project can be set public, and linked projects with public repos publish public Storybooks. | Yes. Chromatic syncs collaborators from the repo: `read` becomes Viewer and `write` becomes Developer. |
| Static Storybook on another host | `npm run build-storybook` writes a static site to `storybook-static` that any web host can serve. | Depends on the host. GitHub Pages allows one site per repo. | Depends on the host. | Depends on the host. GitHub Pages restricts access only on GitHub Enterprise Cloud. | Depends on the host. Which GitHub plans allow Pages for a private repo is **unconfirmed**. |
| Vercel preview | Vercel builds a preview for every push to a non-production branch, every PR, and every `vercel deploy` without `--prod`. `vercel deploy` prints the deployment URL on stdout. | Hobby is free and limited to non-commercial, personal use. Pro is $20 per developer seat per month, and viewer seats are free. Password Protection costs $20 per protected project per month on Pro. | Default preview retention is 30 days on Hobby and 180 days on Pro. The latest preview of a branch whose PR is still open is kept. A deleted deployment returns HTTP 410 and can be restored for 30 days. | Yes by default. Vercel Authentication has been on for new projects since 2023-11-02. A Shareable Link lets anyone in. Hobby allows one Shareable Link and one external user per account. | Yes. Vercel access is managed apart from GitHub access. |
| Any public URL | An image on a public host, embedded with `![alt](https://...)`. GitHub serves it through Camo. | Depends on the host. Not researched. | Depends on the host. | No. Camo can't show an image from a server that requires authentication. | Yes, but the file itself is public. |

## What Playwright produces

Playwright makes files. It hosts nothing.

- **Screenshots.** `page.screenshot({ path, fullPage: true })` captures the full scrollable page, and `locator.screenshot()` captures one element. `page.screenshot()` with no `path` returns a buffer.
- **Videos.** The `video` option takes `'off'`, `'on'`, `'retain-on-failure'`, or `'on-first-retry'`. Playwright saves each video when its browser context closes, under `test-results`. The recorder in `videoRecorder.ts` accepts only a `.webm` file name and encodes VP9 at 1 Mbit/s for the default 800x450 frame at 25 fps, scaling the bitrate up for larger or faster video. One minute at the default size comes to about 7.5 MB. **Inference** from the bitrate. GitHub recommends H.264 video for the widest browser support. `show: { actions }` draws each action on the video. The `Screencast` class, added in v1.59, records a page to a path and adds overlays and chapter titles.
- **Traces.** The `trace` option takes `'on-first-retry'`, `'on-all-retries'`, `'off'`, `'on'`, or `'retain-on-failure'`. A trace `.zip` holds a screencast film strip, DOM snapshots before and after each action, and every network request. `npx playwright show-trace <path or URL>` opens one. `trace.playwright.dev` opens one entirely in the browser and sends no data out. It accepts `?trace=<url>`, subject to CORS. Whether GitHub-hosted URLs pass that CORS check is **unconfirmed**.
- **HTML report.** The HTML reporter writes a self-contained `playwright-report` folder that any web server can serve. Attachments sit in `data/`, and `attachmentsBaseURL` points the report at attachments hosted elsewhere.

## Unconfirmed

- How long GitHub keeps a file uploaded with `--attach`, and whether deleting the comment or closing the PR deletes it.
- The exact URL format `--attach` returns. The `gh` source reads a `url` field from the response and nothing more.
- Whether GitHub renders a video player for a video stored in a branch or a release. GitHub documents the player only for uploaded attachments.
- Whether a release-asset image renders inline in a private repo's PR.
- Whether a branch link that names a commit SHA survives the branch being deleted.
- Chromatic retention, and whether a publish with no visual tests uses snapshots.
- Whether a GitHub Actions artifact download needs a login.
- Whether `trace.playwright.dev` can load a trace from a GitHub-hosted URL.
- The changelog lists WebP for `--attach`, but the "Attaching files" page doesn't list `.webp`.

## What this means for Flight Deck

These facts constrain the decision on what a factory PR shows the maintainer. They don't make it.

- `--attach` is the only way GitHub documents to put an image or video inline in a PR from a local machine without committing the file. It needs `gh` 2.99.0 or later. This Mac has 2.96.0, so the setup flow would have to check the version.
- An upload can't be undone, as the `gh` pull request that added it says. It runs as whoever `gh auth` is logged in as, which on the maintainer's Mac is the maintainer.
- `campdotdev/shaders` is a public repo. Anything attached to a dry-run PR there is readable without a login, and no source says closing the PR removes it.
- The `campdotdev` org is on GitHub's Team plan, so its repos take videos up to 100 MB. A repo owned by a free personal account takes 10 MB, which is roughly one minute of default Playwright video.
- Trace files and HTML reports can't go through `--attach`. They need a branch, a release, a CI artifact, or a static host, and the reader opens them in a separate viewer.
- Inline images render only from GitHub storage or a fully public URL. Evidence behind Vercel, Chromatic, or Linear auth reaches the PR as a link the reader clicks.
- In a private repo, every option needs a login. The GitHub options reuse the GitHub session the maintainer reviews with. Vercel and Chromatic each need the reader to hold an account with access on that service.
- Links age differently. By default Vercel deletes previews after 30 days on Hobby and 180 days on Pro, but it keeps the latest preview of a branch whose PR is still open. Actions artifacts default to 90 days. GitHub attachments, branch files, and release assets have no documented expiry.
- Vercel Hobby is for non-commercial, personal use. A commercial repo needs Pro.
- Vercel's Git integration builds a preview on push with no work from the agent. A `vercel deploy` from the Mac needs a linked project and a Vercel login, and the first deploy of a new project is always production.
- Linear finds preview links in a PR description on its own. It detects Vercel, Netlify, Cloudflare, and AWS Amplify previews automatically. Other hosts need a Markdown link whose label contains "Preview". Linear shows them on the issue and drops them after 30 days of PR inactivity.
- The Linear MCP server in this environment can upload a file under 2 GB to an issue. The signed upload URL expires after 60 seconds. On Linear's Free plan the limit is 10 MB per file. That evidence lands on the issue, not the PR.
- The kind of repo decides which evidence exists. A web app can have a preview site, screenshots, and video. A component library can have a published Storybook and story screenshots. A library with no UI has none of these, so its evidence is test output and the code itself.
- Committing evidence to the PR's own branch puts the files in the diff and, after merge, in the default branch. **Inference.** A separate branch keeps them out of both.

## Sources

All fetched 2026-10-16.

- GitHub Docs, [Attaching files](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files): supported types, size limits, private-repo visibility.
- GitHub Docs, [Attaching files with GitHub CLI](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli): `--attach` commands, in-place rewriting, the video player rule, push access.
- GitHub Changelog, [GitHub CLI: media in issues, pull requests, and comments](https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments): v2.99.0, formats, plans, limits.
- GitHub CLI [v2.99.0 release notes](https://github.com/cli/cli/releases/tag/v2.99.0) and [manual for `gh pr comment`](https://cli.github.com/manual/gh_pr_comment).
- `cli/cli` source: [`internal/attachments/client.go`](https://github.com/cli/cli/blob/trunk/internal/attachments/client.go) and `internal/ghinstance/host.go` for the endpoint, token types, and permission check. [PR #14180](https://github.com/cli/cli/pull/14180) for "an upload cannot be undone".
- GitHub REST, [Create an issue comment](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment): `body` is the only body parameter.
- GitHub [REST OpenAPI description](https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json): no `/user-attachments` path.
- GitHub GraphQL schema, introspected with `gh api graphql`: no upload mutation, and `AddCommentInput` has only `subjectId`, `body`, and `clientMutationId`.
- GitHub Docs, [Basic writing and formatting syntax](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax): relative image links in PRs and private-repo access.
- GitHub Docs, [About anonymized URLs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-anonymized-urls): Camo, and images that need authentication.
- GitHub Docs, [About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases) and [Release assets REST](https://docs.github.com/en/rest/releases/assets).
- GitHub Docs, [About large files on GitHub](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github).
- GitHub Docs, [Managing GitHub Actions settings for a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository): artifact retention.
- GitHub Docs, [What is GitHub Pages?](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) and [Changing the visibility of your GitHub Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/changing-the-visibility-of-your-github-pages-site).
- Playwright Docs: [Videos](https://playwright.dev/docs/videos), [Trace viewer](https://playwright.dev/docs/trace-viewer), [Screenshots](https://playwright.dev/docs/screenshots), [Reporters](https://playwright.dev/docs/test-reporters#html-reporter), [`browser.newContext` `recordVideo`](https://playwright.dev/docs/api/class-browser#browser-new-context-option-record-video), [Screencast](https://playwright.dev/docs/api/class-screencast).
- Playwright source, [`videoRecorder.ts`](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/videoRecorder.ts): `.webm` only, VP9 settings.
- Storybook Docs, [Publish Storybook](https://storybook.js.org/docs/sharing/publish-storybook).
- Chromatic Docs: [Permalinks](https://www.chromatic.com/docs/permalinks/), [Publish](https://www.chromatic.com/docs/publish/), [Collaborators](https://www.chromatic.com/docs/collaborators/), [CLI](https://www.chromatic.com/docs/cli/), and [Pricing](https://www.chromatic.com/pricing).
- Vercel Docs: [Deployment Protection](https://vercel.com/docs/deployment-protection), [Vercel Authentication](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication), [Sharable Links](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/sharable-links), [Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation), [Deployment Retention](https://vercel.com/docs/deployment-retention), [Environments](https://vercel.com/docs/deployments/environments), [`vercel deploy`](https://vercel.com/docs/cli/deploy), and [Hobby plan](https://vercel.com/docs/plans/hobby).
- Vercel Changelog, [Deployment Protection is now enabled by default for new projects](https://vercel.com/changelog/deployment-protection-is-now-enabled-by-default-for-new-projects), dated 2023-11-02.
- Linear Developers: [How to upload a file to Linear](https://linear.app/developers/how-to-upload-a-file-to-linear), [File storage authentication](https://linear.app/developers/file-storage-authentication), and [Attachments](https://linear.app/developers/attachments).
- Linear Docs, [GitHub integration](https://linear.app/docs/github): preview-link detection. Linear [pricing](https://linear.app/pricing).
- Linear MCP tool descriptions for `prepare_attachment_upload` and `create_attachment_from_upload`, read in this session.
- Local checks: `gh --version` reports 2.96.0. `gh repo view campdotdev/shaders` reports `PUBLIC`. `gh api orgs/campdotdev` reports plan `team`.
