from pathlib import Path
import re

provider = Path("src/provider-status/index.ts")
text = provider.read_text()

pattern = r'''function compatibilityWindows\(snapshot: ProviderStatusSnapshot\): CompatibilityWindow\[] \{.*?\n}\n\nfunction resetMode'''
replacement = r'''function compatibilityWindows(snapshot: ProviderStatusSnapshot): CompatibilityWindow[] {
  const legacy = snapshot as ProviderStatusSnapshot & {
    primary?: Record<string, unknown>;
    secondary?: Record<string, unknown>;
  };
  const generic = snapshot.windows ?? [];
  const builtinQuota =
    isCodexProviderId(snapshot.provider) || snapshot.provider === ANTHROPIC_SOURCE.id;

  const displayPercent = (window: QuotaWindow | undefined): number | undefined => {
    if (!window) return undefined;
    if (builtinQuota) {
      if (window.usedPercent !== undefined) return window.usedPercent;
      if (window.remainingPercent !== undefined) return 100 - window.remainingPercent;
      return undefined;
    }
    // Declarative/custom providers historically display remaining quota.
    if (window.remainingPercent !== undefined) return window.remainingPercent;
    if (window.usedPercent !== undefined) return 100 - window.usedPercent;
    return remainingPercent(window);
  };

  const hasLegacy = legacy.primary !== undefined || legacy.secondary !== undefined;
  if (hasLegacy) {
    return ([
      ["primary", legacy.primary, generic[0]],
      ["secondary", legacy.secondary, generic[1]],
    ] as const).flatMap(([role, value, base]) => {
      if (!value && !base) return [];
      const legacyUsed = typeof value?.usedPercent === "number" ? value.usedPercent : undefined;
      const usedPercent = legacyUsed ?? displayPercent(base);
      const label =
        typeof value?.label === "string"
          ? value.label
          : base?.label ?? role;
      const resetAt =
        compatibilityResetAt(value?.resetAt) ?? compatibilityResetAt(base?.resetAt);
      return [{
        id: typeof value?.id === "string" ? value.id : base?.id ?? label,
        label,
        role,
        ...(usedPercent !== undefined ? { usedPercent } : {}),
        ...(resetAt !== undefined ? { resetAt } : {}),
        ...(value?.usageUnknown === true || base?.usageUnknown === true
          ? { usageUnknown: true }
          : {}),
        ...(base ? { raw: base } : {}),
      }];
    });
  }

  return generic.map((window, index) => {
    const usedPercent = displayPercent(window);
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

function resetMode'''
text, count = re.subn(pattern, lambda _: replacement, text, count=1, flags=re.S)
if count != 1:
    raise SystemExit(f"compatibilityWindows replacement failed: {count}")

text = text.replace(
'''  const windows = compatibilityWindows(snapshot);
  const balances = snapshot.balances ?? [];
  if (windows.length === 0 && (!config.showCredits || balances.length === 0)) return "";
''',
'''  const windows = compatibilityWindows(snapshot);
  const balances = snapshot.balances ?? [];
  const legacyCredits = (snapshot as ProviderStatusSnapshot & { credits?: string }).credits;
  if (
    windows.length === 0 &&
    (!config.showCredits || (balances.length === 0 && !legacyCredits))
  ) return "";
''',
1,
)
text = text.replace(
'''  if (config.showCredits) {
    parts.push(...balances.map((balance) => formatProviderBalance(snapshot, balance)));
  }
''',
'''  if (config.showCredits) {
    parts.push(...balances.map((balance) => formatProviderBalance(snapshot, balance)));
    if (legacyCredits && !balances.some((balance) => balance.id === "credits")) {
      parts.push(`cr:${legacyCredits}`);
    }
  }
''',
1,
)
text = text.replace(
'''    await writeProviderStatusCache(snapshot, cacheKey).catch(() => undefined);
    return snapshot;
''',
'''    await writeProviderStatusCache(snapshot, cacheKey).catch(() => undefined);
    const scoped = (snapshot as ProviderStatusSnapshot & { scoped?: unknown[] }).scoped;
    if (Array.isArray(scoped) && scoped.length === 0) {
      const { scoped: _emptyScoped, ...visible } = snapshot as ProviderStatusSnapshot & {
        scoped?: unknown[];
      };
      return visible as ProviderStatusSnapshot;
    }
    return snapshot;
''',
1,
)
provider.write_text(text)

render = Path("src/render.ts")
text = render.read_text()
text = text.replace(
'''                gaugeColors,
                theme,
                defaultTextColor,
              ),''',
'''                gaugeColors,
                theme,
                defaultTextColor,
                nowMs,
              ),''',
1,
)
text = text.replace('''            showReset: false,''', '''            showReset: "off",''')
text = text.replace(
'''        const shortened = providerStatuses.map((snapshot) => ({
          ...snapshot,
          label:
            snapshot.label.length > 8
              ? `${snapshot.label.slice(0, 7)}…`
              : snapshot.label,
        }));''',
'''        const shortened = providerStatuses.map((snapshot) => {
          const label = snapshot.label ?? snapshot.provider;
          return {
            ...snapshot,
            label: label.length > 8 ? `${label.slice(0, 7)}…` : label,
          };
        });''',
1,
)
text = text.replace(
'''          balances: snapshot.balances.slice(0, 1),''',
'''          balances: (snapshot.balances ?? []).slice(0, 1),''',
1,
)
text = text.replace(
'''    const extras = config.showCredits
      ? (snapshot.balances ?? []).map((balance) => formatProviderBalance(snapshot, balance))
      : [];''',
'''    const extras = config.showCredits
      ? (snapshot.balances ?? []).map((balance) => formatProviderBalance(snapshot, balance))
      : [];
    const legacyCredits = (snapshot as ProviderStatusSnapshot & { credits?: string }).credits;
    if (
      config.showCredits &&
      legacyCredits &&
      !(snapshot.balances ?? []).some((balance) => balance.id === "credits")
    ) {
      extras.push(`cr:${legacyCredits}`);
    }''',
1,
)
render.write_text(text)
