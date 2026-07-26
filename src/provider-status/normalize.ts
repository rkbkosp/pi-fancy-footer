import {
  gaugeSeverity,
  type ProviderStatusState,
  type ProviderStatusWindow,
} from "../shared.ts";

export function objectValue(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function numberString(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function windowLabelFromSeconds(
  seconds: number | undefined,
): string | undefined {
  if (seconds === undefined || seconds <= 0) return undefined;
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return undefined;
}

export function windowFromUsedPercent(
  label: string,
  usedPercent: number,
  resetAt: number | undefined,
  _now: Date,
): ProviderStatusWindow {
  const clampedUsed = Math.max(0, Math.min(100, usedPercent));
  return {
    label,
    usedPercent: clampedUsed,
    leftPercent: Math.max(0, Math.min(100, 100 - clampedUsed)),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

export function computeProviderStatusState(
  primary: ProviderStatusWindow | undefined,
  secondary: ProviderStatusWindow | undefined,
): ProviderStatusState {
  const values = [primary?.leftPercent, secondary?.leftPercent].filter(
    (value): value is number => value !== undefined,
  );
  if (values.length === 0) return "unavailable";
  const severity = gaugeSeverity(Math.min(...values));
  return severity === "success" ? "ok" : severity;
}

export function normalizeResetAt(
  value: number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  return value > 10_000_000_000 ? Math.round(value / 1000) : value;
}

export function resetAtFromTimestamp(
  value: string | undefined,
): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.round(parsed / 1000) : undefined;
}
