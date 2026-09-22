import type { spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveConfig } from "./config";
import { resolveHostConfig } from "./host-client";
import { startCodebaseSurvey } from "./survey";

vi.mock("./host-client", () => ({ resolveHostConfig: vi.fn() }));

let directory: string;
const spawn = vi.fn(() => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  queueMicrotask(() => child.emit("spawn"));
  return child;
});
function destination(principal = "codex", bankId = "bank-1", apiUrl = "https://router.test", apiToken?: string) {
  vi.mocked(resolveHostConfig).mockReturnValue({
    cfg: { ...resolveConfig({ apiUrl, apiToken }), routerHarness: principal },
    bankId,
  });
}
function start(repo = "/repo") {
  return startCodebaseSurvey(repo, { harness: "codex", spawn: spawn as unknown as typeof spawnProcess, exists: () => true, lease: { dir: directory } });
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "router-survey-"));
  spawn.mockClear();
  destination();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it("admits only one concurrent survey for a managed destination across repositories", async () => {
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => start(`/repo-${i}`)));
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(spawn).toHaveBeenCalledOnce();
});

it("isolates principals, banks and router endpoints", async () => {
  expect(await start()).toBe(true);
  for (const [principal, bank, api] of [
    ["opencode", "bank-1", "https://router.test"],
    ["codex", "bank-2", "https://router.test"],
    ["codex", "bank-1", "https://other.test"],
  ]) {
    destination(principal, bank, api);
    expect(await start()).toBe(true);
  }
  expect(spawn).toHaveBeenCalledTimes(4);
});

it("keeps admission stable across credential rotation and trailing API slashes", async () => {
  destination("codex", "bank-1", "https://router.test", "old-token");
  expect(await start()).toBe(true);
  destination("codex", "bank-1", "https://router.test///", "new-token");
  expect(await start()).toBe(false);
  expect(spawn).toHaveBeenCalledOnce();
  expect(readdirSync(directory)).toEqual([expect.stringMatching(/^survey-[a-f0-9]{64}\.lock$/)]);
});

it("launches nothing when managed destination resolution fails", async () => {
  vi.mocked(resolveHostConfig).mockImplementation(() => { throw new Error("unconfigured principal"); });
  expect(await start()).toBe(false);
  expect(spawn).not.toHaveBeenCalled();
});
