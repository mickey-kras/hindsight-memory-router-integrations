import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { HindsightClient } from "@vectorize-io/hindsight-client";
import { afterAll, describe, expect, it } from "vitest";

import {
  AGENT_HEADER,
  AuthenticatedClientFactory,
  RouterUrlError,
  validateRouterUrl,
  type RouterClient,
} from "../src/router/authenticated-client-factory.js";

const TOKEN_MAIN = `mr_main-key_${"a".repeat(64)}`;
const TOKEN_BACKEND = `mr_backend-key_${"b".repeat(64)}`;

describe("validateRouterUrl", () => {
  it("accepts https URLs", () => {
    expect(validateRouterUrl("https://router.example.test/")).toBe("https://router.example.test");
  });

  it("rejects http URLs: no HTTP fallback", () => {
    expect(() => validateRouterUrl("http://router.example.test")).toThrow(RouterUrlError);
    expect(() => validateRouterUrl("http://router.example.test")).toThrow("not-https");
  });

  it("rejects credentials in URLs", () => {
    expect(() => validateRouterUrl("https://user:pass@router.example.test")).toThrow("userinfo");
    expect(() => validateRouterUrl("https://token@router.example.test")).toThrow("userinfo");
  });

  it("rejects missing/invalid URLs", () => {
    expect(() => validateRouterUrl(undefined)).toThrow("missing");
    expect(() => validateRouterUrl("not a url")).toThrow("invalid");
  });
});

describe("AuthenticatedClientFactory", () => {
  it("builds per-agent clients with that agent's token and agent header", () => {
    const built: Array<{
      baseUrl: string;
      apiKey: string;
      headers: Record<string, string>;
    }> = [];
    const factory = new AuthenticatedClientFactory({
      routerUrl: "https://router.example.test",
      userAgent: "test-agent/0",
      construct: (options) => {
        built.push(options);
        return {} as RouterClient;
      },
    });
    factory.forAgent({ agentId: "main", token: TOKEN_MAIN });
    factory.forAgent({ agentId: "backend", token: TOKEN_BACKEND });
    expect(built).toHaveLength(2);
    expect(built[0].apiKey).toBe(TOKEN_MAIN);
    expect(built[0].headers[AGENT_HEADER]).toBe("main");
    expect(built[1].apiKey).toBe(TOKEN_BACKEND);
    expect(built[1].headers[AGENT_HEADER]).toBe("backend");
  });

  it("isolates agents: cached clients never cross agents", () => {
    const factory = new AuthenticatedClientFactory({
      routerUrl: "https://router.example.test",
      userAgent: "test-agent/0",
      construct: () => ({}) as RouterClient,
    });
    const a1 = factory.forAgent({ agentId: "main", token: TOKEN_MAIN });
    const b1 = factory.forAgent({ agentId: "backend", token: TOKEN_BACKEND });
    const a2 = factory.forAgent({ agentId: "main", token: TOKEN_MAIN });
    expect(a1).not.toBe(b1);
    expect(a1).toBe(a2);
  });
});

describe("transport: redirect authorization stripping (Node >=22 undici)", () => {
  let redirector: Server;
  let echo: Server;
  let redirectorPort: number;
  let echoPort: number;

  afterAll(() => {
    redirector?.close();
    echo?.close();
  });

  it("strips Authorization on cross-origin redirect, keeps it same-origin", async () => {
    echo = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ authorization: req.headers.authorization ?? null }));
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    echoPort = (echo.address() as AddressInfo).port;

    redirector = createServer((req, res) => {
      if (req.url === "/cross") {
        // Different host name -> cross-origin per fetch spec.
        res.writeHead(302, { location: `http://localhost:${echoPort}/landing` });
        res.end();
      } else if (req.url === "/same") {
        res.writeHead(302, { location: "/landing" });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ authorization: req.headers.authorization ?? null }));
      }
    });
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    redirectorPort = (redirector.address() as AddressInfo).port;

    const cross = await fetch(`http://127.0.0.1:${redirectorPort}/cross`, {
      headers: { authorization: `Bearer ${TOKEN_MAIN}` },
    }).then((r) => r.json() as Promise<{ authorization: string | null }>);
    const same = await fetch(`http://127.0.0.1:${redirectorPort}/same`, {
      headers: { authorization: `Bearer ${TOKEN_MAIN}` },
    }).then((r) => r.json() as Promise<{ authorization: string | null }>);

    expect(cross.authorization).toBeNull();
    expect(same.authorization).toBe(`Bearer ${TOKEN_MAIN}`);
  });

  it("published client sends Bearer token from apiKey", async () => {
    const seen: { authorization?: string; agent?: string } = {};
    const server = createServer((req, res) => {
      seen.authorization = req.headers.authorization;
      seen.agent = req.headers[AGENT_HEADER] as string | undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const client = new HindsightClient({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: TOKEN_MAIN,
        headers: { [AGENT_HEADER]: "main" },
      });
      await client.recall("main", "hello");
      expect(seen.authorization).toBe(`Bearer ${TOKEN_MAIN}`);
      expect(seen.agent).toBe("main");
    } finally {
      server.close();
    }
  });
});
