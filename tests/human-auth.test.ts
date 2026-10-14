import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginHuman, openLoginBrowser, runHumanAuth, signOutHuman } from "../src/coding-agents/human-login.js";
import {
  humanRouterUrl,
  readHumanSession,
  secureEntry,
  validateHumanSession,
} from "../src/coding-agents/human-session.js";
import { harnessTransport } from "../src/coding-agents/runtime.js";
import { loadManagedConfig } from "../src/shared/managed-config.js";

const keychain = vi.hoisted(() => ({
  records: new Map<string, string>(),
  locked: false,
  writeFails: false,
  deleteFails: false,
  constructed: [] as Array<{ service: string; account: string; options: unknown }>,
}));
vi.mock("node:module", () => ({
  createRequire:
    () =>
    (name: string): unknown => {
      if (name !== "@napi-rs/keyring") throw new Error("unexpected native dependency");
      return {
        Entry: class {
          private readonly key: string;
          constructor(service: string, account: string, options: unknown) {
            keychain.constructed.push({ service, account, options });
            this.key = `${service}:${account}`;
          }
          getPassword(): string | null {
            if (keychain.locked) throw new Error("SENSITIVE native identity");
            return keychain.records.get(this.key) ?? null;
          }
          setPassword(value: string): void {
            if (keychain.writeFails) throw new Error("SENSITIVE write failed");
            keychain.records.set(this.key, value);
          }
          deleteCredential(): boolean {
            if (keychain.deleteFails) throw new Error("SENSITIVE delete failed");
            return keychain.records.delete(this.key);
          }
        },
      };
    },
}));

const router = "https://router.example.test/prefix";
const token = `mrh_${"a".repeat(32)}_${"b".repeat(64)}`;
const session = () => ({
  token,
  principal_id: "human-example",
  expires_at: Math.floor(Date.now() / 1000) + 3500,
  routerUrl: router,
});
const realFetch = globalThis.fetch;
let directory: string;
let configPath: string;

function provision(extra: Record<string, unknown> = {}): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      routerUrl: router,
      principals: {
        codex: {
          human: { credentialRef: "person" },
          writeBank: "private",
          additionalReadBanks: [],
          mapPathToBank: { [directory]: "private" },
          ...extra,
        },
      },
    }),
  );
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "human-auth-"));
  configPath = join(directory, "router.json");
  provision();
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", configPath);
  vi.stubEnv("HINDSIGHT_MCP_HARNESS", "codex");
  keychain.records.clear();
  keychain.constructed.length = 0;
  keychain.locked = false;
  keychain.writeFails = false;
  keychain.deleteFails = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe("OS credential isolation", () => {
  it("pins Linux Secret Service and separates router path and credential references", () => {
    secureEntry(router, "person").setPassword(JSON.stringify(session()));
    expect(readHumanSession(router, "person")).toEqual(session());
    expect(keychain.constructed[0].options).toEqual({ linux: { store: "secret-service" } });
    expect(() => readHumanSession("https://router.example.test/another", "person")).toThrow(
      "human session unavailable",
    );
    expect(() => readHumanSession(router, "another")).toThrow("human session unavailable");
    expect(keychain.constructed[0].service).not.toContain("human-example");
  });

  it.each([undefined, "{}", "invalid", "x".repeat(4097)])("rejects missing or malformed storage %s", (value) => {
    if (value) secureEntry(router, "person").setPassword(value);
    expect(() => readHumanSession(router, "person")).toThrow("human session unavailable");
  });

  it("redacts locked-store failures and never consults an app environment token", () => {
    vi.stubEnv("APP_TOKEN", `mr_app_${"c".repeat(64)}`);
    keychain.locked = true;
    expect(() => readHumanSession(router, "person")).toThrow("human session unavailable");
    expect(() => harnessTransport("codex")).toThrow("human session unavailable");
  });

  it.each([
    { token: `mr_app_${"a".repeat(64)}` },
    { principal_id: "bad principal" },
    { expires_at: 0 },
    { expires_at: 1.5 },
    { expires_at: Math.floor(Date.now() / 1000) + 7200 },
    { routerUrl: "https://another.test" },
  ])("rejects invalid session binding %#", (change) => {
    expect(() => validateHumanSession({ ...session(), ...change }, router)).toThrow("human session unavailable");
  });

  it.each([
    "http://router.test",
    "https://router.test/?token=x",
    "https://router.test/#fragment",
    "https://router.test/a/../b",
    "https://router.test/a%2Fb",
    "https://router.test/a\\b",
    "https://router.test/prefix//",
    "https://u:p@router.test",
  ])("rejects ambiguous/insecure base %s", (url) => {
    expect(() => humanRouterUrl(url)).toThrow();
  });

  it.each([0, 1, 3, 4])("rejects malformed HTTPS authority with %i separators before normalization", (count) => {
    for (const path of ["/prefix", "/prefix/../admin", "/a%2Fb"]) {
      expect(() => humanRouterUrl(`https:${"/".repeat(count)}router.example${path}`)).toThrow(
        "human session unavailable",
      );
    }
  });

  it.each(["https://", "https:///", "https://?query", "https://#fragment", "https://@router.test"])(
    "rejects missing or ambiguous authority %s",
    (url) => expect(() => humanRouterUrl(url)).toThrow("human session unavailable"),
  );

  it("normalizes host/default TLS port and retains router prefix", () => {
    expect(humanRouterUrl("https://ROUTER.example.test:443/prefix/")).toBe(router);
    expect(humanRouterUrl("HTTPS://ROUTER.example.test:8443/prefix/child")).toBe(
      "https://router.example.test:8443/prefix/child",
    );
    expect(humanRouterUrl("https://[::1]:8443/prefix")).toBe("https://[::1]:8443/prefix");
    expect(humanRouterUrl(" \thttps://ROUTER.example.test:443/prefix/\r\n ")).toBe(router);
    expect(() => secureEntry(router, "bad/ref")).toThrow("human session unavailable");
  });

  it.each(["/prefix//", "/a/../b", "/a/./b", "/a%2Fb", "/a%2e%2e/b"])(
    "rejects ambiguous path %s even when URL has surrounding whitespace",
    (path) => {
      expect(() => humanRouterUrl(` \thttps://router.test${path}\r\n `)).toThrow("human session unavailable");
    },
  );

  it.each(["\t", "\r", "\n", "\0", "\u001f", "\u007f"])(
    "rejects embedded ASCII control %# before URL normalization can hide it",
    (control) => {
      expect(() => humanRouterUrl(` https://router.example/prefix/${control}../admin `)).toThrow(
        "human session unavailable",
      );
      expect(() => humanRouterUrl(` https:${control}//router.example/prefix/../admin `)).toThrow(
        "human session unavailable",
      );
    },
  );

  it.each([
    { tokenEnv: "APP_TOKEN" },
    { human: { credentialRef: "person", token } },
    { human: null },
    { human: { credentialRef: "bad/ref" } },
  ])("rejects mixed or malformed managed human config %#", (change) => {
    provision(change);
    expect(() => loadManagedConfig(process.env, "codex")).toThrow("memory access denied");
  });

  it("re-reads expiry/sign-out/re-login in existing transports with server-bound principal", async () => {
    secureEntry(router, "person").setPassword(JSON.stringify(session()));
    const send = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}"));
    vi.stubGlobal("fetch", send);
    const transport = harnessTransport("codex");
    await transport.request(transport.bankUrl("private"));
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "x-memory-router-agent": "human-example" },
    });
    secureEntry(router, "person").deleteCredential();
    await expect(transport.request(transport.bankUrl("private"))).rejects.toThrow("human session unavailable");
    secureEntry(router, "person").setPassword(JSON.stringify({ ...session(), principal_id: "human-second" }));
    await transport.request(transport.bankUrl("private"));
    expect(send.mock.calls[1]?.[1]).toMatchObject({ headers: { "x-memory-router-agent": "human-second" } });
    secureEntry(router, "person").setPassword(JSON.stringify({ ...session(), expires_at: 1 }));
    expect(transport.hasCredentials()).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

interface RouterMockOptions {
  start?: (value: Record<string, string>) => unknown;
  exchange?: unknown;
  revokeFails?: boolean;
}
function mockRouter(options: RouterMockOptions = {}) {
  const requests: Array<{ url: string; init: RequestInit; body: Record<string, string> }> = [];
  const send = vi.fn(async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    if (!url.startsWith(router)) return realFetch(input, init);
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, string>) : {};
    requests.push({ url, init, body });
    if (url.endsWith("/start")) {
      const auth = new URL("https://issuer.example.test/authorize");
      for (const [key, value] of Object.entries({
        ...body,
        response_type: "code",
        scope: "openid",
        code_challenge_method: "S256",
      }))
        auth.searchParams.set(key, value);
      return Response.json(
        options.start ? options.start(body) : { transaction_id: "t".repeat(32), authorization_url: auth.href },
      );
    }
    if (url.endsWith("/exchange"))
      return Response.json(
        options.exchange ?? {
          ...session(),
          token_type: "Bearer",
          grants: [{ bank: "private", scopes: ["memory.recall", "memory.retain"] }],
        },
      );
    if (url.endsWith("/sign-out")) return new Response(null, { status: options.revokeFails ? 503 : 204 });
    throw new Error("unexpected route");
  });
  vi.stubGlobal("fetch", send);
  return requests;
}

async function authorize(url: string, mutate?: (callback: URL) => void): Promise<void> {
  const auth = new URL(url);
  const callback = new URL(String(auth.searchParams.get("redirect_uri")));
  callback.searchParams.set("state", String(auth.searchParams.get("state")));
  callback.searchParams.set("code", "synthetic-auth-code");
  mutate?.(callback);
  await realFetch(callback);
}

describe("interactive code flow", () => {
  it("exchanges loopback code+PKCE once and stores only bound credential metadata", async () => {
    const requests = mockRouter();
    await loginHuman(router, "person", authorize);
    expect(requests.map((item) => item.url)).toEqual([`${router}/auth/human/start`, `${router}/auth/human/exchange`]);
    expect(requests[0].body.state).toMatch(/^[\w-]{43}$/);
    expect(requests[1].body.code_verifier).toMatch(/^[\w-]{43}$/);
    expect(requests[1].body.code_verifier).not.toBe(requests[0].body.code_challenge);
    expect(requests.every((item) => item.init.redirect === "error")).toBe(true);
    expect(readHumanSession(router, "person")).toEqual(session());
    expect([...keychain.records.values()][0]).not.toContain("synthetic-auth-code");
    expect([...keychain.records.values()][0]).not.toContain("grants");
  });

  it.each([
    (url: URL) => url.searchParams.set("state", "x".repeat(43)),
    (url: URL) => url.searchParams.set("state", "é".repeat(43)),
    (url: URL) => url.searchParams.append("code", "duplicate"),
    (url: URL) => url.searchParams.set("error", "access_denied"),
    (url: URL) => url.searchParams.delete("code"),
  ])("rejects callback tampering without exchange %#", async (mutate) => {
    const requests = mockRouter();
    await expect(loginHuman(router, "person", (url) => authorize(url, mutate))).rejects.toThrow(
      "human session unavailable",
    );
    expect(requests).toHaveLength(1);
    expect(keychain.records.size).toBe(0);
  });

  it("rejects callback replay and applies no-store browser headers", async () => {
    mockRouter();
    await loginHuman(router, "person", async (url) => {
      const auth = new URL(url);
      const callback = new URL(String(auth.searchParams.get("redirect_uri")));
      callback.searchParams.set("code", "synthetic-code");
      callback.searchParams.set("state", String(auth.searchParams.get("state")));
      const first = await realFetch(callback);
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect((await realFetch(callback)).status).toBe(404);
    });
  });

  it.each([
    { token_type: "Basic" },
    { token: "mr_app_invalid" },
    { grants: [{ bank: "private", scopes: ["admin"] }] },
    { grants: [{ bank: "bad/bank", scopes: [] }] },
    { grants: "invalid" },
    { expires_at: 0 },
  ])("rejects malformed/elevated exchange response %#", async (change) => {
    mockRouter({ exchange: { ...session(), token_type: "Bearer", grants: [], ...change } });
    await expect(loginHuman(router, "person", authorize)).rejects.toThrow("human session unavailable");
    expect(keychain.records.size).toBe(0);
  });

  it("revokes a newly issued credential if secure persistence fails", async () => {
    const requests = mockRouter();
    keychain.writeFails = true;
    await expect(loginHuman(router, "person", authorize)).rejects.toThrow("human session unavailable");
    expect(requests.at(-1)?.url).toBe(`${router}/auth/human/sign-out`);
    expect(keychain.records.size).toBe(0);
  });

  it("rejects a server redirect target before opening browser", async () => {
    mockRouter({ start: () => ({ transaction_id: "t".repeat(32), authorization_url: "http://attacker.test" }) });
    const open = vi.fn();
    await expect(loginHuman(router, "person", open)).rejects.toThrow("human session unavailable");
    expect(open).not.toHaveBeenCalled();
  });

  it("does not start login with inaccessible secure storage", async () => {
    const requests = mockRouter();
    keychain.locked = true;
    await expect(loginHuman(router, "person", authorize)).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});

describe("explicit lifecycle", () => {
  it.each([401, 403])("keeps human status %s actionable without retry or token fallback", async (status) => {
    secureEntry(router, "person").setPassword(JSON.stringify(session()));
    vi.stubEnv("APP_TOKEN", `mr_app_${"c".repeat(64)}`);
    const send = vi.fn(async () => new Response(null, { status }));
    vi.stubGlobal("fetch", send);
    const transport = harnessTransport("codex");
    const message = status === 401 ? "human session unavailable" : "memory access denied";
    await expect(transport.request(transport.bankUrl("private"))).rejects.toThrow(message);
    await expect(transport.request(transport.bankUrl("private"))).rejects.toThrow(message);
    expect(send).toHaveBeenCalledTimes(1);
    secureEntry(router, "person").setPassword(
      JSON.stringify({ ...session(), token: `mrh_${"d".repeat(32)}_${"e".repeat(64)}` }),
    );
    send.mockResolvedValue(new Response("{}"));
    await expect(transport.request(transport.bankUrl("private"))).resolves.toBeInstanceOf(Response);
  });

  it("preserves application 401 behavior", async () => {
    provision({ human: undefined, tokenEnv: "APP_TOKEN" });
    vi.stubEnv("APP_TOKEN", `mr_app_${"c".repeat(64)}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    const transport = harnessTransport("codex");
    await expect(transport.request(transport.bankUrl("private"))).rejects.toThrow("memory access denied");
  });

  it.skipIf(process.platform !== "linux")(
    "detects unsuccessful browser opener exits without exposing URL or stderr",
    async () => {
      writeFileSync(join(directory, "xdg-open"), "#!/bin/sh\necho SENSITIVE >&2\nexit 23\n", { mode: 0o700 });
      vi.stubEnv("PATH", directory);
      const stderr = vi.spyOn(process.stderr, "write");
      await expect(openLoginBrowser("https://issuer.example.test/?state=SENSITIVE")).rejects.toThrow(
        "human session unavailable",
      );
      expect(stderr).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform !== "linux")(
    "does not wait for an opener that remains attached to its browser",
    async () => {
      writeFileSync(join(directory, "xdg-open"), "#!/bin/sh\n/bin/sleep 2\n", { mode: 0o700 });
      vi.stubEnv("PATH", directory);
      const started = Date.now();
      await expect(openLoginBrowser("https://issuer.example.test/")).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(1_800);
    },
  );

  it.skipIf(process.platform !== "linux")("accepts successful opener exit and rejects missing executable", async () => {
    writeFileSync(join(directory, "xdg-open"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    vi.stubEnv("PATH", directory);
    await expect(openLoginBrowser("https://issuer.example.test/")).resolves.toBeUndefined();
    rmSync(join(directory, "xdg-open"));
    await expect(openLoginBrowser("https://issuer.example.test/")).rejects.toThrow("human session unavailable");
  });

  it.each([false, true])("removes local credential when remote revocation fails=%s", async (revokeFails) => {
    const requests = mockRouter({ revokeFails });
    secureEntry(router, "person").setPassword(JSON.stringify(session()));
    expect(await signOutHuman(router, "person")).toBe(!revokeFails);
    expect(keychain.records.size).toBe(0);
    expect(requests[0].init.headers).toMatchObject({ Authorization: `Bearer ${token}` });
  });

  it("signs out absent/expired credentials and never claims failed keychain deletion succeeded", async () => {
    mockRouter();
    expect(await signOutHuman(router, "person")).toBe(true);
    secureEntry(router, "person").setPassword(JSON.stringify({ ...session(), expires_at: 1 }));
    keychain.deleteFails = true;
    await expect(signOutHuman(router, "person")).rejects.toThrow();
    expect(keychain.records.size).toBe(1);
  });

  it("CLI reports unconfirmed revocation without exposing credential/identity", async () => {
    mockRouter({ revokeFails: true });
    secureEntry(router, "person").setPassword(JSON.stringify(session()));
    const messages: string[] = [];
    expect(await runHumanAuth(["sign-out", "codex"], (value) => messages.push(value), false)).toBe(1);
    expect(messages.join()).toContain("server revocation could not be confirmed");
    expect(messages.join()).not.toContain(token);
    expect(messages.join()).not.toContain("human-example");
  });

  it.each(["SENSITIVE malformed JSON", JSON.stringify({ token, principal_id: "SENSITIVE invalid metadata" })])(
    "CLI reports local removal when stored session is malformed %# without making a bearer request",
    async (stored) => {
      const requests = mockRouter();
      secureEntry(router, "person").setPassword(stored);
      const messages: string[] = [];
      expect(await runHumanAuth(["sign-out", "codex"], (value) => messages.push(value), false)).toBe(1);
      expect(messages.join()).toContain("Local credential removed; server revocation could not be confirmed");
      expect(messages.join()).not.toContain("SENSITIVE");
      expect(messages.join()).not.toContain(token);
      expect(keychain.records.size).toBe(0);
      expect(requests).toHaveLength(0);
    },
  );

  it.each(["locked", "deleteFails"] as const)(
    "CLI never claims local removal when secure storage %s",
    async (failure) => {
      mockRouter();
      secureEntry(router, "person").setPassword(JSON.stringify(session()));
      keychain[failure] = true;
      const messages: string[] = [];
      expect(await runHumanAuth(["sign-out", "codex"], (value) => messages.push(value), false)).toBe(1);
      expect(messages.join()).toContain("Human authentication unavailable");
      expect(messages.join()).not.toContain("Local credential removed");
      expect(messages.join()).not.toContain("SENSITIVE");
    },
  );

  it.each([
    { args: ["login"] },
    { args: ["login", "--api-token=secret"] },
    { args: ["sign-out", "codex", "extra"] },
    { args: ["unknown"] },
  ])("rejects invalid/noninteractive CLI %#", async ({ args }) => {
    const log = vi.fn();
    expect(await runHumanAuth(args, log, false)).toBe(1);
    expect(log.mock.calls.flat().join()).not.toContain("secret");
  });
});
