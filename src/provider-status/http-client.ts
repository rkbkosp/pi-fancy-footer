import { performance } from "node:perf_hooks";
import { ProviderStatusFailure } from "./errors.ts";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

export interface JsonRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxResponseBytes?: number;
  followRedirects?: boolean;
  signal?: AbortSignal;
}

export interface JsonResponse {
  status: number;
  headers: Headers;
  data: unknown;
  latencyMs: number;
  url: string;
}

export async function requestJson(request: JsonRequest): Promise<JsonResponse> {
  const startedAt = performance.now();
  const timeoutSignal = AbortSignal.timeout(
    request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const signal = request.signal
    ? AbortSignal.any([request.signal, timeoutSignal])
    : timeoutSignal;
  const method = request.method ?? "GET";
  const body =
    request.body === undefined ? undefined : JSON.stringify(request.body);
  let headers = new Headers(request.headers);
  if (body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (!headers.has("accept")) headers.set("accept", "application/json");

  let url = parseHttpUrl(request.url);
  let response: Response;

  try {
    for (let redirects = 0; ; redirects += 1) {
      response = await fetch(url, {
        method,
        headers,
        body,
        redirect: "manual",
        signal,
      });

      if (!isRedirect(response.status)) break;
      if (!request.followRedirects) {
        throw new ProviderStatusFailure(
          "http",
          `Provider request returned redirect status ${response.status}`,
          { status: response.status },
        );
      }
      if (redirects >= MAX_REDIRECTS) {
        throw new ProviderStatusFailure(
          "http",
          `Provider request exceeded ${MAX_REDIRECTS} redirects`,
          { status: response.status },
        );
      }

      const location = response.headers.get("location");
      if (!location) {
        throw new ProviderStatusFailure(
          "http",
          `Provider redirect ${response.status} did not include a location`,
          { status: response.status },
        );
      }
      const nextUrl = parseHttpUrl(new URL(location, url).toString());
      if (nextUrl.origin !== url.origin)
        headers = withoutSensitiveHeaders(headers);
      url = nextUrl;
    }
  } catch (error) {
    if (error instanceof ProviderStatusFailure) throw error;
    if (timeoutSignal.aborted && !request.signal?.aborted) {
      throw new ProviderStatusFailure("timeout", "Provider request timed out", {
        cause: error,
      });
    }
    if (request.signal?.aborted) {
      throw new ProviderStatusFailure(
        "network",
        "Provider request was aborted",
        {
          cause: error,
        },
      );
    }
    throw new ProviderStatusFailure("network", "Provider request failed", {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new ProviderStatusFailure(
      response.status === 401 || response.status === 403 ? "auth" : "http",
      `Provider request failed with HTTP ${response.status}`,
      { status: response.status },
    );
  }

  const bytes = await readResponseBytes(
    response,
    request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    signal,
  );
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new ProviderStatusFailure(
      "parse",
      "Provider response was not valid JSON",
      { cause: error },
    );
  }

  return {
    status: response.status,
    headers: response.headers,
    data,
    latencyMs: Math.max(0, performance.now() - startedAt),
    url: url.toString(),
  };
}

async function readResponseBytes(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximum) {
    throw responseTooLarge(maximum);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) {
        throw new ProviderStatusFailure(
          "network",
          "Provider request was aborted",
        );
      }
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw responseTooLarge(maximum);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ProviderStatusFailure("config", "Provider URL is invalid", {
      cause: error,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderStatusFailure(
      "config",
      "Provider URL must use http or https",
    );
  }
  if (url.username || url.password) {
    throw new ProviderStatusFailure(
      "config",
      "Provider URL must not contain credentials",
    );
  }
  return url;
}

function withoutSensitiveHeaders(headers: Headers): Headers {
  const next = new Headers(headers);
  for (const name of SENSITIVE_HEADERS) next.delete(name);
  return next;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function responseTooLarge(maximum: number): ProviderStatusFailure {
  return new ProviderStatusFailure(
    "parse",
    `Provider response exceeded ${maximum} bytes`,
  );
}
