import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { estimateSessionCost, estimateUsageCost } from "./pricing/estimate.ts";
import {
  fetchRemotePricingCatalog,
  loadPricingCatalog,
} from "./pricing/fetch.ts";
import { normalizePricingResponse } from "./pricing/normalize.ts";
import type { PricingConfig } from "./pricing/types.ts";

const baseConfig: PricingConfig = {
  mode: "estimate-only",
  request: { url: "https://example.com/prices" },
  modelsSelector: "data.models",
  fields: {
    id: "name",
    input: "input_price",
    output: "output_price",
    cacheRead: "cache_read_price",
    cacheWrite: "cache_write_price",
  },
  currency: "USD",
  unit: "per_million_tokens",
};

test("normalizePricingResponse converts remote prices to per-million-token rates", () => {
  const prices = normalizePricingResponse(
    {
      data: {
        models: [
          {
            name: "model-a",
            input_price: 0.000002,
            output_price: 0.00001,
            cache_read_price: 0.000001,
            cache_write_price: 0.000003,
          },
        ],
      },
    },
    { ...baseConfig, unit: "per_token" },
  );
  assert.deepEqual(prices, [
    {
      id: "model-a",
      input: 2,
      output: 10,
      cacheRead: 1,
      cacheWrite: 3,
      currency: "USD",
      unit: "per_million_tokens",
    },
  ]);
});

test("pricing estimates input, output, and cache token costs", () => {
  const price = {
    id: "model-a",
    input: 2,
    output: 10,
    cacheRead: 1,
    cacheWrite: 3,
    currency: "USD",
    unit: "per_million_tokens" as const,
  };
  assert.equal(
    estimateUsageCost(
      {
        input: 1_000_000,
        output: 100_000,
        cacheRead: 500_000,
        cacheWrite: 10_000,
      },
      price,
    ),
    3.53,
  );
  assert.equal(
    estimateSessionCost(
      [
        {
          type: "message",
          message: {
            role: "assistant",
            provider: "proxy",
            model: "model-a",
            usage: { input: 1_000_000, output: 100_000 },
          },
        },
      ],
      { fetchedAt: new Date().toISOString(), source: "api", prices: [price] },
    ),
    3,
  );
});

test("fetchRemotePricingCatalog resolves auth without persisting raw responses", async (t) => {
  let authorization: string | undefined;
  const server = createServer((request, response) => {
    authorization = request.headers.authorization;
    response.end(
      JSON.stringify({
        data: {
          models: [{ name: "model-a", input_price: 2, output_price: 10 }],
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  process.env.PRICING_TEST_TOKEN = "pricing-secret";
  t.after(() => delete process.env.PRICING_TEST_TOKEN);

  const catalog = await fetchRemotePricingCatalog({
    ...baseConfig,
    request: {
      url: `http://127.0.0.1:${address.port}`,
      headers: { Authorization: "Bearer $PRICING_TEST_TOKEN" },
    },
  });
  assert.equal(authorization, "Bearer pricing-secret");
  assert.equal(catalog.prices[0]?.input, 2);
  assert.equal(catalog.prices[0]?.output, 10);
});

test("loadPricingCatalog uses an independent stale disk cache", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-fancy-footer-pricing-"));
  const previousCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = directory;
  t.after(async () => {
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCache;
    await rm(directory, { recursive: true, force: true });
  });
  let fail = false;
  const server = createServer((_request, response) => {
    if (fail) {
      response.statusCode = 500;
      response.end("failed");
      return;
    }
    response.end(
      JSON.stringify({
        data: {
          models: [{ name: "model-a", input_price: 2, output_price: 10 }],
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  const config: PricingConfig = {
    ...baseConfig,
    request: { url: `http://127.0.0.1:${address.port}` },
    cacheTtlMs: 0,
  };

  const fresh = await loadPricingCatalog(config, { force: true });
  assert.equal(fresh?.source, "api");
  fail = true;
  const cached = await loadPricingCatalog(config, { force: true });
  assert.equal(cached?.source, "cache");
  assert.equal(cached?.stale, true);
  assert.equal(cached?.prices[0]?.id, "model-a");
});

test("pricing failures without a cache do not block startup", async () => {
  const catalog = await loadPricingCatalog({
    ...baseConfig,
    request: { url: "http://127.0.0.1:1", timeoutMs: 10 },
  });
  assert.equal(catalog, undefined);
});
