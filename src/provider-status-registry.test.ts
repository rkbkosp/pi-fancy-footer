import assert from "node:assert/strict";
import test from "node:test";
import { ProviderStatusRegistry } from "./provider-status/registry.ts";
import type { ProviderStatusSource } from "./provider-status/types.ts";

function source(
  id: string,
  supportedProviders: readonly string[],
): ProviderStatusSource {
  return {
    id,
    label: id,
    usageUrl: `https://example.com/${id}`,
    preserveMissingWindows: false,
    supports: (providerId) => supportedProviders.includes(providerId),
    async fetch() {
      return {
        provider: id,
        label: id,
        source: "api",
        fetchedAt: new Date(0).toISOString(),
        windows: [],
        balances: [],
      };
    },
    parseHeaders: () => undefined,
  };
}

test("ProviderStatusRegistry registers, gets, and lists sources", () => {
  const registry = new ProviderStatusRegistry();
  const alpha = source("alpha", ["model-provider"]);
  const beta = source("beta", ["other-provider"]);

  registry.register(alpha);
  registry.register(beta);

  assert.equal(registry.get("alpha"), alpha);
  assert.equal(registry.get("missing"), undefined);
  assert.deepEqual(registry.list(), [alpha, beta]);
});

test("ProviderStatusRegistry finds sources by provider support", () => {
  const registry = new ProviderStatusRegistry();
  const alpha = source("alpha", ["shared"]);
  const beta = source("beta", ["shared", "beta"]);
  registry.register(alpha);
  registry.register(beta);

  assert.deepEqual(registry.findForProvider("shared"), [alpha, beta]);
  assert.deepEqual(registry.findForProvider("beta"), [beta]);
  assert.deepEqual(registry.findForProvider("missing"), []);
});

test("ProviderStatusRegistry replaces an existing source with the same id", () => {
  const registry = new ProviderStatusRegistry();
  const original = source("alpha", ["old"]);
  const replacement = source("alpha", ["new"]);
  registry.register(original);
  registry.register(replacement);

  assert.equal(registry.get("alpha"), replacement);
  assert.deepEqual(registry.list(), [replacement]);
});
