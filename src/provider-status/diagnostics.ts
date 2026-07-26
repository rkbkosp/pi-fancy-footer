import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProviderStatusConfigSnapshot } from "../shared.ts";
import { readProviderStatusCache } from "./cache.ts";
import {
  createProviderStatusRegistry,
  formatProviderStatusText,
} from "./index.ts";
import {
  CODEX_SOURCE,
  createCodexSource,
  isCodexProviderId,
} from "./sources/codex.ts";
import { fetchDeclarativeProvider } from "./sources/declarative.ts";
import type { ModelLike, ProviderStatusSnapshot } from "./types.ts";

export function listProviderStatusSources(
  config: ProviderStatusConfigSnapshot,
  model?: ModelLike | string,
): string[] {
  const currentProvider = modelProviderId(model);
  const codexEnabled = config.providers.includes("openai-codex");
  const lines = [
    builtinLine("openai-codex", codexEnabled),
    builtinLine("anthropic", config.providers.includes("anthropic")),
  ];
  if (
    codexEnabled &&
    currentProvider &&
    !CODEX_SOURCE.supports(currentProvider) &&
    isCodexProviderId(currentProvider)
  ) {
    lines.push(
      `${currentProvider.padEnd(16)} Codex clone matched: ${currentProvider}`,
    );
  }
  for (const [id, provider] of Object.entries(config.customProviders)) {
    const enabled = provider.enabled !== false;
    let match = "unmatched";
    if (currentProvider === id) match = `matched: ${id}`;
    else if (
      currentProvider &&
      provider.matchProviders?.includes(currentProvider)
    ) {
      match = `matched: ${currentProvider}`;
    } else if (provider.alwaysRefresh) match = "always refresh";
    lines.push(`${id.padEnd(16)} declarative ${enabled ? match : "disabled"}`);
  }
  return lines;
}

export async function testProviderStatusSource(
  pi: ExtensionAPI,
  config: ProviderStatusConfigSnapshot,
  providerId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const custom = config.customProviders[providerId];
  if (custom?.enabled === false) {
    throw new Error(`Provider ${providerId} is disabled`);
  }

  if (custom) {
    const result = await fetchDeclarativeProvider(providerId, custom, {
      signal,
    });
    return [
      `Provider: ${providerId}`,
      `Request: ${custom.request.method ?? "GET"} ${safeRequestUrl(custom.request.url)}`,
      `HTTP: ${result.http.status}`,
      `Latency: ${Math.round(result.http.latencyMs)} ms`,
      `Balance selectors: ${result.selectors.balances.successful}/${result.selectors.balances.total} success`,
      `Window selectors: ${result.selectors.windows.successful}/${result.selectors.windows.total} success`,
      `Result: ${snapshotSummary(result.snapshot)}`,
    ];
  }

  const registry = createProviderStatusRegistry(config.customProviders);
  const isCodexClone =
    config.providers.includes(CODEX_SOURCE.id) &&
    !CODEX_SOURCE.supports(providerId) &&
    isCodexProviderId(providerId);
  const source =
    registry.get(providerId) ??
    (isCodexClone ? createCodexSource(providerId, providerId) : undefined);
  if (!source || (!config.providers.includes(providerId) && !isCodexClone)) {
    throw new Error(`Unknown or disabled provider: ${providerId}`);
  }
  const startedAt = Date.now();
  const snapshot = await source.fetch(pi, { signal });
  return [
    `Provider: ${providerId}`,
    `Request: provider adapter`,
    `Latency: ${Date.now() - startedAt} ms`,
    `Result: ${snapshotSummary(snapshot)}`,
  ];
}

export async function debugProviderStatusSource(
  config: ProviderStatusConfigSnapshot,
  providerId: string,
): Promise<string[]> {
  const custom = config.customProviders[providerId];
  const registry = createProviderStatusRegistry(config.customProviders);
  const source =
    registry.get(providerId) ??
    (config.providers.includes(CODEX_SOURCE.id) &&
    !CODEX_SOURCE.supports(providerId) &&
    isCodexProviderId(providerId)
      ? createCodexSource(providerId, providerId)
      : undefined);
  if (!source && !custom) throw new Error(`Unknown provider: ${providerId}`);

  const cacheKey = source?.cacheKey ?? providerId;
  const cached = await readProviderStatusCache(cacheKey);
  const cacheAge = cached
    ? Math.max(
        0,
        Math.round((Date.now() - Date.parse(cached.fetchedAt)) / 1000),
      )
    : undefined;
  const endpoint = custom?.request.url ?? source?.usageUrl ?? "";
  return [
    `Provider: ${providerId}`,
    `Source: ${custom ? "declarative" : "builtin"}`,
    `Cache: ${cacheAge === undefined ? "empty" : `refreshed ${cacheAge}s ago`}`,
    `Endpoint host: ${endpointHost(endpoint)}`,
    `Snapshot: ${cached ? "valid" : "unavailable"}`,
    ...(cached?.error ? [`Error: ${cached.error.code}`] : []),
  ];
}

function builtinLine(id: string, enabled: boolean): string {
  return `${id.padEnd(16)} builtin     ${enabled ? "enabled" : "disabled"}`;
}

function modelProviderId(model: ModelLike | string | undefined): string {
  if (typeof model === "string") return model.trim().toLowerCase();
  if (!model) return "";
  const value = model.provider ?? model.providerId;
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function snapshotSummary(snapshot: ProviderStatusSnapshot): string {
  return (
    formatProviderStatusText(snapshot, {
      showCredits: true,
      showReset: false,
    }) || "no displayable metrics"
  );
}

function safeRequestUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<configured endpoint>";
  }
}

function endpointHost(value: string): string {
  try {
    return new URL(value).host || "unknown";
  } catch {
    return "unknown";
  }
}
