# Changesets

Every PR that changes behavior adds a changeset: run `pnpm changeset`, pick
patch / minor / major, and write the note users will read in the CHANGELOG.
Pure refactors can run `pnpm changeset --empty`.

On merge to `main`, the release workflow opens or updates a "Version Packages"
PR. Merging that PR publishes `@cephalization/px-triage` to npm and tags the
release.

## After a publish

New packages and versions can take a few minutes to appear on the public
registry; a 404 right after the workflow finishes is propagation, not failure.
If the publishing token only has stage-publish rights, the version instead
waits in npm's staged-publishing queue until a maintainer approves it with
2FA (`npm stage list` / `npm stage approve`, or the "Staged Packages" tab on
npmjs.com).
