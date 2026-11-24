import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { AccessDeniedError, classifyOperation } from "../src/shared/bank-access.js";
import { RouterTransport } from "../src/shared/router-transport.js";

interface RouterRoute {
  readonly method: string;
  readonly route: string;
  readonly access: "read" | "write" | "excluded";
  readonly scope: string;
  readonly payloadScope?: string;
}

const routes = JSON.parse(
  readFileSync(new URL("../compat/router-routes.json", import.meta.url), "utf8"),
) as RouterRoute[];
const suffixOf = (route: string): string => (route ? `/${route.replace(/\{\w+\}/g, "id")}` : "");
const classify = (method: string, suffix: string): "read" | "write" | "excluded" => {
  try {
    return classifyOperation(method, suffix);
  } catch (error) {
    if (error instanceof AccessDeniedError) return "excluded";
    throw error;
  }
};

const url = "https://router.test";
const token = `mr_test_${"a".repeat(64)}`;
function transport(): { client: RouterTransport; send: ReturnType<typeof vi.fn<typeof fetch>> } {
  const send = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({}));
  const client = new RouterTransport({
    routerUrl: url,
    access: { writeBank: "W", additionalReadBanks: ["R"] },
    token: () => token,
    fetch: send,
  });
  return { client, send };
}

describe("client route permissions", () => {
  it.each(routes)("classifies $method /$route as $access", ({ method, route, access }) => {
    expect(classify(method, suffixOf(route)), `${method} /${route} must be ${access}`).toBe(access);
  });

  it("keeps the contract table free of duplicates", () => {
    const keys = routes.map(({ method, route }) => `${method} ${route}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("denies routes the router does not define", () => {
    expect(classify("POST", "/unknown")).toBe("excluded");
    expect(classify("TRACE", "/config")).toBe("excluded");
  });

  it("sends dry-run refresh to the router on a read bank", async () => {
    const { client, send } = transport();
    await client.request(client.bankUrl("R", "/mental-models/id/dry-run-refresh"), { method: "POST" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(routes.filter(({ access }) => access === "write"))(
    "restricts $method /$route to the write bank",
    async ({ method, route }) => {
      const { client, send } = transport();
      const suffix = suffixOf(route);
      await expect(client.request(client.bankUrl("R", suffix), { method })).rejects.toThrow(AccessDeniedError);
      expect(send).not.toHaveBeenCalled();
      await client.request(client.bankUrl("W", suffix), { method });
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("treats dry-run extraction as a write although the router marks it as a read", () => {
    const extraction = routes.find(({ route }) => route === "memories/dry-run-extract");
    expect(extraction).toMatchObject({ method: "POST", access: "write", scope: "memory.retain" });
  });

  it("leaves operation payload scope enforcement to the router", async () => {
    const operation = routes.find(({ method, route }) => method === "GET" && route === "operations/{operation_id}");
    expect(operation).toMatchObject({ access: "read", scope: "bank.config.read", payloadScope: "memory.recall" });
    const { client, send } = transport();
    await client.request(client.bankUrl("R", "/operations/id"));
    await client.request(client.bankUrl("R", "/operations/id?include_payload=true"));
    expect(send.mock.calls.map(([target]) => String(target))).toEqual([
      `${url}/v1/default/banks/R/operations/id`,
      `${url}/v1/default/banks/R/operations/id?include_payload=true`,
    ]);
  });
});

type Classify = (method: string, suffix: string) => "read" | "write" | "excluded";
const { compareRoutes } = createRequire(import.meta.url)("../.github/scripts/combination-routes.cjs") as {
  compareRoutes(
    table: readonly RouterRoute[],
    router: readonly Omit<RouterRoute, "access">[],
    classify: Classify,
  ): string[];
};

describe("resolved router comparison", () => {
  const served = routes.map(({ access: _access, ...route }) => route);
  const refresh = "POST /mental-models/{mental_model_id}/dry-run-refresh";

  it("accepts the contract table for the routes it was derived from", () => {
    expect(compareRoutes(routes, served, classify)).toEqual([]);
  });

  it("reports a client regression with method, route and expected classification", () => {
    const regressed: Classify = (method, suffix) =>
      suffix.endsWith("/dry-run-refresh") ? "write" : classify(method, suffix);
    expect(compareRoutes(routes, served, regressed)).toEqual([`${refresh}: expected read, packaged client says write`]);
  });

  it("rejects a classification that contradicts the router scope", () => {
    const table = routes.map((entry) =>
      entry.route === "memories/dry-run-extract" ? { ...entry, access: "read" as const } : entry,
    );
    expect(compareRoutes(table, served, classify)).toContain(
      "POST /memories/dry-run-extract: expected write for router scope memory.retain, contract table says read",
    );
  });

  it("rejects router scope changes, new routes and stale entries", () => {
    const changed = [
      ...served
        .filter(({ route }) => route !== "audit-logs")
        .map((route) => (route.payloadScope ? { ...route, payloadScope: undefined } : route)),
      { method: "GET", route: "new", scope: "memory.recall" },
    ];
    expect(compareRoutes(routes, changed, classify)).toEqual([
      "GET /operations/{operation_id}: payloadScope is undefined in the router, memory.recall in the contract table",
      "GET /audit-logs: the router does not serve this route; remove it from the contract table",
      "GET /new: router route with scope memory.recall has no classification or exclusion",
    ]);
  });
});
