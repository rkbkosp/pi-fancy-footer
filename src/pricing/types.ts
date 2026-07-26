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

export interface PricingFallbackCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface PricingRegistrationModel {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  fallbackCost?: PricingFallbackCost;
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
}

export interface PricingProviderRegistration {
  id: string;
  name?: string;
  baseUrl: string;
  apiKey?: string;
  api: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models: PricingRegistrationModel[];
}

export interface PricingConfig {
  mode: PricingMode;
  matchProviders?: string[];
  request: DeclarativeRequestConfig;
  modelsSelector: string;
  fields: PricingFieldConfig;
  transform?: NumericTransform;
  currency?: string;
  unit?: "per_token" | "per_million_tokens";
  refreshMs?: number;
  cacheTtlMs?: number;
  registration?: PricingProviderRegistration;
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
