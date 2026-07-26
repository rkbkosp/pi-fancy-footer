---
title: Provider-scoped price estimates
type: bugfix
authors:
  - rkbkosp
components:
  - pricing
created: 2026-07-26T05:02:39.361199Z
---

Estimate-only pricing can now use matchProviders to restrict a remote catalog to exact Pi provider IDs. Sessions that use the same model ID through another provider no longer inherit unrelated proxy rates.
