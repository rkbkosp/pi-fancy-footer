import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { footerConfigValidationErrors } from "./config.ts";
import { collectProviderStatus } from "./provider-status.ts";
import {
  resolveEnvironmentString,
  resolveEnvironmentValue,
} from "./provider-status/env.ts";
import { requestJson } from "./provider-status/http-client.ts";
import { normalizeTimestamp } from "./provider-status/normalize.ts";
import { redactSensitiveText } from "./provider-status/redact.ts";
import { selectJson } from "./provider-status/selector.ts";
import { fetchDeclarativeProvider } from "./provider-status/sources/declarative.ts";
import { transformNumber } from "./provider-status/transform.ts";
import type { ProviderStatusConfigSnapshot } from "./shared.ts";

interface TestServer {
  url: string;
  close(): Promise<void>;
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function customStatusConfig(
  customProviders: ProviderStatusConfigSnapshot["customProviders"],
): ProviderStatusConfigSnapshot {
  return {
    refreshMs: 60_000,
    cacheTtlMs: 0,
    providers: [],
    display: "gauge",
    showCredits: true,
    showReset: true,
    customProviders,
  };
}

test("redactSensitiveText removes bearer tokens and API keys", () => {
  const redacted = redactSensitiveText(
    "Authorization: Bearer super-secret api_key=abc123 token: xyz987 sk-livevalue123",
  );
  assert.doesNotMatch(redacted, /super-secret|abc123|xyz987|sk-livevalue123/);
  assert.match(redacted, /REDACTED/);
});

test("selectJson supports object paths and array indexes", () => {
  const value = { data: { items: [{ remaining: 42 }], nullable: null } };
  assert.equal(selectJson(value, "data.items[0].remaining"), 42);
  assert.equal(selectJson(value, "data.missing"), undefined);
  assert.equal(selectJson(value, "data.nullable"), null);
  assert.equal(selectJson(value, "data.nullable.value"), undefined);
  assert.equal(selectJson({ data: 1 }, "data.value"), undefined);
});

test("selectJson rejects invalid and unsafe selectors", () => {
  for (const selector of [
    "",
    "data.",
    "data[-1]",
    "data[foo]",
    "__proto__.x",
  ]) {
    assert.throws(() => selectJson({}, selector), /Invalid JSON selector/);
  }
});

test("transformNumber applies transforms in the documented order", () => {
  assert.equal(
    transformNumber("20", {
      scale: 2,
      offset: 10,
      invertPercent: true,
      clamp: [0, 60],
      round: 2,
    }),
    50,
  );
  assert.equal(transformNumber(1.236, { round: 2 }), 1.24);
  assert.throws(() => transformNumber("NaN"), /finite numeric value/);
  assert.throws(
    () => transformNumber(Number.POSITIVE_INFINITY),
    /finite numeric/,
  );
  assert.throws(() => transformNumber(Number.NaN), /finite numeric/);
});

test("normalizeTimestamp handles seconds, milliseconds, ISO 8601, and invalid dates", () => {
  assert.equal(
    normalizeTimestamp(1_800_000_000, "seconds"),
    new Date(1_800_000_000 * 1000).toISOString(),
  );
  assert.equal(
    normalizeTimestamp(1_800_000_000_000, "milliseconds"),
    new Date(1_800_000_000_000).toISOString(),
  );
  assert.equal(
    normalizeTimestamp("2030-01-15T12:00:00Z", "iso8601"),
    "2030-01-15T12:00:00.000Z",
  );
  assert.equal(normalizeTimestamp("not-a-date", "iso8601"), undefined);
});

test("environment resolution supports bare and braced references recursively", () => {
  const env = { TOKEN: "secret", USER_ID: "42" };
  assert.equal(
    resolveEnvironmentString("Bearer $TOKEN/${USER_ID}", env),
    "Bearer secret/42",
  );
  assert.deepEqual(
    resolveEnvironmentValue({ id: "$USER_ID", values: ["${TOKEN}"] }, env),
    { id: "42", values: ["secret"] },
  );
  assert.throws(
    () => resolveEnvironmentString("$MISSING", env),
    /environment variable MISSING/,
  );
});

test("fetchDeclarativeProvider extracts balances and quota windows", async (t) => {
  const resetAt = Math.ceil(Date.now() / 1000) + 3600;
  const server = await listen((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, "Bearer test-secret");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        data: {
          quota: 42_130_000,
          usage: { percent: 27 },
          reset_at: resetAt,
        },
      }),
    );
  });
  t.after(() => server.close());
  process.env.TEST_PROVIDER_TOKEN = "test-secret";
  t.after(() => delete process.env.TEST_PROVIDER_TOKEN);

  const result = await fetchDeclarativeProvider("zero", {
    label: "0-0",
    request: {
      url: `${server.url}/usage`,
      headers: { Authorization: "Bearer $TEST_PROVIDER_TOKEN" },
    },
    balances: [
      {
        id: "remaining",
        selector: "data.quota",
        transform: { scale: 0.000002, round: 2 },
        currency: "CNY",
      },
    ],
    windows: [
      {
        id: "monthly",
        label: "月",
        usedPercentSelector: "data.usage.percent",
        resetAtSelector: "data.reset_at",
        timestampUnit: "seconds",
      },
    ],
  });

  assert.deepEqual(result.snapshot.balances, [
    { id: "remaining", value: 84.26, currency: "CNY" },
  ]);
  assert.equal(result.snapshot.windows[0]?.remainingPercent, 73);
  assert.equal(
    result.snapshot.windows[0]?.resetAt,
    new Date(resetAt * 1000).toISOString(),
  );
  assert.deepEqual(result.selectors, {
    balances: { successful: 1, total: 1 },
    windows: { successful: 2, total: 2 },
  });
});

test("fetchDeclarativeProvider sends resolved POST JSON bodies", async (t) => {
  let receivedBody = "";
  const server = await listen((request, response) => {
    request.setEncoding("utf8");
    request.on("data", (chunk) => (receivedBody += chunk));
    request.on("end", () => {
      response.end(JSON.stringify({ credits: 17 }));
    });
  });
  t.after(() => server.close());
  process.env.TEST_USER_ID = "user-7";
  t.after(() => delete process.env.TEST_USER_ID);

  const result = await fetchDeclarativeProvider("post-provider", {
    request: {
      url: server.url,
      method: "POST",
      body: { user_id: "$TEST_USER_ID" },
    },
    balances: [{ id: "credits", selector: "credits", unit: "credits" }],
  });

  assert.deepEqual(JSON.parse(receivedBody), { user_id: "user-7" });
  assert.equal(result.snapshot.balances[0]?.value, 17);
});

test("requestJson handles HTTP errors, invalid JSON, limits, and timeouts", async (t) => {
  const server = await listen((request, response) => {
    if (request.url === "/error") {
      response.statusCode = 500;
      response.end("sensitive response body");
      return;
    }
    if (request.url === "/invalid") {
      response.end("not-json");
      return;
    }
    if (request.url === "/large") {
      response.end(JSON.stringify({ value: "x".repeat(200) }));
      return;
    }
    setTimeout(() => response.end("{}"), 100);
  });
  t.after(() => server.close());

  await assert.rejects(
    requestJson({ url: `${server.url}/error` }),
    (error: Error) =>
      /HTTP 500/.test(error.message) && !error.message.includes("sensitive"),
  );
  await assert.rejects(
    requestJson({ url: `${server.url}/invalid` }),
    /not valid JSON/,
  );
  await assert.rejects(
    requestJson({ url: `${server.url}/large`, maxResponseBytes: 50 }),
    /exceeded 50 bytes/,
  );
  await assert.rejects(
    requestJson({ url: `${server.url}/slow`, timeoutMs: 10 }),
    /timed out/,
  );
});

test("requestJson rejects redirects by default and strips auth across hosts", async (t) => {
  let forwardedAuthorization: string | undefined;
  const target = await listen((request, response) => {
    forwardedAuthorization = request.headers.authorization;
    response.end(JSON.stringify({ ok: true }));
  });
  const redirect = await listen((_request, response) => {
    response.statusCode = 302;
    response.setHeader("location", target.url);
    response.end();
  });
  t.after(async () => {
    await redirect.close();
    await target.close();
  });

  await assert.rejects(
    requestJson({ url: redirect.url }),
    /redirect status 302/,
  );
  const result = await requestJson({
    url: redirect.url,
    headers: { Authorization: "Bearer secret" },
    followRedirects: true,
  });
  assert.deepEqual(result.data, { ok: true });
  assert.equal(forwardedAuthorization, undefined);
});

test("requestJson honors an external AbortSignal", async (t) => {
  const server = await listen((_request, response) => {
    setTimeout(() => response.end("{}"), 100);
  });
  t.after(() => server.close());
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    requestJson({ url: server.url, signal: controller.signal }),
    /was aborted/,
  );
});

test("config validation accepts declarative providers and rejects unknown keys", () => {
  assert.deepEqual(
    footerConfigValidationErrors({
      providerStatus: {
        customProviders: {
          zero: {
            request: { url: "https://api.example.com/usage" },
            balances: [{ id: "remaining", selector: "data.quota" }],
          },
        },
      },
    }),
    [],
  );
  assert.notDeepEqual(
    footerConfigValidationErrors({
      providerStatus: {
        customProviders: {
          zero: {
            request: { url: "https://api.example.com", secret: "nope" },
          },
        },
      },
    }),
    [],
  );
});

test("custom providers match exact and configured Pi provider ids", async (t) => {
  let requests = 0;
  const server = await listen((_request, response) => {
    requests += 1;
    response.end(JSON.stringify({ value: 9 }));
  });
  t.after(() => server.close());
  const provider = {
    request: { url: server.url },
    matchProviders: ["proxy-id"],
    balances: [{ id: "credits", selector: "value", unit: "credits" }],
  };
  const config = customStatusConfig({ "custom-key": provider });

  assert.deepEqual(
    await collectProviderStatus({} as never, config, { provider: "unrelated" }),
    [],
  );
  assert.equal(requests, 0);
  assert.equal(
    (
      await collectProviderStatus({} as never, config, {
        provider: "custom-key",
      })
    ).length,
    1,
  );
  assert.equal(
    (await collectProviderStatus({} as never, config, { provider: "proxy-id" }))
      .length,
    1,
  );
  assert.equal(requests, 2);
});

test("alwaysRefresh custom providers refresh without a model match", async (t) => {
  const server = await listen((_request, response) => {
    response.end(JSON.stringify({ value: 4 }));
  });
  t.after(() => server.close());
  const config = customStatusConfig({
    balance: {
      alwaysRefresh: true,
      request: { url: server.url },
      balances: [{ id: "credits", selector: "value" }],
    },
  });

  const snapshots = await collectProviderStatus({} as never, config, {
    provider: "other",
  });
  assert.equal(snapshots[0]?.balances[0]?.value, 4);
});

test("custom provider cache keys change with the endpoint and omit secrets", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "pi-fancy-footer-declarative-"),
  );
  const previousCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = directory;
  process.env.CACHE_TEST_TOKEN = "do-not-persist";
  t.after(async () => {
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCache;
    delete process.env.CACHE_TEST_TOKEN;
    await rm(directory, { recursive: true, force: true });
  });
  const first = await listen((_request, response) => {
    response.end(JSON.stringify({ value: 1 }));
  });
  const second = await listen((_request, response) => {
    response.end(JSON.stringify({ value: 2 }));
  });
  t.after(async () => {
    await first.close();
    await second.close();
  });

  const provider = (url: string) => ({
    request: {
      url,
      headers: { Authorization: "Bearer $CACHE_TEST_TOKEN" },
    },
    balances: [{ id: "credits", selector: "value" }],
  });
  const firstConfig = customStatusConfig({ cache: provider(first.url) });
  firstConfig.cacheTtlMs = 60_000;
  const secondConfig = customStatusConfig({ cache: provider(second.url) });
  secondConfig.cacheTtlMs = 60_000;

  const firstValue = await collectProviderStatus({} as never, firstConfig, {
    provider: "cache",
  });
  const secondValue = await collectProviderStatus({} as never, secondConfig, {
    provider: "cache",
  });
  assert.equal(firstValue[0]?.balances[0]?.value, 1);
  assert.equal(secondValue[0]?.balances[0]?.value, 2);

  const cacheDirectory = join(directory, "pi-fancy-footer", "provider-status");
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(cacheDirectory);
  assert.equal(files.length, 2);
  for (const file of files) {
    const content = await readFile(join(cacheDirectory, file), "utf8");
    assert.doesNotMatch(content, /do-not-persist|Authorization/);
  }
});

test("custom provider refresh failures fall back to stale cached balances", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-fancy-footer-stale-"));
  const previousCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = directory;
  t.after(async () => {
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCache;
    await rm(directory, { recursive: true, force: true });
  });
  let fail = false;
  const server = await listen((_request, response) => {
    if (fail) {
      response.statusCode = 500;
      response.end("failure");
    } else {
      response.end(JSON.stringify({ value: 12 }));
    }
  });
  t.after(() => server.close());
  const config = customStatusConfig({
    stale: {
      request: { url: server.url },
      balances: [{ id: "remaining", selector: "value", currency: "USD" }],
    },
  });
  config.cacheTtlMs = 0;

  const fresh = await collectProviderStatus({} as never, config, {
    provider: "stale",
  });
  assert.equal(fresh[0]?.balances[0]?.value, 12);
  await new Promise((resolve) => setTimeout(resolve, 2));
  fail = true;
  const cached = await collectProviderStatus({} as never, config, {
    provider: "stale",
  });
  assert.equal(cached[0]?.balances[0]?.value, 12);
  assert.equal(cached[0]?.source, "cache");
  assert.equal(cached[0]?.stale, true);
  assert.equal(cached[0]?.error?.status, 500);
});

test("concurrent custom provider refreshes share one in-flight request", async (t) => {
  let requests = 0;
  const server = await listen((_request, response) => {
    requests += 1;
    setTimeout(() => response.end(JSON.stringify({ value: 5 })), 20);
  });
  t.after(() => server.close());
  const config = customStatusConfig({
    shared: {
      request: { url: server.url },
      balances: [{ id: "credits", selector: "value" }],
    },
  });

  const [first, second] = await Promise.all([
    collectProviderStatus({} as never, config, { provider: "shared" }),
    collectProviderStatus({} as never, config, { provider: "shared" }),
  ]);
  assert.equal(first[0]?.balances[0]?.value, 5);
  assert.equal(second[0]?.balances[0]?.value, 5);
  assert.equal(requests, 1);
});
