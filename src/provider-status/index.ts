import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type GaugeSegment,
  type GaugeStyleDef,
  type ProviderStatusConfigSnapshot,
  buildGauge,
  formatGaugePercent,
} from "../shared.ts";
import {
  isProviderStatusFresh,
  readProviderStatusCache,
  writeProviderStatusCache,
} from "./cache.ts";
import { computeProviderStatusState, remainingPercent } from "./normalize.ts";
import { ProviderStatusRegistry } from "./registry.ts";
import {
  ANTHROPIC_SOURCE,
  CLAUDE_USAGE_URL,
  normalizeClaudeUsageResponse,
} from "./sources/anthropic.ts";
import {
  CODEX_SECONDARY_WINDOW_LABEL,
  CODEX_SOURCE,
  CODEX_USAGE_URL,
  normalizeCodexUsageResponse,
  parseCodexRateLimitHeaders,
} from "./sources/codex.ts";
import type {
  BalanceMetric,
  HeaderLike,
  ModelLike,
  ProviderStatusSnapshot,
  ProviderStatusSource,
  QuotaWindow,
} from "./types.ts";

export {
  CLAUDE_USAGE_URL,
  ProviderStatusRegistry,
  CODEX_USAGE_URL,
  isProviderStatusFresh,
  normalizeClaudeUsageResponse,
  normalizeCodexUsageResponse,
  parseCodexRateLimitHeaders,
};
export type {
  BalanceMetric,
  ProviderResourceSnapshot,
  ProviderStatusError,
  ProviderStatusSnapshot,
  ProviderStatusSource,
  QuotaWindow,
} from "./types.ts";

export function createProviderStatusRegistry(): ProviderStatusRegistry {
  const registry = new ProviderStatusRegistry();
  registry.register(CODEX_SOURCE);
  registry.register(ANTHROPIC_SOURCE);
  return registry;
}

const PROVIDER_STATUS_REGISTRY = createProviderStatusRegistry();

export const PROVIDER_STATUS_SOURCES: readonly ProviderStatusSource[] =
  PROVIDER_STATUS_REGISTRY.list();

function modelValue(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function looksLikeOpenAIModel(value: string): boolean {
  if (!value) return false;

  const normalized = value.replace(/[/_:\s]+/g, "-");
  return (
    normalized.includes("openai") ||
    normalized.includes("codex") ||
    normalized.includes("chatgpt") ||
    /(^|-)gpt(?:[0-9-]|$)/.test(normalized) ||
    /(^|-)o[134](?:-|$)/.test(normalized)
  );
}

function looksLikeAnthropicModel(value: string): boolean {
  if (!value) return false;

  const normalized = value.replace(/[/_:\s]+/g, "-");
  return (
    normalized.includes("anthropic") ||
    normalized.includes("claude") ||
    /(^|-)(sonnet|opus|haiku)(?:-|$)/.test(normalized)
  );
}

function looksLikeProviderModel(providerId: string, value: string): boolean {
  if (providerId === CODEX_SOURCE.id) return looksLikeOpenAIModel(value);
  if (providerId === ANTHROPIC_SOURCE.id) return looksLikeAnthropicModel(value);
  return true;
}

export function isProviderStatusRelevantToModel(
  providerId: string,
  model: ModelLike | string | undefined,
): boolean {
  if (providerId !== CODEX_SOURCE.id && providerId !== ANTHROPIC_SOURCE.id) {
    return true;
  }

  if (typeof model === "string") {
    return looksLikeProviderModel(providerId, modelValue(model));
  }
  if (!model) return false;

  const provider = modelValue(model.provider) || modelValue(model.providerId);
  if (provider) return looksLikeProviderModel(providerId, provider);

  return [
    modelValue(model.id),
    modelValue(model.name),
    modelValue(model.displayName),
  ].some((value) => looksLikeProviderModel(providerId, value));
}

function enabledProviderStatusSources(
  config: Pick<ProviderStatusConfigSnapshot, "providers">,
): readonly ProviderStatusSource[] {
  return config.providers.flatMap((id) => {
    const source = PROVIDER_STATUS_REGISTRY.get(id);
    return source ? [source] : [];
  });
}

export function formatProviderStatusText(
  snapshot: ProviderStatusSnapshot | undefined,
  config: Pick<ProviderStatusConfigSnapshot, "showCredits" | "showReset">,
): string {
  if (!snapshot) return "";
  if (
    snapshot.windows.length === 0 &&
    (!config.showCredits || snapshot.balances.length === 0)
  ) {
    return "";
  }

  const parts = snapshot.windows.flatMap((window) => {
    const left = remainingPercent(window);
    return left === undefined
      ? []
      : [`${window.label}:${formatGaugePercent(left)}`];
  });
  if (config.showReset && snapshot.windows[0]?.resetAt) {
    const reset = formatReset(snapshot.windows[0].resetAt);
    if (reset) parts.push(`reset:${reset}`);
  }
  if (config.showCredits) {
    parts.push(...snapshot.balances.map(formatLegacyBalance));
  }

  return parts.join(" ");
}

export function providerStatusColor(
  snapshot: ProviderStatusSnapshot | undefined,
): "success" | "warning" | "error" | "dim" {
  if (!snapshot) return "dim";
  const state = computeProviderStatusState(snapshot.windows);
  if (state === "unavailable") return "dim";
  if (state === "error") return "error";
  if (state === "warning") return "warning";
  return "success";
}

export interface ProviderStatusGaugeSegment extends GaugeSegment {
  id: string;
  label: string;
}

export function buildProviderStatusGauge(
  snapshot: ProviderStatusSnapshot | undefined,
  style: GaugeStyleDef,
  cells: number,
): ProviderStatusGaugeSegment[] {
  if (!snapshot) return [];
  return snapshot.windows.flatMap((window) => {
    const left = remainingPercent(window);
    if (left === undefined) return [];
    return [
      {
        id: window.id,
        label: window.label,
        ...buildGauge(left, style, cells),
      },
    ];
  });
}

export async function collectProviderStatus(
  pi: ExtensionAPI,
  config: ProviderStatusConfigSnapshot,
): Promise<ProviderStatusSnapshot[]> {
  return Promise.all(
    enabledProviderStatusSources(config).map((source) =>
      collectProviderStatusFromSource(pi, source, config),
    ),
  );
}

async function collectProviderStatusFromSource(
  pi: ExtensionAPI,
  source: ProviderStatusSource,
  config: ProviderStatusConfigSnapshot,
): Promise<ProviderStatusSnapshot> {
  const cached = await readProviderStatusCache(source.id);
  if (isProviderStatusFresh(cached, config.cacheTtlMs)) {
    return { ...cached, source: "cache" };
  }

  try {
    // Anthropic refreshes can be partial and report only the weekly window.
    // Codex refreshes are authoritative: OpenAI can remove a window and promote
    // the weekly window to primary, so retaining a missing window would show a
    // stale or duplicated quota.
    const fresh = await source.fetch(pi);
    const merged = source.preserveMissingWindows
      ? mergeProviderStatus(displayableCachedStatus(cached), fresh)
      : fresh;
    const { error: _staleError, stale: _stale, ...snapshot } = merged;
    await writeProviderStatusCache(snapshot).catch(() => undefined);
    return snapshot;
  } catch (error) {
    // A refresh failed. The cached quota windows remain valid until they
    // reset, regardless of why the refresh failed, so keep showing whichever
    // windows are still in effect.
    return (
      displayableCachedStatus(cached, error) ??
      unavailableProviderStatus(source, error)
    );
  }
}

// Projects a cached snapshot onto the windows that are still in effect, i.e.
// have not reset yet. Returns undefined when nothing is left to display.
function displayableCachedStatus(
  cached: ProviderStatusSnapshot | undefined,
  error?: unknown,
  now = new Date(),
): ProviderStatusSnapshot | undefined {
  if (!cached) return undefined;

  const windows = cached.windows.filter((window) =>
    windowInEffect(window, now),
  );
  if (windows.length === 0) return undefined;

  return {
    ...cached,
    source: "cache",
    windows,
    stale: error !== undefined,
    ...(error === undefined ? {} : { error: providerStatusError(error) }),
  };
}

// A window is in effect while its reset time is still in the future. Windows
// without a reset time have no intrinsic lifetime, so they are not shown once
// the refresh that would confirm them has failed.
function windowInEffect(window: QuotaWindow, now: Date): boolean {
  if (!window.resetAt) return false;
  const resetAtMs = Date.parse(window.resetAt);
  return Number.isFinite(resetAtMs) && resetAtMs > now.getTime();
}

function unavailableProviderStatus(
  source: ProviderStatusSource,
  error: unknown,
): ProviderStatusSnapshot {
  return {
    provider: source.id,
    label: source.label,
    source: "api",
    fetchedAt: new Date().toISOString(),
    windows: [],
    balances: [],
    url: source.usageUrl,
    error: providerStatusError(error),
  };
}

function providerStatusError(error: unknown) {
  return {
    code: "unknown" as const,
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function updateProviderStatusFromHeaders(
  headers: HeaderLike,
  config?: ProviderStatusConfigSnapshot,
): Promise<ProviderStatusSnapshot[]> {
  const sources = config
    ? enabledProviderStatusSources(config)
    : PROVIDER_STATUS_SOURCES;

  const updated: ProviderStatusSnapshot[] = [];
  for (const source of sources) {
    const parsed = source.parseHeaders(headers);
    if (!parsed) continue;

    const cached = await readProviderStatusCache(source.id);
    const freshCached =
      config && isProviderStatusFresh(cached, config.cacheTtlMs)
        ? cached
        : undefined;
    const merged = mergeProviderStatus(freshCached, parsed, {
      // A duration-bearing weekly primary with no secondary is an explicit
      // weekly-only Codex layout, not a sparse update.
      preserveMissingWindows:
        source.preserveMissingWindows || !isWeeklyOnlyCodexStatus(parsed),
    });
    await writeProviderStatusCache(merged).catch(() => undefined);
    updated.push(merged);
  }
  return updated;
}

function mergeProviderStatus(
  existing: ProviderStatusSnapshot | undefined,
  update: ProviderStatusSnapshot,
  options: { preserveMissingWindows?: boolean } = {},
): ProviderStatusSnapshot {
  if (!existing) return update;

  const preserveMissingWindows = options.preserveMissingWindows ?? true;
  const windows = new Map<string, QuotaWindow>();
  if (preserveMissingWindows) {
    for (const window of existing.windows) windows.set(window.id, window);
  }
  for (const window of update.windows) windows.set(window.id, window);

  const balances = new Map<string, BalanceMetric>();
  for (const balance of existing.balances) balances.set(balance.id, balance);
  for (const balance of update.balances) balances.set(balance.id, balance);

  return {
    ...existing,
    ...update,
    windows: Array.from(windows.values()).sort(
      (a, b) => windowDurationMinutes(a.label) - windowDurationMinutes(b.label),
    ),
    balances: Array.from(balances.values()),
  };
}

function windowDurationMinutes(label: string): number {
  const match = label.match(/^(\d+(?:\.\d+)?)(m|h|d)$/);
  if (!match) return Number.POSITIVE_INFINITY;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  if (match[2] === "d") return value * 24 * 60;
  if (match[2] === "h") return value * 60;
  return value;
}

function isWeeklyOnlyCodexStatus(snapshot: ProviderStatusSnapshot): boolean {
  return (
    snapshot.provider === CODEX_SOURCE.id &&
    snapshot.windows.length === 1 &&
    snapshot.windows[0]?.label === CODEX_SECONDARY_WINDOW_LABEL
  );
}

export function formatProviderStatusReset(resetAt: string): string {
  return formatReset(resetAt);
}

function formatReset(resetAt: string): string {
  const date = new Date(resetAt);
  if (!Number.isFinite(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}

function formatLegacyBalance(balance: BalanceMetric): string {
  const prefix = balance.approximate ? "≈" : "";
  if (balance.id === "credits" || balance.unit === "credits") {
    return `cr:${prefix}${balance.value}`;
  }
  return `${balance.label ?? balance.id}:${prefix}${balance.value}${
    balance.unit ? ` ${balance.unit}` : ""
  }`;
}
