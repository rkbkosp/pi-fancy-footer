# Keep built-in provider adapters

## Status

Accepted

## Context

Codex and Anthropic usage endpoints require provider-specific OAuth credentials, token refresh behavior, response headers, and partial-window cache semantics. A generic HTTP configuration cannot reproduce those behaviors safely without exposing implementation details or weakening compatibility.

## Decision

Keep Codex and Anthropic as dedicated provider-status sources. Register them through the same source registry used by declarative providers, but do not replace their authentication or normalization logic with the declarative adapter.

## Consequences

Built-in behavior remains compatible with existing installations. New providers can use the declarative HTTP source, while providers with specialized authentication can add dedicated sources later.
