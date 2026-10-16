// Synthetic fixtures; HTTP and keyring are mocked. Timings include instrumentation.
// Run: npx vitest run --config scripts/benchmarks/vitest.config.ts

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { it, vi } from "vitest";

const counters = vi.hoisted(() => ({
  reads: 0,
  readBytes: 0,
  writes: 0,
  writeBytes: 0,
  appends: 0,
  appendBytes: 0,
  fsyncs: 0,
  credentials: 0,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      const r = fs.readFileSync(...args);
      counters.reads++;
      counters.readBytes += Buffer.byteLength(r);
      return r;
    },
    readSync: (...args: Parameters<typeof fs.readSync>) => {
      const r = fs.readSync(...args);
      counters.reads++;
      counters.readBytes += r;
      return r;
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      const r = fs.writeFileSync(...args);
      counters.writes++;
      counters.writeBytes += Buffer.byteLength(args[1] as string);
      return r;
    },
    appendFileSync: (...args: Parameters<typeof fs.appendFileSync>) => {
      const r = fs.appendFileSync(...args);
      counters.appends++;
      counters.appendBytes += Buffer.byteLength(args[1] as string);
      return r;
    },
    fsyncSync: (...args: Parameters<typeof fs.fsyncSync>) => {
      counters.fsyncs++;
      return fs.fsyncSync(...args);
    },
  };
});
vi.mock("../../src/coding-agents/human-session.js", async (original) => {
  const module = await original<typeof import("../../src/coding-agents/human-session.js")>();
  return {
    ...module,
    readHumanSession: () => {
      counters.credentials++;
      return {
        token: `mrh_${"a".repeat(32)}_${"b".repeat(64)}`,
        principal_id: "main",
        routerUrl: "https://router.example.test",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };
    },
  };
});

import { harnessTransport, managedReadScope, managedSettings } from "../../src/coding-agents/runtime.js";
import { AuthenticatedClientFactory } from "../../src/shared/authenticated-client-factory.js";
import { PrincipalCredentialResolver } from "../../src/shared/principal-credential-resolver.js";
import { RetainCoordinator } from "../../src/shared/retain-coordinator.js";
import { HindsightClient } from "../../src/upstream/coding-agents/src/core/hindsight";
import { appendJournalTurn } from "../../src/upstream/coding-agents/src/core/turn-journal";

const reset = (): void => {
  for (const key of Object.keys(counters) as (keyof typeof counters)[]) counters[key] = 0;
};
const report = (name: string, started: number): void => {
  process.stdout.write(
    `${JSON.stringify({ name, ms: Math.round((performance.now() - started) * 100) / 100, ...counters })}\n`,
  );
};
it("profile runtime, queues and journal", async () => {
  const previousConfig = process.env.HINDSIGHT_ROUTER_CONFIG;
  const root = fs.mkdtempSync(join(tmpdir(), "issue293-profile-"));
  fs.chmodSync(root, 0o700);
  try {
    const config = join(root, "config.json");
    process.env.HINDSIGHT_ROUTER_CONFIG = config;
    fs.writeFileSync(
      config,
      JSON.stringify({
        routerUrl: "https://router.example.test",
        principals: {
          main: {
            human: { credentialRef: "main" },
            writeBank: "main",
            additionalReadBanks: [],
            mapPathToBank: { [root]: "main" },
          },
        },
      }),
    );
    for (const [name, action] of [
      ["managedSettings", () => managedSettings("main")],
      ["managedReadScope", () => managedReadScope("main", root, root)],
      ["harnessTransport", () => harnessTransport("main")],
    ] as const) {
      reset();
      const start = performance.now();
      for (let i = 0; i < 1000; i++) action();
      report(`${name}:1000`, start);
    }

    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      return new Response(
        JSON.stringify(url.endsWith("/config") ? { config: { store_document_text: true } } : { api_version: "1.0.0" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = new HindsightClient({ routerHarness: "main", apiUrl: "https://router.example.test", bank: "main" });
    reset();
    let probeStart = performance.now();
    for (let i = 0; i < 20; i++) await client.supportsAppendRetain();
    report(`append-capability:20:HTTP=${urls.length}`, probeStart);
    process.stdout.write(
      `${JSON.stringify({
        probeURLs: urls.reduce<Record<string, number>>((counts, url) => {
          counts[url] = (counts[url] ?? 0) + 1;
          return counts;
        }, {}),
      })}\n`,
    );
    urls.length = 0;
    reset();
    probeStart = performance.now();
    for (let i = 0; i < 20; i++)
      await new HindsightClient({
        routerHarness: "main",
        apiUrl: "https://router.example.test",
        bank: "main",
      }).supportsAppendRetain();
    report(`append-capability:20-new-clients:HTTP=${urls.length}`, probeStart);
    vi.unstubAllGlobals();
    for (const legacy of [false, true]) {
      for (const size of [10, 50, 100]) {
        const queueDir = join(root, `queue-${legacy}-${size}`);
        fs.mkdirSync(queueDir, { mode: 0o700 });
        const rows = Array.from({ length: size }, (_, i) => ({
          id: `row-${i}`,
          ...(legacy ? {} : { operationId: `operation-${i}` }),
          bankId: "main",
          content: "x".repeat(1024),
          documentId: `doc-${i}`,
          metadata: {},
          createdAt: new Date().toISOString(),
        }));
        fs.writeFileSync(
          join(queueDir, "hindsight-retain-queue.main.jsonl"),
          `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
          { mode: 0o600 },
        );
        let requests = 0;
        const coordinator = new RetainCoordinator({
          queueDir,
          credentials: new PrincipalCredentialResolver({
            principals: { main: { token: `mr_main_${"a".repeat(64)}`, writeBank: "main" } },
          }),
          clients: new AuthenticatedClientFactory({
            routerUrl: "https://router.example.test",
            userAgent: "profile",
            construct: () => ({
              retain: async () => {
                requests++;
              },
              recall: async () => ({ results: [] }),
            }),
          }),
          logger: {
            warn: () => {},
            error: (message) => {
              throw new Error(message);
            },
          },
        });
        reset();
        const start = performance.now();
        await coordinator.flushQueues();
        report(`queue:${legacy ? "legacy" : "ordinary"}:${size}:requests=${requests}`, start);
        if (requests !== Math.min(size, 50)) throw new Error("Replay did not deliver the expected batch");
      }
    }
    for (const size of [1024, 1024 * 1024, 7 * 1024 * 1024]) {
      const file = join(root, `journal-${size}.jsonl`);
      const line = `${JSON.stringify({ role: "user", content: "x".repeat(1000) })}\n`;
      fs.writeFileSync(file, line.repeat(Math.ceil(size / line.length)), { mode: 0o600 });
      reset();
      const start = performance.now();
      for (let i = 0; i < 20; i++) appendJournalTurn(file, { role: "assistant", content: `reply-${i}` });
      report(`journal:${size}:20`, start);
    }
  } finally {
    if (previousConfig === undefined) delete process.env.HINDSIGHT_ROUTER_CONFIG;
    else process.env.HINDSIGHT_ROUTER_CONFIG = previousConfig;
    vi.unstubAllGlobals();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
