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

export interface ProviderStatusSource {
  id: string;
  label: string;
  usageUrl: string;
  preserveMissingWindows: boolean;
  fetch(pi: ExtensionAPI): Promise<ProviderResourceSnapshot>;
  parseHeaders(
    headers: HeaderLike,
    now?: Date,
  ): ProviderResourceSnapshot | undefined;
}

export type ModelLike = {
  id?: unknown;
  name?: unknown;
  displayName?: unknown;
  provider?: unknown;
  providerId?: unknown;
};
