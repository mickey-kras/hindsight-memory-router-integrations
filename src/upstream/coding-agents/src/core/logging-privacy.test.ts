import { ChildProcess, type spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config";
import { diag, parseHookEvent } from "./diag";
import * as git from "./git";
import { HindsightClient, ReflectError } from "./hindsight";
import { buildHookOutput } from "./hook";
import * as hookLifecycle from "./hook";
import { buildKnowledgeTools } from "./knowledge-tools";
import { log, setLogLevel } from "./log";
import { buildRetain } from "./retain-hook";
import { RuntimeCore } from "./runtime";
import * as seed from "./seed";
import * as sessionStart from "./session-start";
import * as companionSkill from "./skill-sync";
import { writeSessionCache } from "./session-cache";

const PROMPT = "PROMPT_CANARY_private_question";
const ANSWER = "ANSWER_CANARY_private_memory";
const FAILURE = "FAILURE_CANARY_private_response";
const IDENTITY = "IDENTITY_CANARY_private_path";
let root: string;
let diagnostic: string;
let ordinary: string;

function contents(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function records(): Record<string, unknown>[] {
  return contents(diagnostic).trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function client(): HindsightClient {
  const instance = new HindsightClient({ routerHarness: "codex", apiUrl: "https://router.test", bank: "A" });
  vi.spyOn(instance, "reflect").mockResolvedValue(ANSWER);
  vi.spyOn(instance, "listPages").mockResolvedValue({ items: [{ id: IDENTITY, name: ANSWER }] });
  vi.spyOn(instance, "searchKnowledgePages").mockResolvedValue([]);
  vi.spyOn(instance, "recallObservations").mockResolvedValue([]);
  return instance;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "logging-privacy-"));
  diagnostic = join(root, "diag.jsonl");
  ordinary = join(root, "plugin.log");
  vi.stubEnv("TMPDIR", root);
  vi.stubEnv("HINDSIGHT_DIAG_FILE", diagnostic);
  vi.stubEnv("HINDSIGHT_LOG_FILE", ordinary);
  vi.stubEnv("HINDSIGHT_USAGE_FILE", join(root, "usage.jsonl"));
  vi.stubEnv("HINDSIGHT_LOG_LEVEL", "");
  const managed = join(root, "managed.json");
  writeFileSync(managed, JSON.stringify({ routerUrl: "https://router.test", principals: {
    codex: { tokenEnv: "LOGGING_TEST_TOKEN", writeBank: "A", mapPathToBank: { [root]: "A" } },
  } }));
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", managed);
  vi.stubEnv("LOGGING_TEST_TOKEN", `mr_codex_${"b".repeat(64)}`);
});

afterEach(() => {
  try {
    for (const file of [diagnostic, ordinary]) {
      for (const canary of [PROMPT, ANSWER, FAILURE, IDENTITY]) expect(contents(file)).not.toContain(canary);
    }
  } finally {
    setLogLevel("info");
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});

describe.each(["info", "debug"] as const)("metadata-only logs at %s", (level) => {
  beforeEach(() => setLogLevel(level));

  it("keeps successful reflection content in the injection and out of both log files", async () => {
    const output = await buildHookOutput({ harness: "codex", prompt: PROMPT,
      cfg: resolveConfig(), client: client(), cacheFile: join(root, "session.json") });
    expect(output.context).toContain(ANSWER);
    expect(records()).toContainEqual(expect.objectContaining({ event: "reflect_ok", chars: ANSWER.length }));
    expect(records().find((entry) => entry.event === "reflect_ok")).not.toHaveProperty("query");
    if (level === "debug") expect(contents(ordinary)).toContain("diag:reflect_ok");
  });

  it("records failed reflect, fallback and page reads without their error messages or causes", async () => {
    const instance = client();
    const failure = new Error(FAILURE, { cause: Object.assign(new Error(PROMPT), { code: "ECONNREFUSED" }) });
    vi.mocked(instance.reflect).mockRejectedValue(new ReflectError(FAILURE, 503, false));
    vi.mocked(instance.searchKnowledgePages).mockRejectedValue(failure);
    vi.mocked(instance.recallObservations).mockRejectedValue(failure);
    vi.mocked(instance.listPages).mockRejectedValue(failure);
    await buildHookOutput({ harness: "codex", prompt: PROMPT, cfg: resolveConfig(),
      client: instance, cacheFile: join(root, "session.json") });
    expect(records()).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "reflect_failed", timeoutMs: 20_000, status: 503, errorClass: "operation_failed" }),
      expect.objectContaining({ event: "reflect_fallback_pages_failed", errorClass: "connection_refused" }),
      expect.objectContaining({ event: "reflect_fallback_observations_failed", errorClass: "connection_refused" }),
      expect.objectContaining({ event: "pages_failed", errorClass: "connection_refused" }),
    ]));
    expect(contents(ordinary)).toContain("reflect failed");
  });

  it.each(["pages", "recall"] as const)("omits failed %s injection content", async (autoInject) => {
    const instance = client();
    vi.mocked(instance.searchKnowledgePages).mockRejectedValue(FAILURE);
    vi.mocked(instance.recallObservations).mockRejectedValue({ message: FAILURE, code: ANSWER, cause: PROMPT });
    await buildHookOutput({ harness: "codex", prompt: PROMPT, cfg: resolveConfig({ autoInject }),
      client: instance, cacheFile: join(root, "session.json") });
    expect(records()).toContainEqual(expect.objectContaining({ event: `inject_${autoInject}_failed`, errorClass: "operation_failed" }));
  });

  it("omits deferred prompts and persistent-runtime notice previews", async () => {
    const cacheFile = join(root, "deferred.json");
    writeSessionCache(cacheFile, { deferInitialReflect: true });
    await buildHookOutput({ harness: "codex", prompt: PROMPT, cfg: resolveConfig(), client: client(), cacheFile });
    expect(records()).toContainEqual(expect.objectContaining({ event: "reflect_deferred_new_bank" }));
    const runtime = new RuntimeCore(client(), "A", resolveConfig({ logLevel: level }), "codex", root);
    const notify = vi.fn<(title: string, message: string) => void>();
    runtime.setNotifier(notify);
    await runtime.onPrompt(IDENTITY, PROMPT);
    expect(runtime.getInjection(IDENTITY)).toContain(ANSWER);
    expect(notify).toHaveBeenCalled();
    expect(contents(ordinary)).toContain("reflection notice dispatched");
  });

  it.each(["absent", "working", "throwing", "rejecting"] as const)(
    "preserves lifecycle and private model output when notifier is %s", async (mode) => {
      vi.spyOn(companionSkill, "syncCompanionSkill").mockImplementation(() => {});
      vi.spyOn(sessionStart, "buildSessionStartContext").mockResolvedValue({
        systemMessage: `Hindsight is learning ${IDENTITY}`, deferInitialReflect: true,
      });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const instance = client();
      const hookOutputs = vi.spyOn(hookLifecycle, "buildHookOutput");
      const runtime = new RuntimeCore(instance, "A", resolveConfig({ logLevel: level, autoUpdate: false }), "codex", root);
      const failure = new Error(FAILURE);
      const notify = vi.fn<(title: string, message: string) => void | Promise<void>>(() => {
        if (mode === "throwing") throw failure;
        if (mode === "rejecting") return Promise.reject(failure);
      });
      if (mode !== "absent") runtime.setNotifier(notify);
      await runtime.seedIfCold(root);
      await runtime.onPrompt(IDENTITY, PROMPT);
      expect(instance.reflect).not.toHaveBeenCalled();
      expect(runtime.getInjection(IDENTITY)).toBeTruthy();
      await runtime.onPrompt(IDENTITY, PROMPT);
      expect(instance.reflect).toHaveBeenCalledOnce();
      expect(runtime.getInjection(IDENTITY)).toContain(ANSWER);
      await Promise.resolve();
      if (mode === "absent") {
        expect(notify).not.toHaveBeenCalled();
        expect(contents(ordinary)).toContain("session notice not dispatched: host notifier unavailable");
        expect(contents(ordinary)).toContain("reflection notice not dispatched: host notifier unavailable");
      } else {
        expect(notify).toHaveBeenCalledWith("Hindsight", `Is learning ${IDENTITY}`);
        const notice = (await hookOutputs.mock.results[1].value).notice!;
        expect(notify).toHaveBeenCalledWith("Hindsight · recalled past decisions", notice.replaceAll(/\s+/g, " ").trim().slice(0, 140));
        const outcome = mode === "working" ? "dispatched" : "delivery failed";
        expect(contents(ordinary)).toContain(`session notice ${outcome}`);
        expect(contents(ordinary)).toContain(`reflection notice ${outcome}`);
      }
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    }
  );

  it.each(["absent", "working"] as const)(
    "preserves private lifecycle and model context after seed launch fails with notifier %s", async (mode) => {
      vi.spyOn(companionSkill, "syncCompanionSkill").mockImplementation(() => {});
      vi.spyOn(git, "hasGitHistory").mockReturnValue(true);
      const startSeed = seed.startBackgroundSeed;
      const spawnFailure = vi.fn<typeof spawn>().mockImplementation(() => {
        const child = new ChildProcess();
        queueMicrotask(() => child.emit("error", new Error(FAILURE)));
        return child;
      });
      const launch = vi.spyOn(seed, "startBackgroundSeed").mockImplementation((repo, opts) =>
        startSeed(repo, { ...opts, spawn: spawnFailure }));
      const sessionOutputs = vi.spyOn(sessionStart, "buildSessionStartContext");
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const instance = client();
      vi.spyOn(instance, "listDocumentIds").mockResolvedValue(new Set());
      vi.spyOn(instance, "hasDocuments").mockResolvedValue(false);
      const runtime = new RuntimeCore(instance, IDENTITY, resolveConfig({
        logLevel: level, autoUpdate: false, autoSeed: true, codebaseSurvey: false, gitIngest: "none",
      }), "codex", root);
      const notify = vi.fn<(title: string, message: string) => void>();
      if (mode === "working") runtime.setNotifier(notify);

      await runtime.seedIfCold(root);
      const output = await sessionOutputs.mock.results[0].value;
      expect(launch).toHaveBeenCalledOnce();
      expect(output.systemMessage).toContain("Background seed launch failed.");
      expect(output.systemMessage).toContain(IDENTITY);
      expect(output.systemMessage).not.toContain("is learning");
      expect(output.additionalContext).toContain("hindsight_search_knowledge_pages");
      expect(output.deferInitialReflect).toBe(true);
      expect(records()).toContainEqual(expect.objectContaining({ event: "session_start", cold: true }));
      expect(records().some((entry) => entry.event === "seed_started")).toBe(false);
      if (mode === "working") {
        expect(notify).toHaveBeenCalledExactlyOnceWith("Hindsight", expect.stringContaining(IDENTITY));
        expect(notify.mock.calls[0][1]).toContain("Background seed launch failed.");
        expect(notify.mock.calls[0][1]).not.toContain("is learning");
        expect(contents(ordinary)).toContain("session notice dispatched");
      } else {
        expect(notify).not.toHaveBeenCalled();
        expect(contents(ordinary)).toContain("session notice not dispatched: host notifier unavailable");
      }

      await runtime.onPrompt(IDENTITY, PROMPT);
      expect(instance.reflect).not.toHaveBeenCalled();
      expect(runtime.getInjection(IDENTITY)).toContain("hindsight_search_knowledge_pages");
      expect(records()).toContainEqual(expect.objectContaining({ event: "reflect_deferred_new_bank" }));
      await runtime.onPrompt(IDENTITY, PROMPT);
      expect(instance.reflect).toHaveBeenCalledOnce();
      expect(runtime.getInjection(IDENTITY)).toContain(ANSWER);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledExactlyOnceWith("[memory-router] Background seed launch failed.\n");
    }
  );

  it("keeps failed-reflection notices private when no host notifier exists", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const instance = client();
    vi.mocked(instance.reflect).mockRejectedValue(new ReflectError(FAILURE, 503, false));
    const runtime = new RuntimeCore(instance, "A", resolveConfig({ logLevel: level }), "codex", root);
    await runtime.onPrompt(IDENTITY, PROMPT);
    expect(runtime.getInjection(IDENTITY)).toContain("hindsight_search_knowledge_pages");
    expect(runtime.getInjection(IDENTITY)).not.toContain(FAILURE);
    expect(contents(ordinary)).toContain("reflection notice not dispatched: host notifier unavailable");
    expect(contents(ordinary)).not.toContain("reflection notice dispatched");
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("reports unknown sync status and foreground errors without persisting their content", async () => {
    const instance = client();
    const documents = vi.spyOn(instance, "listDocumentIds").mockImplementation(async (tag) =>
      new Set(tag === "source:git" ? [`gitlog:${basename(root)}`] : []));
    const failure = new Error(FAILURE, { cause: Object.assign(new Error(PROMPT), { code: "ECONNREFUSED" }) });
    const operations = vi.spyOn(instance, "activeOperations").mockRejectedValue(failure);
    const tool = buildKnowledgeTools(instance, "A", { repoDir: root })
      .find((entry) => entry.name.endsWith("_sync_status"))!;
    const unknown = await tool.handler({});
    expect(unknown.isError).toBeFalsy();
    expect(JSON.parse(unknown.content[0].text)).toMatchObject({ activeOps: null, synced: false });
    operations.mockResolvedValueOnce(0);
    const settled = await tool.handler({});
    expect(settled.isError).toBeFalsy();
    expect(JSON.parse(settled.content[0].text)).toMatchObject({ activeOps: 0, synced: true });
    documents.mockRejectedValueOnce(failure);
    const failed = await tool.handler({});
    expect(failed.isError).toBe(true);
    expect(JSON.parse(failed.content[0].text).error).toContain(FAILURE);
    expect(JSON.parse(failed.content[0].text).error).toContain("ECONNREFUSED");
  });

  it.each(["retain", "idle"] as const)("preserves bounded transport categories through the %s failure path", async (path) => {
    const instance = client();
    const cause = Object.assign(new Error(ANSWER), { code: "ECONNREFUSED" });
    const failure = new Error(FAILURE, { cause });
    if (path === "retain") {
      vi.spyOn(instance, "supportsAppendRetain").mockResolvedValue(false);
      const retain = vi.spyOn(instance, "retain").mockRejectedValue(failure);
      await buildRetain({ harness: "codex", sessionId: IDENTITY, transcriptPath: join(root, "transcript"),
        client: instance, readTranscript: () => [{ role: "user", content: PROMPT }] });
      expect(retain).toHaveBeenCalledOnce();
      expect(contents(ordinary)).toContain('"errorClass":"connection_refused"');
    } else {
      const runtime = new RuntimeCore(instance, "A", resolveConfig({ logLevel: level }), "codex", root);
      runtime.setTranscriptSource(async () => { throw failure; });
      await runtime.onSessionIdle(IDENTITY);
    }
    expect(records()).toContainEqual(expect.objectContaining({
      event: path === "retain" ? "retain_failed" : "idle_fetch_failed", errorClass: "connection_refused",
    }));
    if (level === "debug") expect(contents(ordinary)).toContain('"errorClass":"connection_refused"');
  });

  it("filters arbitrary extras in both sinks and unsafe config validation values", () => {
    const extra = { prompt: PROMPT, answer: ANSWER, error: new Error(FAILURE), session: IDENTITY,
      bank: IDENTITY, path: IDENTITY, apiUrl: IDENTITY, nested: { text: ANSWER },
      count: 3, ms: 12, cold: true, settled: false, mode: "append", chars: ANSWER, errorClass: FAILURE };
    diag("codex", "retain_failed", extra);
    log.warn("codex", "session write-back failed", extra);
    parseHookEvent("codex", FAILURE);
    resolveConfig({ pages: { [PROMPT]: { source_query: ANSWER } },
      customPages: { [IDENTITY]: { source_query: "", tags: [ANSWER] } } });
    expect(records()[0]).toMatchObject({ count: 3, ms: 12, cold: true, settled: false, mode: "append", errorClass: "operation_failed" });
    expect(records()[0]).not.toHaveProperty("chars");
    expect(contents(ordinary)).toContain('"count":3');
    expect(contents(ordinary)).toContain('"settled":false');
    expect(contents(ordinary)).toContain("ignoring invalid customPages entry");
    diag("deepen", "deepen_done", { settled: ANSWER });
    expect(records().at(-1)).not.toHaveProperty("settled");
  });
});
