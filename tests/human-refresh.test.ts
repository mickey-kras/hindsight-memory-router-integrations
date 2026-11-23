import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginHuman, runHumanAuth, signOutHuman } from "../src/coding-agents/human-login.js";
import { ensureFreshHumanSession } from "../src/coding-agents/human-refresh.js";
import { readHumanSession, secureEntry } from "../src/coding-agents/human-session.js";
import { harnessTransport } from "../src/coding-agents/runtime.js";
import { RouterRequestError } from "../src/shared/router-transport.js";

const keychain = vi.hoisted(() => ({ records: new Map<string, string>(), writeFails: false }));
vi.mock("node:module", () => ({
  createRequire:
    () =>
    (name: string): unknown => {
      if (name !== "@napi-rs/keyring") throw new Error("unexpected native dependency");
      return {
        Entry: class {
          private readonly key: string;
          constructor(service: string, account: string) {
            this.key = `${service}:${account}`;
          }
          getPassword(): string | null {
            return keychain.records.get(this.key) ?? null;
          }
          setPassword(value: string): void {
            if (keychain.writeFails) throw new Error("SENSITIVE write failed");
            keychain.records.set(this.key, value);
          }
          deleteCredential(): boolean {
            return keychain.records.delete(this.key);
          }
        },
      };
    },
}));

const router = "https://router.example.test/prefix";
const now = () => Math.floor(Date.now() / 1000);
const access = (char: string) => `mrh_${char.repeat(32)}_${char.repeat(64)}`;
const refresh = (char: string) => `mrr_${char.repeat(32)}_${char.repeat(64)}`;
const stored = (overrides: Record<string, unknown> = {}) => ({
  token: access("a"),
  principal_id: "human-example",
  expires_at: now() - 10,
  routerUrl: router,
  refresh_token: refresh("1"),
  ...overrides,
});
const issued = (char: string, overrides: Record<string, unknown> = {}) => ({
  token: access(char),
  token_type: "Bearer",
  refresh_token: refresh(char),
  principal_id: "human-example",
  grants: [{ bank: "private", scopes: ["memory.recall"] }],
  expires_at: now() + 3600,
  ...overrides,
});

let directory: string;
type Handler = (body: Record<string, string>, init: RequestInit) => Response | Promise<Response>;
interface Call {
  route: string;
  body: Record<string, string>;
  authorization: string | null;
}

function routerMock(handlers: Partial<Record<"refresh" | "sign-out" | "memory", Handler>> = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, string>) : {};
      const route = url.includes("/auth/human/") ? (url.split("/auth/human/")[1] ?? "") : "memory";
      calls.push({ route, body, authorization: new Headers(init.headers).get("Authorization") });
      const handler = handlers[route as "refresh" | "sign-out" | "memory"];
      if (handler) return handler(body, init);
      if (route === "refresh") return Response.json(issued("b"));
      if (route === "sign-out") return Response.json({ signed_out: true });
      return Response.json({});
    }),
  );
  return calls;
}

function lockPath(harness: string): string {
  const key = createHash("sha256").update(`${router}\0${harness}\0person`).digest("hex");
  return join(directory, ".hindsight", "locks", `human-${key}.lock`);
}

function store(harness: string, value: unknown): void {
  secureEntry(router, "person", harness).setPassword(JSON.stringify(value));
}

function provision(harnesses = ["codex", "claude-code"]): void {
  writeFileSync(
    join(directory, "router.json"),
    JSON.stringify({
      routerUrl: router,
      principals: Object.fromEntries(
        harnesses.map((harness) => [
          harness,
          {
            human: { credentialRef: "person" },
            writeBank: "private",
            additionalReadBanks: [],
            mapPathToBank: { [directory]: "private" },
          },
        ]),
      ),
    }),
  );
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "human-refresh-"));
  provision();
  vi.stubEnv("HOME", directory);
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", join(directory, "router.json"));
  keychain.records.clear();
  keychain.writeFails = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe("automatic renewal", () => {
  it("renews a long-running MCP transport once and replaces the keyring entry before use", async () => {
    store("codex", { ...stored(), expires_at: now() + 3000 });
    const calls = routerMock({
      refresh: (body) => {
        // The keyring still holds the old entry while the router rotates.
        expect(readHumanSession(router, "person", "codex").token).toBe(access("a"));
        expect(body).toEqual({ refresh_token: refresh("1") });
        return Response.json(issued("b"));
      },
    });
    const transport = harnessTransport("codex");
    store("codex", stored());
    await transport.request(transport.bankUrl("private"));
    await transport.request(transport.bankUrl("private"));
    expect(calls.map((call) => call.route)).toEqual(["refresh", "memory", "memory"]);
    expect(calls[0].authorization).toBeNull();
    expect(calls.slice(1).every((call) => call.authorization === `Bearer ${access("b")}`)).toBe(true);
    expect(readHumanSession(router, "person", "codex")).toMatchObject({
      token: access("b"),
      refresh_token: refresh("b"),
      principal_id: "human-example",
    });
  });

  it("serializes concurrent MCP and hook requests on one entry into one refresh", async () => {
    store("codex", stored());
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = routerMock({
      refresh: async () => {
        await paused;
        return Response.json(issued("b"));
      },
    });
    const mcp = harnessTransport("codex");
    const hook = harnessTransport("codex");
    const requests = [mcp.request(mcp.bankUrl("private")), hook.request(hook.bankUrl("private"))];
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    release();
    await Promise.all(requests);
    expect(calls.filter((call) => call.route === "refresh")).toHaveLength(1);
    expect(calls.filter((call) => call.route === "memory").map((call) => call.authorization)).toEqual([
      `Bearer ${access("b")}`,
      `Bearer ${access("b")}`,
    ]);
  });

  it("honors caller cancellation during renewal and still persists the rotation", async () => {
    store("codex", stored());
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = routerMock({
      refresh: async () => {
        await paused;
        return Response.json(issued("b"));
      },
    });
    const transport = harnessTransport("codex");
    const controller = new AbortController();
    const pending = transport.request(transport.bankUrl("private"), { signal: controller.signal });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort(new DOMException("caller deadline", "TimeoutError"));
    await expect(pending).rejects.toThrow("caller deadline");
    release();
    await vi.waitFor(() => expect(readHumanSession(router, "person", "codex").token).toBe(access("b")));
    expect(calls.map((call) => call.route)).toEqual(["refresh"]);
  });

  it("rejects an already aborted request before renewal resolves", async () => {
    store("codex", stored());
    routerMock();
    const transport = harnessTransport("codex");
    const controller = new AbortController();
    controller.abort(new DOMException("aborted", "AbortError"));
    await expect(transport.request(transport.bankUrl("private"), { signal: controller.signal })).rejects.toThrow(
      "aborted",
    );
  });

  it("reuses a session another process refreshed while this one waited for the lock", async () => {
    store("codex", stored());
    const calls = routerMock();
    const lock = lockPath("codex");
    mkdirSync(lock, { recursive: true });
    const pending = ensureFreshHumanSession(router, "person", "codex");
    // The other process holds the lock, writes its refreshed entry, then releases the lock.
    store("codex", stored({ token: access("c"), refresh_token: refresh("c"), expires_at: now() + 3600 }));
    rmSync(lock, { recursive: true });
    await expect(pending).resolves.toMatchObject({ token: access("c") });
    expect(calls).toHaveLength(0);
  });

  it("breaks a lock whose holder process no longer exists", async () => {
    store("codex", stored());
    const calls = routerMock();
    const lock = lockPath("codex");
    mkdirSync(lock, { recursive: true });
    // Above the Linux pid_max, so no process can have this ID.
    writeFileSync(join(lock, "owner"), "999999999");
    await expect(ensureFreshHumanSession(router, "person", "codex")).resolves.toMatchObject({ token: access("b") });
    expect(calls.map((call) => call.route)).toEqual(["refresh"]);
    expect(existsSync(lock)).toBe(false);
  });

  it("never breaks an old lock while its holder is alive", async () => {
    store("codex", stored());
    const calls = routerMock();
    const lock = lockPath("codex");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner"), String(process.pid));
    utimesSync(lock, new Date(0), new Date(0));
    let settled = false;
    const pending = ensureFreshHumanSession(router, "person", "codex").finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    expect(calls).toHaveLength(0);
    rmSync(lock, { recursive: true });
    await expect(pending).resolves.toMatchObject({ token: access("b") });
  });

  it("breaks an ownerless lock only after a crash could have left it", async () => {
    store("codex", stored());
    routerMock();
    const lock = lockPath("codex");
    mkdirSync(lock, { recursive: true });
    utimesSync(lock, new Date(0), new Date(0));
    await expect(ensureFreshHumanSession(router, "person", "codex")).resolves.toMatchObject({ token: access("b") });
  });

  it("keeps access-only entries until expiry, then requires one explicit login without refresh", async () => {
    store("codex", { ...stored({ expires_at: now() + 3000 }), refresh_token: undefined });
    const calls = routerMock();
    const transport = harnessTransport("codex");
    await transport.request(transport.bankUrl("private"));
    store("codex", { ...stored(), refresh_token: undefined });
    await expect(transport.request(transport.bankUrl("private"))).rejects.toThrow("human session unavailable");
    expect(calls.map((call) => call.route)).toEqual(["memory"]);
  });
});

describe("refresh failures", () => {
  it.each([400, 401])("clears only the matching harness on definitive rejection %s", async (status) => {
    store("codex", stored());
    store("claude-code", stored({ token: access("d"), refresh_token: refresh("d"), expires_at: now() + 3600 }));
    routerMock({ refresh: () => new Response(null, { status }) });
    const codex = harnessTransport("codex");
    await expect(codex.request(codex.bankUrl("private"))).rejects.toThrow("human session unavailable");
    expect(() => readHumanSession(router, "person", "codex")).toThrow();
    const claude = harnessTransport("claude-code");
    await expect(claude.request(claude.bankUrl("private"))).resolves.toBeInstanceOf(Response);
  });

  it.each([429, 503])("preserves the entry on transient status %s without resubmitting", async (status) => {
    store("codex", stored());
    const calls = routerMock({ refresh: () => new Response(null, { status }) });
    await expect(ensureFreshHumanSession(router, "person", "codex")).rejects.toBeInstanceOf(RouterRequestError);
    expect(readHumanSession(router, "person", "codex").refresh_token).toBe(refresh("1"));
    expect(calls.map((call) => call.route)).toEqual(["refresh"]);
  });

  it("preserves the entry when the router is unreachable before the request is sent", async () => {
    store("codex", stored());
    routerMock({
      refresh: () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }) });
      },
    });
    await expect(ensureFreshHumanSession(router, "person", "codex")).rejects.toBeInstanceOf(RouterRequestError);
    expect(readHumanSession(router, "person", "codex").refresh_token).toBe(refresh("1"));
  });

  it("uses a still-valid access token when renewal is temporarily unavailable", async () => {
    store("codex", stored({ expires_at: now() + 30 }));
    routerMock({ refresh: () => new Response(null, { status: 503 }) });
    await expect(ensureFreshHumanSession(router, "person", "codex")).resolves.toMatchObject({ token: access("a") });
  });

  it.each([
    ["a lost response", () => Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }))],
    ["a gateway error", () => new Response(null, { status: 502 })],
    ["a changed principal", () => Response.json(issued("b", { principal_id: "human-other" }))],
    ["a missing refresh token", () => Response.json(issued("b", { refresh_token: undefined }))],
    ["an overlong expiry", () => Response.json(issued("b", { expires_at: now() + 7200 }))],
  ] as const)("revokes instead of resubmitting after %s", async (_name, response) => {
    store("codex", stored());
    const calls = routerMock({ refresh: response });
    const failure = ensureFreshHumanSession(router, "person", "codex");
    await expect(failure).rejects.toThrow("renewal could not be confirmed");
    expect(calls.filter((call) => call.route === "refresh")).toHaveLength(1);
    const signOut = calls.find((call) => call.route === "sign-out");
    expect(signOut?.authorization).toBeNull();
    expect([refresh("1"), refresh("b")]).toContain(signOut?.body.refresh_token);
    expect(keychain.records.size).toBe(0);
  });

  it("revokes the rotated session when the keyring write fails", async () => {
    store("codex", stored());
    const calls = routerMock();
    keychain.writeFails = true;
    const failure = ensureFreshHumanSession(router, "person", "codex");
    await expect(failure).rejects.toThrow("renewal could not be confirmed");
    await expect(failure).rejects.not.toThrow("SENSITIVE");
    expect(calls.map((call) => [call.route, call.body.refresh_token])).toEqual([
      ["refresh", refresh("1")],
      ["sign-out", refresh("b")],
    ]);
  });

  it("reports an actionable compatibility error for a router without refresh", async () => {
    store("codex", stored());
    routerMock({ refresh: () => new Response(null, { status: 404 }) });
    await expect(ensureFreshHumanSession(router, "person", "codex")).rejects.toThrow(
      "router does not support human session refresh",
    );
  });
});

describe("login and sign-out", () => {
  it("stores the refresh token returned by exchange", async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        if (!url.startsWith(router)) return realFetch(input, init);
        const body = JSON.parse(String(init.body)) as Record<string, string>;
        if (!url.endsWith("/start")) return Response.json(issued("e"));
        const auth = new URL("https://issuer.example.test/authorize");
        for (const [key, value] of Object.entries({
          ...body,
          response_type: "code",
          scope: "openid",
          code_challenge_method: "S256",
        }))
          auth.searchParams.set(key, value);
        return Response.json({ transaction_id: "t".repeat(32), authorization_url: auth.href });
      }),
    );
    await loginHuman(router, "person", "codex", async (url) => {
      const auth = new URL(url);
      const callback = new URL(String(auth.searchParams.get("redirect_uri")));
      callback.searchParams.set("state", String(auth.searchParams.get("state")));
      callback.searchParams.set("code", "synthetic-auth-code");
      await realFetch(callback);
    });
    expect(readHumanSession(router, "person", "codex")).toMatchObject({
      token: access("e"),
      refresh_token: refresh("e"),
    });
    expect([...keychain.records.values()][0]).not.toContain("grants");
  });

  it("revokes a refreshable session with its refresh token after access expiry", async () => {
    store("codex", stored());
    store("claude-code", stored({ token: access("d"), refresh_token: refresh("d"), expires_at: now() + 3600 }));
    const calls = routerMock();
    expect(await signOutHuman(router, "person", "codex")).toBe(true);
    expect(calls).toEqual([{ route: "sign-out", body: { refresh_token: refresh("1") }, authorization: null }]);
    expect(() => readHumanSession(router, "person", "codex")).toThrow();
    const claude = harnessTransport("claude-code");
    await expect(claude.request(claude.bankUrl("private"))).resolves.toBeInstanceOf(Response);
  });

  it("waits for an in-flight refresh and revokes its result so the entry stays signed out", async () => {
    store("codex", stored());
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = routerMock({
      refresh: async () => {
        await paused;
        return Response.json(issued("b"));
      },
    });
    const renewal = ensureFreshHumanSession(router, "person", "codex");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const signOut = signOutHuman(router, "person", "codex");
    release();
    await renewal;
    expect(await signOut).toBe(true);
    expect(calls.at(-1)).toMatchObject({ route: "sign-out", body: { refresh_token: refresh("b") } });
    expect(keychain.records.size).toBe(0);
    await expect(ensureFreshHumanSession(router, "person", "codex")).rejects.toThrow("human session unavailable");
  });

  it("removes the local credential and reports unconfirmed revocation when sign-out fails", async () => {
    store("codex", stored());
    routerMock({ "sign-out": () => new Response(null, { status: 503 }) });
    const messages: string[] = [];
    expect(await runHumanAuth(["sign-out", "codex"], (message) => messages.push(message), false)).toBe(1);
    expect(messages.join()).toContain("server revocation could not be confirmed");
    expect(messages.join()).not.toContain(refresh("1"));
    expect(keychain.records.size).toBe(0);
  });
});
