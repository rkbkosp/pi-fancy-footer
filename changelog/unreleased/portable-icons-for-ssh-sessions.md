---
title: Portable icons for SSH sessions
type: bugfix
authors:
  - rkbkosp
components:
  - config
created: 2026-07-26T05:12:52.676924Z
---

When iconFamily is not configured, SSH sessions now select the portable Unicode icon palette while local sessions retain Nerd Font icons. An explicit iconFamily continues to override automatic detection.
