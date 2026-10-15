import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { readPrivateFile, sessionStateFile, writePrivateFileAtomic } from "./private-state";
import { fileCursorStore, sessionCacheFile, writeSessionCache, stashPendingContext, hasPendingContext, takePendingContext, discardPendingContext } from "./session-cache";
import { appendJournalTurn, journalPath, readJournalTranscript } from "./turn-journal";

vi.mock("node:fs", async (original) => ({ ...await original<typeof fs>() }));

const directories: string[] = [];
function harness(): string {
  const name = `private-state-test-${randomUUID()}`;
  directories.push(dirname(sessionCacheFile(name, "session")), join(tmpdir(), `hindsight-${name}`));
  return name;
}

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(join(tmpdir(), "private-state-test-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("private session state", () => {
  it("stores buffered transcript bytes and journals in an owner-only per-user directory", () => {
    const name = harness();
    const pending = [{ content: "private prompt", operationId: "op", at: 1 }];
    fileCursorStore(name).write("session", { bank: "A", turns: 1, fingerprint: "f", pending });
    const cursor = sessionStateFile(name, "session", ".retain.json");
    const journal = journalPath(name, "session");
    appendJournalTurn(journal, { role: "assistant", content: "private reply" });

    expect(dirname(cursor)).toContain(`hindsight-${process.geteuid?.()}-`);
    expect(fs.statSync(dirname(cursor)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(cursor).mode & 0o777).toBe(0o600);
    expect(fs.statSync(journal).mode & 0o777).toBe(0o600);
    expect(fileCursorStore(name).read("session")?.pending).toEqual(pending);
    expect(readJournalTranscript(journal)[0].content).toBe("private reply");
  });

  it("keeps atomic temporary files private before they become visible as cursors", () => {
    const file = join(temporaryDirectory(), "cursor.json");
    const rename = fs.renameSync;
    const atomicModes: number[] = [];
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      atomicModes.push(fs.statSync(from).mode & 0o777);
      rename(from, to);
    });
    writePrivateFileAtomic(file, "first");
    writePrivateFileAtomic(file, "second");
    expect(atomicModes).toEqual([0o600, 0o600]);
    expect(fs.readdirSync(dirname(file))).toEqual(["cursor.json"]);
    expect(readPrivateFile(file)).toBe("second");
  });

  it("migrates an owned permissive legacy directory without dropping the conversation", () => {
    const name = harness();
    const legacy = join(tmpdir(), `hindsight-${name}`);
    fs.mkdirSync(legacy, { mode: 0o755 });
    fs.writeFileSync(join(legacy, "session.journal.jsonl"), '{"role":"user","content":"before upgrade"}\n', { mode: 0o644 });
    fs.writeFileSync(join(legacy, "session.retain.json"), '{"bank":"A","turns":1,"fingerprint":"f"}', { mode: 0o644 });

    const journal = journalPath(name, "session");
    appendJournalTurn(journal, { role: "assistant", content: "after upgrade" });
    expect(readJournalTranscript(journal).map((turn) => turn.content)).toEqual(["before upgrade", "after upgrade"]);
    expect(fileCursorStore(name).read("session")?.turns).toBe(1);
    expect(fs.statSync(legacy).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(legacy)).toEqual([]);
    expect(fs.statSync(dirname(journal)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(journal).mode & 0o777).toBe(0o600);
    expect(fs.statSync(sessionStateFile(name, "session", ".retain.json")).mode & 0o777).toBe(0o600);
  });

  it.each([false, true])("preserves exact legacy identities across encoding collisions (reverse order: %s)", (reverse) => {
    const name = harness();
    const legacy = join(tmpdir(), `hindsight-${name}`);
    const sessions = ["session%id", "session%25id", "session id", "session%20id"];
    fs.mkdirSync(legacy, { mode: 0o755 });
    for (const id of sessions) {
      const pending = [{ content: `private prompt for ${id}`, operationId: id, at: 1 }];
      fs.writeFileSync(join(legacy, `${id}.retain.json`), JSON.stringify({ bank: "A", turns: 1, fingerprint: id, pending }));
      fs.writeFileSync(join(legacy, `${id}.journal.jsonl`), JSON.stringify({ role: "user", content: id }) + "\n");
    }

    for (const id of reverse ? [...sessions].reverse() : sessions) {
      const cursor = fileCursorStore(name).read(id);
      expect(cursor?.pending).toEqual([{ content: `private prompt for ${id}`, operationId: id, at: 1 }]);
      expect(readJournalTranscript(journalPath(name, id))[0].content).toBe(id);
      fileCursorStore(name).write(id, { bank: "A", turns: 2, fingerprint: id });
    }
    for (const id of sessions) {
      expect(fileCursorStore(name).read(id)).toEqual({ bank: "A", turns: 2, fingerprint: id });
    }
    expect(fs.readdirSync(legacy)).toEqual([]);
  });

  it("tightens an existing destination directory and journal before appending", () => {
    const file = join(temporaryDirectory(), "journal.jsonl");
    fs.chmodSync(dirname(file), 0o777);
    fs.writeFileSync(file, '{"role":"user","content":"first"}\n', { mode: 0o666 });
    fs.chmodSync(file, 0o666);
    appendJournalTurn(file, { role: "assistant", content: "second" });
    expect(fs.statSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readJournalTranscript(file)).toHaveLength(2);
  });

  it.each(["symbolic", "hard"])("does not read or modify a %s-linked transcript target", (kind) => {
    const root = temporaryDirectory();
    const target = join(root, "target");
    const file = join(root, "journal.jsonl");
    const body = '{"role":"user","content":"other file"}\n';
    fs.writeFileSync(target, body);
    if (kind === "symbolic") fs.symlinkSync(target, file);
    else fs.linkSync(target, file);
    appendJournalTurn(file, { role: "assistant", content: "must not write" });
    writeSessionCache(file, { turns: 9 });
    expect(readJournalTranscript(file)).toEqual([]);
    expect(fs.readFileSync(target, "utf8")).toBe(body);
  });

  it("rejects a symlinked session directory without changing its target", () => {
    const name = harness();
    const target = temporaryDirectory();
    const file = sessionCacheFile(name, "session");
    fs.chmodSync(target, 0o755);
    fs.symlinkSync(target, dirname(file));
    fileCursorStore(name).write("session", { bank: "A", turns: 1, fingerprint: "f" });
    appendJournalTurn(journalPath(name, "session"), { role: "user", content: "must not write" });
    expect(fs.readdirSync(target)).toEqual([]);
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
  });

  it("ignores a symlinked legacy directory and creates private new state", () => {
    const name = harness();
    const target = temporaryDirectory();
    const legacy = join(tmpdir(), `hindsight-${name}`);
    fs.chmodSync(target, 0o755);
    fs.symlinkSync(target, legacy);
    const journal = journalPath(name, "session");
    appendJournalTurn(journal, { role: "user", content: "private" });
    expect(readJournalTranscript(journal)[0].content).toBe("private");
    expect(fs.readdirSync(target)).toEqual([]);
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
  });

  it("rejects a session directory owned by another user", () => {
    const file = join(temporaryDirectory(), "journal.jsonl");
    const currentUid = process.geteuid?.() ?? 0;
    vi.spyOn(process, "geteuid").mockReturnValue(currentUid + 1);
    appendJournalTurn(file, { role: "user", content: "must not write" });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("rejects foreign-owned files inside an otherwise owned directory", () => {
    const file = join(temporaryDirectory(), "journal.jsonl");
    const content = '{"role":"user","content":"foreign state"}\n';
    fs.writeFileSync(file, content, { mode: 0o644 });
    const fstat = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation((fd) => {
      const stat = fstat(fd);
      if (stat.isFile()) stat.uid += 1;
      return stat;
    });
    appendJournalTurn(file, { role: "assistant", content: "must not write" });
    expect(readJournalTranscript(file)).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe(content);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
  });

  it("keeps slash-bearing identities inside their directory and distinct from encoded identities", () => {
    const name = harness();
    const escaped = sessionCacheFile(name, "../../other-user");
    expect(dirname(escaped)).toBe(dirname(sessionCacheFile(name, "session")));
    expect(escaped).not.toBe(sessionCacheFile(name, "..%2F..%2Fother-user"));
  });
});


describe.skipIf(process.platform === "win32")("Grok one-time private context handoff", () => {
  it("does not replay a consumed block or lose distinct concurrent process publications", async () => {
    const root = temporaryDirectory();
    const children: ReturnType<typeof spawn>[] = [];
    const exits: Promise<void>[] = [];
    vi.stubEnv("TMPDIR", root);
    try {
      for (const file of ["private-state", "session-cache"]) {
        const source = fs.readFileSync(new URL(`./${file}.ts`, import.meta.url), "utf8")
          .replace('from "./private-state"', 'from "./private-state.mjs"');
        fs.writeFileSync(join(root, `${file}.mjs`), transpileModule(source, {
          compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
        }).outputText);
      }
      const script = join(root, "worker.mjs");
      fs.writeFileSync(script, `
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
const fs = createRequire(import.meta.url)("node:fs");
const [mode, modulePath, ready, release, result, context] = process.argv.slice(2);
const wait = () => {
  fs.writeFileSync(ready, "ready");
  while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
};
if (mode === "produce") {
  const read = fs.readFileSync;
  let paused = false;
  fs.readFileSync = (...args) => {
    const value = read(...args);
    if (typeof args[0] === "number" && !paused) { paused = true; wait(); }
    return value;
  };
  syncBuiltinESMExports();
}
const cache = await import(pathToFileURL(modulePath).href);
if (mode === "produce") cache.stashPendingContext("process-race", "session", context);
else { wait(); fs.writeFileSync(result, JSON.stringify(cache.takePendingContext("process-race", "session") ?? null)); }
`);
      const start = (mode: string, id: string, context = "") => {
        const ready = join(root, `${id}.ready`);
        const release = join(root, `${id}.release`);
        const result = join(root, `${id}.result`);
        const child = spawn(process.execPath, [script, mode, join(root, "session-cache.mjs"), ready, release, result, context], {
          env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
        });
        children.push(child);
        let stderr = "";
        child.stderr?.on("data", (chunk) => { stderr += chunk; });
        const exited = new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exit ${code}`)));
        });
        exits.push(exited);
        void exited.catch(() => {});
        return { ready, release, result, exited };
      };
      const waitFor = async (...paths: string[]) => {
        const deadline = Date.now() + 5000;
        while (!paths.every((path) => fs.existsSync(path))) {
          if (Date.now() > deadline) throw new Error("child did not reach the filesystem barrier");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      };
      stashPendingContext("process-race", "session", "FIRST_BLOCK");
      const producers = [start("produce", "producer-b", "SECOND_BLOCK"), start("produce", "producer-c", "THIRD_BLOCK")];
      await waitFor(...producers.map((child) => child.ready));
      expect(takePendingContext("process-race", "session")).toBe("FIRST_BLOCK");
      for (const child of producers) fs.writeFileSync(child.release, "go");
      await Promise.all(producers.map((child) => child.exited));
      const consumers = [start("consume", "consumer-one"), start("consume", "consumer-two")];
      await waitFor(...consumers.map((child) => child.ready));
      for (const child of consumers) fs.writeFileSync(child.release, "go");
      await Promise.all(consumers.map((child) => child.exited));
      const delivered = consumers.flatMap((child) => {
        const content = JSON.parse(fs.readFileSync(child.result, "utf8")) as string | null;
        return content ? content.split("\n\n") : [];
      });
      expect(delivered.sort()).toEqual(["SECOND_BLOCK", "THIRD_BLOCK"]);
      expect(takePendingContext("process-race", "session")).toBeUndefined();
      expect(fs.readdirSync(dirname(sessionStateFile("process-race", "session", ".pending")))).toEqual([]);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.allSettled(exits);
      vi.unstubAllEnvs();
    }
  });

  it("uses private state, deduplicates the pending block and consumes it once", () => {
    const name = harness();
    stashPendingContext(name, "session", "PRIVATE_MEMORY");
    stashPendingContext(name, "session", "PRIVATE_MEMORY");
    const directory = dirname(sessionStateFile(name, "session", ".pending"));
    const file = join(directory, fs.readdirSync(directory)[0]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(hasPendingContext(name, "session")).toBe(true);
    expect(hasPendingContext(name, "session")).toBe(true);
    expect(takePendingContext(name, "session")).toBe("PRIVATE_MEMORY");
    expect(hasPendingContext(name, "session")).toBe(false);
    expect(takePendingContext(name, "session")).toBeUndefined();
    expect(fs.readdirSync(dirname(file))).toEqual([]);
  });
  it("accepts the legacy pending file without copying it into a new publication", () => {
    const name = harness();
    const legacy = sessionStateFile(name, "session", ".pending");
    writePrivateFileAtomic(legacy, "LEGACY_MEMORY");
    stashPendingContext(name, "session", "NEW_MEMORY");
    expect(takePendingContext(name, "session")?.split("\n\n")).toEqual(["LEGACY_MEMORY", "NEW_MEMORY"]);
    expect(takePendingContext(name, "session")).toBeUndefined();
  });

  it("drains a large handoff in finite batches without losing blocks, and discards the whole scope", () => {
    const name = harness();
    const expected = Array.from({ length: 70 }, (_, index) => `BLOCK_${index}_END`);
    for (const context of expected) stashPendingContext(name, "session", context);
    const delivered: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const context = takePendingContext(name, "session");
      if (context) delivered.push(...context.split("\n\n"));
    }
    expect(delivered).toEqual(expected);
    expect(hasPendingContext(name, "session")).toBe(false);
    for (const context of expected) stashPendingContext(name, "session", context);
    discardPendingContext(name, "session");
    expect(hasPendingContext(name, "session")).toBe(false);
    expect(takePendingContext(name, "session")).toBeUndefined();
  });

  it.each([
    ["symlink", "legacy"], ["hardlink", "legacy"],
    ["symlink", "block"], ["hardlink", "block"],
  ])("refuses %s %s pending memory without changing its target", (kind, layout) => {
    const name = harness();
    const target = join(temporaryDirectory(), "target");
    fs.writeFileSync(target, "PRIVATE_EXTERNAL_MEMORY");
    const suffix = layout === "legacy" ? ".pending" : ".pending.1234567890123456-12345678901234567890-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.block";
    const file = sessionStateFile(name, "session", suffix);
    fs.mkdirSync(dirname(file), { recursive: true });
    if (kind === "symlink") fs.symlinkSync(target, file); else fs.linkSync(target, file);
    expect(hasPendingContext(name, "session")).toBe(false);
    expect(takePendingContext(name, "session")).toBeUndefined();
    stashPendingContext(name, "session", "replacement");
    expect(fs.readFileSync(target, "utf8")).toBe("PRIVATE_EXTERNAL_MEMORY");
  });
});
