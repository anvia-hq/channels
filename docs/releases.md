# Releases and recovery

The five public packages version independently through Changesets. `.changeset/config.json` keeps
`fixed` and `linked` empty, leaves private packages unversioned, and sets
`updateInternalDependencies` to `patch`. Public packages depend on each other with `workspace:*`,
so each package still gets its own version and changelog when its changesets (or a dependency
release) require one.

`.github/workflows/version-packages.yml` opens or updates the version pull request when changesets
land on `main`. Publication runs only through `.github/workflows/release.yml` dispatched from
current `main`. Release retains the `npmjs` GitHub environment and `id-token: write` for npm
Trusted Publishing; do not introduce npm write tokens. The version workflow does not set a publish
command, does not use the `npmjs` environment, and does not request `id-token`.

## Version pull request

On every push to `main`, the version workflow runs `changesets/action` in version mode only
(`version-script: pnpm version-packages`, no `publish-script`). When non-empty changesets are
present, the action opens or updates a pull request titled **Version Packages** from
`changeset-release/main` into `main`. A later push that still contains changesets updates that
same pull request. A push with no changesets, including the merge of the version pull request,
exits without publishing. Empty changesets do not open a pull request.

`pnpm version-packages` is the command the action runs before it commits:

1. `changeset version` bumps each affected package, writes its changelog, and removes consumed
   changesets. Changesets' own `commit` option stays `false`, so this step does not create a
   commit and does not add a `[skip ci]` trailer. The action commits afterwards with the message
   `Version Packages`.
2. `pnpm format` runs Oxfmt so generated changelogs and package manifests satisfy `pnpm check`.
3. `pnpm install --lockfile-only` refreshes `pnpm-lock.yaml` from those manifests, and
   `pnpm install --frozen-lockfile` confirms the lockfile matches. Workspace `link:` entries often
   stay unchanged because internal dependencies use `workspace:*`; the refresh still runs so a
   `patch` range update cannot leave CI's frozen install inconsistent.
4. `pnpm check` repeats the formatting and lint gate on the tree the pull request will commit.

Merging the pull request puts those versions and changelogs on `main` and drops the consumed
changesets. That merge does not publish to npm, push `<package-name>@<version>` tags, or create
GitHub releases. Dispatch Release only after that merge is current `main`.

Pull requests and branch pushes created with the default `GITHUB_TOKEN` do not start other
workflows. GitHub does this to avoid recursive workflow runs, and `workflow_dispatch` is the
exception. The Version Packages pull request therefore does not get a CI run when the action
creates or updates it. The version job has already run `pnpm check` and a frozen install on the
committed files. To attach CI to that pull request, close and reopen it, or push a follow-up
commit: either action is a human `pull_request` event (`reopened` or `synchronize`), and CI
listens for `pull_request`. Automatic CI on every bot update needs a GitHub App or personal access
token passed to the action's `github-token` input. This workflow uses the default token and does
not require that secret. Keep `[skip ci]` out of the version commit so a later CI run is not
skipped.

The workflow can open the pull request only when the repository allows GitHub Actions to create
pull requests (Settings → Actions → General). This document does not assert that setting.

## Before dispatch

1. Merge the Version Packages pull request so current `main` contains the bumped package versions
   and changelogs.
2. Run `pnpm verify:release` and inspect generated package tarballs with `pnpm -r pack --dry-run`.
3. Record dated results in [live verification](./live-verification.md), including unresolved gaps.
4. Confirm npm trusted publishers reference repository `anvia-hq/channels`, workflow `release.yml`,
   and environment `npmjs`. The environment must permit the `main` dispatch branch. Reviewers and
   protection rules are configured on GitHub; this document does not assert their current settings.
5. Dispatch **Actions → Release → Run workflow** on `main`. The workflow refuses other branches
   and a commit that is no longer current main, then repeats the offline gate.

The release script is CI-only in execution mode. `node scripts/release-packages.mjs --plan` reads
npm and local tags without publishing, tagging, pushing, or creating GitHub releases. Only run it
when assessing a release; the fixture tests need no network.

## Package tags

Each version released from the dispatch commit gets `<package-name>@<version>`, for example
`@anvia/channel-agent@0.4.1`. It also gets a GitHub release with that tag. Unchanged historical package
versions are skipped. Legacy repository `v*` tags and releases remain intact.

Before any publication, all target tags are checked for conflicting commits. `pnpm -r publish`
skips versions already on npm and publishes missing versions in workspace dependency order, with
provenance. Existing matching tags are pushed idempotently and existing GitHub releases are skipped.
Conflicts stop the workflow; tags are never moved or force-pushed.

## Partial success and retries

A failed workflow can already have published some packages. Check npm and the workflow log before
retrying; do not bump versions merely to rerun a failed GitHub step. If the failed dispatch revision
is still current main, rerun that workflow revision. Published metadata whose `gitHead` matches the
dispatch commit is eligible for missing package tags/releases without being republished. Because
npm metadata may omit `gitHead`, the workflow also persists its pre-publication package list and
revision as the `channels-release-plan` artifact before any upload. Reruns restore that same run's
plan and can finish its publications even without `gitHead`. A tag push or GitHub release failure
can therefore be completed on a retry.

If npm metadata is not yet visible, the workflow stops before tagging; retry after visibility. If
main has advanced, or the original run's artifact is expired/missing and npm has no `gitHead`, do
not infer which commit a version came from. Retry attempts without an artifact stop for recovery;
restore verified publication/provenance evidence in a separately reviewed change. A fresh dispatch
has a different run ID and cannot substitute for a rerun when metadata is absent. Missing historical
tags are not automatically assigned to a new commit. Never reuse a legacy `v*` tag for
an independently versioned package.

The release fixture suite covers an agent-only patch, partial npm success, retries after tagging,
existing releases, conflicting tags, registry failure, private-package exclusion, and delayed npm
visibility. It makes no publication or GitHub calls.
