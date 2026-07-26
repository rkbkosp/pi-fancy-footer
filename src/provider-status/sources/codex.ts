import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  ProviderStatusSnapshot,
  ProviderStatusWindow,
} from "../../shared.ts";
import { refreshAuth, resolveCodexAuth } from "../auth.ts";
import {
  computeProviderStatusState,
  normalizeResetAt,
  numberString,
  numberValue,
  objectValue,
  stringValue,
  windowFromUsedPercent,
  windowLabelFromSeconds,
} from "../normalize.ts";
import type { HeaderLike, ProviderStatusSource } from "../types.ts";

export const CODEX_USAGE_URL = "https://chatgpt.com/codex/settings/usage";
const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_PRIMARY_WINDOW_LABEL = "5h";
export const CODEX_SECONDARY_WINDOW_LABEL = "7d";

export const CODEX_SOURCE: ProviderStatusSource = {
  id: "openai-codex",
  label: "Codex",
  usageUrl: CODEX_USAGE_URL,
  preserveMissingWindows: false,
  fetch: fetchCodexProviderStatus,
  parseHeaders: parseCodexRateLimitHeaders,
};

export function parseCodexRateLimitHeaders(
  headers: HeaderLike,
  now = new Date(),
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
  const credits = headerValue(headers, "x-codex-credits-balance");
  if (!primary && !secondary && credits === undefined) return undefined;

  return {
    provider: "openai-codex",
    source: "headers",
    fetchedAt: now.toISOString(),
    state: computeProviderStatusState(primary, secondary),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(credits ? { credits } : {}),
    url: CODEX_USAGE_URL,
  };
}

export function normalizeCodexUsageResponse(
  value: unknown,
  now = new Date(),
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
  const credits = stringValue(creditsObj?.balance);
  if (!primary && !secondary && credits === undefined) return undefined;

  return {
    provider: "openai-codex",
    source: "api",
    fetchedAt: now.toISOString(),
    state: computeProviderStatusState(primary, secondary),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(credits !== undefined ? { credits } : {}),
    url: CODEX_USAGE_URL,
  };
}

async function fetchCodexProviderStatus(
  _pi: ExtensionAPI,
): Promise<ProviderStatusSnapshot> {
  let auth = await resolveCodexAuth();

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
      const parsed = normalizeCodexUsageResponse(JSON.parse(text));
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

    throw new Error(
      `Codex usage request failed (${response.status}): ${text.slice(0, 500)}`,
    );
  }

  throw new Error("Codex usage request failed after auth refresh");
}

function parseHeaderWindow(
  headers: HeaderLike,
  prefix: string,
  label: string,
  now: Date,
): ProviderStatusWindow | undefined {
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
  return windowFromUsedPercent(
    durationLabel ?? label,
    usedPercent ?? 0,
    resetAt,
    now,
  );
}

function normalizeApiWindow(
  value: Record<string, unknown> | undefined,
  fallbackLabel: string,
  now: Date,
): ProviderStatusWindow | undefined {
  if (!value) return undefined;
  const usedPercent = numberValue(value.used_percent);
  const resetAt = normalizeResetAt(numberValue(value.reset_at));
  if (usedPercent === undefined && resetAt === undefined) return undefined;
  const label =
    windowLabelFromSeconds(numberValue(value.limit_window_seconds)) ??
    fallbackLabel;
  return windowFromUsedPercent(label, usedPercent ?? 0, resetAt, now);
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
