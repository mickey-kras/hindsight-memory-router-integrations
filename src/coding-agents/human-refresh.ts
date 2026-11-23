/// <reference path="../shared/fs-native-extensions.d.ts" />
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BANK_ID_PATTERN } from "../shared/patterns.js";
import { RouterRequestError } from "../shared/router-transport.js";
import {
  HumanLoginRequiredError,
  type HumanSession,
  REFRESH_TOKEN_PATTERN,
  humanRouterUrl,
  readHumanSession,
  type SecureEntry,
  secureEntry,
  validateHumanSession,
} from "./human-session.js";

const RESPONSE_LIMIT = 65_536;
const HUMAN_SCOPES = new Set(["bank.list", "memory.recall", "memory.retain", "memory.reflect", "bank.config.read"]);
// Refresh slightly early so a request never starts with an access token about to expire.
const REFRESH_SKEW_SECONDS = 60;

const LOCK_WAIT_MS = 20_000;
// Connection failures before any byte reaches the router cannot have consumed the refresh token.
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export class HumanAuthResponseError extends HumanLoginRequiredError {
  constructor(readonly status: number) {
    super();
  }
}

export class HumanRefreshUnsupportedError extends HumanLoginRequiredError {
  constructor() {
    super();
    this.message =
      "router does not support human session refresh; run hindsight-coding-agents login (sessions then last at most one hour) or upgrade the router";
    this.name = "HumanRefreshUnsupportedError";
  }
}

export class HumanRenewalUnconfirmedError extends HumanLoginRequiredError {
  constructor(detail: string) {
    super();
    this.message = `human session renewal could not be confirmed; ${detail}. Run hindsight-coding-agents login`;
    this.name = "HumanRenewalUnconfirmedError";
  }
}

export async function authRequest(
  routerUrl: string,
  route: string,
  body: Record<string, string> | undefined,
  token?: string,
): Promise<unknown> {
  const response = await fetch(`${routerUrl}/auth/human/${route}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    response.body?.cancel().catch(() => undefined);
    throw new HumanAuthResponseError(response.status);
  }
  if (response.status === 204) return undefined;
  const reader = response.body?.getReader();
  if (!reader) throw new HumanLoginRequiredError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > RESPONSE_LIMIT) throw new HumanLoginRequiredError();
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HumanLoginRequiredError();
  return value as Record<string, unknown>;
}

/** Validates an exchange or refresh response and returns only the fields to store. */
export function issuedSession(value: unknown, routerUrl: string): HumanSession {
  const response = record(value);
  if (response.token_type !== "Bearer" || !Array.isArray(response.grants) || response.grants.length > 1024) {
    throw new HumanLoginRequiredError();
  }
  for (const grant of response.grants) {
    const entry = record(grant);
    if (
      typeof entry.bank !== "string" ||
      !BANK_ID_PATTERN.test(entry.bank) ||
      !Array.isArray(entry.scopes) ||
      entry.scopes.some((scope: unknown) => typeof scope !== "string" || !HUMAN_SCOPES.has(scope))
    ) {
      throw new HumanLoginRequiredError();
    }
  }
  return validateHumanSession({ ...response, routerUrl }, routerUrl);
}

function lockPath(routerUrl: string, credentialRef: string, harness: string): string {
  const key = createHash("sha256")
    .update(`${humanRouterUrl(routerUrl)}\0${harness}\0${credentialRef}`)
    .digest("hex");
  return join(homedir(), ".hindsight", "locks", `human-${key}.lock`);
}

/**
 * Serializes refresh, login persistence, and sign-out for one stored session across processes.
 * The action receives the keyring entry and must reread it: another holder may have changed it.
 */
export async function withSessionLock<T>(
  routerUrl: string,
  credentialRef: string,
  harness: string,
  action: (entry: SecureEntry, pending: string) => Promise<T>,
): Promise<T> {
  const entry = secureEntry(routerUrl, credentialRef, harness);
  const path = lockPath(routerUrl, credentialRef, harness);
  const deadline = performance.now() + LOCK_WAIT_MS;
  let fd: number | undefined;
  try {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    const { tryLock } = await import("fs-native-extensions");
    fd = openSync(`${path}.fd`, "a+", 0o600);
    while (!tryLock(fd)) {
      if (performance.now() >= deadline) throw new RouterRequestError(503);
      await sleep(50);
    }
    return await action(entry, `${path}.pending`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function stored(entry: SecureEntry, routerUrl: string): HumanSession | undefined {
  const value = entry.getPassword();
  if (!value) return undefined;
  if (value.length > 4096) throw new HumanLoginRequiredError();
  return validateHumanSession(JSON.parse(value), routerUrl, true);
}

function due(session: HumanSession): boolean {
  return session.expires_at - REFRESH_SKEW_SECONDS <= Math.floor(Date.now() / 1000);
}

function notSent(error: unknown): boolean {
  const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return typeof code === "string" && NOT_SENT_CODES.has(code);
}

async function abandon(entry: SecureEntry, routerUrl: string, refreshToken: string): Promise<never> {
  let remote = "server revocation confirmed";
  try {
    await authRequest(routerUrl, "sign-out", { refresh_token: refreshToken });
  } catch {
    remote = "server revocation unconfirmed";
  }
  let local = "local credential removed";
  try {
    if (!entry.deleteCredential()) local = "local removal unconfirmed";
  } catch {
    local = "local removal unconfirmed";
  }
  throw new HumanRenewalUnconfirmedError(`${remote}, ${local}`);
}

async function rotate(
  entry: SecureEntry,
  current: HumanSession,
  routerUrl: string,
  pending: string,
): Promise<HumanSession> {
  const refreshToken = current.refresh_token as string;
  // Persist intent before sending. A crash or ambiguous reply requires explicit login.
  try {
    writeFileSync(pending, "", { flag: "wx", mode: 0o600, flush: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new HumanRenewalUnconfirmedError("explicit login required");
    throw error;
  }
  let value: unknown;
  try {
    value = await authRequest(routerUrl, "refresh", { refresh_token: refreshToken });
  } catch (error) {
    if (error instanceof HumanAuthResponseError) {
      if (error.status === 400 || error.status === 401) {
        // Definitive rejection: clear only this harness entry and require login.
        try {
          entry.deleteCredential();
        } catch {
          /* The router rejects the stored token regardless. */
        }
        throw new HumanLoginRequiredError();
      }
      const usable = current.expires_at > Math.floor(Date.now() / 1000);
      if (error.status === 404) {
        rmSync(pending);
        if (usable) return current;
        throw new HumanRefreshUnsupportedError();
      }
      // The router rolls back before answering 429 or 503, so the token is unused.
      if (error.status === 429 || error.status === 503) {
        rmSync(pending);
        if (usable) return current;
        throw new RouterRequestError(error.status);
      }
    } else if (notSent(error)) {
      rmSync(pending);
      if (current.expires_at > Math.floor(Date.now() / 1000)) return current;
      throw new RouterRequestError(503);
    }
    return abandon(entry, routerUrl, refreshToken);
  }
  let next: HumanSession;
  try {
    next = issuedSession(value, routerUrl);
    if (!next.refresh_token || next.principal_id !== current.principal_id) throw new HumanLoginRequiredError();
  } catch {
    const returned = (value as { refresh_token?: unknown } | null)?.refresh_token;
    return abandon(
      entry,
      routerUrl,
      typeof returned === "string" && REFRESH_TOKEN_PATTERN.test(returned) ? returned : refreshToken,
    );
  }
  try {
    entry.setPassword(JSON.stringify(next));
  } catch {
    return abandon(entry, routerUrl, next.refresh_token);
  }
  rmSync(pending);
  return next;
}

/** Renews an expiring refreshable session before a request reads its access token. */
export async function ensureFreshHumanSession(
  routerUrl: string,
  credentialRef: string,
  harness: string,
): Promise<HumanSession> {
  // Access-only entries from older installs stay usable until expiry, then require login.
  const seen = readHumanSession(routerUrl, credentialRef, harness);
  if (!seen.refresh_token || !due(seen)) return seen;
  const base = humanRouterUrl(routerUrl);
  return withSessionLock(base, credentialRef, harness, async (entry, pending) => {
    let current: HumanSession | undefined;
    try {
      current = stored(entry, base);
    } catch {
      throw new HumanLoginRequiredError();
    }
    // Signed out, replaced by an access-only login, or refreshed by another process.
    if (!current || (!current.refresh_token && current.expires_at <= Math.floor(Date.now() / 1000))) {
      throw new HumanLoginRequiredError();
    }
    if (!current.refresh_token || !due(current)) return current;
    return rotate(entry, current, base, pending);
  });
}
