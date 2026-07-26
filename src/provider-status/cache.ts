import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeProviderResourceSnapshot } from "./normalize.ts";
import type { ProviderStatusSnapshot } from "./types.ts";

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
    return normalizeProviderResourceSnapshot(parsed);
  } catch {
    return undefined;
  }
}

export async function writeProviderStatusCache(
  snapshot: ProviderStatusSnapshot,
): Promise<void> {
  await writeJsonAtomic(providerStatusCachePath(snapshot.provider), snapshot);
}

export function isProviderStatusFresh(
  snapshot: ProviderStatusSnapshot | undefined,
  maxAgeMs: number,
): snapshot is ProviderStatusSnapshot {
  if (!snapshot) return false;
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
  return join(base, "pi-fancy-footer", "provider-status", `${providerId}.json`);
}
