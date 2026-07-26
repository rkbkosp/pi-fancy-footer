import type {
  ExtensionAPI,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { defaultCacheReadPrice } from "./defaults.ts";
import { findModelPrice } from "./estimate.ts";
import type {
  PricingCatalog,
  PricingConfig,
  PricingProviderRegistration,
} from "./types.ts";

export function registerProviderWithPricing(
  pi: ExtensionAPI,
  config: PricingConfig,
  catalog?: PricingCatalog,
): boolean {
  if (config.mode !== "register-provider" || !config.registration) return false;
  const registration = config.registration;
  pi.registerProvider(
    registration.id,
    buildProviderConfig(registration, catalog),
  );
  return true;
}

export function buildProviderConfig(
  registration: PricingProviderRegistration,
  catalog?: PricingCatalog,
): ProviderConfig {
  return {
    ...(registration.name ? { name: registration.name } : {}),
    baseUrl: registration.baseUrl,
    ...(registration.apiKey ? { apiKey: registration.apiKey } : {}),
    api: registration.api,
    ...(registration.headers ? { headers: { ...registration.headers } } : {}),
    ...(registration.authHeader !== undefined
      ? { authHeader: registration.authHeader }
      : {}),
    models: registration.models.map((model) => {
      const remote = catalog
        ? findModelPrice(catalog, model.id, registration.id)
        : undefined;
      const usableRemote = remote?.currency === "USD" ? remote : undefined;
      const fallback = model.fallbackCost ?? {};
      const inputCost = usableRemote?.input ?? fallback.input ?? 0;
      return {
        id: model.id,
        name: model.name ?? model.id,
        ...(model.api ? { api: model.api } : {}),
        ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
        reasoning: model.reasoning ?? false,
        input: model.input ?? ["text"],
        cost: {
          input: inputCost,
          output: usableRemote?.output ?? fallback.output ?? 0,
          cacheRead:
            usableRemote?.cacheRead ??
            fallback.cacheRead ??
            defaultCacheReadPrice(inputCost) ??
            0,
          cacheWrite:
            usableRemote?.cacheWrite ?? fallback.cacheWrite ?? inputCost,
        },
        contextWindow: model.contextWindow ?? 128_000,
        maxTokens: model.maxTokens ?? 16_384,
        ...(model.headers ? { headers: { ...model.headers } } : {}),
      };
    }),
  };
}
