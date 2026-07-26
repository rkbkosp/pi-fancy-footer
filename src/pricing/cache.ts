import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PricingCatalog, PricingConfig } from "./types.ts";

interface CachedPricingCatalog {
  version: 1;
  savedAt: string;
  catalog: PricingCatalog;
}

export async function readPricingCache(
  config: PricingConfig,
): Promise<PricingCatalog | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(pricingCachePath(config), "utf8"),
    ) as CachedPricingCatalog;
    if (parsed.version !== 1 || !Array.isArray(parsed.catalog?.prices)) {
      return undefined;
    }
    return parsed.catalog;
  } catch {
    return undefined;
  }
}

export async function writePricingCache(
  config: PricingConfig,
  catalog: PricingCatalog,
): Promise<void> {
  const path = pricingCachePath(config);
  await mkdir(dirname(path), { recursive: true });
  const value: CachedPricingCatalog = {
    version: 1,
    savedAt: new Date().toISOString(),
    catalog,
  };
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

export function isPricingCacheFresh(
  catalog: PricingCatalog | undefined,
  maxAgeMs: number,
): catalog is PricingCatalog {
  if (!catalog) return false;
  const fetchedAt = Date.parse(catalog.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return false;
  const age = Date.now() - fetchedAt;
  return age >= 0 && age <= maxAgeMs;
}

function pricingCachePath(config: PricingConfig): string {
  const base =
    process.env.XDG_CACHE_HOME ||
    join(process.env.HOME || process.env.USERPROFILE || ".", ".cache");
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        url: config.request.url,
        modelsSelector: config.modelsSelector,
        fields: config.fields,
      }),
    )
    .digest("hex")
    .slice(0, 20);
  return join(base, "pi-fancy-footer", "pricing", `${key}.json`);
}
