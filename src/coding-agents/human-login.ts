import { rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadManagedConfig } from "../shared/managed-config.js";
import { authRequest, issuedSession, withSessionLock } from "./human-refresh.js";
import {
  HumanLoginRequiredError,
  type HumanSession,
  humanRouterUrl,
  secureEntry,
  validateHumanSession,
} from "./human-session.js";

const LOGIN_TIMEOUT_MS = 300_000;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HumanLoginRequiredError();
  return value as Record<string, unknown>;
}

function authorizationUrl(
  value: unknown,
  state: string,
  challenge: string,
  redirectUri: string,
): { url: string; transaction: string } {
  const response = record(value);
  if (
    typeof response.transaction_id !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(response.transaction_id) ||
    typeof response.authorization_url !== "string" ||
    response.authorization_url.length > 8192
  )
    throw new HumanLoginRequiredError();
  const url = new URL(response.authorization_url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new HumanLoginRequiredError();
  for (const [key, expected] of Object.entries({
    state,
    code_challenge: challenge,
    redirect_uri: redirectUri,
    code_challenge_method: "S256",
    response_type: "code",
    scope: "openid",
  })) {
    if (url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== expected)
      throw new HumanLoginRequiredError();
  }
  return { url: url.href, transaction: response.transaction_id };
}

export async function openLoginBrowser(url: string): Promise<void> {
  let launch: string[];
  switch (process.platform) {
    case "darwin":
      launch = ["/usr/bin/open", url];
      break;
    case "win32":
      launch = ["rundll32.exe", "url.dll,FileProtocolHandler", url];
      break;
    case "linux":
      launch = ["xdg-open", url];
      break;
    default:
      throw new HumanLoginRequiredError();
  }
  const [command, ...args] = launch;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true, shell: false });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (successful: boolean): void => {
      clearTimeout(timer);
      child.unref();
      if (successful) resolve();
      else reject(new HumanLoginRequiredError());
    };
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
    child.once("spawn", () => {
      // Some openers remain attached to the browser. Detect immediate launch errors
      // without waiting for the browser itself to close.
      timer = setTimeout(() => finish(true), 1_000);
    });
  });
}

export async function loginHuman(
  routerUrl: string,
  credentialRef: string,
  harness: string,
  openBrowser = openLoginBrowser,
): Promise<void> {
  const base = humanRouterUrl(routerUrl);
  const entry = secureEntry(base, credentialRef, harness);
  entry.getPassword(); // Fail before launching a browser if secure storage cannot be read.
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let receive!: (code: string) => void;
  let rejectCallback!: (error: Error) => void;
  const callback = new Promise<string>((resolve, reject) => {
    receive = resolve;
    rejectCallback = reject;
  });
  // Register rejection handling before discovery/browser launch can fail.
  const outcome = callback.then(
    (code) => ({ code }),
    () => ({ code: undefined }),
  );
  let consumed = false;
  let callbackHost = "";
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (
      request.method !== "GET" ||
      request.headers.host !== callbackHost ||
      !request.url?.startsWith("/callback?") ||
      consumed
    ) {
      response.writeHead(404).end("Not found");
      return;
    }
    const url = new URL(request.url, `http://${callbackHost}`);
    const returnedState = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code");
    if (
      [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1) ||
      !/^[A-Za-z0-9_-]{43}$/.test(returnedState) ||
      !timingSafeEqual(Buffer.from(returnedState), Buffer.from(state)) ||
      !code ||
      code.length > 8192 ||
      url.searchParams.has("error")
    ) {
      consumed = true;
      response.writeHead(400).end("Login failed. Start login again.");
      rejectCallback(new HumanLoginRequiredError());
      return;
    }
    consumed = true;
    response.end("Login received. Return to the installer.");
    receive(code);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 20;
  const timer = setTimeout(() => rejectCallback(new HumanLoginRequiredError()), LOGIN_TIMEOUT_MS);
  let issued: HumanSession | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    callbackHost = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    const redirectUri = `http://${callbackHost}/callback`;
    const started = authorizationUrl(
      await authRequest(base, "start", {
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
      }),
      state,
      challenge,
      redirectUri,
    );
    await openBrowser(started.url);
    const { code } = await outcome;
    if (!code) throw new HumanLoginRequiredError();
    issued = issuedSession(
      await authRequest(base, "exchange", {
        transaction_id: started.transaction,
        code,
        state,
        code_verifier: verifier,
      }),
      base,
    );
    const persisted = issued;
    // A concurrent refresh must not overwrite the new login with the previous session.
    await withSessionLock(base, credentialRef, harness, async (locked, pending) => {
      locked.setPassword(JSON.stringify(persisted));
      rmSync(pending, { force: true });
    });
  } catch {
    if (issued) {
      try {
        await revoke(base, issued);
      } catch {
        /* Credential was never persisted; expiry still bounds it. */
      }
    }
    throw new HumanLoginRequiredError();
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function revoke(routerUrl: string, session: HumanSession): Promise<void> {
  // A refresh token revokes the whole session, even after its access token expires.
  if (session.refresh_token) await authRequest(routerUrl, "sign-out", { refresh_token: session.refresh_token });
  else await authRequest(routerUrl, "sign-out", undefined, session.token);
}

export async function signOutHuman(routerUrl: string, credentialRef: string, harness: string): Promise<boolean> {
  const base = humanRouterUrl(routerUrl);
  // The lock orders sign-out after any in-flight refresh, which cannot then restore this entry.
  return withSessionLock(base, credentialRef, harness, async (entry) => {
    let revoked = false;
    try {
      const stored = entry.getPassword();
      if (!stored) return true;
      try {
        if (stored.length > 4096) throw new HumanLoginRequiredError();
        await revoke(base, validateHumanSession(JSON.parse(stored), base, true));
        revoked = true;
      } catch {
        revoked = false;
      }
    } finally {
      entry.deleteCredential();
    }
    return revoked;
  });
}

export async function runHumanAuth(
  argv: string[],
  log: (message: string) => void,
  interactive: boolean,
): Promise<number> {
  try {
    const [command, ...args] = argv;
    if (!["login", "sign-out"].includes(command) || args.length > 1 || args.some((arg) => arg.startsWith("--"))) {
      throw new HumanLoginRequiredError();
    }
    const { config, principal, principalId } = loadManagedConfig(
      process.env,
      args[0] ?? process.env.HINDSIGHT_MCP_HARNESS,
    );
    if (!principal.human) throw new HumanLoginRequiredError();
    if (command === "login") {
      if (!interactive) throw new HumanLoginRequiredError();
      await loginHuman(config.routerUrl, principal.human.credentialRef, principalId);
      log(
        "Signed in. Run install for the configured coding agent. Sessions renew automatically while the router allows; login again when required.",
      );
      return 0;
    }
    const revoked = await signOutHuman(config.routerUrl, principal.human.credentialRef, principalId);
    log(
      revoked
        ? "Signed out."
        : "Local credential removed; server revocation could not be confirmed. The session remains valid until expiry or operator revocation.",
    );
    return revoked ? 0 : 1;
  } catch {
    log(
      "Human authentication unavailable. Verify human provisioning and unlock OS secure storage; if native support is missing, reinstall from a verified package before login. Then run login interactively. No application credential was used.",
    );
    return 1;
  }
}
