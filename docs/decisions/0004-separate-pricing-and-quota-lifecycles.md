# Separate pricing and quota lifecycles

## Status

Accepted

## Context

Balances and quota windows change frequently, while model prices change infrequently and may be needed before the first provider request. Refreshing both through the footer's minute-scale status loop would add unnecessary traffic and couple pricing failures to live quota display.

## Decision

Use separate caches, refresh intervals, in-flight requests, and failure handling for provider resources and model pricing. Provider resources follow the active model and refresh frequently. Pricing loads from cache at startup and refreshes on a multi-hour interval.

## Consequences

A pricing outage cannot prevent quota refreshes or Pi startup. Balance updates do not invalidate price data, and operators can tune the two lifecycles independently.
