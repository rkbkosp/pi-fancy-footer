import { gaugeSeverity } from "../shared.ts";
import type {
  BalanceMetric,
  ProviderResourceSnapshot,
  ProviderStatusError,
  QuotaWindow,
} from "./types.ts";

export type ProviderStatusState = "ok" | "warning" | "error" | "unavailable";

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

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
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
  id: string,
  label: string,
  usedPercent: number,
  resetAt: string | undefined,
  _now: Date,
): QuotaWindow {
  const used = clampPercent(usedPercent);
  return {
    id,
    label,
    usedPercent: used,
    remainingPercent: clampPercent(100 - used),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

export function remainingPercent(window: QuotaWindow): number | undefined {
  if (window.remainingPercent !== undefined) {
    return clampPercent(window.remainingPercent);
  }
  if (window.usedPercent !== undefined) {
    return clampPercent(100 - window.usedPercent);
  }
  if (
    window.remaining !== undefined &&
    window.limit !== undefined &&
    window.limit > 0
  ) {
    return clampPercent((window.remaining / window.limit) * 100);
  }
  if (
    window.used !== undefined &&
    window.limit !== undefined &&
    window.limit > 0
  ) {
    return clampPercent(100 - (window.used / window.limit) * 100);
  }
  return undefined;
}

export function computeProviderStatusState(
  windows: readonly QuotaWindow[],
): ProviderStatusState {
  const values = windows
    .map((window) => remainingPercent(window))
    .filter((value): value is number => value !== undefined);
  if (values.length === 0) return "unavailable";
  const severity = gaugeSeverity(Math.min(...values));
  return severity === "success" ? "ok" : severity;
}

export function normalizeTimestamp(
  value: unknown,
  unit: "seconds" | "milliseconds" | "iso8601",
): string | undefined {
  let date: Date;
  if (unit === "seconds") {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) return undefined;
    date = new Date(numeric * 1000);
  } else if (unit === "milliseconds") {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) return undefined;
    date = new Date(numeric);
  } else {
    if (typeof value !== "string" && typeof value !== "number") {
      return undefined;
    }
    date = new Date(value);
  }
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function normalizeResetAt(
  value: number | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  return normalizeTimestamp(
    value,
    value > 10_000_000_000 ? "milliseconds" : "seconds",
  );
}

export function resetAtFromTimestamp(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  return normalizeTimestamp(value, "iso8601");
}

export function normalizeProviderResourceSnapshot(
  value: unknown,
): ProviderResourceSnapshot | undefined {
  const obj = objectValue(value);
  const provider = stringValue(obj?.provider);
  const fetchedAt = stringValue(obj?.fetchedAt);
  if (!obj || !provider || !fetchedAt) return undefined;

  const source = normalizeSource(obj.source);
  const windows = Array.isArray(obj.windows)
    ? obj.windows
        .map((window) => normalizeWindow(window))
        .filter((window): window is QuotaWindow => window !== undefined)
    : normalizeLegacyWindows(obj);
  const balances = Array.isArray(obj.balances)
    ? obj.balances
        .map((balance) => normalizeBalance(balance))
        .filter((balance): balance is BalanceMetric => balance !== undefined)
    : normalizeLegacyBalances(obj);
  const label = stringValue(obj.label) ?? providerLabel(provider);
  const error = normalizeError(obj.error);

  return {
    provider,
    label,
    fetchedAt,
    source,
    windows,
    balances,
    ...(obj.stale === true ? { stale: true } : {}),
    ...(error ? { error } : {}),
    ...(stringValue(obj.url) ? { url: stringValue(obj.url) } : {}),
  };
}

function normalizeSource(value: unknown): ProviderResourceSnapshot["source"] {
  return value === "headers" || value === "local" || value === "cache"
    ? value
    : "api";
}

function normalizeWindow(value: unknown): QuotaWindow | undefined {
  const obj = objectValue(value);
  if (!obj) return undefined;
  const id = stringValue(obj.id);
  const label = stringValue(obj.label);
  if (!id || !label) return undefined;

  const normalized: QuotaWindow = { id, label };
  for (const field of [
    "remainingPercent",
    "usedPercent",
    "remaining",
    "used",
    "limit",
  ] as const) {
    const numeric = numberValue(obj[field]);
    if (numeric !== undefined) normalized[field] = numeric;
  }
  if (
    normalized.remainingPercent === undefined &&
    normalized.usedPercent !== undefined
  ) {
    normalized.remainingPercent = clampPercent(100 - normalized.usedPercent);
  }
  if (
    normalized.usedPercent === undefined &&
    normalized.remainingPercent !== undefined
  ) {
    normalized.usedPercent = clampPercent(100 - normalized.remainingPercent);
  }
  if (normalized.remainingPercent !== undefined) {
    normalized.remainingPercent = clampPercent(normalized.remainingPercent);
  }
  if (normalized.usedPercent !== undefined) {
    normalized.usedPercent = clampPercent(normalized.usedPercent);
  }
  const unit = stringValue(obj.unit);
  const resetAt = resetAtValue(obj.resetAt);
  if (unit) normalized.unit = unit;
  if (resetAt) normalized.resetAt = resetAt;
  return normalized;
}

function normalizeLegacyWindows(obj: Record<string, unknown>): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  for (const slot of ["primary", "secondary"] as const) {
    const legacy = objectValue(obj[slot]);
    if (!legacy) continue;
    const label = stringValue(legacy.label) ?? slot;
    const used = numberValue(legacy.usedPercent);
    const left = numberValue(legacy.leftPercent);
    const window: QuotaWindow = {
      id: label,
      label,
      ...(left !== undefined ? { remainingPercent: clampPercent(left) } : {}),
      ...(used !== undefined ? { usedPercent: clampPercent(used) } : {}),
    };
    const resetAt = resetAtValue(legacy.resetAt);
    if (resetAt) window.resetAt = resetAt;
    if (
      window.remainingPercent === undefined &&
      window.usedPercent !== undefined
    ) {
      window.remainingPercent = clampPercent(100 - window.usedPercent);
    }
    if (
      window.usedPercent === undefined &&
      window.remainingPercent !== undefined
    ) {
      window.usedPercent = clampPercent(100 - window.remainingPercent);
    }
    windows.push(window);
  }
  return windows;
}

function normalizeBalance(value: unknown): BalanceMetric | undefined {
  const obj = objectValue(value);
  if (!obj) return undefined;
  const id = stringValue(obj.id);
  const numeric = numberValue(obj.value);
  if (!id || numeric === undefined) return undefined;
  const label = stringValue(obj.label);
  const currency = stringValue(obj.currency);
  const unit = stringValue(obj.unit);
  return {
    id,
    value: numeric,
    ...(label ? { label } : {}),
    ...(currency ? { currency } : {}),
    ...(unit ? { unit } : {}),
    ...(obj.approximate === true ? { approximate: true } : {}),
  };
}

function normalizeLegacyBalances(
  obj: Record<string, unknown>,
): BalanceMetric[] {
  const credits = numberString(stringValue(obj.credits));
  return credits === undefined
    ? []
    : [{ id: "credits", value: credits, unit: "credits" }];
}

function normalizeError(value: unknown): ProviderStatusError | undefined {
  if (typeof value === "string") {
    return { code: "unknown", message: value };
  }
  const obj = objectValue(value);
  const message = stringValue(obj?.message);
  if (!obj || !message) return undefined;
  const allowedCodes = new Set<ProviderStatusError["code"]>([
    "network",
    "timeout",
    "http",
    "parse",
    "selector",
    "config",
    "auth",
    "unknown",
  ]);
  const rawCode = stringValue(obj.code) as
    | ProviderStatusError["code"]
    | undefined;
  const code = rawCode && allowedCodes.has(rawCode) ? rawCode : "unknown";
  const status = numberValue(obj.status);
  return {
    code,
    message,
    ...(status !== undefined ? { status } : {}),
  };
}

function resetAtValue(value: unknown): string | undefined {
  if (typeof value === "number") return normalizeResetAt(value);
  if (typeof value === "string") return resetAtFromTimestamp(value);
  return undefined;
}

function providerLabel(provider: string): string {
  if (provider === "openai-codex") return "Codex";
  if (provider === "anthropic") return "Claude";
  return provider;
}
