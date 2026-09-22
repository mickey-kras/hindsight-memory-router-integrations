import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOOK_HARNESSES } from "../harness/hook-lifecycle";
import type { LoadOptions, RawConfig } from "./config";
import type { HindsightClient } from "./hindsight";
import { runHook } from "./hook";
import { runRetainHook } from "./retain-hook";
import { journalPath, readJournalTranscript } from "./turn-journal";

const input = vi.hoisted(() => ({ stdin: "", configPath: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (target: unknown, ...rest: unknown[]) =>
      target === 0 ? input.stdin : (actual.readFileSync as (...args: unknown[]) => unknown)(target, ...rest),
  };
});

vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return {
    ...actual,
    loadConfig: (opts: LoadOptions) => actual.loadConfig({ ...opts, path: input.configPath }),
  };
});

let root: string;
let approved: string;
let managedPath: string;
const sessionId = "policy-session";
const prompt = "PRIVATE_USER_PROMPT";
const reply = "PRIVATE_ASSISTANT_REPLY";
const spec = HOOK_HARNESSES.zcode;

function configure(raw: RawConfig = {}) {
  writeFileSync(input.configPath, JSON.stringify({ autoInject: "none", autoSeed: false, ...raw }));
}

function authorize(options: { mapped?: boolean; readOnly?: boolean; bank?: string } = {}) {
  writeFileSync(managedPath, JSON.stringify({
    routerUrl: "https://router.example.test",
    principals: {
      zcode: {
        ...(options.readOnly ? {} : { writeBank: "A" }),
        additionalReadBanks: ["A", "B"],
        tokenEnv: "JOURNAL_POLICY_TOKEN",
        mapPathToBank: options.mapped === false ? {} : { [approved]: options.bank ?? "A" },
      },
    },
  }));
}

function event(cwd = approved) {
  input.stdin = JSON.stringify({ session_id: sessionId, cwd, prompt, responseText: reply });
}

function clients() {
  const promptClient = {
    reflect: vi.fn().mockResolvedValue(""),
    listPages: vi.fn().mockResolvedValue([]),
    searchKnowledgePages: vi.fn().mockResolvedValue([]),
    recallObservations: vi.fn().mockResolvedValue([]),
  };
  const retainClient = {
    retain: vi.fn<HindsightClient["retain"]>().mockResolvedValue(undefined),
    supportsIdempotentRetain: vi.fn<HindsightClient["supportsIdempotentRetain"]>().mockResolvedValue(false),
  };
  return {
    makePrompt: vi.fn(() => promptClient),
    makeRetain: vi.fn(() => retainClient),
    retain: retainClient.retain,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "journal-policy-"));
  approved = join(root, "approved");
  mkdirSync(approved);
  input.configPath = join(root, "coding-agent.json");
  managedPath = join(root, "managed.json");
  vi.stubEnv("TMPDIR", root);
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", managedPath);
  vi.stubEnv("JOURNAL_POLICY_TOKEN", `mr_zcode_${"a".repeat(64)}`);
  vi.stubEnv("HINDSIGHT_DIAG_FILE", join(root, "diag.jsonl"));
  vi.stubEnv("HINDSIGHT_LOG_FILE", join(root, "plugin.log"));
  vi.stubEnv("HINDSIGHT_USAGE_FILE", join(root, "usage.jsonl"));
  vi.stubEnv("HINDSIGHT_DISABLE_HOOKS", "");
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  configure();
  authorize();
  event();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("ZCode journal retention policy", () => {
  it.each<[string, RawConfig]>([
    ["global disablement", { disabled: true }],
    ["harness disablement", { harnesses: { zcode: { disabled: true } } }],
    ["bank disablement", { banks: { A: { disabled: true } } }],
    ["global retention opt-out", { retainSessions: false }],
    ["harness retention opt-out", { harnesses: { zcode: { retainSessions: false } } }],
    ["bank retention opt-out", { banks: { A: { retainSessions: false } } }],
  ])("does not journal prompts or replies after %s", async (_name, raw) => {
    configure(raw);
    const client = clients();
    await runHook(spec.prompt, client.makePrompt);
    await runRetainHook(spec.retain, client.makeRetain);
    expect(existsSync(journalPath("zcode", sessionId))).toBe(false);
    expect(client.makeRetain).not.toHaveBeenCalled();
  });

  it.each(["unmapped path", "symlink escaping a mapped path"])("denies %s before either journal write", async (scenario) => {
    if (scenario === "unmapped path") {
      authorize({ mapped: false });
    } else {
      const outside = join(root, "outside");
      mkdirSync(outside);
      const escaped = join(approved, "escape");
      symlinkSync(outside, escaped);
      event(escaped);
    }
    const client = clients();
    await expect(runHook(spec.prompt, client.makePrompt)).rejects.toThrow("memory access denied");
    await expect(runRetainHook(spec.retain, client.makeRetain)).rejects.toThrow("memory access denied");
    expect(existsSync(journalPath("zcode", sessionId))).toBe(false);
    expect(client.makePrompt).not.toHaveBeenCalled();
    expect(client.makeRetain).not.toHaveBeenCalled();
  });

  it.each([
    { readOnly: true, bank: "A" },
    { readOnly: false, bank: "B" },
  ])("keeps reads available without journaling a bank the principal cannot write: %j", async (principal) => {
    authorize(principal);
    configure({ retainSessions: true, banks: { [principal.bank]: { retainSessions: true } } });
    const client = clients();
    await runHook(spec.prompt, client.makePrompt);
    await runRetainHook(spec.retain, client.makeRetain);
    expect(client.makePrompt).toHaveBeenCalled();
    expect(client.makeRetain).not.toHaveBeenCalled();
    expect(existsSync(journalPath("zcode", sessionId))).toBe(false);
  });

  it("journals and retains an authorized conversation when its bank overrides a global opt-out", async () => {
    configure({ retainSessions: false, banks: { A: { retainSessions: true } } });
    const client = clients();
    await runHook(spec.prompt, client.makePrompt);
    await runRetainHook(spec.retain, client.makeRetain);
    expect(readJournalTranscript(journalPath("zcode", sessionId))).toMatchObject([
      { role: "user", content: prompt },
      { role: "assistant", content: reply },
    ]);
    expect(client.retain).toHaveBeenCalledWith(
      expect.stringContaining(prompt),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(client.retain.mock.calls[0][0]).toContain(reply);
  });

  it("preserves authorized turns before network work can fail", async () => {
    const unavailable = () => { throw new Error("router unavailable"); };
    await expect(runHook(spec.prompt, unavailable)).rejects.toThrow("router unavailable");
    await expect(runRetainHook(spec.retain, unavailable)).rejects.toThrow("router unavailable");
    expect(readJournalTranscript(journalPath("zcode", sessionId))).toMatchObject([
      { role: "user", content: prompt },
      { role: "assistant", content: reply },
    ]);
  });

  it("stops appending to an existing journal after retention is disabled", async () => {
    const client = clients();
    await runHook(spec.prompt, client.makePrompt);
    const path = journalPath("zcode", sessionId);
    const before = readFileSync(path, "utf8");
    configure({ banks: { A: { retainSessions: false } } });
    event();
    await runHook(spec.prompt, client.makePrompt);
    await runRetainHook(spec.retain, client.makeRetain);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(client.makeRetain).not.toHaveBeenCalled();
  });
});
