import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError, HostedRouterClient } from "../src/shared/hosted-client.js";
import { RouterTransport } from "../src/shared/router-transport.js";

const token = `mr_hosted_${"a".repeat(64)}`;
const config = {
  routerUrl: "https://router.example",
  principalId: "hosted",
  token,
  writeBank: "write",
  additionalReadBanks: [],
};

function transport(send: typeof fetch): RouterTransport {
  return new RouterTransport({ ...config, access: config, token: () => token, fetch: send });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("discarded HTTP responses", () => {
  it.each([401, 403, 404, 429, 503])(
    "delivers status %i while cleanup stays pending after caller abort",
    async (status) => {
      const caller = new AbortController();
      const cancel = vi.fn(() => {
        caller.abort();
        return new Promise<void>(() => {});
      });
      const body = new ReadableStream<Uint8Array>({ cancel });
      const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
      const client = transport(send);
      const request = client.request(client.bankUrl("write"), { signal: caller.signal });
      if (status === 404) {
        await expect(request).resolves.toMatchObject({ status: 404, body: null });
      } else if (status === 401 || status === 403) {
        await expect(request).rejects.toThrow(AccessDeniedError);
        await expect(client.request(client.bankUrl("write"))).rejects.toThrow(AccessDeniedError);
      } else {
        await expect(request).rejects.toMatchObject({ statusCode: status });
      }
      expect(caller.signal.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
    },
    1000,
  );

  it.each([401, 403, 404, 429, 500, 503])("cancels status %i without exposing disposal failures", async (status) => {
    const cancel = vi.fn(() => Promise.reject(new Error(`secret ${token}`)));
    const body = new ReadableStream<Uint8Array>({ cancel });
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { status, headers: { "Retry-After": "2" } }));
    const client = transport(send);
    const request = client.request(client.bankUrl("write"));
    if (status === 404) {
      const replacement = await request;
      expect(replacement.status).toBe(404);
      expect(replacement.body).toBeNull();
    } else if (status === 401 || status === 403) {
      await expect(request).rejects.toThrow(AccessDeniedError);
      await expect(client.request(client.bankUrl("write"))).rejects.toThrow(AccessDeniedError);
    } else {
      await expect(request).rejects.toMatchObject({
        statusCode: status,
        message: `memory request failed (${status})`,
        retryAfterMs: status === 429 ? 2000 : 0,
      });
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("leaves a returned successful body readable", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":true}'));
          controller.close();
        },
        cancel,
      }),
    );
    const client = transport(vi.fn<typeof fetch>().mockResolvedValue(response));
    const result = await client.request(client.bankUrl("write"));
    expect(result).toBe(response);
    expect(result.body?.locked).toBe(false);
    await expect(result.json()).resolves.toEqual({ ok: true });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("preserves an already-aborted caller reason without sending or logging", async () => {
    const reason = new Error("caller cancellation");
    const send = vi.fn<typeof fetch>();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const client = transport(send);
    await expect(client.request(client.bankUrl("write"), { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(send).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});

describe("hosted streaming responses", () => {
  it.each(["cancelled", "oversized"])(
    "releases the reader for a %s body while cleanup stays pending",
    async (kind) => {
      const caller = new AbortController();
      const reason = new DOMException("caller stopped reading", "AbortError");
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
        },
        cancel,
      });
      const response = new Response(body);
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockImplementation(async () => {
          if (kind === "cancelled") caller.abort(reason);
          return response;
        }),
      );
      const request = new HostedRouterClient(config).getDocument("write", "doc", { signal: caller.signal });
      if (kind === "cancelled") await expect(request).rejects.toBe(reason);
      else await expect(request).rejects.toThrow("memory request failed (502)");
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
    },
    1000,
  );

  it("preserves caller cancellation during a pending body read and releases the reader", async () => {
    const caller = new AbortController();
    let response: Response | undefined;
    let started: () => void = () => {
      throw new Error("missing body-read waiter");
    };
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"text":"'));
          init?.signal?.addEventListener("abort", () => controller.error(new Error(`fetch secret ${token}`)), {
            once: true,
          });
        },
        pull() {
          started();
        },
      });
      response = new Response(body);
      return response;
    });
    vi.stubGlobal("fetch", fetcher);
    const pending = new HostedRouterClient(config).getDocument("write", "doc", { signal: caller.signal });
    const reason = new DOMException("caller stopped reading", "AbortError");
    const rejected = expect(pending).rejects.toBe(reason);
    await reading;
    caller.abort(reason);
    await rejected;
    expect(response?.body?.locked).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["malformed", "oversized", "failed", "valid"])("handles a %s stream and releases its lock", async (kind) => {
    const cancel = vi.fn(() => Promise.reject(new Error(`cleanup secret ${token}`)));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (kind === "failed") {
          controller.error(new Error(`stream secret ${token}`));
          return;
        }
        const content =
          kind === "oversized" ? "x".repeat(4 * 1024 * 1024 + 1) : kind === "valid" ? '{"ok":true}' : `secret ${token}`;
        controller.enqueue(new TextEncoder().encode(content));
        if (kind !== "oversized") controller.close();
      },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));
    const request = new HostedRouterClient(config).getDocument("write", "doc");
    if (kind === "valid") await expect(request).resolves.toEqual({ ok: true });
    else await expect(request).rejects.toThrow("memory request failed (502)");
    expect(body.locked).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(kind === "oversized" ? 1 : 0);
  });
});
