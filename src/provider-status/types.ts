import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type HeaderLike = Record<
  string,
  string | number | boolean | undefined | null
>;

export interface QuotaWindow {
  id: string;
  label: string;
  remainingPercent?: number;
  usedPercent?: number;
  remaining?: number;
  used?: number;
  limit?: number;
  unit?: string;
  resetAt?: string;
}

export interface BalanceMetric {
  id: string;
  label?: string;
  value: number;
  currency?: string;
  unit?: string;
  approximate?: boolean;
}

export interface ProviderStatusError {
  code:
    | "network"
    | "timeout"
    | "http"
    | "parse"
    | "selector"
    | "config"
    | "auth"
    | "unknown";
  message: string;
  status?: number;
}

export interface ProviderResourceSnapshot {
  provider: string;
  label: string;
  fetchedAt: string;
  source: "api" | "headers" | "local" | "cache";
  windows: QuotaWindow[];
  balances: BalanceMetric[];
  stale?: boolean;
  error?: ProviderStatusError;
  url?: string;
}

export type ProviderStatusSnapshot = ProviderResourceSnapshot;

export interface ProviderStatusFetchOptions {
  signal?: AbortSignal;
}

export interface ProviderStatusSource {
  id: string;
  label: string;
  usageUrl: string;
  preserveMissingWindows: boolean;
  kind?: "builtin" | "declarative";
  cacheKey?: string;
  alwaysRefresh?: boolean;
  matchProviders?: readonly string[];
  supports(providerId: string): boolean;
  fetch(
    pi: ExtensionAPI,
    options?: ProviderStatusFetchOptions,
  ): Promise<ProviderResourceSnapshot>;
  parseHeaders(
    headers: HeaderLike,
    now?: Date,
  ): ProviderResourceSnapshot | undefined;
}

export interface NumericTransform {
  scale?: number;
  offset?: number;
  invertPercent?: boolean;
  clamp?: [number, number];
  round?: number;
}

export interface DeclarativeRequestConfig {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxResponseBytes?: number;
  followRedirects?: boolean;
}

export interface DeclarativeBalanceConfig {
  id: string;
  label?: string;
  selector: string;
  transform?: NumericTransform;
  currency?: string;
  unit?: string;
  approximate?: boolean;
}

export type TimestampUnit = "seconds" | "milliseconds" | "iso8601";

export interface DeclarativeWindowConfig {
  id: string;
  label: string;
  remainingPercentSelector?: string;
  usedPercentSelector?: string;
  remainingSelector?: string;
  usedSelector?: string;
  limitSelector?: string;
  transform?: NumericTransform;
  unit?: string;
  resetAtSelector?: string;
  timestampUnit?: TimestampUnit;
}

export interface DeclarativeProviderConfig {
  label?: string;
  matchProviders?: string[];
  alwaysRefresh?: boolean;
  enabled?: boolean;
  request: DeclarativeRequestConfig;
  balances?: DeclarativeBalanceConfig[];
  windows?: DeclarativeWindowConfig[];
}

export type ModelLike = {
  id?: unknown;
  name?: unknown;
  displayName?: unknown;
  provider?: unknown;
  providerId?: unknown;
};
