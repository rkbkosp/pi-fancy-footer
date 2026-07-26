import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { refreshAuth, resolveClaudeAuth } from "../auth.ts";
import {
  numberString,
  numberValue,
  objectValue,
  resetAtFromTimestamp,
  stringValue,
  windowFromUsedPercent,
} from "../normalize.ts";
import type {
  ProviderStatusSnapshot,
  ProviderStatusSource,
  QuotaWindow,
} from "../types.ts";

export const CLAUDE_USAGE_URL = "https://claude.ai/settings/usage";
const CLAUDE_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_PRIMARY_WINDOW_LABEL = "5h";
const CLAUDE_SECONDARY_WINDOW_LABEL = "7d";

export const ANTHROPIC_SOURCE: ProviderStatusSource = {
  id: "anthropic",
  label: "Claude",
  usageUrl: CLAUDE_USAGE_URL,
  preserveMissingWindows: true,
  fetch: fetchClaudeProviderStatus,
  parseHeaders: () => undefined,
};

export function normalizeClaudeUsageResponse(
  value: unknown,
  now = new Date(),
): ProviderStatusSnapshot | undefined {
  const obj = objectValue(value);
  if (!obj) return undefined;

  const primary = normalizeClaudeUsageWindow(
    objectValue(obj.five_hour),
    CLAUDE_PRIMARY_WINDOW_LABEL,
    now,
  );
  const secondary = normalizeClaudeUsageWindow(
    objectValue(obj.seven_day),
    CLAUDE_SECONDARY_WINDOW_LABEL,
    now,
  );
  if (!primary && !secondary) return undefined;

  return {
    provider: "anthropic",
    label: "Claude",
    source: "api",
    fetchedAt: now.toISOString(),
    windows: [primary, secondary].filter(
      (window): window is QuotaWindow => window !== undefined,
    ),
    balances: [],
    url: CLAUDE_USAGE_URL,
  };
}

async function fetchClaudeProviderStatus(
  _pi: ExtensionAPI,
): Promise<ProviderStatusSnapshot> {
  let auth = await resolveClaudeAuth();

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(CLAUDE_USAGE_ENDPOINT, {
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        accept: "application/json",
        "user-agent": "pi-fancy-footer",
      },
    });
    const text = await response.text();

    if (response.ok) {
      const parsed = normalizeClaudeUsageResponse(JSON.parse(text));
      if (parsed) return parsed;
      throw new Error("Claude usage response did not contain quota data");
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
      `Claude usage request failed (${response.status}): ${text.slice(0, 500)}`,
    );
  }

  throw new Error("Claude usage request failed after auth refresh");
}

function normalizeClaudeUsageWindow(
  value: Record<string, unknown> | undefined,
  fallbackLabel: string,
  now: Date,
): QuotaWindow | undefined {
  if (!value) return undefined;
  const usedPercent =
    numberValue(value.utilization) ??
    numberString(stringValue(value.utilization));
  if (usedPercent === undefined) return undefined;

  return windowFromUsedPercent(
    fallbackLabel,
    fallbackLabel,
    usedPercent,
    resetAtFromTimestamp(stringValue(value.resets_at)),
    now,
  );
}
