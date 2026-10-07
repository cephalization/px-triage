/** Agent-facing instructions, printed by `pxt skill`. Keep in sync with the commands. */
export const SKILL_MD = `---
name: px-triage
description: Triage a GitHub repository's new issues and pull requests with px-triage. Use when asked to work through a triage queue, label/assign/close new issues, or route PRs to reviewers. Each step is one \`pxt\` command that prints JSON.
---

# px-triage for agents

px-triage keeps a queue: every issue or PR carrying the repo's queue label
(default \`triage\`). A decision model (TypeSafe Jev) reads each item and
proposes a next step. Your job is to review the suggestion, decide, and apply.
Applying removes the item from the queue.

Run every command with \`--json\`. Output has \`schema: 1\`. Errors are JSON on
stderr. Exit codes: 0 ok, 1 failure, 2 usage, 3 queue empty.

## The loop

\`\`\`
pxt next --json                      # head of the queue, fully described; exit 3 when empty
pxt apply <number> --accept --json   # take the suggestion with defaults
\`\`\`

Repeat until \`next\` exits 3. Pass \`--repo owner/name\` when not inside a
checkout of the repository. Set \`PX_TRIAGE_SESSION\` (or \`--session\`) to one
value for the whole loop so traces group in Phoenix.

## Reading an item

\`pxt show <number> --json\` (or \`next\`) returns:

- \`body\`, \`commentsText\`, \`pr.files\`: read these before deciding.
- \`suggestion\`: \`action\`, \`uncertain\`, \`confidence\`, \`category\`,
  \`rationale\`, proposed \`labels\`, ranked \`owners\`, \`reviewers\`.
- \`acceptPreview\`: exactly what \`--accept\` would do, including
  \`propagations\` to linked items.
- \`commands\`: ready-to-run \`pxt apply\` lines for every valid action. Prefer
  copying these over composing flags.

When \`suggestion.uncertain\` is true, \`--accept\` is refused; choose
\`--action\` yourself after reading the item.

## Actions

| action | meaning | GitHub effect |
| --- | --- | --- |
| \`needs-info\` | Not enough to act on | Comment (template or \`--comment\`), add needs-information label, remove queue label |
| \`bug\` (issues) | Real defect | Add bug + component/language/priority labels, assign \`--assign\` / \`--assign-me\` / suggested owner, remove queue label |
| \`feature\` (issues) | Valid request | Add enhancement + component labels; \`--when now\` assigns, \`backlog\`/\`roadmap\` label instead |
| \`review\` (PRs) | Ready for maintainers | Add labels, request \`--reviewer\` or suggested reviewer, remove queue label |
| \`close\` | Not moving forward | Comment (template or \`--comment\`), close as not planned, add wontfix/duplicate/question label |
| \`skip\` | Decide later | Nothing on GitHub; moves to the back of the queue |

Templates: \`needs-info\` → repro, logs, clarify-feature, pr-description.
\`close\` → support, out-of-scope, third-party, duplicate, cannot-reproduce,
spam, pr-not-accepted, pr-superseded. Templates containing \`#NNN\` require
\`--comment\` with the real number.

## Linked items

Issues often have PRs that close them and vice versa. Applying an action
propagates: the first linked item (maintainer-authored first, else oldest)
gets the equivalent action; the rest are closed as duplicates with
cross-references. \`acceptPreview.propagations\` shows this. Pass
\`--no-propagate\` to act on the one item only.

## Rules of thumb

- Read the body before accepting. The suggestion is a prior, not a verdict.
- Prefer \`needs-info\` over \`close\` when a human could plausibly add detail.
- Never close an issue because its PR was rejected; the issue stands alone.
- Use \`--dry-run\` first on anything you are unsure about; it prints the plan
  without touching GitHub.
- Your decisions are recorded as agent decisions (not human) in Phoenix and
  are excluded from training by default.
`
