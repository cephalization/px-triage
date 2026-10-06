---
"@cephalization/px-triage": minor
---

Agent-facing commands: `pxt queue`, `pxt next`, `pxt show <n>`, and
`pxt apply <n>` run the triage loop non-interactively with `--json` output,
ready-to-run command hints, dry runs, and provenance (`--actor`, `--session`).
`pxt skill` prints SKILL.md for agents. Agent decisions are stored as LLM
annotations and excluded from `pxt train` unless `--include-agents`.

Fixes: TypeSafe score answers are probability-weighted, so severity/value/risk
now route on the most likely level (priority labels were never applied before).
Comment templates take docs/community/contributing links from the repo config
instead of hard-coding Phoenix's.
