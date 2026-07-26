import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveEnvironmentString, resolveEnvironmentValue } from "../env.ts";
import { ProviderStatusFailure, toProviderStatusError } from "../errors.ts";
import { requestJson } from "../http-client.ts";
import { clampPercent, normalizeTimestamp } from "../normalize.ts";
import { selectJson } from "../selector.ts";
import { transformNumber } from "../transform.ts";
import type {
  BalanceMetric,
  DeclarativeProviderConfig,
  DeclarativeWindowConfig,
  ProviderResourceSnapshot,
  ProviderStatusFetchOptions,
  ProviderStatusSource,
  QuotaWindow,
} from "../types.ts";

export interface DeclarativeFetchDiagnostics {
  snapshot: ProviderResourceSnapshot;
  http: {
    status: number;
    latencyMs: number;
    endpointHost: string;
  };
  selectors: {
    balances: { successful: number; total: number };
    windows: { successful: number; total: number };
  };
}

export function createDeclarativeSource(
  id: string,
  config: DeclarativeProviderConfig,
): ProviderStatusSource {
  const label = config.label ?? id;
  const matchProviders = config.matchProviders ?? [];
  return {
    id,
    label,
    usageUrl: config.request.url,
    preserveMissingWindows: false,
    kind: "declarative",
    cacheKey: declarativeCacheKey(id, config.request.url),
    alwaysRefresh: config.alwaysRefresh ?? false,
    matchProviders,
    supports: (providerId) =>
      providerId === id || matchProviders.includes(providerId),
    fetch: async (_pi, options) =>
      (await fetchDeclarativeProvider(id, config, options)).snapshot,
    parseHeaders: () => undefined,
  };
}

export async function fetchDeclarativeProvider(
  id: string,
  config: DeclarativeProviderConfig,
  options: ProviderStatusFetchOptions = {},
): Promise<DeclarativeFetchDiagnostics> {
  validateDeclarativeConfig(config);
  const requestUrl = resolveEnvironmentString(config.request.url);
  const requestHeaders = Object.fromEntries(
    Object.entries(config.request.headers ?? {}).map(([name, value]) => [
      name,
      resolveEnvironmentString(value),
    ]),
  );
  const requestBody = resolveEnvironmentValue(config.request.body);
  const response = await requestJson({
    url: requestUrl,
    method: config.request.method ?? "GET",
    headers: requestHeaders,
    ...(requestBody === undefined ? {} : { body: requestBody }),
    timeoutMs: config.request.timeoutMs,
    maxResponseBytes: config.request.maxResponseBytes,
    followRedirects: config.request.followRedirects,
    signal: options.signal,
  });

  const errors: unknown[] = [];
  let successfulBalances = 0;
  const balances: BalanceMetric[] = [];
  for (const metric of config.balances ?? []) {
    try {
      const selected = selectRequired(response.data, metric.selector);
      balances.push({
        id: metric.id,
        value: transformNumber(selected, metric.transform),
        ...(metric.label ? { label: metric.label } : {}),
        ...(metric.currency ? { currency: metric.currency } : {}),
        ...(metric.unit ? { unit: metric.unit } : {}),
        ...(metric.approximate ? { approximate: true } : {}),
      });
      successfulBalances += 1;
    } catch (error) {
      errors.push(error);
    }
  }

  let successfulWindowSelectors = 0;
  let totalWindowSelectors = 0;
  const windows: QuotaWindow[] = [];
  for (const windowConfig of config.windows ?? []) {
    const window = normalizeDeclarativeWindow(
      response.data,
      windowConfig,
      errors,
      (successful) => {
        totalWindowSelectors += 1;
        if (successful) successfulWindowSelectors += 1;
      },
    );
    if (window) windows.push(window);
  }

  if (balances.length === 0 && windows.length === 0 && errors[0]) {
    throw errors[0];
  }

  const snapshot: ProviderResourceSnapshot = {
    provider: id,
    label: config.label ?? id,
    source: "api",
    fetchedAt: new Date().toISOString(),
    windows,
    balances,
    url: config.request.url,
    ...(errors[0] ? { error: toProviderStatusError(errors[0]) } : {}),
  };
  return {
    snapshot,
    http: {
      status: response.status,
      latencyMs: response.latencyMs,
      endpointHost: new URL(response.url).host,
    },
    selectors: {
      balances: {
        successful: successfulBalances,
        total: config.balances?.length ?? 0,
      },
      windows: {
        successful: successfulWindowSelectors,
        total: totalWindowSelectors,
      },
    },
  };
}

function normalizeDeclarativeWindow(
  data: unknown,
  config: DeclarativeWindowConfig,
  errors: unknown[],
  recordSelector: (successful: boolean) => void,
): QuotaWindow | undefined {
  const window: QuotaWindow = { id: config.id, label: config.label };
  let hasNumericMetric = false;

  for (const [selectorKey, outputKey] of [
    ["remainingPercentSelector", "remainingPercent"],
    ["usedPercentSelector", "usedPercent"],
    ["remainingSelector", "remaining"],
    ["usedSelector", "used"],
    ["limitSelector", "limit"],
  ] as const) {
    const selector = config[selectorKey];
    if (!selector) continue;
    try {
      const value = transformNumber(
        selectRequired(data, selector),
        config.transform,
      );
      window[outputKey] =
        outputKey === "remainingPercent" || outputKey === "usedPercent"
          ? clampPercent(value)
          : value;
      hasNumericMetric = true;
      recordSelector(true);
    } catch (error) {
      errors.push(error);
      recordSelector(false);
    }
  }

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
  if (config.unit) window.unit = config.unit;

  if (config.resetAtSelector) {
    try {
      const selected = selectRequired(data, config.resetAtSelector);
      const resetAt = normalizeTimestamp(
        selected,
        config.timestampUnit ?? "iso8601",
      );
      if (!resetAt) {
        throw new ProviderStatusFailure(
          "parse",
          `Invalid reset timestamp selected by ${config.resetAtSelector}`,
        );
      }
      window.resetAt = resetAt;
      recordSelector(true);
    } catch (error) {
      errors.push(error);
      recordSelector(false);
    }
  }

  return hasNumericMetric ? window : undefined;
}

function selectRequired(data: unknown, selector: string): unknown {
  const selected = selectJson(data, selector);
  if (selected === undefined || selected === null) {
    throw new ProviderStatusFailure(
      "selector",
      `JSON selector did not match a value: ${selector}`,
    );
  }
  return selected;
}

function validateDeclarativeConfig(config: DeclarativeProviderConfig): void {
  if (
    (config.request.method ?? "GET") === "GET" &&
    config.request.body !== undefined
  ) {
    throw new ProviderStatusFailure(
      "config",
      "GET provider requests cannot include a body",
    );
  }
  if (
    (config.balances?.length ?? 0) === 0 &&
    (config.windows?.length ?? 0) === 0
  ) {
    throw new ProviderStatusFailure(
      "config",
      "Declarative provider must configure at least one balance or window",
    );
  }
  for (const window of config.windows ?? []) {
    if (
      !window.remainingPercentSelector &&
      !window.usedPercentSelector &&
      !window.remainingSelector &&
      !window.usedSelector &&
      !window.limitSelector
    ) {
      throw new ProviderStatusFailure(
        "config",
        `Quota window ${window.id} must configure a numeric selector`,
      );
    }
  }
}

function declarativeCacheKey(id: string, endpoint: string): string {
  const digest = createHash("sha256")
    .update(endpoint)
    .digest("hex")
    .slice(0, 16);
  return `${id}-${digest}`;
}
