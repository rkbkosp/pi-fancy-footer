# Do not write models.json

## Status

Accepted

## Context

Remote pricing can correct cost metadata without taking ownership of a user's model configuration. Rewriting `~/.pi/agent/models.json` would mix generated state with user-authored providers and could destroy comments, ordering, or unrelated overrides.

## Decision

Never modify `models.json`. Estimate-only pricing remains local to the footer. Dynamic pricing integration uses Pi's runtime provider registration API and falls back to cache or existing model prices when remote data is unavailable.

## Consequences

Users retain full ownership of their model configuration. Price updates apply at runtime and can disappear when the extension is disabled, without leaving generated configuration behind.
