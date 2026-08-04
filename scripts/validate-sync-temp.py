from pathlib import Path
import re


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"replacement not found in {path}: {old[:80]!r}")
    p.write_text(text.replace(old, new, 1))


def regex_replace_once(path: str, pattern: str, replacement: str) -> None:
    p = Path(path)
    text = p.read_text()
    next_text, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"regex replacement count={count} in {path}: {pattern[:80]!r}")
    p.write_text(next_text)


# 1. Reconcile provider reset configuration while retaining fork-only custom providers.
shared = Path("src/shared.ts")
text = shared.read_text()
text = text.replace(
'''  showCredits: boolean;
  showReset: boolean;
  customProviders: Record<string, DeclarativeProviderConfig>;
}''',
'''  showCredits: boolean;
  showReset: ProviderStatusResetMode;
  /** Inclusive displayed-used-percentage threshold for reset countdowns. */
  resetMinUsedPercent: number;
  customProviders: Record<string, DeclarativeProviderConfig>;
}''',
1,
)
text = text.replace(
'''  showCredits: false,
  showReset: false,
  customProviders: {},''',
'''  showCredits: false,
  showReset: "all",
  resetMinUsedPercent: 75,
  customProviders: {},''',
1,
)
shared.write_text(text)

config = Path("src/config.ts")
text = config.read_text()
if "const providerStatusResetModeSchema" not in text:
    text = text.replace(
        "const providerStatusDisplaySchema = literalUnion(PROVIDER_STATUS_DISPLAYS);",
        "const providerStatusDisplaySchema = literalUnion(PROVIDER_STATUS_DISPLAYS);\nconst providerStatusResetModeSchema = literalUnion(PROVIDER_STATUS_RESET_MODES);",
        1,
    )
text = text.replace(
    "    showReset: Type.Optional(Type.Boolean()),",
    '''    showReset: Type.Optional(providerStatusResetModeSchema),
    resetMinUsedPercent: Type.Optional(
      Type.Number({ minimum: 0, maximum: 100 }),
    ),''',
    1,
)
text = text.replace(
'''    showReset: input?.showReset ?? DEFAULT_PROVIDER_STATUS_CONFIG.showReset,
    customProviders: structuredClone(''',
'''    showReset: input?.showReset ?? DEFAULT_PROVIDER_STATUS_CONFIG.showReset,
    resetMinUsedPercent:
      input?.resetMinUsedPercent ??
      DEFAULT_PROVIDER_STATUS_CONFIG.resetMinUsedPercent,
    customProviders: structuredClone(''',
1,
)
config.write_text(text)

# 2. Preserve compatibility metadata in the modular provider status cache.
normalize = Path("src/provider-status/normalize.ts")
text = normalize.read_text()
text = text.replace(
'''  const error = normalizeError(obj.error);

  return {''',
'''  const error = normalizeError(obj.error);
  const scoped = Array.isArray(obj.scoped)
    ? obj.scoped
        .map((window) => normalizeScopedCompatibilityWindow(window))
        .filter((window): window is Record<string, unknown> => window !== undefined)
    : undefined;

  return {''',
1,
)
text = text.replace(
'''    balances,
    ...(obj.stale === true ? { stale: true } : {}),''',
'''    balances,
    ...(obj.primary && objectValue(obj.primary) ? { primary: obj.primary } : {}),
    ...(obj.secondary && objectValue(obj.secondary) ? { secondary: obj.secondary } : {}),
    ...(scoped !== undefined ? { scoped } : {}),
    ...(stringValue(obj.state) ? { state: stringValue(obj.state) } : {}),
    ...(stringValue(obj.credits) ? { credits: stringValue(obj.credits) } : {}),
    ...(obj.stale === true ? { stale: true } : {}),''',
1,
)
text = text.replace(
'''  const unit = stringValue(obj.unit);
  const resetAt = resetAtValue(obj.resetAt);''',
'''  const unit = stringValue(obj.unit);
  const resetAt = resetAtValue(obj.resetAt);
  if (obj.usageUnknown === true) normalized.usageUnknown = true;''',
1,
)
if "function normalizeScopedCompatibilityWindow" not in text:
    marker = "function normalizeSource(value: unknown): ProviderResourceSnapshot[\"source\"] {"
    helper = r'''function normalizeScopedCompatibilityWindow(
  value: unknown,
): Record<string, unknown> | undefined {
  const obj = objectValue(value);
  if (!obj) return undefined;
  const label = stringValue(obj.label);
  const model = stringValue(obj.model);
  const usedPercent = numberValue(obj.usedPercent);
  if (!label || !model || usedPercent === undefined) return undefined;
  const leftPercent = numberValue(obj.leftPercent) ?? clampPercent(100 - usedPercent);
  const resetAt = numberValue(obj.resetAt);
  return {
    label,
    model,
    usedPercent: clampPercent(usedPercent),
    leftPercent: clampPercent(leftPercent),
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(obj.usageUnknown === true ? { usageUnknown: true } : {}),
  };
}

'''
    text = text.replace(marker, helper + marker, 1)
normalize.write_text(text)

# 3. Anthropic: keep generic windows but also expose upstream model-scoped quota semantics.
anthropic = Path("src/provider-status/sources/anthropic.ts")
text = anthropic.read_text()
text = text.replace(
'''  objectValue,
  resetAtFromTimestamp,''',
'''  computeProviderStatusState,
  objectValue,
  resetAtFromTimestamp,''',
1,
)
pattern = r'''export function normalizeClaudeUsageResponse\(.*?\n}\n\nasync function fetchClaudeProviderStatus'''
replacement = r'''export function normalizeClaudeUsageResponse(
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

async function fetchClaudeProviderStatus'''
text, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
if count != 1:
    raise SystemExit(f"failed replacing Anthropic normalizer: {count}")
anthropic.write_text(text)

# 4. Provider status compatibility view: used quota, reset countdowns, and scoped projection.
provider = Path("src/provider-status/index.ts")
text = provider.read_text()
text = text.replace(
'''    normalized.includes("claude") ||
    /(^|-)(sonnet|opus|haiku)(?:-|$)/.test(normalized)''',
'''    normalized.includes("claude") ||
    /(^|-)(sonnet|opus|haiku|fable)(?:-|$)/.test(normalized)''',
1,
)

format_pattern = r'''export function formatProviderStatusText\(.*?\n}\n\nexport function providerStatusColor'''
format_replacement = r'''interface CompatibilityWindow {
  id: string;
  label: string;
  role: "primary" | "secondary";
  usedPercent?: number;
  resetAt?: number;
  usageUnknown?: boolean;
  raw?: QuotaWindow;
}

function compatibilityResetAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.round(value / 1000) : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.round(parsed / 1000) : undefined;
  }
  return undefined;
}

function compatibilityWindows(snapshot: ProviderStatusSnapshot): CompatibilityWindow[] {
  const legacy = snapshot as ProviderStatusSnapshot & {
    primary?: Record<string, unknown>;
    secondary?: Record<string, unknown>;
  };
  if (legacy.primary || legacy.secondary) {
    return ([
      ["primary", legacy.primary],
      ["secondary", legacy.secondary],
    ] as const).flatMap(([role, value]) => {
      if (!value) return [];
      const usedPercent = typeof value.usedPercent === "number" ? value.usedPercent : undefined;
      return [{
        id: typeof value.id === "string" ? value.id : typeof value.label === "string" ? value.label : role,
        label: typeof value.label === "string" ? value.label : role,
        role,
        ...(usedPercent !== undefined ? { usedPercent } : {}),
        ...(compatibilityResetAt(value.resetAt) !== undefined
          ? { resetAt: compatibilityResetAt(value.resetAt) }
          : {}),
        ...(value.usageUnknown === true ? { usageUnknown: true } : {}),
      }];
    });
  }

  return (snapshot.windows ?? []).map((window, index) => {
    const usedPercent =
      window.usedPercent !== undefined
        ? window.usedPercent
        : window.remainingPercent !== undefined
          ? 100 - window.remainingPercent
          : undefined;
    return {
      id: window.id,
      label: window.label,
      role: index === 0 ? "primary" : "secondary",
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(compatibilityResetAt(window.resetAt) !== undefined
        ? { resetAt: compatibilityResetAt(window.resetAt) }
        : {}),
      ...(window.usageUnknown === true ? { usageUnknown: true } : {}),
      raw: window,
    };
  });
}

function resetMode(config: Pick<ProviderStatusConfigSnapshot, "showReset">): "off" | "primary" | "all" {
  const value = config.showReset as unknown;
  if (value === true) return "primary";
  if (value === false) return "off";
  return value === "primary" || value === "all" ? value : "off";
}

export function resetCountdownText(
  window: Pick<CompatibilityWindow, "usedPercent" | "resetAt" | "usageUnknown">,
  role: "primary" | "secondary",
  config: Pick<ProviderStatusConfigSnapshot, "showReset" | "resetMinUsedPercent">,
  nowMs: number,
): string {
  const mode = resetMode(config);
  const roleEnabled = mode === "all" || (mode === "primary" && role === "primary");
  const displayed = window.usedPercent === undefined
    ? 0
    : Number.parseFloat(formatGaugePercent(window.usedPercent));
  const threshold = Number.isFinite(config.resetMinUsedPercent)
    ? config.resetMinUsedPercent
    : 75;
  if (
    !roleEnabled ||
    window.usageUnknown ||
    window.resetAt === undefined ||
    !Number.isFinite(displayed) ||
    displayed < threshold
  ) return "";
  return formatResetCountdown(window.resetAt, nowMs);
}

export function formatProviderStatusText(
  snapshot: ProviderStatusSnapshot | undefined,
  config: Pick<ProviderStatusConfigSnapshot, "showCredits" | "showReset" | "resetMinUsedPercent">,
  nowMs = Date.now(),
): string {
  if (!snapshot) return "";
  const windows = compatibilityWindows(snapshot);
  const balances = snapshot.balances ?? [];
  if (windows.length === 0 && (!config.showCredits || balances.length === 0)) return "";

  const parts = windows.flatMap((window) => {
    let part: string | undefined;
    if (window.usedPercent !== undefined) {
      part = `${window.label}:${formatGaugePercent(window.usedPercent)}`;
    } else if (window.raw) {
      const raw = window.raw;
      const unit = raw.unit ? ` ${raw.unit}` : "";
      if (raw.remaining !== undefined) part = `${window.label}:${raw.remaining}${unit}`;
      else if (raw.used !== undefined && raw.limit !== undefined) part = `${window.label}:${raw.used}/${raw.limit}${unit}`;
      else if (raw.used !== undefined) part = `${window.label}:${raw.used}${unit}`;
      else if (raw.limit !== undefined) part = `${window.label}:${raw.limit}${unit}`;
    }
    if (!part) return [];
    const reset = resetCountdownText(window, window.role, config, nowMs);
    if (reset) part += ` ${reset}`;
    return [part];
  });

  if (config.showCredits) {
    parts.push(...balances.map((balance) => formatProviderBalance(snapshot, balance)));
  }
  const body = parts.join(" ");
  if (!body) return "";
  const label = shouldShowProviderLabel(snapshot)
    ? `${snapshot.label} `
    : snapshot.stale
      ? "~"
      : "";
  return `${snapshot.stale && label !== "~" ? "~" : ""}${label}${body}`;
}

export function providerStatusColor'''
text, count = re.subn(format_pattern, format_replacement, text, count=1, flags=re.S)
if count != 1:
    raise SystemExit(f"failed replacing provider text formatter: {count}")

text = text.replace(
'''  if (!snapshot) return "dim";
  const state = computeProviderStatusState(snapshot.windows);''',
'''  if (!snapshot) return "dim";
  const compatibilityState = (snapshot as ProviderStatusSnapshot & { state?: string }).state;
  const state = compatibilityState === "ok" || compatibilityState === "warning" || compatibilityState === "error" || compatibilityState === "unavailable"
    ? compatibilityState
    : computeProviderStatusState(snapshot.windows ?? []);''',
1,
)

gauge_pattern = r'''export interface ProviderStatusGaugeSegment extends GaugeSegment \{.*?\n}\n\n\nexport function formatResetCountdown'''
gauge_replacement = r'''export interface ProviderStatusGaugeSegment extends GaugeSegment {
  id: string;
  label: string;
  role: "primary" | "secondary";
  usedPercent: number;
  resetAt?: number;
  usageUnknown?: true;
}

export function buildProviderStatusGauge(
  snapshot: ProviderStatusSnapshot | undefined,
  style: GaugeStyleDef,
  cells: number,
): ProviderStatusGaugeSegment[] {
  if (!snapshot) return [];
  return compatibilityWindows(snapshot).flatMap((window) => {
    if (window.usedPercent === undefined) return [];
    const gauge = buildGauge(window.usageUnknown ? 0 : window.usedPercent, style, cells);
    return [{
      id: window.id,
      label: window.label,
      role: window.role,
      usedPercent: window.usedPercent,
      ...(window.resetAt !== undefined ? { resetAt: window.resetAt } : {}),
      ...(window.usageUnknown ? { usageUnknown: true as const } : {}),
      ...gauge,
      ...(window.usageUnknown ? { percentText: "—" } : {}),
    }];
  });
}

export function formatResetCountdown'''
text, count = re.subn(gauge_pattern, gauge_replacement, text, count=1, flags=re.S)
if count != 1:
    raise SystemExit(f"failed replacing provider gauge builder: {count}")
provider.write_text(text)

# 5. Render reset countdowns beside the matching gauge and support both old/new 10th arguments.
render = Path("src/render.ts")
text = render.read_text()
text = text.replace("  formatProviderStatusReset,\n", "", 1)
if "  resetCountdownText," not in text:
    text = text.replace("  providerStatusColor,\n", "  providerStatusColor,\n  resetCountdownText,\n", 1)

render_provider_pattern = r'''function buildProviderStatusPart\(.*?\n}\n\nfunction getUsageData'''
render_provider_replacement = r'''function buildProviderStatusPart(
  snapshot: ProviderStatusSnapshot,
  config: Pick<
    ProviderStatusConfigSnapshot,
    "display" | "showCredits" | "showReset" | "resetMinUsedPercent"
  >,
  barStyle: GaugeStyleDef,
  gaugeWidth: number,
  gaugeColors: GaugeColorsSnapshot,
  theme: Theme,
  defaultTextColor: WidgetRenderContext["defaultTextColor"],
  nowMs: number,
): string {
  const text = formatProviderStatusText(snapshot, config, nowMs);
  if (!text) return "";

  const gauge =
    config.display === "gauge"
      ? buildProviderStatusGauge(snapshot, barStyle, gaugeWidth)
      : [];
  let body: string;
  if (gauge.length > 0) {
    const pieces = gauge.map((segment) => {
      let piece =
        theme.fg(defaultTextColor, `${segment.label} `) +
        theme.fg(
          gaugeColorFor(segment.color, gaugeColors),
          segment.filledGlyphs,
        ) +
        theme.fg("dim", segment.emptyGlyphs) +
        theme.fg(defaultTextColor, ` ${segment.percentText}`);
      const reset = resetCountdownText(segment, segment.role, config, nowMs);
      if (reset) piece += theme.fg("dim", ` ${reset}`);
      return piece;
    });
    const extras = config.showCredits
      ? (snapshot.balances ?? []).map((balance) => formatProviderBalance(snapshot, balance))
      : [];
    const providerLabel = shouldShowProviderLabel(snapshot)
      ? `${snapshot.label} `
      : "";
    body =
      theme.fg(
        snapshot.stale ? "dim" : defaultTextColor,
        `${snapshot.stale ? "~" : ""}${providerLabel}`,
      ) +
      pieces.join(" ") +
      (extras.length > 0 ? theme.fg(defaultTextColor, ` ${extras.join(" ")}`) : "");
  } else {
    const color = providerStatusColor(snapshot);
    body = theme.fg(
      color === "dim" ? defaultTextColor : gaugeColorFor(color, gaugeColors),
      text,
    );
  }

  return body;
}

function getUsageData'''
text, count = re.subn(render_provider_pattern, render_provider_replacement, text, count=1, flags=re.S)
if count != 1:
    raise SystemExit(f"failed replacing render provider part: {count}")

old_signature = '''  extensionWidgets: readonly NormalizedFancyFooterDataWidget[] = [],
  providerStatuses: readonly ProviderStatusSnapshot[] = [],
  extensionStatuses: ReadonlyMap<string, string> = new Map(),
): string[] {
  if (width <= 0) return ["", ""];
'''
new_signature = '''  extensionWidgets: readonly NormalizedFancyFooterDataWidget[] = [],
  providerStatuses: readonly ProviderStatusSnapshot[] = [],
  extensionStatusesOrNowMs: ReadonlyMap<string, string> | number = new Map(),
  maybeNowMs = Date.now(),
): string[] {
  if (width <= 0) return ["", ""];
  const extensionStatuses =
    typeof extensionStatusesOrNowMs === "number"
      ? new Map<string, string>()
      : extensionStatusesOrNowMs;
  const nowMs =
    typeof extensionStatusesOrNowMs === "number"
      ? extensionStatusesOrNowMs
      : maybeNowMs;
'''
if old_signature not in text:
    raise SystemExit("renderFooterLines signature marker not found")
text = text.replace(old_signature, new_signature, 1)
render.write_text(text)
