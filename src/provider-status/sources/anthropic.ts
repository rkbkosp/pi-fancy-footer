import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { refreshAuth, resolveClaudeAuth } from "../auth.ts";
import {
  numberString,
  numberValue,
  computeProviderStatusState,
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
  kind: "builtin",
  supports: (providerId) => providerId === "anthropic",
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
  const limits = normalizeClaudeLimits(obj.limits, now);
  const resolvedPrimary =
    primary ?? limits?.account.get(CLAUDE_PRIMARY_WINDOW_LABEL);
  const resolvedSecondary =
    secondary ?? limits?.account.get(CLAUDE_SECONDARY_WINDOW_LABEL);
  if (!resolvedPrimary && !resolvedSecondary) return undefined;

  const windows = [resolvedPrimary, resolvedSecondary].filter(
    (window): window is QuotaWindow => window !== undefined,
  );
  const legacyPrimary = resolvedPrimary
    ? compatibilityWindow(resolvedPrimary)
    : undefined;
  const legacySecondary = resolvedSecondary
    ? compatibilityWindow(resolvedSecondary)
    : undefined;
  return {
    provider: "anthropic",
    label: "Claude",
    source: "api",
    fetchedAt: now.toISOString(),
    windows,
    balances: [],
    state: computeProviderStatusState(windows),
    ...(legacyPrimary ? { primary: legacyPrimary } : {}),
    ...(legacySecondary ? { secondary: legacySecondary } : {}),
    ...(limits ? { scoped: limits.scoped } : {}),
    url: CLAUDE_USAGE_URL,
  } as ProviderStatusSnapshot;
}

interface ClaudeLimitWindows {
  account: Map<string, QuotaWindow>;
  scoped: Record<string, unknown>[];
}

function normalizeClaudeLimits(
  value: unknown,
  now: Date,
): ClaudeLimitWindows | undefined {
  if (!Array.isArray(value)) return undefined;

  const account = new Map<string, QuotaWindow>();
  const scoped = new Map<string, Record<string, unknown>>();
  const scopedIsActive = new Set<string>();

  for (const entry of value) {
    const limit = objectValue(entry);
    if (!limit) continue;
    const group = stringValue(limit.group);
    const label =
      group === "session"
        ? CLAUDE_PRIMARY_WINDOW_LABEL
        : group === "weekly"
          ? CLAUDE_SECONDARY_WINDOW_LABEL
          : undefined;
    const usedPercent = numberValue(limit.percent);
    if (!label || usedPercent === undefined) continue;

    const window = windowFromUsedPercent(
      label,
      label,
      usedPercent,
      resetAtFromTimestamp(stringValue(limit.resets_at)),
      now,
    );
    const scope = objectValue(limit.scope);
    if (!scope) {
      if (!account.has(label)) account.set(label, window);
      continue;
    }

    const model = stringValue(objectValue(scope.model)?.display_name);
    if (!model) continue;
    const key = `${label}\u0000${model.toLowerCase()}`;
    const active = limit.is_active === true;
    if (scoped.has(key) && !(active && !scopedIsActive.has(key))) continue;
    scoped.set(key, { ...compatibilityWindow(window), model });
    if (active) scopedIsActive.add(key);
  }

  return { account, scoped: Array.from(scoped.values()) };
}

function compatibilityWindow(window: QuotaWindow): Record<string, unknown> {
  const usedPercent = window.usedPercent ?? 0;
  const leftPercent = window.remainingPercent ?? Math.max(0, 100 - usedPercent);
  const resetMs = window.resetAt ? Date.parse(window.resetAt) : Number.NaN;
  return {
    label: window.label,
    usedPercent,
    leftPercent,
    ...(Number.isFinite(resetMs) ? { resetAt: Math.round(resetMs / 1000) } : {}),
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

    throw new Error(`Claude usage request failed (${response.status})`);
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
