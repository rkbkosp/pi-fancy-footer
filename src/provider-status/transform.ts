import { ProviderStatusFailure } from "./errors.ts";
import type { NumericTransform } from "./types.ts";

export function transformNumber(
  value: unknown,
  transform: NumericTransform = {},
): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim() === "")
  ) {
    throw invalidNumber(value);
  }

  let result = Number(value);
  if (!Number.isFinite(result)) throw invalidNumber(value);

  if (transform.scale !== undefined) result *= transform.scale;
  if (transform.offset !== undefined) result += transform.offset;
  if (transform.invertPercent) result = 100 - result;
  if (transform.clamp) {
    const [minimum, maximum] = transform.clamp;
    result = Math.max(minimum, Math.min(maximum, result));
  }
  if (transform.round !== undefined) {
    const factor = 10 ** transform.round;
    result = Math.round((result + Number.EPSILON) * factor) / factor;
  }

  if (!Number.isFinite(result)) throw invalidNumber(value);
  return result;
}

function invalidNumber(value: unknown): ProviderStatusFailure {
  const type = value === null ? "null" : typeof value;
  return new ProviderStatusFailure(
    "parse",
    `Expected a finite numeric value, received ${type}`,
  );
}
