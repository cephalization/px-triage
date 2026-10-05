# Changesets

Every PR that changes behavior adds a changeset: run `pnpm changeset`, pick
patch / minor / major, and write the note users will read in the CHANGELOG.
Pure refactors can run `pnpm changeset --empty`.

On merge to `main`, the release workflow opens or updates a "Version Packages"
PR. Merging that PR publishes `@cephalization/px-triage` to npm and tags the
release.

## Approving a staged publish

npm routes CI publishes made with a stage-only token into its staged
publishing queue: the version is not live until a maintainer approves it with
2FA. The workflow log still reads "Successfully published". To go live:

```bash
npm login                                   # if your local token has expired
npm stage list @cephalization/px-triage     # find the stage id
npm stage view <stage-id>                   # optional: inspect what CI built
npm stage approve <stage-id>                # prompts for 2FA
```

The same approval is available under "Staged Packages" on npmjs.com. Until a
new package is approved, npm serves a public `0.0.0-stage` placeholder, which
is why `npx` may report "could not determine executable to run".
