from pathlib import Path

render = Path("src/render.ts")
text = render.read_text()
old = '''        theme.fg("dim", segment.emptyGlyphs) +\n        theme.fg(defaultTextColor, ` ${segment.percentText}`),\n    );\n    const extras: string[] = [];'''
new = '''        theme.fg("dim", segment.emptyGlyphs) +\n        theme.fg(defaultTextColor, ` ${segment.percentText}`);\n      return piece;\n    });\n    const extras: string[] = [];'''
if old in text:
    render.write_text(text.replace(old, new, 1))

provider = Path("src/provider-status/index.ts")
text = provider.read_text()
marker = "export interface CollectProviderStatusOptions {"
if "export function formatResetCountdown(" not in text:
    insert = r'''
export function formatResetCountdown(
  resetAt: number,
  nowMs = Date.now(),
): string {
  if (!Number.isFinite(resetAt) || !Number.isFinite(nowMs) || resetAt <= 0) return "";
  const remainingMs = resetAt * 1000 - nowMs;
  if (remainingMs <= 0) return "";
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (remainingMs >= dayMs) {
    const days = Math.floor(remainingMs / dayMs);
    const hours = Math.floor((remainingMs % dayMs) / hourMs);
    return `~${days}d${hours > 0 ? `${hours}h` : ""}`;
  }
  if (remainingMs >= hourMs) {
    const hours = Math.floor(remainingMs / hourMs);
    const minutes = Math.floor((remainingMs % hourMs) / minuteMs);
    return `~${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
  }
  if (remainingMs >= minuteMs) return `~${Math.floor(remainingMs / minuteMs)}m`;
  return "~now";
}

function modelTokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function scopeMatchesModel(scopeModel: string, model: ModelLike | string | undefined): boolean {
  const scopeTokens = modelTokens(scopeModel);
  if (scopeTokens.length === 0) return false;
  const candidates = typeof model === "string" ? [model] : model ? [model.id, model.name, model.displayName] : [];
  return candidates.some((candidate) => {
    if (typeof candidate !== "string") return false;
    const tokens = new Set(modelTokens(candidate));
    return scopeTokens.every((token) => tokens.has(token));
  });
}

export function projectProviderStatusForModel(snapshot: any, model: ModelLike | string | undefined): any {
  if (!snapshot?.scoped || snapshot.scoped.length === 0) return snapshot;
  const applicable = snapshot.scoped.filter((window: any) =>
    typeof window?.model === "string" && scopeMatchesModel(window.model, model),
  );
  if (applicable.length === 0) return snapshot;
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
  const primary = apply(snapshot.primary);
  const secondary = apply(snapshot.secondary);
  if (primary === snapshot.primary && secondary === snapshot.secondary) return snapshot;
  const used = [primary, secondary].filter(Boolean).map((w: any) => Number(w.usedPercent)).filter(Number.isFinite);
  const max = used.length ? Math.max(...used) : Number.NaN;
  const state = !Number.isFinite(max) ? "unavailable" : max > 75 ? "error" : max > 40 ? "warning" : "ok";
  return { ...snapshot, ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}), state };
}

'''
    if marker not in text:
        raise SystemExit("provider status insertion marker not found")
    provider.write_text(text.replace(marker, insert + marker, 1))
