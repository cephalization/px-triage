# px-triage

Absurdly fast triage for `arize-ai/phoenix` issues and pull requests.
Built with **Effect 4** (`effect/cli`, `effect/http`, `effect/observability`)
and **TypeSafe Jev** for the judgement calls.

```
ISSUE #16760 [3/26]  [BUG]: compare page shows +0% when the change is undefined
by 4ktLuffy · opened 1d ago · 0 comments
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
    owners  @cephalization @mikeldking @rickarize

  [Enter] accept suggestion   [i] Needs information   [b] Bug   [f] Feature   [c] Close   [s] Skip   [v] View markdown   [o] Open in browser   [q] Quit
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
6. Every decision (suggested vs chosen) is appended to
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

Environment overrides: `TYPESAFE_API_KEY`, `PX_TRIAGE_MODEL`, `PX_TRIAGE_REPO`,
`PHOENIX_COLLECTOR_ENDPOINT`, `PHOENIX_API_KEY`, `PHOENIX_PROJECT_NAME`,
`PX_TRIAGE_HOME` (config directory).

## Commands

```bash
pnpm triage                          # walk the queue
pnpm triage -- --only prs --dry-run  # preview PR triage, change nothing
pnpm triage -- --number 16760        # one item
pnpm triage -- train --limit 200     # replay history, report agreement
pnpm triage -- init                  # redo onboarding
pnpm test                            # planner unit tests
```

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
- `src/triage/roster.ts` — who owns what; label and CODEOWNERS mappings.
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
