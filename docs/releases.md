# Releases and recovery

The five public packages version independently through Changesets. Publication runs only through
`.github/workflows/release.yml` dispatched from current `main`. It retains the `npmjs` GitHub
environment and `id-token: write` for npm Trusted Publishing; do not introduce npm write tokens.

## Before dispatch

1. Review the package changes and their changesets, then merge the version state.
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
