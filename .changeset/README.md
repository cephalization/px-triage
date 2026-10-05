# Changesets

Every PR that changes behavior adds a changeset: run `pnpm changeset`, pick
patch / minor / major, and write the note users will read in the CHANGELOG.
Pure refactors can run `pnpm changeset --empty`.

On merge to `main`, the release workflow opens or updates a "Version Packages"
PR. Merging that PR publishes `@cephalization/px-triage` to npm and tags the
release.
