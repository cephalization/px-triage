---
"@cephalization/px-triage": patch
---

The current directory's git `origin` now takes precedence over the repository
saved in the config, so running `pxt` inside another checkout triages that
repository. The config value is only a fallback outside a GitHub checkout.
