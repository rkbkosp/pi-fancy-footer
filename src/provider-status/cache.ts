import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeProviderResourceSnapshot } from "./normalize.ts";
import type { ProviderStatusSnapshot } from "./types.ts";

export interface CachedProviderSnapshot {
  version: 1;
  provider: string;
  savedAt: string;
  snapshot: ProviderStatusSnapshot;
}

export async function readProviderStatusCache(
  providerId: string,
): Promise<ProviderStatusSnapshot | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(providerStatusCachePath(providerId), "utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as { version?: unknown; snapshot?: unknown };
    return normalizeProviderResourceSnapshot(
      record.version === 1 ? record.snapshot : parsed,
    );
  } catch {
    return undefined;
  }
}

export async function writeProviderStatusCache(
  snapshot: ProviderStatusSnapshot,
  cacheKey = snapshot.provider,
): Promise<void> {
  const cached: CachedProviderSnapshot = {
    version: 1,
    provider: snapshot.provider,
    savedAt: new Date().toISOString(),
    snapshot,
  };
  await writeJsonAtomic(providerStatusCachePath(cacheKey), cached);
}

export function isProviderStatusFresh(
  snapshot: ProviderStatusSnapshot | undefined,
  maxAgeMs: number,
): snapshot is ProviderStatusSnapshot {
  if (!snapshot || maxAgeMs <= 0) return false;
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return false;
  const age = Date.now() - fetchedAt;
  return age >= 0 && age <= maxAgeMs;
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

function providerStatusCachePath(providerId: string): string {
  const base =
    process.env.XDG_CACHE_HOME ||
    join(process.env.HOME || process.env.USERPROFILE || ".", ".cache");
  const safeId = providerId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(base, "pi-fancy-footer", "provider-status", `${safeId}.json`);
}
