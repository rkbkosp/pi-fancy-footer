from pathlib import Path
import re

provider = Path("src/provider-status/index.ts")
text = provider.read_text()
text = text.replace(
'''      const label =
        typeof value?.label === "string"
          ? value.label
          : base?.label ?? role;''',
'''      const label =
        typeof value?.label === "string"
          ? value.label
          : base?.label ?? (role === "primary" ? "5h" : "7d");''',
1,
)

pattern = r'''export function projectProviderStatusForModel\(snapshot: any, model: ModelLike \| string \| undefined\): any \{.*?\n}\n\nexport interface CollectProviderStatusOptions'''
replacement = r'''export function projectProviderStatusForModel(snapshot: any, model: ModelLike | string | undefined): any {
  if (!snapshot?.scoped || snapshot.scoped.length === 0) return snapshot;
  const applicable = snapshot.scoped.filter((window: any) =>
    typeof window?.model === "string" && scopeMatchesModel(window.model, model),
  );
  if (applicable.length === 0) return snapshot;

  const compatibility = compatibilityWindows(snapshot);
  const baseWindow = (role: "primary" | "secondary") => {
    const original = snapshot[role];
    const fallback = compatibility.find((window) => window.role === role);
    if (!original && !fallback) return undefined;
    const usedPercent =
      typeof original?.usedPercent === "number"
        ? original.usedPercent
        : fallback?.usedPercent;
    return {
      ...(original ?? {}),
      label:
        typeof original?.label === "string"
          ? original.label
          : fallback?.label ?? (role === "primary" ? "5h" : "7d"),
      ...(usedPercent !== undefined
        ? {
            usedPercent,
            leftPercent:
              typeof original?.leftPercent === "number"
                ? original.leftPercent
                : Math.max(0, 100 - usedPercent),
          }
        : {}),
      ...(original?.resetAt === undefined && fallback?.resetAt !== undefined
        ? { resetAt: fallback.resetAt }
        : {}),
    };
  };
  const apply = (window: any) => {
    const matches = applicable.filter((candidate: any) => candidate.label === window?.label);
    if (matches.length === 0) return window;
    let strictest = window;
    for (const match of matches) {
      if (strictest && Number(match.usedPercent) <= Number(strictest.usedPercent)) continue;
      const { model: _model, ...replacement } = match;
      strictest = replacement;
    }
    return strictest;
  };
  const primary = apply(baseWindow("primary"));
  const secondary = apply(baseWindow("secondary"));
  const used = [primary, secondary]
    .filter(Boolean)
    .map((window: any) => Number(window.usedPercent))
    .filter(Number.isFinite);
  const max = used.length ? Math.max(...used) : Number.NaN;
  const state = !Number.isFinite(max)
    ? "unavailable"
    : max > 75
      ? "error"
      : max > 40
        ? "warning"
        : "ok";
  return {
    ...snapshot,
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    state,
  };
}

export interface CollectProviderStatusOptions'''
text, count = re.subn(pattern, lambda _: replacement, text, count=1, flags=re.S)
if count != 1:
    raise SystemExit(f"projectProviderStatusForModel replacement failed: {count}")
provider.write_text(text)
