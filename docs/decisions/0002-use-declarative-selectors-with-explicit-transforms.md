# Use declarative selectors with explicit transforms

## Status

Accepted

## Context

Custom balance and quota APIs return different JSON shapes and numeric units. Executing JavaScript from footer configuration would make validation, diagnostics, and secret handling unsafe, while a complete JSONPath or JMESPath implementation is unnecessary for the first version.

## Decision

Support deterministic object paths and array indexes such as `data.items[0].remaining`. Numeric conversion uses an explicit transform pipeline: number conversion, scale, offset, percentage inversion, clamping, and rounding.

## Consequences

Configuration remains serializable, strictly validated, and safe to execute. Complex expressions require either a dedicated adapter or a future opt-in selector mode.
