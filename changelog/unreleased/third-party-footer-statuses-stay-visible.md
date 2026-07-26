---
title: Third-party footer statuses stay visible
type: bugfix
authors:
  - rkbkosp
components:
  - footer
created: 2026-07-26T05:35:51.936626Z
---

The custom footer now renders Pi extension statuses from footerData, preserving TPS meters, memory activity, and other setStatus integrations on a native-style third line. Statuses remain sorted, sanitized to one line, and width-limited.
