import { defaultCacheReadPrice } from "./defaults.ts";
import type { NormalizedModelPrice, PricingCatalog } from "./types.ts";

interface UsageLike {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
}

interface SessionEntryLike {
  type: string;
  message?: {
    role?: string;
    model?: string;
    provider?: string;
    usage?: UsageLike;
  };
}

export function estimateSessionCost(
  entries: readonly SessionEntryLike[],
  catalog: PricingCatalog,
  fallbackModelId?: string,
  fallbackProviderId?: string,
): number | undefined {
  let total = 0;
  let priced = false;
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") {
      continue;
    }
    const usage = entry.message.usage;
    if (!usage) continue;
    const modelId = entry.message.model ?? fallbackModelId;
    const providerId = entry.message.provider ?? fallbackProviderId;
    const price = findModelPrice(catalog, modelId, providerId);
    if (!price) continue;
    total += estimateUsageCost(usage, price);
    priced = true;
  }
  return priced ? total : undefined;
}

export function estimateUsageCost(
  usage: UsageLike,
  price: NormalizedModelPrice,
): number {
  const input = tokenCount(usage.input);
  const output = tokenCount(usage.output);
  const cacheRead = tokenCount(usage.cacheRead);
  const cacheWrite = tokenCount(usage.cacheWrite);
  return (
    (input * (price.input ?? 0) +
      output * (price.output ?? 0) +
      cacheRead * (price.cacheRead ?? defaultCacheReadPrice(price.input) ?? 0) +
      cacheWrite * (price.cacheWrite ?? price.input ?? 0)) /
    1_000_000
  );
}

export function findModelPrice(
  catalog: PricingCatalog,
  modelId?: string,
  providerId?: string,
): NormalizedModelPrice | undefined {
  if (!modelId) return undefined;
  const qualified = providerId ? `${providerId}/${modelId}` : "";
  return catalog.prices.find(
    (price) => price.id === qualified || price.id === modelId,
  );
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}
