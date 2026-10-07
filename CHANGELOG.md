# @cephalization/px-triage

## 0.4.0

### Minor Changes

- [#12](https://github.com/cephalization/px-triage/pull/12) [`28b2f42`](https://github.com/cephalization/px-triage/commit/28b2f42765400bb4c46713d74b603a7683442384) Thanks [@cephalization](https://github.com/cephalization)! - New `pxt team` mode: what should I work on or unblock next, strictly from my
  team. Open items from teammates are bucketed by what they are waiting on
  (review requested from you, assigned to you, author pushed after changes were
  requested, PR with no reviewer, approved but unmerged, failing checks, issue
  with no owner) and walked with hotkeys: open, take, nudge, done-until-it-changes.
  `--json` lists the same for agents. `--mine` narrows to your own plate. Bot comments (preview deployments,
  CI apps) are hidden from the item card preview.

### Patch Changes

- [#12](https://github.com/cephalization/px-triage/pull/12) [`28b2f42`](https://github.com/cephalization/px-triage/commit/28b2f42765400bb4c46713d74b603a7683442384) Thanks [@cephalization](https://github.com/cephalization)! - Use the official `@arizeai/openinference-instrumentation-typesafe` (0.4.3,
  now published with the `decision.*` conventions) for Jev spans instead of a
  hand-rolled wrapper. Span shape is unchanged.

## 0.3.0

### Minor Changes

- [#8](https://github.com/cephalization/px-triage/pull/8) [`44d86c1`](https://github.com/cephalization/px-triage/commit/44d86c14c53360b6d0076b677a26aa0095b4aa3d) Thanks [@cephalization](https://github.com/cephalization)! - Agent-facing commands: `pxt queue`, `pxt next`, `pxt show <n>`, and
  `pxt apply <n>` run the triage loop non-interactively with `--json` output,
  ready-to-run command hints, dry runs, and provenance (`--actor`, `--session`).
  `pxt skill` prints SKILL.md for agents. Agent decisions are stored as LLM
  annotations and excluded from `pxt train` unless `--include-agents`.
  
  Fixes: TypeSafe score answers are probability-weighted, so severity/value/risk
  now route on the most likely level (priority labels were never applied before).
  Comment templates take docs/community/contributing links from the repo config
  instead of hard-coding Phoenix's.

### Patch Changes

- [#9](https://github.com/cephalization/px-triage/pull/9) [`85e1017`](https://github.com/cephalization/px-triage/commit/85e10175113e4cc6b4f1074601d4c4cbd4d02d05) Thanks [@cephalization](https://github.com/cephalization)! - Phoenix traces are easier to read: GitHub TOOL spans record what they were
  asked to do and what came back, `triage.apply` records its result, and
  `triage.decide` records skip/quit/cancel outcomes. `pxt train` no longer
  leaks experiment task spans into the triage project, and the experiment task
  is named `triageWithCurrentQuestions` instead of `task`.

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
