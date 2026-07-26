import { redactSensitiveText } from "./redact.ts";
import type { ProviderStatusError } from "./types.ts";

export class ProviderStatusFailure extends Error {
  readonly code: ProviderStatusError["code"];
  readonly status?: number;

  constructor(
    code: ProviderStatusError["code"],
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ProviderStatusFailure";
    this.code = code;
    this.status = options.status;
  }
}

export function toProviderStatusError(error: unknown): ProviderStatusError {
  if (error instanceof ProviderStatusFailure) {
    return {
      code: error.code,
      message: redactSensitiveText(error.message),
      ...(error.status !== undefined ? { status: error.status } : {}),
    };
  }
  return {
    code: "unknown",
    message: redactSensitiveText(
      error instanceof Error ? error.message : String(error),
    ),
  };
}
