import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  debugProviderStatusSource,
  listProviderStatusSources,
  testProviderStatusSource,
} from "./provider-status/diagnostics.ts";
import type { ProviderStatusConfigSnapshot } from "./shared.ts";

function config(url: string): ProviderStatusConfigSnapshot {
  return {
    refreshMs: 60_000,
    cacheTtlMs: 60_000,
    providers: ["openai-codex", "anthropic"],
    display: "gauge",
    showCredits: true,
    showReset: true,
    customProviders: {
      zero: {
        label: "0-0",
        matchProviders: ["proxy"],
        request: {
          url: `${url}/usage?api_key=must-not-appear`,
          headers: { Authorization: "Bearer $DIAGNOSTIC_TOKEN" },
        },
        balances: [
          { id: "remaining", selector: "data.balance", currency: "CNY" },
        ],
      },
      disabled: {
        enabled: false,
        request: { url },
        balances: [{ id: "credits", selector: "credits" }],
      },
    },
  };
}

test("provider diagnostics list built-in, matched, and disabled sources", () => {
  const lines = listProviderStatusSources(config("https://example.com"), {
    provider: "proxy",
  });
  assert.match(lines.join("\n"), /openai-codex\s+builtin\s+enabled/);
  assert.match(lines.join("\n"), /anthropic\s+builtin\s+enabled/);
  assert.match(lines.join("\n"), /zero\s+declarative matched: proxy/);
  assert.match(lines.join("\n"), /disabled\s+declarative disabled/);
});

test("provider diagnostics identify an active cloned Codex account", () => {
  const lines = listProviderStatusSources(config("https://example.com"), {
    provider: "codex-my",
  });
  assert.match(lines.join("\n"), /codex-my\s+Codex clone matched: codex-my/);
});

test("provider test diagnostics report selector counts without secrets", async (t) => {
  const server = createServer((_request, response) => {
    response.end(JSON.stringify({ data: { balance: 84.26 } }));
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
  const url = `http://127.0.0.1:${address.port}`;
  process.env.DIAGNOSTIC_TOKEN = "must-not-appear";
  t.after(() => delete process.env.DIAGNOSTIC_TOKEN);

  const lines = await testProviderStatusSource(
    {} as never,
    config(url),
    "zero",
  );
  const output = lines.join("\n");
  assert.match(output, /HTTP: 200/);
  assert.match(output, /Balance selectors: 1\/1 success/);
  assert.match(output, /Result: 0-0 ¥84\.26/);
  assert.doesNotMatch(output, /must-not-appear|api_key/);
});

test("provider debug diagnostics expose only endpoint host", async () => {
  const lines = await debugProviderStatusSource(
    config("https://api.example.com"),
    "zero",
  );
  const output = lines.join("\n");
  assert.match(output, /Endpoint host: api\.example\.com/);
  assert.doesNotMatch(output, /usage|api_key|must-not-appear|Authorization/);
});
