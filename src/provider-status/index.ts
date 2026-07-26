import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type GaugeSegment,
  type GaugeStyleDef,
  type ProviderStatusConfigSnapshot,
  type ProviderStatusSnapshot,
  type ProviderStatusWindow,
  buildGauge,
  formatGaugePercent,
} from "../shared.ts";
import {
  isProviderStatusFresh,
  readProviderStatusCache,
  writeProviderStatusCache,
} from "./cache.ts";
import { computeProviderStatusState } from "./normalize.ts";
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
  HeaderLike,
  ModelLike,
  ProviderStatusSource,
} from "./types.ts";

export {
  CLAUDE_USAGE_URL,
  CODEX_USAGE_URL,
  isProviderStatusFresh,
  normalizeClaudeUsageResponse,
  normalizeCodexUsageResponse,
  parseCodexRateLimitHeaders,
};
export type { ProviderStatusSource };

export const PROVIDER_STATUS_SOURCES: readonly ProviderStatusSource[] = [
  CODEX_SOURCE,
  ANTHROPIC_SOURCE,
];

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
  return PROVIDER_STATUS_SOURCES.filter((source) =>
    config.providers.includes(source.id),
  );
}

export function formatProviderStatusText(
  snapshot: ProviderStatusSnapshot | undefined,
  config: Pick<ProviderStatusConfigSnapshot, "showCredits" | "showReset">,
): string {
  if (!snapshot) return "";
  if (
    snapshot.state === "unavailable" &&
    (!config.showCredits || !snapshot.credits)
  ) {
    return "";
  }

  const parts: string[] = [];
  if (snapshot.primary) {
    parts.push(
      `${snapshot.primary.label}:${formatGaugePercent(snapshot.primary.leftPercent)}`,
    );
  }
  if (snapshot.secondary) {
    parts.push(
      `${snapshot.secondary.label}:${formatGaugePercent(snapshot.secondary.leftPercent)}`,
    );
  }
  if (config.showReset && snapshot.primary?.resetAt) {
    const reset = formatReset(snapshot.primary.resetAt);
    if (reset) parts.push(`reset:${reset}`);
  }
  if (config.showCredits && snapshot.credits) {
    parts.push(`cr:${snapshot.credits}`);
  }

  return parts.join(" ");
}

export function providerStatusColor(
  snapshot: ProviderStatusSnapshot | undefined,
): "success" | "warning" | "error" | "dim" {
  if (!snapshot || snapshot.state === "unavailable") return "dim";
  if (snapshot.state === "error") return "error";
  if (snapshot.state === "warning") return "warning";
  return "success";
}

export interface ProviderStatusGaugeSegment extends GaugeSegment {
  label: string;
}

export function buildProviderStatusGauge(
  snapshot: ProviderStatusSnapshot | undefined,
  style: GaugeStyleDef,
  cells: number,
): ProviderStatusGaugeSegment[] {
  if (!snapshot) return [];
  const segments: ProviderStatusGaugeSegment[] = [];
  for (const window of [snapshot.primary, snapshot.secondary]) {
    if (!window) continue;
    segments.push({
      label: window.label,
      ...buildGauge(window.leftPercent, style, cells),
    });
  }
  return segments;
}

export async function collectProviderStatus(
  pi: ExtensionAPI,
  config: ProviderStatusConfigSnapshot,
): Promise<ProviderStatusSnapshot[]> {
  const snapshots = await Promise.all(
    enabledProviderStatusSources(config).map((source) =>
      collectProviderStatusFromSource(pi, source, config),
    ),
  );
  return snapshots;
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
    const { error: _staleError, ...snapshot } = merged;
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

  const primary = windowInEffect(cached.primary, now);
  const secondary = windowInEffect(cached.secondary, now);
  if (!primary && !secondary) return undefined;

  const {
    primary: _expiredPrimary,
    secondary: _expiredSecondary,
    ...rest
  } = cached;
  return {
    ...rest,
    source: "cache",
    state: computeProviderStatusState(primary, secondary),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(error === undefined
      ? {}
      : { error: providerStatusErrorMessage(error) }),
  };
}

// A window is in effect while its reset time is still in the future. Windows
// without a reset time have no intrinsic lifetime, so they are not shown once
// the refresh that would confirm them has failed.
function windowInEffect(
  window: ProviderStatusWindow | undefined,
  now: Date,
): ProviderStatusWindow | undefined {
  if (!window?.resetAt) return undefined;
  const resetAtMs = window.resetAt * 1000;
  return Number.isFinite(resetAtMs) && resetAtMs > now.getTime()
    ? window
    : undefined;
}

function unavailableProviderStatus(
  source: ProviderStatusSource,
  error: unknown,
): ProviderStatusSnapshot {
  return {
    provider: source.id,
    source: "api",
    fetchedAt: new Date().toISOString(),
    state: "unavailable",
    url: source.usageUrl,
    error: providerStatusErrorMessage(error),
  };
}

function providerStatusErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
        source.preserveMissingWindows ||
        !isWeeklyOnlyCodexStatus(parsed),
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
  const windows = new Map<string, ProviderStatusWindow>();
  if (preserveMissingWindows) {
    for (const window of providerStatusWindows(existing)) {
      windows.set(window.label, window);
    }
  }
  for (const window of providerStatusWindows(update)) {
    windows.set(window.label, window);
  }

  const [primary, secondary] = Array.from(windows.values()).sort(
    (a, b) => windowDurationMinutes(a.label) - windowDurationMinutes(b.label),
  );
  const {
    primary: _existingPrimary,
    secondary: _existingSecondary,
    credits: existingCredits,
    error: _existingError,
    ...existingBase
  } = existing;
  const {
    primary: _updatePrimary,
    secondary: _updateSecondary,
    credits: updateCredits,
    ...updateBase
  } = update;
  const credits = updateCredits ?? existingCredits;

  return {
    ...existingBase,
    ...updateBase,
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(credits !== undefined ? { credits } : {}),
    state: computeProviderStatusState(primary, secondary),
  };
}

function providerStatusWindows(
  snapshot: ProviderStatusSnapshot,
): ProviderStatusWindow[] {
  return [snapshot.primary, snapshot.secondary].filter(
    (window): window is ProviderStatusWindow => window !== undefined,
  );
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

function isWeeklyOnlyCodexStatus(
  snapshot: ProviderStatusSnapshot,
): boolean {
  return (
    snapshot.provider === CODEX_SOURCE.id &&
    snapshot.primary?.label === CODEX_SECONDARY_WINDOW_LABEL &&
    snapshot.secondary === undefined
  );
}

export function formatProviderStatusReset(resetAt: number): string {
  return formatReset(resetAt);
}

function formatReset(resetAt: number): string {
  const date = new Date(resetAt * 1000);
  if (!Number.isFinite(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}
