import { ProviderStatusFailure } from "./errors.ts";

const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

type SelectorPart = string | number;

export function selectJson(value: unknown, selector: string): unknown {
  const parts = parseSelector(selector);
  let current = value;
  for (const part of parts) {
    if (typeof part === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[part];
      continue;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function parseSelector(selector: string): SelectorPart[] {
  if (!selector) throw invalidSelector(selector);
  const parts: SelectorPart[] = [];
  let index = 0;

  while (index < selector.length) {
    const keyMatch = selector.slice(index).match(/^[A-Za-z_$][A-Za-z0-9_$-]*/);
    if (!keyMatch) throw invalidSelector(selector);
    const key = keyMatch[0];
    if (BLOCKED_KEYS.has(key)) throw invalidSelector(selector);
    parts.push(key);
    index += key.length;

    while (selector[index] === "[") {
      const end = selector.indexOf("]", index + 1);
      if (end < 0) throw invalidSelector(selector);
      const rawIndex = selector.slice(index + 1, end);
      if (!/^(0|[1-9]\d*)$/.test(rawIndex)) throw invalidSelector(selector);
      parts.push(Number(rawIndex));
      index = end + 1;
    }

    if (index === selector.length) break;
    if (selector[index] !== ".") throw invalidSelector(selector);
    index += 1;
    if (index === selector.length) throw invalidSelector(selector);
  }

  return parts;
}

function invalidSelector(selector: string): ProviderStatusFailure {
  return new ProviderStatusFailure(
    "selector",
    `Invalid JSON selector: ${selector || "<empty>"}`,
  );
}
