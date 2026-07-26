---
title: Zero cache TTL always refreshes providers
type: bugfix
authors:
  - rkbkosp
components:
  - provider-status
created: 2026-07-26T05:45:36.900303Z
---

A provider cacheTtlMs value of zero now consistently disables fresh-cache reuse, including requests made within the same millisecond. This makes forced no-cache configurations and their tests deterministic.
