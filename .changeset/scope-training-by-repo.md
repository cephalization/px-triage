---
"@cephalization/px-triage": patch
---

Scope training data by repository when several repos share one Phoenix
project: decisions read back from Phoenix are filtered to the repo being
trained, and the repository sent to Jev is taken from each item instead of
being hard-coded.
