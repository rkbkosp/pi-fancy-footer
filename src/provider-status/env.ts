import { ProviderStatusFailure } from "./errors.ts";

const ENV_REFERENCE =
  /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

export function resolveEnvironmentString(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return value.replace(ENV_REFERENCE, (_match, braced, bare) => {
    const name = (braced ?? bare) as string;
    const resolved = env[name];
    if (resolved === undefined) {
      throw new ProviderStatusFailure(
        "config",
        `Required environment variable ${name} is not set`,
      );
    }
    return resolved;
  });
}

export function resolveEnvironmentValue(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  if (typeof value === "string") return resolveEnvironmentString(value, env);
  if (Array.isArray(value)) {
    return value.map((item) => resolveEnvironmentValue(item, env));
  }
  if (!value || typeof value !== "object") return value;

  const resolved: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    resolved[key] = resolveEnvironmentValue(item, env);
  }
  return resolved;
}
