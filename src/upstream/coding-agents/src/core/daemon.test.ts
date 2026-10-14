import type { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { AccessDeniedError } from "@memory-router/shared/bank-access";
import { resolveConfig } from "./config";
import { detectLlm, ensureDaemon, hasRustToolchain, hasUvx } from "./daemon";

afterEach(() => vi.restoreAllMocks());
it("leaves deployment unconfigured until managed router settings are loaded", () => {
  expect(resolveConfig()).toMatchObject({ apiUrl: "", serverMode: "self-hosted" });
  expect(resolveConfig({ serverMode: "daemon", apiPort: 9999 }).apiUrl).toBe("");
});
it.each(["cloud", "daemon"] as const)("rejects %s deployment without network or process launch", async (serverMode) => {
  const send = vi.spyOn(globalThis, "fetch");
  const spawnFn = vi.fn<typeof spawn>(() => { throw new Error("unexpected launch"); });
  await expect(ensureDaemon(resolveConfig({ serverMode }), "codex", { spawnFn: spawnFn as unknown as typeof spawn })).rejects.toThrow(AccessDeniedError);
  expect(send).not.toHaveBeenCalled(); expect(spawnFn).not.toHaveBeenCalled();
});
it("keeps the shared harness lifecycle inert for managed router mode", async () => {
  const send = vi.spyOn(globalThis, "fetch");
  const spawnFn = vi.fn<typeof spawn>(() => { throw new Error("unexpected launch"); });
  await expect(ensureDaemon(resolveConfig({ apiUrl: "https://router.test" }), "codex", { spawnFn: spawnFn as unknown as typeof spawn })).resolves.toBeUndefined();
  expect(send).not.toHaveBeenCalled(); expect(spawnFn).not.toHaveBeenCalled();
});
it("never discovers upstream credentials or local provisioning tools", () => {
  expect(detectLlm({ OPENAI_API_KEY: "secret", HINDSIGHT_API_LLM_PROVIDER: "openai" })).toBeUndefined();
  expect(hasUvx()).toBe(false); expect(hasRustToolchain()).toBe(false);
});
