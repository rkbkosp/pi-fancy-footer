import type {
  DeclarativeRequestConfig,
  NumericTransform,
} from "../provider-status/types.ts";

export type PricingMode = "estimate-only" | "register-provider";

export interface PricingFieldConfig {
  id: string;
  input?: string;
  output?: string;
  cacheRead?: string;
  cacheWrite?: string;
}

export interface PricingConfig {
  mode: PricingMode;
  request: DeclarativeRequestConfig;
  modelsSelector: string;
  fields: PricingFieldConfig;
  transform?: NumericTransform;
  currency?: string;
  unit?: "per_token" | "per_million_tokens";
  refreshMs?: number;
  cacheTtlMs?: number;
}

export interface NormalizedModelPrice {
  id: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  currency: string;
  unit: "per_million_tokens";
}

export interface PricingCatalog {
  fetchedAt: string;
  source: "api" | "cache";
  prices: NormalizedModelPrice[];
  stale?: boolean;
  error?: string;
}
