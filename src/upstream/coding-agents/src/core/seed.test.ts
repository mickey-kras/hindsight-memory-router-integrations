import { ChildProcess, spawn as realSpawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBackgroundSeed, seedControl, DEFAULT_SEED_LIMIT } from "./seed";

const failure = "[memory-router] Background seed launch failed.\n";
afterEach(() => vi.restoreAllMocks());

function fakeSpawn() {
  const child = new ChildProcess();
  const unref = vi.spyOn(child, "unref").mockImplementation(() => {});
  const spawn = vi.fn<typeof realSpawn>().mockImplementation(() => child);
  return { child, spawn, unref };
}

describe("startBackgroundSeed", () => {
  it("waits for OS launch before unref and reports only launch, not completion", async () => {
    const { child, spawn, unref } = fakeSpawn();
    let settled = false;
    const result = startBackgroundSeed("/some/repo", { enginePath: "/dist/deepen.js", spawn })
      .then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(unref).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith("node", [
      "/dist/deepen.js", "--repo", "/some/repo", "--gitlog-limit", String(DEFAULT_SEED_LIMIT),
    ], { detached: true, stdio: "ignore", windowsHide: true });
    child.emit("spawn");
    expect(await result).toBe(true);
    expect(unref).toHaveBeenCalledOnce();
  });

  it("preserves the default engine location, limit override and calling harness", async () => {
    const { child, spawn } = fakeSpawn();
    const result = startBackgroundSeed("/repo", { spawn, limit: 50, harness: "codex" });
    expect(spawn).toHaveBeenCalledWith("node", [
      expect.stringMatching(/deepen\.js$/), "--repo", "/repo", "--gitlog-limit", "50", "--harness", "codex",
    ], { detached: true, stdio: "ignore", windowsHide: true });
    child.emit("spawn");
    expect(await result).toBe(true);
  });

  it("reports asynchronous launch errors without raw error text or success", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { child, spawn, unref } = fakeSpawn();
    const result = startBackgroundSeed("/secret/path", { spawn });
    child.emit("error", new Error("ENOENT token=SECRET " + "x".repeat(10_000)));
    expect(await result).toBe(false);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(failure);
    expect(unref).not.toHaveBeenCalled();
  });

  it("reports synchronous launch errors with the same bounded diagnostic", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const spawn = vi.fn<typeof realSpawn>().mockImplementation(() => { throw new Error("SECRET EMFILE"); });
    expect(await startBackgroundSeed("/repo", { spawn })).toBe(false);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("handles an actual unavailable executable error event", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const spawn = vi.fn<typeof realSpawn>().mockImplementation(() =>
      realSpawn("/memory-router-nonexistent-executable", [], { stdio: "ignore" }));
    expect(await startBackgroundSeed("/repo", { spawn })).toBe(false);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(failure);
  });
});

describe("seedControl", () => {
  it("reports launch only after spawn succeeds", async () => {
    const { child, spawn } = fakeSpawn();
    const result = seedControl("seed", { repo: "/r", bankId: "bank", spawn });
    child.emit("spawn");
    expect(await result).toMatchObject({ ok: true, message: expect.stringContaining("seed launched") });
  });

  it("reports async launch failure to the manual caller", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { child, spawn } = fakeSpawn();
    const result = seedControl("seed", { repo: "/r", bankId: "bank", spawn });
    child.emit("error", new Error("SECRET"));
    expect(await result).toEqual({ ok: false, message: "Background seed launch failed." });
  });

  it("does not spawn for unsupported commands", async () => {
    const { spawn } = fakeSpawn();
    expect(await seedControl("bogus", { repo: "/r", bankId: "b", spawn })).toEqual({
      ok: false, message: "usage: hindsight-seed seed --repo <dir>",
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
