import { validateRouterUrl } from "./router-url.js";
import { AccessDeniedError, classifyOperation, requireBank, visibleBanks, type BankAccess } from "./bank-access.js";
import { TOKEN_FORMAT_PATTERN } from "./principal-credential-resolver.js";

export class RouterRequestError extends Error {
  constructor(readonly statusCode: number) {
    super(`memory request failed (${statusCode})`);
    this.name = "RouterRequestError";
  }
}

export class RouterTransport {
  readonly baseUrl: string;
  readonly access: BankAccess;
  readonly #token: () => string | undefined;
  readonly #send: typeof fetch;
  readonly #principalId?: string;
  #denied = false;

  constructor(options: { routerUrl: string; access: BankAccess; token: () => string | undefined; principalId?: string; fetch?: typeof fetch }) {
    this.baseUrl = validateRouterUrl(options.routerUrl);
    const url = new URL(this.baseUrl);
    if (url.search || url.hash) throw new AccessDeniedError();
    this.access = Object.freeze({ writeBank: options.access.writeBank, additionalReadBanks: Object.freeze([...options.access.additionalReadBanks]) });
    visibleBanks(this.access);
    this.#principalId = options.principalId;
    this.#token = options.token;
    this.#send = options.fetch ?? ((input, init) => fetch(input, init));
    this.credential();
  }

  hasCredentials(): boolean {
    try { this.credential(); return true; } catch { return false; }
  }

  assertAuthorized(): void {
    if (this.#denied) throw new AccessDeniedError();
  }

  private credential(): string {
    this.assertAuthorized();
    const token = this.#token();
    if (!token || !TOKEN_FORMAT_PATTERN.test(token)) throw new AccessDeniedError();
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
    if (/[\\#]/.test(url) || /%(?:2e|2f|5c|25)/i.test(url) || /\/\.\.?(?:\/|$|\?)/.test(url)) throw new AccessDeniedError();
    const parsed = new URL(url);
    const routingKeys = ["bankId", "bank_id", "bank_ids"];
    if (routingKeys.some(key => parsed.searchParams.has(key))) throw new AccessDeniedError();
    if (typeof init.body === "string") {
      let body: unknown;
      try { body = JSON.parse(init.body); } catch { throw new AccessDeniedError(); }
      if (body && typeof body === "object" && routingKeys.some(key => Object.hasOwn(body, key))) throw new AccessDeniedError();
    }
    const prefix = `${this.baseUrl}/v1/default/banks/`;
    if (url === `${this.baseUrl}/v1/default/banks` && method === "GET") {
      // Never request global bank metadata. These are configured IDs, not existence claims.
      return Response.json({ banks: visibleBanks(this.access).map(bank_id => ({ bank_id })) });
    }
    if (!(url === `${this.baseUrl}/version` && method === "GET")) {
      if (!url.startsWith(prefix)) throw new AccessDeniedError();
      const path = url.slice(prefix.length).split("?")[0];
      const split = path.indexOf("/");
      const bank = decodeURIComponent(split < 0 ? path : path.slice(0, split));
      const suffix = split < 0 ? "" : path.slice(split);
      requireBank(this.access, bank, classifyOperation(method, suffix));
    }
    if (parsed.username || parsed.password) throw new AccessDeniedError();
    let response: Response;
    try {
      response = await this.#send(url, {
        ...init,
        redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(this.#principalId ? { "x-memory-router-agent": this.#principalId } : {}) },
        signal: init.signal ?? AbortSignal.timeout(15_000),
      });
    } catch {
      throw new RouterRequestError(503);
    }
    if (response.status === 401 || response.status === 403) {
      this.#denied = true;
      throw new AccessDeniedError();
    }
    // Never expose server error bodies, which may echo credentials or bank existence.
    if (!response.ok && (response.status !== 404 || method !== "GET")) throw new RouterRequestError(response.status);
    return response.status === 404 ? new Response(null, { status: 404 }) : response;
  }
}
