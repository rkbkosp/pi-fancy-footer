import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "./cache.ts";
import { numberValue, objectValue, stringValue } from "./normalize.ts";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLAUDE_CLIENT_ID = "https://claude.ai/oauth/claude-code-client-metadata";
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

type TokenRefreshResult =
  | { ok: true; stdout: string }
  | { ok: false; error: Error };

export interface AuthCredentials {
  provider: "openai-codex" | "anthropic";
  source: "pi" | "codex";
  path: string;
  accessToken: string;
  refreshToken?: string;
  accountId?: string;
  expiresAtMs?: number;
  raw: Record<string, unknown>;
}

export async function resolveCodexAuth(): Promise<AuthCredentials> {
  const pi = await readAuthFile(
    "pi",
    homePath(".pi/agent/auth.json"),
    "openai-codex",
  );
  if (pi) return refreshIfNeeded(pi);

  const codex = await readAuthFile(
    "codex",
    homePath(".codex/auth.json"),
    "openai-codex",
  );
  if (codex) return refreshIfNeeded(codex);

  throw new Error(
    "No usable Codex OAuth credentials found. Run pi /login for OpenAI Codex or `codex login` first.",
  );
}

export async function resolveClaudeAuth(): Promise<AuthCredentials> {
  const pi = await readAuthFile(
    "pi",
    homePath(".pi/agent/auth.json"),
    "anthropic",
  );
  if (pi) return refreshIfNeeded(pi);

  throw new Error(
    "No usable Anthropic OAuth credentials found. Run pi /login for Claude/Anthropic first.",
  );
}

async function refreshIfNeeded(
  auth: AuthCredentials,
): Promise<AuthCredentials> {
  if (!auth.refreshToken || !auth.expiresAtMs) return auth;
  if (auth.expiresAtMs > Date.now() + 5 * 60 * 1000) return auth;
  return refreshAuth(auth);
}

export async function refreshAuth(
  auth: AuthCredentials,
): Promise<AuthCredentials> {
  if (!auth.refreshToken) return auth;

  const refreshConfig =
    auth.provider === "anthropic"
      ? {
          clientId: CLAUDE_CLIENT_ID,
          tokenUrl: CLAUDE_TOKEN_URL,
          label: "Anthropic",
        }
      : {
          clientId: CODEX_CLIENT_ID,
          tokenUrl: CODEX_TOKEN_URL,
          label: "Codex",
        };
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: auth.refreshToken,
    client_id: refreshConfig.clientId,
  }).toString();

  const result = await requestTokenRefresh(
    body,
    refreshConfig.tokenUrl,
    `${refreshConfig.label} auth refresh`,
  );

  if (!result.ok) throw result.error;
  if (!result.stdout) {
    throw new Error(`Failed to refresh ${refreshConfig.label} auth`);
  }

  const refreshed = JSON.parse(result.stdout) as Record<string, unknown>;
  const accessToken = stringValue(refreshed.access_token);
  if (!accessToken) {
    throw new Error(
      `${refreshConfig.label} auth refresh did not return access_token`,
    );
  }

  const refreshToken =
    stringValue(refreshed.refresh_token) ?? auth.refreshToken;
  const expiresIn = numberValue(refreshed.expires_in);
  const next: AuthCredentials = {
    ...auth,
    accessToken,
    refreshToken,
    ...(expiresIn !== undefined
      ? { expiresAtMs: Date.now() + expiresIn * 1000 }
      : {}),
  };
  await persistAuth(next);
  return next;
}

async function requestTokenRefresh(
  body: string,
  tokenUrl: string,
  label: string,
): Promise<TokenRefreshResult> {
  try {
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        error: new Error(
          `${label} failed (${response.status}): ${text.slice(0, 500)}`,
        ),
      };
    }
    return { ok: true, stdout: text };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

async function readAuthFile(
  source: "pi" | "codex",
  path: string,
  provider: AuthCredentials["provider"],
): Promise<AuthCredentials | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    return source === "pi"
      ? parsePiAuth(raw as Record<string, unknown>, path, provider)
      : parseCodexAuth(raw as Record<string, unknown>, path);
  } catch {
    return undefined;
  }
}

function parsePiAuth(
  raw: Record<string, unknown>,
  path: string,
  provider: AuthCredentials["provider"],
): AuthCredentials | undefined {
  const entry = objectValue(raw[provider]);
  const accessToken = stringValue(entry?.access);
  if (!accessToken) return undefined;
  return {
    provider,
    source: "pi",
    path,
    accessToken,
    ...(stringValue(entry?.refresh)
      ? { refreshToken: stringValue(entry?.refresh) }
      : {}),
    ...(stringValue(entry?.accountId)
      ? { accountId: stringValue(entry?.accountId) }
      : {}),
    ...(numberValue(entry?.expires)
      ? { expiresAtMs: numberValue(entry?.expires) }
      : {}),
    raw,
  };
}

function parseCodexAuth(
  raw: Record<string, unknown>,
  path: string,
): AuthCredentials | undefined {
  const tokens = objectValue(raw.tokens);
  const accessToken = stringValue(tokens?.access_token);
  if (!accessToken) return undefined;
  return {
    provider: "openai-codex",
    source: "codex",
    path,
    accessToken,
    ...(stringValue(tokens?.refresh_token)
      ? { refreshToken: stringValue(tokens?.refresh_token) }
      : {}),
    ...(stringValue(tokens?.account_id)
      ? { accountId: stringValue(tokens?.account_id) }
      : {}),
    raw,
  };
}

async function persistAuth(auth: AuthCredentials): Promise<void> {
  const raw = JSON.parse(await readFile(auth.path, "utf8")) as Record<
    string,
    unknown
  >;

  if (auth.source === "pi") {
    const entry = objectValue(raw[auth.provider]);
    if (entry) {
      entry.access = auth.accessToken;
      if (auth.refreshToken) entry.refresh = auth.refreshToken;
      if (auth.expiresAtMs) entry.expires = auth.expiresAtMs;
      if (auth.accountId) entry.accountId = auth.accountId;
    }
  } else {
    const tokens = objectValue(raw.tokens);
    if (tokens) {
      tokens.access_token = auth.accessToken;
      if (auth.refreshToken) tokens.refresh_token = auth.refreshToken;
    }
    raw.last_refresh = new Date().toISOString();
  }

  await writeJsonAtomic(auth.path, raw);
}

function homePath(relative: string): string {
  return join(process.env.HOME || process.env.USERPROFILE || ".", relative);
}
