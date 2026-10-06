---
"@cephalization/px-triage": minor
---

New `pxt automate` command: asks how new issues and PRs should enter the
triage queue, writes `.github/workflows/triage-label.yml` into the current
repository (skipping bots and the changesets release PR by default), and
optionally commits it on a branch and opens a pull request.
