import { ProviderStatusFailure } from "../provider-status/errors.ts";
import { selectJson } from "../provider-status/selector.ts";
import { transformNumber } from "../provider-status/transform.ts";
import { defaultCacheReadPrice } from "./defaults.ts";
import type {
  NormalizedModelPrice,
  PricingConfig,
  PricingFieldConfig,
} from "./types.ts";

export function normalizePricingResponse(
  value: unknown,
  config: Pick<
    PricingConfig,
    "modelsSelector" | "fields" | "transform" | "currency" | "unit"
  >,
): NormalizedModelPrice[] {
  const selected = selectJson(value, config.modelsSelector);
  if (!Array.isArray(selected)) {
    throw new ProviderStatusFailure(
      "selector",
      `Pricing models selector did not match an array: ${config.modelsSelector}`,
    );
  }

  const prices = selected.flatMap((item) => {
    const price = normalizeModelPrice(item, config.fields, config);
    return price ? [price] : [];
  });
  if (prices.length === 0) {
    throw new ProviderStatusFailure(
      "parse",
      "Pricing response did not contain usable model prices",
    );
  }
  return prices;
}

function normalizeModelPrice(
  value: unknown,
  fields: PricingFieldConfig,
  config: Pick<PricingConfig, "transform" | "currency" | "unit">,
): NormalizedModelPrice | undefined {
  const idValue = selectJson(value, fields.id);
  const id =
    typeof idValue === "string" || typeof idValue === "number"
      ? String(idValue)
      : "";
  if (!id) return undefined;

  const price: NormalizedModelPrice = {
    id,
    currency: config.currency ?? "USD",
    unit: "per_million_tokens",
  };
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const selector = fields[field];
    if (!selector) continue;
    const selected = selectJson(value, selector);
    if (selected === undefined || selected === null) continue;
    const normalized = transformNumber(selected, config.transform);
    price[field] =
      config.unit === "per_token" ? normalized * 1_000_000 : normalized;
  }
  price.cacheRead ??= defaultCacheReadPrice(price.input);
  return price.input === undefined && price.output === undefined
    ? undefined
    : price;
}
