# px-triage

Absurdly fast triage for `arize-ai/phoenix` issues and pull requests.
Built with **Effect 4** (`effect/cli`, `effect/http`, `effect/observability`)
and **TypeSafe Jev** for the judgement calls.

```
ISSUE #1234 [3/26]  [BUG]: Example page shows the wrong value when the input is empty
by some-contributor · opened 1d ago · 0 comments
 triage
────────────────────────────────────────────────────────────────────────────
  ### Where do you use Phoenix …
────────────────────────────────────────────────────────────────────────────
jev jev-1.13.0 · 412ms · 1830 tok
  category     bug_report ████████░░  84%   feature_request █░░░░░░░░░  9%
               confidence ████████░░  81%
  component    ui ███████░░░  72%   experiments ██░░░░░░░░  18%
  language     typescript █████████░  91%
  reproducible █████████░  93%   in scope  ██████████  99%
  severity     level 1 (71% conf) A workflow is blocked or results are wrong…
────────────────────────────────────────────────────────────────────────────
  → suggest Bug → label + assign
    · severity level 1 (71% confident)
    labels  bug  c/ui  language: typescript  priority: medium
    owners  @maintainer-one @maintainer-two @maintainer-three

  [Enter] accept suggestion   [m] accept, assign @you   [a] accept, choose assignee   [i] Needs information   [b] Bug   [f] Feature   [c] Close   [s] Skip   [v] View markdown   [o] Open in browser   [q] Quit
```

## How it works

1. **One GraphQL call** pulls the whole `triage` queue (issues + PRs, bodies,
   comments, changed files, linked issues, check status).
2. **Every item is classified immediately and concurrently** with one
   TypeSafe `systemOne` request each (speculative fan-out: category,
   component, language, in-scope, reproducible/described, severity/value/risk,
   agent-authored). By the time you reach an item, its answer is usually there.
3. The **planner** (`src/triage/plan.ts`, pure, unit-tested) turns the answers
   into a suggested next step with labels, owner, reviewers, and a rationale,
   using the thresholds in `src/classify/questions.ts`.
4. You press **Enter** to accept with sensible defaults, or a letter to run the
   guided flow (templates, label multi-select, owner autocomplete, `$EDITOR`).
5. **GitHub mutations run in background fibers**; results are printed before
   the next prompt and drained before exit. `--dry-run` prints them instead.
6. On boot, items that already have a logged decision are re-checked against
   live labels and dropped if `triage` is gone (GitHub's search index lags by
   minutes), and items you skipped move to the end of the queue.
7. Every decision (suggested vs chosen) is appended to
   `~/.px-triage/decisions.jsonl`, and each item is traced to **Phoenix** as an
   OpenInference `CHAIN` span containing the Jev `LLM` span (input state,
   output answers, token counts).

### The triage workflow it encodes

| Step | Key | What happens |
| --- | --- | --- |
| Needs more info | `i` | Pick/edit a template, comment, add `needs information`, remove `triage` |
| Bug | `b` | Add `bug` + `c/*` + `language:` + `priority:` labels, assign an owner, remove `triage` |
| Feature | `f` | Add `enhancement`/`documentation` + `c/*`, choose now / `backlog` / `roadmap`, optionally assign |
| PR ready for review | `r` | Add type/component labels, request reviewers (roster + CODEOWNERS teams), remove `triage` |
| Not moving forward | `c` | Pick/edit a thank-you template, comment, close as not planned, add `wontfix`/`duplicate`/`question`/… |

`Enter` applies the suggestion with defaults: default template for the detected
category, top-ranked owner, first suggested reviewer, `backlog` for
non-high-value features. Templates with a `#NNN` placeholder open `$EDITOR`.

## Setup

```bash
pnpm install
pnpm triage            # first run → onboarding writes ~/.px-triage/config.json
```

Onboarding asks for the TypeSafe API key (https://console.typesafe.ai/keys),
the default repo, and optional Phoenix tracing (URL, API key, project name).
GitHub auth comes from `GITHUB_TOKEN` / `GH_TOKEN` or `gh auth token`.

Per-repo settings live under `repos` in the same file, keyed by `owner/name`:

```json
"repos": {
  "arize-ai/phoenix": {
    "description": "Arize Phoenix is an open-source LLM observability and evaluation platform: …",
    "label": "triage"
  }
}
```

`description` is the project context Jev sees in every question, so it is the
single most useful thing to edit when suggestions feel generic. Onboarding asks
for it; for any other repo it is seeded from the GitHub description, topics,
and primary language on first use. Changing it invalidates the classification
cache for that repo.

Environment overrides: `TYPESAFE_API_KEY`, `PX_TRIAGE_MODEL`, `PX_TRIAGE_REPO`,
`PHOENIX_COLLECTOR_ENDPOINT`, `PHOENIX_API_KEY`, `PHOENIX_PROJECT_NAME`,
`PX_TRIAGE_HOME` (config directory).

## Commands

```bash
pnpm triage                          # walk the queue
pnpm triage -- --only prs --dry-run  # preview PR triage, change nothing
pnpm triage -- --number 1234         # one item
pnpm triage -- train --limit 200     # replay history, report agreement
pnpm triage -- roster --refresh      # regenerate the repo profile (owners, labels)
pnpm triage -- init                  # redo onboarding
pnpm test                            # planner unit tests
```

### `roster`

Nothing about a repository is hard-coded. On first use (and again after 7
days, or with `pxt roster --refresh`) px-triage builds a **repo profile** from
GitHub and caches it at `~/.px-triage/profiles/<owner>-<name>.json`:

- all labels with colors, and which label maps to each classifier component
  (`c/ui` → `ui`, `documentation` → `docs`, …; aliases live in `roster.ts`)
- teammates inferred from the last ~250 closed issues and ~150 merged PRs:
  who gets assigned what, who reviews what, which languages they touch
- CODEOWNERS teams per path prefix, used to suggest PR reviewers

`pxt roster` prints it; `pxt roster --json` dumps the raw profile. Bots are
filtered out. If a repo spells a label differently, add it to the alias tables.

### `train`

Fetches items that have already left the queue, infers what humans did from
their final state and labels (`needs information` → needs_info, closed
not-planned/`wontfix`/`duplicate`/`question` → close, `bug` → bug,
`enhancement`/`documentation` → feature, merged/reviewed PR → review),
classifies them with Jev, and prints:

- agreement, a confusion matrix, per-action precision/recall
- a **threshold sweep** showing what each knob in `THRESHOLDS` would do
- the most confident disagreements (the issues to look at when editing questions)
- live acceptance rate from `decisions.jsonl` and the most common overrides

The raw run is saved to `~/.px-triage/training/<timestamp>.json`. Ground
truth is noisy (labels get added after triage), so treat it as a disagreement
finder, not a benchmark. Jev isn't fine-tuned per account: the loop improves by
editing `questions.ts` (instructions, criteria, thresholds) and re-running.

## Where to look

- `src/classify/questions.ts` — every Jev question and threshold. **Review this file.**
- `src/triage/profile.ts` — generates and caches the per-repo profile (labels, owners, reviewers, CODEOWNERS).
- `src/triage/roster.ts` — alias tables mapping a repo's labels onto the classifier's component/language keys, plus owner ranking.
- `src/triage/templates.ts` — comment templates.
- `src/triage/plan.ts` — routing logic (`suggestPlan`), tests in `plan.test.ts`.
- `src/triage/session.ts` — the hotkey loop, quick-accept defaults, guided flows.
- `src/github/GitHub.ts` — GraphQL fetch + REST mutations via `effect/http`.
- `src/ui/` — ANSI helpers, markdown renderer, pager, keypress reader, card renderer.
- `src/tracing.ts` — Phoenix OTLP export.

## Why Effect 4's `effect/cli` instead of clack

Effect 4 folded `@effect/cli` into core as `effect/cli` and ships a clack-style
`Prompt` module (Select, MultiSelect, AutoComplete, Confirm, Text, Password…)
that runs on the `Terminal` service, so prompts compose with every other
effect, cancel cleanly on Ctrl+C (`QuitError`), and can be tested with a fake
terminal. `@clack/prompts` still works if wrapped in `Effect.tryPromise`, but
you lose that integration. Single-key triage uses `Terminal.readInput`
directly (`src/ui/keys.ts`).
