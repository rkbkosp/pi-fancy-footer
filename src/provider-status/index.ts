import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type GaugeSegment,
  type GaugeStyleDef,
  type ProviderStatusConfigSnapshot,
  buildGauge,
  formatGaugePercent,
} from "../shared.ts";
import { toProviderStatusError } from "./errors.ts";
import {
  isProviderStatusFresh,
  readProviderStatusCache,
  writeProviderStatusCache,
} from "./cache.ts";
import { computeProviderStatusState, remainingPercent } from "./normalize.ts";
import { ProviderStatusRegistry } from "./registry.ts";
import { createDeclarativeSource } from "./sources/declarative.ts";
import {
  ANTHROPIC_SOURCE,
  CLAUDE_USAGE_URL,
  normalizeClaudeUsageResponse,
} from "./sources/anthropic.ts";
import {
  CODEX_SECONDARY_WINDOW_LABEL,
  CODEX_SOURCE,
  CODEX_USAGE_URL,
  createCodexSource,
  isCodexProviderId,
  normalizeCodexUsageResponse,
  parseCodexRateLimitHeaders,
} from "./sources/codex.ts";
import type {
  BalanceMetric,
  DeclarativeProviderConfig,
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

export function createProviderStatusRegistry(
  customProviders: Record<string, DeclarativeProviderConfig> = {},
): ProviderStatusRegistry {
  const registry = new ProviderStatusRegistry();
  registry.register(CODEX_SOURCE);
  registry.register(ANTHROPIC_SOURCE);
  for (const [id, config] of Object.entries(customProviders)) {
    if (config.enabled === false) continue;
    registry.register(createDeclarativeSource(id, config));
  }
  return registry;
}

const BUILTIN_PROVIDER_STATUS_REGISTRY = createProviderStatusRegistry();

export const PROVIDER_STATUS_SOURCES: readonly ProviderStatusSource[] =
  BUILTIN_PROVIDER_STATUS_REGISTRY.list();

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
    /(^|-)(sonnet|opus|haiku|fable)(?:-|$)/.test(normalized)
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
  config: ProviderStatusConfigSnapshot,
  model?: ModelLike | string,
): readonly ProviderStatusSource[] {
  const registry = createProviderStatusRegistry(config.customProviders);
  const enabled = config.providers.flatMap((id) => {
    const source = registry.get(id);
    return source ? [source] : [];
  });
  const currentProvider = currentProviderId(model);
  if (
    currentProvider &&
    config.providers.includes(CODEX_SOURCE.id) &&
    !CODEX_SOURCE.supports(currentProvider) &&
    isCodexProviderId(currentProvider)
  ) {
    const baseIndex = enabled.findIndex(
      (source) => source.id === CODEX_SOURCE.id,
    );
    if (baseIndex >= 0) {
      enabled.splice(
        baseIndex,
        1,
        createCodexSource(currentProvider, currentProvider),
      );
    }
  }
  for (const id of Object.keys(config.customProviders)) {
    const source = registry.get(id);
    if (!source || enabled.includes(source)) continue;
    if (
      source.alwaysRefresh ||
      (currentProvider && source.supports(currentProvider))
    ) {
      enabled.push(source);
    }
  }
  return enabled;
}

function currentProviderId(model: ModelLike | string | undefined): string {
  if (typeof model === "string") return modelValue(model);
  if (!model) return "";
  return modelValue(model.provider) || modelValue(model.providerId);
}

interface CompatibilityWindow {
  id: string;
  label: string;
  role: "primary" | "secondary";
  usedPercent?: number;
  resetAt?: number;
  usageUnknown?: boolean;
  raw?: QuotaWindow;
}

function compatibilityResetAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.round(value / 1000) : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.round(parsed / 1000) : undefined;
  }
  return undefined;
}

function compatibilityWindows(snapshot: ProviderStatusSnapshot): CompatibilityWindow[] {
  const legacy = snapshot as ProviderStatusSnapshot & {
    primary?: Record<string, unknown>;
    secondary?: Record<string, unknown>;
  };
  const generic = snapshot.windows ?? [];
  const builtinQuota =
    isCodexProviderId(snapshot.provider) || snapshot.provider === ANTHROPIC_SOURCE.id;

  const displayPercent = (window: QuotaWindow | undefined): number | undefined => {
    if (!window) return undefined;
    if (builtinQuota) {
      if (window.usedPercent !== undefined) return window.usedPercent;
      if (window.remainingPercent !== undefined) return 100 - window.remainingPercent;
      return undefined;
    }
    // Declarative/custom providers historically display remaining quota.
    if (window.remainingPercent !== undefined) return window.remainingPercent;
    if (window.usedPercent !== undefined) return 100 - window.usedPercent;
    return remainingPercent(window);
  };

  const hasLegacy = legacy.primary !== undefined || legacy.secondary !== undefined;
  if (hasLegacy) {
    return ([
      ["primary", legacy.primary, generic[0]],
      ["secondary", legacy.secondary, generic[1]],
    ] as const).flatMap(([role, value, base]) => {
      if (!value && !base) return [];
      const legacyUsed = typeof value?.usedPercent === "number" ? value.usedPercent : undefined;
      const usedPercent = legacyUsed ?? displayPercent(base);
      const label =
        typeof value?.label === "string"
          ? value.label
          : base?.label ?? (role === "primary" ? "5h" : "7d");
      const resetAt =
        compatibilityResetAt(value?.resetAt) ?? compatibilityResetAt(base?.resetAt);
      return [{
        id: typeof value?.id === "string" ? value.id : base?.id ?? label,
        label,
        role,
        ...(usedPercent !== undefined ? { usedPercent } : {}),
        ...(resetAt !== undefined ? { resetAt } : {}),
        ...(value?.usageUnknown === true || base?.usageUnknown === true
          ? { usageUnknown: true }
          : {}),
        ...(base ? { raw: base } : {}),
      }];
    });
  }

  return generic.map((window, index) => {
    const usedPercent = displayPercent(window);
    return {
      id: window.id,
      label: window.label,
      role: index === 0 ? "primary" : "secondary",
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(compatibilityResetAt(window.resetAt) !== undefined
        ? { resetAt: compatibilityResetAt(window.resetAt) }
        : {}),
      ...(window.usageUnknown === true ? { usageUnknown: true } : {}),
      raw: window,
    };
  });
}

function resetMode(config: Pick<ProviderStatusConfigSnapshot, "showReset">): "off" | "primary" | "all" {
  const value = config.showReset as unknown;
  if (value === true) return "primary";
  if (value === false) return "off";
  return value === "primary" || value === "all" ? value : "off";
}

export function resetCountdownText(
  window: Pick<CompatibilityWindow, "usedPercent" | "resetAt" | "usageUnknown">,
  role: "primary" | "secondary",
  config: Pick<ProviderStatusConfigSnapshot, "showReset" | "resetMinUsedPercent">,
  nowMs: number,
): string {
  const mode = resetMode(config);
  const roleEnabled = mode === "all" || (mode === "primary" && role === "primary");
  const displayed = window.usedPercent === undefined
    ? 0
    : Number.parseFloat(formatGaugePercent(window.usedPercent));
  const threshold = Number.isFinite(config.resetMinUsedPercent)
    ? config.resetMinUsedPercent
    : 75;
  if (
    !roleEnabled ||
    window.usageUnknown ||
    window.resetAt === undefined ||
    !Number.isFinite(displayed) ||
    displayed < threshold
  ) return "";
  return formatResetCountdown(window.resetAt, nowMs);
}

export function formatProviderStatusText(
  snapshot: ProviderStatusSnapshot | undefined,
  config: Pick<ProviderStatusConfigSnapshot, "showCredits" | "showReset" | "resetMinUsedPercent">,
  nowMs = Date.now(),
): string {
  if (!snapshot) return "";
  const windows = compatibilityWindows(snapshot);
  const balances = snapshot.balances ?? [];
  const legacyCredits = (snapshot as ProviderStatusSnapshot & { credits?: string }).credits;
  if (
    windows.length === 0 &&
    (!config.showCredits || (balances.length === 0 && !legacyCredits))
  ) return "";

  const parts = windows.flatMap((window) => {
    let part: string | undefined;
    if (window.usedPercent !== undefined) {
      part = `${window.label}:${formatGaugePercent(window.usedPercent)}`;
    } else if (window.raw) {
      const raw = window.raw;
      const unit = raw.unit ? ` ${raw.unit}` : "";
      if (raw.remaining !== undefined) part = `${window.label}:${raw.remaining}${unit}`;
      else if (raw.used !== undefined && raw.limit !== undefined) part = `${window.label}:${raw.used}/${raw.limit}${unit}`;
      else if (raw.used !== undefined) part = `${window.label}:${raw.used}${unit}`;
      else if (raw.limit !== undefined) part = `${window.label}:${raw.limit}${unit}`;
    }
    if (!part) return [];
    const reset = resetCountdownText(window, window.role, config, nowMs);
    if (reset) part += ` ${reset}`;
    return [part];
  });

  if (config.showCredits) {
    parts.push(...balances.map((balance) => formatProviderBalance(snapshot, balance)));
    if (legacyCredits && !balances.some((balance) => balance.id === "credits")) {
      parts.push(`cr:${legacyCredits}`);
    }
  }
  const body = parts.join(" ");
  if (!body) return "";
  const label = shouldShowProviderLabel(snapshot)
    ? `${snapshot.label} `
    : snapshot.stale
      ? "~"
      : "";
  return `${snapshot.stale && label !== "~" ? "~" : ""}${label}${body}`;
}

export function providerStatusColor(
  snapshot: ProviderStatusSnapshot | undefined,
): "success" | "warning" | "error" | "dim" {
  if (!snapshot) return "dim";
  const compatibilityState = (snapshot as ProviderStatusSnapshot & { state?: string }).state;
  const state = compatibilityState === "ok" || compatibilityState === "warning" || compatibilityState === "error" || compatibilityState === "unavailable"
    ? compatibilityState
    : computeProviderStatusState(snapshot.windows ?? []);
  if (state === "unavailable") return "dim";
  if (state === "error") return "error";
  if (state === "warning") return "warning";
  return "success";
}

export interface ProviderStatusGaugeSegment extends GaugeSegment {
  id: string;
  label: string;
  role: "primary" | "secondary";
  usedPercent: number;
  resetAt?: number;
  usageUnknown?: true;
}

export function buildProviderStatusGauge(
  snapshot: ProviderStatusSnapshot | undefined,
  style: GaugeStyleDef,
  cells: number,
): ProviderStatusGaugeSegment[] {
  if (!snapshot) return [];
  return compatibilityWindows(snapshot).flatMap((window) => {
    if (window.usedPercent === undefined) return [];
    const gauge = buildGauge(window.usageUnknown ? 0 : window.usedPercent, style, cells);
    return [{
      id: window.id,
      label: window.label,
      role: window.role,
      usedPercent: window.usedPercent,
      ...(window.resetAt !== undefined ? { resetAt: window.resetAt } : {}),
      ...(window.usageUnknown ? { usageUnknown: true as const } : {}),
      ...gauge,
      ...(window.usageUnknown ? { percentText: "—" } : {}),
    }];
  });
}

export function formatResetCountdown(
  resetAt: number,
  nowMs = Date.now(),
): string {
  if (!Number.isFinite(resetAt) || !Number.isFinite(nowMs) || resetAt <= 0) return "";
  const remainingMs = resetAt * 1000 - nowMs;
  if (remainingMs <= 0) return "";
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (remainingMs >= dayMs) {
    const days = Math.floor(remainingMs / dayMs);
    const hours = Math.floor((remainingMs % dayMs) / hourMs);
    return `~${days}d${hours > 0 ? `${hours}h` : ""}`;
  }
  if (remainingMs >= hourMs) {
    const hours = Math.floor(remainingMs / hourMs);
    const minutes = Math.floor((remainingMs % hourMs) / minuteMs);
    return `~${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
  }
  if (remainingMs >= minuteMs) return `~${Math.floor(remainingMs / minuteMs)}m`;
  return "~now";
}

function modelTokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function scopeMatchesModel(scopeModel: string, model: ModelLike | string | undefined): boolean {
  const scopeTokens = modelTokens(scopeModel);
  if (scopeTokens.length === 0) return false;
  const candidates = typeof model === "string" ? [model] : model ? [model.id, model.name, model.displayName] : [];
  return candidates.some((candidate) => {
    if (typeof candidate !== "string") return false;
    const tokens = new Set(modelTokens(candidate));
    return scopeTokens.every((token) => tokens.has(token));
  });
}

export function projectProviderStatusForModel(snapshot: any, model: ModelLike | string | undefined): any {
  if (!snapshot?.scoped || snapshot.scoped.length === 0) return snapshot;
  const applicable = snapshot.scoped.filter((window: any) =>
    typeof window?.model === "string" && scopeMatchesModel(window.model, model),
  );
  if (applicable.length === 0) return snapshot;

  const compatibility = compatibilityWindows(snapshot);
  const baseWindow = (role: "primary" | "secondary") => {
    const original = snapshot[role];
    const fallback = compatibility.find((window) => window.role === role);
    if (!original && !fallback) return undefined;
    const usedPercent =
      typeof original?.usedPercent === "number"
        ? original.usedPercent
        : fallback?.usedPercent;
    return {
      ...(original ?? {}),
      label:
        typeof original?.label === "string"
          ? original.label
          : fallback?.label ?? (role === "primary" ? "5h" : "7d"),
      ...(usedPercent !== undefined
        ? {
            usedPercent,
            leftPercent:
              typeof original?.leftPercent === "number"
                ? original.leftPercent
                : Math.max(0, 100 - usedPercent),
          }
        : {}),
      ...(original?.resetAt === undefined && fallback?.resetAt !== undefined
        ? { resetAt: fallback.resetAt }
        : {}),
    };
  };
  const apply = (window: any) => {
    const matches = applicable.filter((candidate: any) => candidate.label === window?.label);
    if (matches.length === 0) return window;
    let strictest = window;
    for (const match of matches) {
      if (strictest && Number(match.usedPercent) <= Number(strictest.usedPercent)) continue;
      const { model: _model, ...replacement } = match;
      strictest = replacement;
    }
    return strictest;
  };
  const primary = apply(baseWindow("primary"));
  const secondary = apply(baseWindow("secondary"));
  const used = [primary, secondary]
    .filter(Boolean)
    .map((window: any) => Number(window.usedPercent))
    .filter(Number.isFinite);
  const max = used.length ? Math.max(...used) : Number.NaN;
  const state = !Number.isFinite(max)
    ? "unavailable"
    : max > 75
      ? "error"
      : max > 40
        ? "warning"
        : "ok";
  return {
    ...snapshot,
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    state,
  };
}

export interface CollectProviderStatusOptions {
  providerId?: string;
  force?: boolean;
  signal?: AbortSignal;
}

export async function collectProviderStatus(
  pi: ExtensionAPI,
  config: ProviderStatusConfigSnapshot,
  model?: ModelLike | string,
  options: CollectProviderStatusOptions = {},
): Promise<ProviderStatusSnapshot[]> {
  const registry = createProviderStatusRegistry(config.customProviders);
  const requestedSource = options.providerId
    ? (registry.get(options.providerId) ??
      (config.providers.includes(CODEX_SOURCE.id) &&
      isCodexProviderId(options.providerId)
        ? createCodexSource(options.providerId, options.providerId)
        : undefined))
    : undefined;
  const sources = options.providerId
    ? [requestedSource].filter(
        (source): source is ProviderStatusSource => source !== undefined,
      )
    : enabledProviderStatusSources(config, model);
  return Promise.all(
    sources.map((source) =>
      collectProviderStatusFromSource(pi, source, config, options),
    ),
  );
}

const providerStatusFlights = new Map<
  string,
  Promise<ProviderStatusSnapshot>
>();

async function collectProviderStatusFromSource(
  pi: ExtensionAPI,
  source: ProviderStatusSource,
  config: ProviderStatusConfigSnapshot,
  options: CollectProviderStatusOptions,
): Promise<ProviderStatusSnapshot> {
  const flightKey = source.cacheKey ?? source.id;
  const active = providerStatusFlights.get(flightKey);
  if (active) return active;

  const flight = collectProviderStatusFromSourceOnce(
    pi,
    source,
    config,
    options,
  );
  providerStatusFlights.set(flightKey, flight);
  try {
    return await flight;
  } finally {
    if (providerStatusFlights.get(flightKey) === flight) {
      providerStatusFlights.delete(flightKey);
    }
  }
}

async function collectProviderStatusFromSourceOnce(
  pi: ExtensionAPI,
  source: ProviderStatusSource,
  config: ProviderStatusConfigSnapshot,
  options: CollectProviderStatusOptions,
): Promise<ProviderStatusSnapshot> {
  const cacheKey = source.cacheKey ?? source.id;
  const cached = await readProviderStatusCache(cacheKey);
  if (!options.force && isProviderStatusFresh(cached, config.cacheTtlMs)) {
    return { ...cached, source: "cache" };
  }

  try {
    // Anthropic refreshes can be partial and report only the weekly window.
    // Codex refreshes are authoritative: OpenAI can remove a window and promote
    // the weekly window to primary, so retaining a missing window would show a
    // stale or duplicated quota.
    const fresh = await source.fetch(pi, { signal: options.signal });
    const merged = source.preserveMissingWindows
      ? mergeProviderStatus(displayableCachedStatus(cached), fresh)
      : fresh;
    const { error: _staleError, stale: _stale, ...snapshot } = merged;
    await writeProviderStatusCache(snapshot, cacheKey).catch(() => undefined);
    const scoped = (snapshot as ProviderStatusSnapshot & { scoped?: unknown[] }).scoped;
    if (Array.isArray(scoped) && scoped.length === 0) {
      const { scoped: _emptyScoped, ...visible } = snapshot as ProviderStatusSnapshot & {
        scoped?: unknown[];
      };
      return visible as ProviderStatusSnapshot;
    }
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
  if (windows.length === 0 && cached.balances.length === 0) return undefined;

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
  return toProviderStatusError(error);
}

export async function updateProviderStatusFromHeaders(
  headers: HeaderLike,
  config?: ProviderStatusConfigSnapshot,
  model?: ModelLike | string,
): Promise<ProviderStatusSnapshot[]> {
  const sources = config
    ? enabledProviderStatusSources(config, model)
    : PROVIDER_STATUS_SOURCES;

  const updated: ProviderStatusSnapshot[] = [];
  for (const source of sources) {
    const parsed = source.parseHeaders(headers);
    if (!parsed) continue;

    const cacheKey = source.cacheKey ?? source.id;
    const cached = await readProviderStatusCache(cacheKey);
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
    await writeProviderStatusCache(merged, cacheKey).catch(() => undefined);
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

  const {
    error: _existingError,
    stale: _existingStale,
    ...existingBase
  } = existing;
  const { error, stale, ...updateBase } = update;
  return {
    ...existingBase,
    ...updateBase,
    windows: Array.from(windows.values()).sort(
      (a, b) => windowDurationMinutes(a.label) - windowDurationMinutes(b.label),
    ),
    balances: Array.from(balances.values()),
    ...(stale ? { stale: true } : {}),
    ...(error ? { error } : {}),
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
    isCodexProviderId(snapshot.provider) &&
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

export function formatBalanceMetric(balance: BalanceMetric): string {
  const approximate = balance.approximate ? "≈" : "";
  if (balance.currency) {
    const symbol =
      balance.currency === "CNY"
        ? "¥"
        : balance.currency === "USD"
          ? "$"
          : `${balance.currency} `;
    return `${balance.label ? `${balance.label}:` : ""}${approximate}${symbol}${balance.value}`;
  }
  const unit = balance.unit ? ` ${balance.unit}` : "";
  return `${balance.label ? `${balance.label}:` : ""}${approximate}${balance.value}${unit}`;
}

export function formatProviderBalance(
  snapshot: ProviderStatusSnapshot,
  balance: BalanceMetric,
): string {
  if (isCodexProviderId(snapshot.provider) && balance.id === "credits") {
    return `cr:${balance.approximate ? "≈" : ""}${balance.value}`;
  }
  return formatBalanceMetric(balance);
}

export function shouldShowProviderLabel(
  snapshot: ProviderStatusSnapshot,
): boolean {
  return (
    snapshot.provider !== "openai-codex" && snapshot.provider !== "anthropic"
  );
}
