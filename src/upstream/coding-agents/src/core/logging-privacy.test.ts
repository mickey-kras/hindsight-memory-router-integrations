import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config";
import { diag, parseHookEvent } from "./diag";
import { HindsightClient, ReflectError } from "./hindsight";
import { buildHookOutput } from "./hook";
import { log, setLogLevel } from "./log";
import { RuntimeCore } from "./runtime";
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
    expect(contents(ordinary)).toContain("reflection notice delivered");
  });

  it("filters arbitrary extras in both sinks and unsafe config validation values", () => {
    const extra = { prompt: PROMPT, answer: ANSWER, error: new Error(FAILURE), session: IDENTITY,
      bank: IDENTITY, path: IDENTITY, apiUrl: IDENTITY, nested: { text: ANSWER },
      count: 3, ms: 12, cold: true, mode: "append", chars: ANSWER, errorClass: FAILURE };
    diag("codex", "retain_failed", extra);
    log.warn("codex", "session write-back failed", extra);
    parseHookEvent("codex", FAILURE);
    resolveConfig({ pages: { [PROMPT]: { source_query: ANSWER } },
      customPages: { [IDENTITY]: { source_query: "", tags: [ANSWER] } } });
    expect(records()[0]).toMatchObject({ count: 3, ms: 12, cold: true, mode: "append", errorClass: "operation_failed" });
    expect(records()[0]).not.toHaveProperty("chars");
    expect(contents(ordinary)).toContain('"count":3');
    expect(contents(ordinary)).toContain("ignoring invalid customPages entry");
  });
});
