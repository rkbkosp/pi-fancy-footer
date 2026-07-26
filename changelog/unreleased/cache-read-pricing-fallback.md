---
title: Cache-read pricing fallback
type: bugfix
authors:
  - rkbkosp
components:
  - pricing
created: 2026-07-26T04:51:41.033206Z
---

Remote pricing now derives a missing cache-read rate as 10% of the model's input-token rate. Explicit cache-read prices still take precedence, and the same fallback is used for estimate-only costs and runtime provider registration.
