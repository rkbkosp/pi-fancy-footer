import { refreshAuth, resolveCodexAuth } from "../auth.ts";
import {
  normalizeResetAt,
  numberString,
  numberValue,
  objectValue,
  stringValue,
  windowFromUsedPercent,
  windowLabelFromSeconds,
} from "../normalize.ts";
import type {
  HeaderLike,
  ProviderStatusSnapshot,
  ProviderStatusSource,
  QuotaWindow,
} from "../types.ts";

export const CODEX_USAGE_URL = "https://chatgpt.com/codex/settings/usage";
const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_PRIMARY_WINDOW_LABEL = "5h";
export const CODEX_SECONDARY_WINDOW_LABEL = "7d";

export function isCodexProviderId(providerId: string): boolean {
  const normalized = providerId.trim().toLowerCase();
  return normalized === "openai" || normalized.includes("codex");
}

export function createCodexSource(
  providerId = "openai-codex",
  label = providerId === "openai-codex" ? "Codex" : providerId,
): ProviderStatusSource {
  return {
    id: providerId,
    label,
    usageUrl: CODEX_USAGE_URL,
    preserveMissingWindows: false,
    kind: "builtin",
    supports: (candidate) =>
      candidate === providerId ||
      (providerId === "openai-codex" && candidate === "openai"),
    fetch: (_pi, _context) => fetchCodexProviderStatus(providerId, label),
    parseHeaders: (headers) =>
      parseCodexRateLimitHeaders(headers, new Date(), providerId, label),
  };
}

export const CODEX_SOURCE: ProviderStatusSource = createCodexSource();

export function parseCodexRateLimitHeaders(
  headers: HeaderLike,
  now = new Date(),
  providerId = "openai-codex",
  label = providerId === "openai-codex" ? "Codex" : providerId,
): ProviderStatusSnapshot | undefined {
  const primary = parseHeaderWindow(
    headers,
    "x-codex-primary",
    CODEX_PRIMARY_WINDOW_LABEL,
    now,
  );
  const secondary = parseHeaderWindow(
    headers,
    "x-codex-secondary",
    CODEX_SECONDARY_WINDOW_LABEL,
    now,
  );
  const credits = numberString(headerValue(headers, "x-codex-credits-balance"));
  if (!primary && !secondary && credits === undefined) return undefined;

  return {
    provider: providerId,
    label,
    source: "headers",
    fetchedAt: now.toISOString(),
    windows: [primary, secondary].filter(
      (window): window is QuotaWindow => window !== undefined,
    ),
    balances:
      credits === undefined
        ? []
        : [{ id: "credits", value: credits, unit: "credits" }],
    url: CODEX_USAGE_URL,
  };
}

export function normalizeCodexUsageResponse(
  value: unknown,
  now = new Date(),
  providerId = "openai-codex",
  label = providerId === "openai-codex" ? "Codex" : providerId,
): ProviderStatusSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const obj = value as Record<string, unknown>;
  const rateLimit = objectValue(obj.rate_limit);
  const primary = normalizeApiWindow(
    objectValue(rateLimit?.primary_window),
    CODEX_PRIMARY_WINDOW_LABEL,
    now,
  );
  const secondary = normalizeApiWindow(
    objectValue(rateLimit?.secondary_window),
    CODEX_SECONDARY_WINDOW_LABEL,
    now,
  );
  const creditsObj = objectValue(obj.credits);
  const credits = numberString(stringValue(creditsObj?.balance));
  if (!primary && !secondary && credits === undefined) return undefined;

  return {
    provider: providerId,
    label,
    source: "api",
    fetchedAt: now.toISOString(),
    windows: [primary, secondary].filter(
      (window): window is QuotaWindow => window !== undefined,
    ),
    balances:
      credits === undefined
        ? []
        : [{ id: "credits", value: credits, unit: "credits" }],
    url: CODEX_USAGE_URL,
  };
}

async function fetchCodexProviderStatus(
  providerId: string,
  label: string,
): Promise<ProviderStatusSnapshot> {
  let auth = await resolveCodexAuth(providerId);

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(CODEX_USAGE_ENDPOINT, {
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        accept: "application/json",
        "user-agent": "pi-fancy-footer",
        ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
      },
    });
    const text = await response.text();

    if (response.ok) {
      const parsed = normalizeCodexUsageResponse(
        JSON.parse(text),
        new Date(),
        providerId,
        label,
      );
      if (parsed) return parsed;
      throw new Error("Codex usage response did not contain quota data");
    }

    if (
      (response.status === 401 || response.status === 403) &&
      attempt === 0 &&
      auth.refreshToken
    ) {
      auth = await refreshAuth(auth);
      continue;
    }

    throw new Error(`Codex usage request failed (${response.status})`);
  }

  throw new Error("Codex usage request failed after auth refresh");
}

function parseHeaderWindow(
  headers: HeaderLike,
  prefix: string,
  label: string,
  now: Date,
): QuotaWindow | undefined {
  const usedPercent = numberString(
    headerValue(headers, `${prefix}-used-percent`),
  );
  const resetAt = normalizeResetAt(
    numberString(headerValue(headers, `${prefix}-reset-at`)),
  );
  const windowMinutes = numberString(
    headerValue(headers, `${prefix}-window-minutes`),
  );
  if (usedPercent === undefined && resetAt === undefined) return undefined;
  const durationLabel =
    windowMinutes === undefined
      ? undefined
      : windowLabelFromSeconds(windowMinutes * 60);
  const windowLabel = durationLabel ?? label;
  return windowFromUsedPercent(
    windowLabel,
    windowLabel,
    usedPercent ?? 0,
    resetAt,
    now,
  );
}

function normalizeApiWindow(
  value: Record<string, unknown> | undefined,
  fallbackLabel: string,
  now: Date,
): QuotaWindow | undefined {
  if (!value) return undefined;
  const usedPercent = numberValue(value.used_percent);
  const resetAt = normalizeResetAt(numberValue(value.reset_at));
  if (usedPercent === undefined && resetAt === undefined) return undefined;
  const label =
    windowLabelFromSeconds(numberValue(value.limit_window_seconds)) ??
    fallbackLabel;
  return windowFromUsedPercent(label, label, usedPercent ?? 0, resetAt, now);
}

function headerValue(headers: HeaderLike, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && value !== undefined && value !== null) {
      return String(value);
    }
  }
  return undefined;
}
