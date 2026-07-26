---
title: Remote model price estimates
type: feature
authors:
  - rkbkosp
components:
  - pricing
created: 2026-07-26T03:32:49.931691Z
---

A separate remote pricing catalog can now estimate session cost from input, output, cache-read, and cache-write tokens. Rates normalize to per-million tokens, estimated totals carry an `≈` marker, pricing uses a multi-hour disk cache and refresh lifecycle, and failures fall back safely without delaying quota updates or modifying `models.json`.
