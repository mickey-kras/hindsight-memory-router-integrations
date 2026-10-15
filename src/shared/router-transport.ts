import { createHash } from "node:crypto";
import { AccessDeniedError, type BankAccess, classifyOperation, requireBank, visibleBanks } from "./bank-access.js";
import { TOKEN_FORMAT_PATTERN } from "./patterns.js";
import { validateRouterUrl } from "./router-url.js";

export class RouterRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly retryAfterMs = 0,
  ) {
    super(`memory request failed (${statusCode})`);
    this.name = "RouterRequestError";
  }
}

export function boundedRetryAfterMs(header: string | null | undefined): number {
  if (!header?.trim()) return 0;
  const value = header.trim();
  const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.min(60_000, Math.max(0, delay)) : 0;
}

const ROUTING_KEYS = ["bankId", "bank_id", "bank_ids"];

function assertAuthorizedUrl(url: string, method: string, baseUrl: string, access: BankAccess): boolean {
  const listing = url === `${baseUrl}/v1/default/banks` && method === "GET";
  if (listing || ([`${baseUrl}/version`, `${baseUrl}/v1/version`].includes(url) && method === "GET")) {
    return listing;
  }
  const prefix = `${baseUrl}/v1/default/banks/`;
  if (!url.startsWith(prefix)) throw new AccessDeniedError();
  const path = url.slice(prefix.length).split("?")[0];
  const split = path.indexOf("/");
  const bank = decodeURIComponent(split < 0 ? path : path.slice(0, split));
  const suffix = split < 0 ? "" : path.slice(split);
  requireBank(access, bank, classifyOperation(method, suffix));
  return false;
}

async function filterVisibleBanks(response: Response, access: BankAccess): Promise<Response> {
  const data = (await response.json()) as { banks?: unknown };
  if (!Array.isArray(data.banks)) throw new RouterRequestError(502);
  const allowed = new Set(visibleBanks(access));
  const banks = data.banks.filter(
    (bank: unknown) =>
      bank !== null && typeof bank === "object" && allowed.has((bank as { bank_id?: string }).bank_id ?? ""),
  );
  return Response.json({ banks, total: banks.length });
}

function assertSafeRequest(url: string, body: RequestInit["body"]): URL {
  // Inspect the original path before URL parsing can normalize traversal segments.
  // Escapes in search text are data, not path separators or bank-routing instructions.
  const rawPath = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(url)?.[1] ?? "";
  if (url.includes("#") || /\\/.test(rawPath) || /%(?:2e|2f|5c|25)/i.test(rawPath) || /\/\.\.?(?:\/|$)/.test(rawPath)) {
    throw new AccessDeniedError();
  }
  const parsed = new URL(url);
  if (ROUTING_KEYS.some((key) => parsed.searchParams.has(key))) throw new AccessDeniedError();
  if (typeof body === "string") {
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body);
    } catch {
      throw new AccessDeniedError();
    }
    if (parsedBody && typeof parsedBody === "object" && ROUTING_KEYS.some((key) => Object.hasOwn(parsedBody, key))) {
      throw new AccessDeniedError();
    }
  }
  if (parsed.username || parsed.password) throw new AccessDeniedError();
  return parsed;
}

const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

// Preserve the host's proxy dispatcher while letting AbortSignal own deadlines beyond 300s.
function signalOnlyDispatcher(): unknown {
  // Headers initializes Node's otherwise lazy global dispatcher.
  void globalThis.Headers;
  const d = (globalThis as Record<symbol, unknown>)[GLOBAL_DISPATCHER] as
    | { compose?: (interceptor: unknown) => unknown }
    | undefined;
  if (typeof d?.compose !== "function") return undefined; // Node 18's undici predates compose()
  type Dispatch = (opts: Record<string, unknown>, handler: unknown) => boolean;
  return d.compose(
    (dispatch: Dispatch) => (opts: Record<string, unknown>, handler: unknown) =>
      dispatch({ ...opts, headersTimeout: 0, bodyTimeout: 0 }, handler),
  );
}

export class RouterTransport {
  readonly baseUrl: string;
  readonly access: BankAccess;
  readonly #token: () => string | undefined;
  readonly #send: typeof fetch;
  readonly #principalId?: string | (() => string);
  readonly #tokenPattern: RegExp;
  readonly #unauthorizedError: () => AccessDeniedError;
  #deniedToken: string | undefined;
  #deniedError: AccessDeniedError | undefined;

  constructor(options: {
    routerUrl: string;
    access: BankAccess;
    token: () => string | undefined;
    principalId?: string | (() => string);
    tokenPattern?: RegExp;
    unauthorizedError?: () => AccessDeniedError;
    fetch?: typeof fetch;
  }) {
    this.baseUrl = validateRouterUrl(options.routerUrl);
    const url = new URL(this.baseUrl);
    if (url.search || url.hash) throw new AccessDeniedError();
    this.access = Object.freeze({
      writeBank: options.access.writeBank,
      additionalReadBanks: Object.freeze([...options.access.additionalReadBanks]),
    });
    visibleBanks(this.access);
    this.#principalId = options.principalId;
    this.#tokenPattern = options.tokenPattern ?? TOKEN_FORMAT_PATTERN;
    this.#unauthorizedError = options.unauthorizedError ?? (() => new AccessDeniedError());
    this.#token = options.token;
    this.#send = options.fetch ?? ((input, init) => fetch(input, init));
    this.credential();
  }

  hasCredentials(): boolean {
    try {
      this.credential();
      return true;
    } catch {
      return false;
    }
  }

  assertAuthorized(): void {
    const token = this.#token();
    if (!token || !this.#tokenPattern.test(token)) throw new AccessDeniedError();
    if (this.#deniedToken === token) throw this.#deniedError ?? new AccessDeniedError();
    if (this.#deniedToken !== undefined) {
      this.#deniedToken = undefined;
      this.#deniedError = undefined;
    }
  }

  authorizationIdentity(): string {
    // Refresh human-session identity before binding a private context handoff.
    this.credential();
    const principal = typeof this.#principalId === "function" ? this.#principalId() : this.#principalId;
    if (!principal) throw new AccessDeniedError();
    return createHash("sha256").update(principal).digest("hex");
  }

  private credential(): string {
    this.assertAuthorized();
    const token = this.#token();
    if (!token) throw new AccessDeniedError();
    return token;
  }

  bankUrl(bank: string, suffix = ""): string {
    requireBank(this.access, bank, "read");
    return `${this.baseUrl}/v1/default/banks/${encodeURIComponent(bank)}${suffix}`;
  }

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const token = this.credential();
    const method = init.method ?? "GET";
    // Validate before URL normalization can erase dot segments or backslashes.
    assertSafeRequest(url, init.body);
    const listing = assertAuthorizedUrl(url, method, this.baseUrl, this.access);
    const response = await this.send(url, init, token);
    if (response.status === 401 || response.status === 403) {
      this.#deniedToken = token;
      this.#deniedError = response.status === 401 ? this.#unauthorizedError() : new AccessDeniedError();
      throw this.#deniedError;
    }
    // Never expose server error bodies, which may echo credentials or bank existence.
    if (!response.ok && (response.status !== 404 || method !== "GET")) {
      throw new RouterRequestError(
        response.status,
        response.status === 429 ? boundedRetryAfterMs(response.headers.get("retry-after")) : 0,
      );
    }
    if (listing && response.ok) {
      return filterVisibleBanks(response, this.access);
    }
    return response.status === 404 ? new Response(null, { status: 404 }) : response;
  }

  private async send(url: string, init: RequestInit, token: string): Promise<Response> {
    try {
      const signal = init.signal ?? AbortSignal.timeout(15_000);
      const dispatcher = signalOnlyDispatcher();
      return await this.#send(url, {
        ...init,
        ...(dispatcher ? { dispatcher } : {}),
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "Accept-Encoding": "identity",
          Authorization: `Bearer ${token}`,
          ...(this.#principalId
            ? {
                "x-memory-router-agent":
                  typeof this.#principalId === "string" ? this.#principalId : this.#principalId(),
              }
            : {}),
        },
        signal,
      } as RequestInit);
    } catch (error) {
      // Log only the error class (TypeError/TimeoutError/AbortError/...), never the message:
      // fetch messages can embed the URL or token. Undifferentiated 503s otherwise hide
      // DNS/TLS/timeout anomalies from local logs.
      process.stderr.write(`memory request failed: ${error instanceof Error ? error.name : typeof error}\n`);
      throw new RouterRequestError(503);
    }
  }
}
