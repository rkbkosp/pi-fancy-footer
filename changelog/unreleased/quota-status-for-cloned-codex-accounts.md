---
title: Quota status for cloned Codex accounts
type: feature
authors:
  - rkbkosp
components:
  - provider-status
created: 2026-07-26T05:00:34.669741Z
---

Active cloned Codex providers now read their own Pi OAuth entry, cache quota independently, and display the matching account's weekly usage window. Response-header updates preserve the clone provider identity instead of overwriting the base OpenAI Codex cache.
