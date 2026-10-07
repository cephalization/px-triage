# @cephalization/px-triage

## 0.2.0

### Minor Changes

- [`d95c538`](https://github.com/cephalization/px-triage/commit/d95c5388f683d17bb71701234a9879185e6ea92e) Thanks [@cephalization](https://github.com/cephalization)! - New `pxt automate` command: asks how new issues and PRs should enter the
  triage queue, writes `.github/workflows/triage-label.yml` into the current
  repository (skipping bots and the changesets release PR by default), and
  optionally commits it on a branch and opens a pull request.

### Patch Changes

- [`2aac4e9`](https://github.com/cephalization/px-triage/commit/2aac4e9563c0a841b47309db6557f16990e01543) Thanks [@cephalization](https://github.com/cephalization)! - When the queue is empty, hint at `pxt automate`, and warn when the repository
  has no queue label at all.

- [`b12ccf8`](https://github.com/cephalization/px-triage/commit/b12ccf8ebf60c14ca8809231d9f27b02b91daa52) Thanks [@cephalization](https://github.com/cephalization)! - The current directory's git `origin` now takes precedence over the repository
  saved in the config, so running `pxt` inside another checkout triages that
  repository. The config value is only a fallback outside a GitHub checkout.

## 0.1.2

### Patch Changes

- [`a2ca753`](https://github.com/cephalization/px-triage/commit/a2ca753cc0faf67d8e0ae2b4015fd6148797ddce) Thanks [@cephalization](https://github.com/cephalization)! - Scope training data by repository when several repos share one Phoenix
  project: decisions read back from Phoenix are filtered to the repo being
  trained, and the repository sent to Jev is taken from each item instead of
  being hard-coded.

## 0.1.1

### Patch Changes

- [`a480e23`](https://github.com/cephalization/px-triage/commit/a480e234b4c79cf258923d5277ae4ccb890b1b77) Thanks [@cephalization](https://github.com/cephalization)! - README: add npm, CI, Node, and license badges plus an installation quick start
  at the top, so the npm page shows how to install and run the tool. Document
  that the queue is the `triage` label, which the repository must apply to new
  issues and PRs (manually or via automation).

## 0.1.0

### Minor Changes

- [`26e2a83`](https://github.com/cephalization/px-triage/commit/26e2a832010ff799c7deab79b4b7bb8b58a01f33) Thanks [@cephalization](https://github.com/cephalization)! - Initial release: keyboard-driven GitHub issue and PR triage with TypeSafe Jev
  suggestions, linked-item propagation, per-repo profiles, and Phoenix-backed
  tracing and training.
