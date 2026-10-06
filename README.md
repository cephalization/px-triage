# px-triage

[![npm version](https://img.shields.io/npm/v/%40cephalization%2Fpx-triage?logo=npm&label=%40cephalization%2Fpx-triage)](https://www.npmjs.com/package/@cephalization/px-triage)
[![CI](https://github.com/cephalization/px-triage/actions/workflows/ci.yml/badge.svg)](https://github.com/cephalization/px-triage/actions/workflows/ci.yml)
[![Node 22.12+](https://img.shields.io/node/v/%40cephalization%2Fpx-triage)](https://nodejs.org)
[![license: MIT](https://img.shields.io/npm/l/%40cephalization%2Fpx-triage)](LICENSE)

A keyboard-driven CLI for triaging a GitHub repository's new issues and pull
requests. A decision model (TypeSafe Jev) reads each item and proposes the
next step; you confirm it with one key or override it. GitHub changes run in
the background, every decision is logged, and every classification is traced
to Phoenix.

## Quick start

```bash
npm install -g @cephalization/px-triage   # installs `px-triage` and the short alias `pxt`
cd your/repo && pxt                        # first run asks for a TypeSafe key (and, optionally, Phoenix)
```

Or without installing: `npx @cephalization/px-triage --help`. You need Node
22.12+, a [TypeSafe API key](https://console.typesafe.ai/keys), and GitHub auth
via `GITHUB_TOKEN` or a logged-in `gh`. The repository defaults to the git
`origin` of your current directory.

**The queue is a label.** px-triage works on issues and PRs that carry a
`triage` label, and removes it as each one is handled. Your repository needs
to apply that label to new items. `pxt automate`, run inside a checkout,
asks a few questions and writes `.github/workflows/triage-label.yml` to do it
(issues and PRs, skipping bots and the changesets release PR by default), then
offers to commit it on a branch and open a PR. A different label name can be
set with `--label` or per repo in the config.

Built with Effect 4 (`effect/cli`, `effect/http`) and the `@typesafe-ai/sdk`.

## The problem it solves

New issues and PRs land with a `triage` label and someone has to read each one
and decide: ask for more information, label it as a bug and find an owner,
accept it as a feature and schedule it, send a PR for review, or close it with
a kind explanation. Each decision is small, but there are many, and the reading
is the slow part. px-triage front-loads the reading and reduces each decision
to a keypress.

## How a session works

```
✔ repo profile  11 teammates · 82 labels 3ms
✔ github user   @you 274ms
✔ queue         26 items labeled "triage" 748ms

ISSUE #1234 [3/26]  [BUG]: Example page shows the wrong value when the input is empty
by some-contributor · opened 1d ago · 0 comments
  linked PRs: #1240 @maintainer-one maintainer  #1241 @drive-by-bot
  … body …
jev jev-1.13.0 · 412ms · 1830 tok
  category     bug_report ████████░░  84%   feature_request █░░░░░░░░░  9%
  component    ui ███████░░░  72%        language  typescript █████████░  91%
  reproducible █████████░  93%        in scope  ██████████  99%
  severity     level 1 (71% conf)
  → suggest Bug → label + assign
    labels  bug  c/ui  language: typescript  priority: medium
    owners  @maintainer-one @maintainer-two

  [Enter] accept   [m] accept, assign @you   [a] accept, choose assignee
  [i] Needs info   [b] Bug   [f] Feature   [c] Close   [s] Skip   [v] View   [o] Open   [q] Quit
```

1. **Load.** One light search fetches the queue's numbers. Item details and
   Jev classifications then stream in batches in the background while you read
   the first item. Items triaged in a previous run are dropped (GitHub's search
   index lags), and items you skipped move to the end.
2. **Classify.** Each item is one Jev request answering several questions at
   once: category, component, language, in-scope, enough-information,
   severity or value or review risk, agent-authored. Answers come back as
   probabilities with confidence, so you see how sure the model is.
3. **Suggest.** A pure planner turns the answers into a suggested action with
   labels, an owner or reviewer, and a one-line rationale. Low confidence is
   shown as uncertain and nothing is preselected.
4. **Act.** `Enter` applies the suggestion with sensible defaults. `m` does
   the same but assigns you. `a` lets you pick the person. A letter runs a
   guided flow (comment templates, label picker, `$EDITOR`).
5. **Apply.** GitHub mutations run in background fibers, report before the
   next prompt, and drain on exit. `--dry-run` prints them instead.

### Actions

| Key | Action | What it does on GitHub |
| --- | --- | --- |
| `i` | Needs information | Comment from a template, add `needs information`, remove `triage` |
| `b` | Bug | Add `bug`, component, language, and priority labels; assign an owner; remove `triage` |
| `f` | Feature | Add `enhancement`/`documentation` and component labels; choose now / backlog / roadmap; optionally assign |
| `r` | Review (PRs) | Add type and component labels; request reviewers from the roster and CODEOWNERS; remove `triage` |
| `c` | Close | Comment from a template, close as not planned, add `wontfix`/`duplicate`/`question`/… |

### Linked items

Issues attract drive-by PRs, often several from different people, and PRs
reference the issues they fix. When you act on an item that has open
closing-references, the action propagates. The first linked item is the one
authored by a maintainer if any, otherwise the oldest; the rest are closed as
duplicates of it with cross-referencing comments.

| You triage… | First linked item gets | Remaining links |
| --- | --- | --- |
| Issue as bug or feature | Same labels, review requested from the assignee, `triage` removed | Closed as duplicate of the first PR, with a comment referencing both |
| Issue as needs-info | Comment pointing at the issue, `needs information`, `triage` removed | Closed as duplicates |
| Issue closed | Closed with a comment referencing the issue | Closed as duplicates |
| PR sent for review | Issue gets the PR's labels and is assigned to the reviewer | Other issues closed as duplicates of the first |
| PR closed or needs-info | Nothing; a PR's fate says little about the issue | Nothing |

## Install

See the [quick start](#quick-start) above. `--repo owner/name` or the config
value override the detected repository.

### Developing

```bash
pnpm install
pnpm dev          # links `pxt` / `px-triage` onto your PATH and watch-compiles
pnpm triage       # or run the sources directly: Node strips the types itself
```

No transpiler in the loop: sources import `.ts` paths, Node runs them as is,
and `tsc` rewrites the extensions when building `dist` for the published
binary. `erasableSyntaxOnly` keeps the code within what Node can strip.

Releases use [changesets](.changeset/README.md): add one with `pnpm changeset`
in your PR; merging the generated "Version Packages" PR publishes to npm.

Onboarding writes `~/.px-triage/config.json` (mode 600) with your TypeSafe API
key, default repo, and optional Phoenix connection (URL, API key, project).
Phoenix powers tracing and training; without it both are skipped and the CLI
points at https://arize.com/docs/phoenix/environments.
GitHub auth comes from `GITHUB_TOKEN` / `GH_TOKEN` or `gh auth token`.

Per-repo settings live under `repos`, keyed by `owner/name`:

```json
"repos": {
  "owner/name": {
    "description": "One paragraph on what the project is. Jev sees this in every question.",
    "label": "triage"
  }
}
```

`description` is the single most useful thing to edit when suggestions feel
generic. For unknown repos it is seeded from the GitHub description and topics
on first use. Environment overrides: `TYPESAFE_API_KEY`, `PX_TRIAGE_MODEL`,
`PX_TRIAGE_REPO`, `PHOENIX_COLLECTOR_ENDPOINT`, `PHOENIX_API_KEY`,
`PHOENIX_PROJECT_NAME`, `PX_TRIAGE_HOME`.

## Commands

```bash
pxt                          # walk the queue
pxt --only prs --dry-run     # preview PR triage, change nothing
pxt --number 1234            # one item
pxt automate                 # write a workflow that labels new issues/PRs for triage; opens a PR
pxt roster                   # show the repo profile; --refresh regenerates it
pxt train                    # Phoenix dataset + experiment; report agreement and what was learned
pxt train --apply            # also write learned thresholds / policy / owners into the profile
pxt init                     # redo onboarding
pnpm test                    # unit tests for the planner and link propagation
```

**Repo profile.** Nothing about a repository is hard-coded. On first use, and
after 7 days, px-triage builds a profile from GitHub and caches it at
`~/.px-triage/profiles/`: all labels, which label maps to each classifier
component, who gets assigned and reviews what (from recent closed issues and
merged PRs, bots excluded), and CODEOWNERS teams per path.

**Training.** Phoenix is the training backend and the shared source of truth
for decisions; without it, `pxt train` only prints how to set one up
(https://arize.com/docs/phoenix/environments). Each decision anyone on the
team makes is recorded as a `HUMAN` annotation (`triage.human`) on the item's
classification span, tagged with the triager's login. `train` reads those
annotations back, so every teammate who runs `train --apply` converges on the
same learned settings. The local `~/.px-triage/decisions.jsonl` is only a
fallback for decisions that never reached Phoenix. `pxt train` then builds a Phoenix dataset
(`px-triage/<owner>/<name>`) from your decisions plus outcomes inferred from
already-triaged history, runs a Phoenix experiment that classifies every
example with the current questions and planner, evaluates action agreement and
owner hit-rate, and prints agreement, a confusion matrix, disagreements, and
what it learned: threshold overrides that beat the defaults, a per-category
action policy where you consistently chose differently, and owner picks per
component (self-assigns excluded). `pxt train --apply` writes those into the
repo profile and the planner uses them on the next run. Every experiment is
visible in Phoenix next to earlier ones, so editing `questions.ts` and
re-running is a measured A/B. Jev itself is not fine-tuned.

**Caching.** Classifications are cached per item, update time, model, and a
hash of the questions and project description, so reopening a session is
instant and editing the questions reclassifies.

## Tracing

Each item yields three Phoenix traces linked by a per-run `session.id`:
`triage.classify` (CHAIN) parenting the `TypeSafeClient.systemOne` `DECISION`
span with JSON input/output and `decision.*` model and token attributes per the
OpenInference decision-span spec; `triage.decide` (CHAIN) with the human's
choice; and `triage.apply` (CHAIN) with each GitHub mutation as a TOOL span.

## Where to look

- `src/classify/questions.ts` — every Jev question and threshold. Review this file.
- `src/triage/plan.ts` — answers → suggested action. `src/triage/links.ts` — propagation rules.
- `src/triage/templates.ts` — comment wording. `src/triage/roster.ts` — label aliases and owner ranking.
- `src/triage/session.ts` — the hotkey loop. `src/triage/profile.ts` — repo profile generation.
- `src/github/GitHub.ts` — GraphQL fetch and REST mutations. `src/tracing.ts` — Phoenix export.

## Why Effect's `effect/cli` rather than clack

Effect 4 ships a clack-style `Prompt` module in core, running on the
`Terminal` service, so prompts compose with every other effect and cancel
cleanly on Ctrl+C. Single-key triage uses `Terminal.readInput` directly.
