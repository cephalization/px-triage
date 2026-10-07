---
"@cephalization/px-triage": patch
---

Phoenix traces are easier to read: GitHub TOOL spans record what they were
asked to do and what came back, `triage.apply` records its result, and
`triage.decide` records skip/quit/cancel outcomes. `pxt train` no longer
leaks experiment task spans into the triage project, and the experiment task
is named `triageWithCurrentQuestions` instead of `task`.
