import {
  resolveEnvironmentString,
  resolveEnvironmentValue,
} from "../provider-status/env.ts";
import { ProviderStatusFailure } from "../provider-status/errors.ts";
import { requestJson } from "../provider-status/http-client.ts";
import { redactSensitiveText } from "../provider-status/redact.ts";
import {
  isPricingCacheFresh,
  readPricingCache,
  writePricingCache,
} from "./cache.ts";
import { normalizePricingResponse } from "./normalize.ts";
import type { PricingCatalog, PricingConfig } from "./types.ts";

export const DEFAULT_PRICING_REFRESH_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_PRICING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function loadPricingCatalog(
  config: PricingConfig,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<PricingCatalog | undefined> {
  const cached = await readPricingCache(config);
  if (
    !options.force &&
    isPricingCacheFresh(
      cached,
      config.cacheTtlMs ?? DEFAULT_PRICING_CACHE_TTL_MS,
    )
  ) {
    return { ...cached, source: "cache" };
  }

  try {
    const catalog = await fetchRemotePricingCatalog(config, options.signal);
    await writePricingCache(config, catalog).catch(() => undefined);
    return catalog;
  } catch (error) {
    if (!cached) return undefined;
    return {
      ...cached,
      source: "cache",
      stale: true,
      error: redactSensitiveText(
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

export async function fetchRemotePricingCatalog(
  config: PricingConfig,
  signal?: AbortSignal,
): Promise<PricingCatalog> {
  const method = config.request.method ?? "GET";
  if (method === "GET" && config.request.body !== undefined) {
    throw new ProviderStatusFailure(
      "config",
      "GET pricing requests cannot include a body",
    );
  }
  const response = await requestJson({
    url: resolveEnvironmentString(config.request.url),
    method,
    headers: Object.fromEntries(
      Object.entries(config.request.headers ?? {}).map(([name, value]) => [
        name,
        resolveEnvironmentString(value),
      ]),
    ),
    ...(config.request.body === undefined
      ? {}
      : { body: resolveEnvironmentValue(config.request.body) }),
    timeoutMs: config.request.timeoutMs,
    maxResponseBytes: config.request.maxResponseBytes,
    followRedirects: config.request.followRedirects,
    signal,
  });
  return {
    fetchedAt: new Date().toISOString(),
    source: "api",
    prices: normalizePricingResponse(response.data, config),
  };
}
