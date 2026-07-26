import assert from "node:assert/strict";
import test from "node:test";
import {
  footerConfigValidationErrors,
  genericFooterSettingsItems,
  moveCustomProviderToIndex,
  plainSettingValue,
  setCustomProviderEnabled,
} from "./config.ts";
import { DEFAULT_FOOTER_CONFIG } from "./shared.ts";

test("footerConfigValidationErrors accepts a valid config", () => {
  assert.deepEqual(
    footerConfigValidationErrors({
      gaugeStyle: "bars",
      gaugeWidth: 8,
      providerStatus: { providers: ["openai-codex", "anthropic"] },
      widgets: { "context-bar": { row: 0 } },
    }),
    [],
  );
});

test("footerConfigValidationErrors accepts remote pricing configuration", () => {
  assert.deepEqual(
    footerConfigValidationErrors({
      pricing: {
        mode: "estimate-only",
        request: { url: "https://api.example.com/prices" },
        modelsSelector: "data.models",
        fields: { id: "name", input: "input", output: "output" },
        unit: "per_million_tokens",
      },
    }),
    [],
  );
});

test("footerConfigValidationErrors names unknown keys with rename hints", () => {
  const errors = footerConfigValidationErrors({ contextBarStyle: "blocks" });
  assert.deepEqual(errors, [
    '  - /: unknown key "contextBarStyle" (it was renamed to "gaugeStyle")',
  ]);
});

test("footerConfigValidationErrors suggests close matches for typos", () => {
  assert.deepEqual(footerConfigValidationErrors({ guageWidth: 5 }), [
    '  - /: unknown key "guageWidth" (did you mean "gaugeWidth"?)',
  ]);
  assert.deepEqual(
    footerConfigValidationErrors({
      providerStatus: { displai: "gauge" },
    }),
    ['  - /providerStatus: unknown key "displai" (did you mean "display"?)'],
  );
  assert.deepEqual(
    footerConfigValidationErrors({
      widgets: { "context-barr": {} },
    }),
    ['  - /widgets: unknown key "context-barr" (did you mean "context-bar"?)'],
  );
  assert.deepEqual(
    footerConfigValidationErrors({
      widgets: { "context-bar": { minWdth: 3 } },
    }),
    [
      '  - /widgets/context-bar: unknown key "minWdth" (did you mean "minWidth"?)',
    ],
  );
});

test("footerConfigValidationErrors reports plain value errors with their path", () => {
  const errors = footerConfigValidationErrors({ gaugeWidth: 1000 });
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /^ {2}- \/gaugeWidth: /);
});

test("footerConfigValidationErrors accepts partial gaugeColors", () => {
  assert.deepEqual(
    footerConfigValidationErrors({ gaugeColors: { ok: "dim" } }),
    [],
  );
  assert.deepEqual(
    footerConfigValidationErrors({ gaugeColors: { okay: "dim" } }),
    ['  - /gaugeColors: unknown key "okay" (did you mean "ok"?)'],
  );
});

test("custom provider settings expose enablement and order without secrets", () => {
  const config = structuredClone(DEFAULT_FOOTER_CONFIG);
  config.providerStatus.customProviders = {
    alpha: {
      request: {
        url: "https://example.com/alpha",
        headers: { Authorization: "Bearer secret-value" },
      },
      balances: [{ id: "credits", selector: "credits" }],
    },
    beta: {
      label: "Beta",
      enabled: false,
      request: { url: "https://example.com/beta" },
      balances: [{ id: "credits", selector: "credits" }],
    },
  };
  const theme = { fg: (_color: string, text: string) => text };
  const items = genericFooterSettingsItems(config, theme as never);
  const output = JSON.stringify(items);

  assert.match(output, /provider alpha/);
  assert.match(output, /provider Beta/);
  assert.doesNotMatch(output, /secret-value|Authorization/);

  setCustomProviderEnabled(config, "beta", true);
  assert.equal(config.providerStatus.customProviders.beta?.enabled, undefined);
  moveCustomProviderToIndex(config, "beta", 0);
  assert.deepEqual(Object.keys(config.providerStatus.customProviders), [
    "beta",
    "alpha",
  ]);
});

test("plainSettingValue strips preview decoration back to the option name", () => {
  assert.equal(plainSettingValue("\x1b[32m██\x1b[0m success"), "success");
  assert.equal(plainSettingValue("default"), "default");
  assert.equal(plainSettingValue("accent"), "accent");
  assert.equal(plainSettingValue("▰▰▰▱▱ parallelograms"), "parallelograms");
});
