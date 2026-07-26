---
title: Runtime providers with remote prices
type: feature
authors:
  - rkbkosp
components:
  - pricing
created: 2026-07-26T03:36:26.436975Z
---

Pricing configuration can optionally register a provider and its models through Pi at runtime. New requests use the normalized remote USD rates in native `usage.cost`, cached prices or configured fallback rates keep startup resilient, and the extension never writes generated model data to `models.json`.
