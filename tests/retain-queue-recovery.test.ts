import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  constants,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetainQueueStorage } from "../src/shared/retain-queue-storage.js";
import { type QueuedRetain, RetainQueue } from "../src/upstream/src/retain-queue.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, openSync: vi.fn(fs.openSync), fsyncSync: vi.fn(fs.fsyncSync), renameSync: vi.fn(fs.renameSync) };
});

let directory: string;
let filePath: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "queue-recovery-"));
  filePath = join(directory, "queue.jsonl");
});
afterEach(() => {
  vi.resetAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function item(id: string, extra: Partial<QueuedRetain> = {}): QueuedRetain {
  return {
    id,
    bankId: "bank",
    content: `private ${id}`,
    documentId: "document",
    metadata: {},
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function recoveries(): Buffer[] {
  const path = `${filePath}.recovery`;
  return readdirSync(path)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => readFileSync(join(path, name)));
}

describe("retain queue corrupt-record recovery", () => {
  const mutations: Array<{ name: string; run: (queue: RetainQueue) => void; ids: string[] }> = [
    { name: "remove", run: (queue) => queue.remove("first"), ids: ["second"] },
    { name: "removeMany", run: (queue) => queue.removeMany(["first"]), ids: ["second"] },
    { name: "removeMany with no delivered IDs", run: (queue) => queue.removeMany([]), ids: ["first", "second"] },
    {
      name: "operation ID assignment",
      run: (queue) => queue.ensureOperationId("first", "new-operation"),
      ids: ["first", "second"],
    },
    { name: "attempt increment", run: (queue) => queue.incrementReplayAttempts("second"), ids: ["first", "second"] },
    { name: "age cleanup", run: (queue) => queue.cleanup(), ids: ["second"] },
  ];
  it.each(mutations)("preserves only exact corrupt bytes before $name", ({ run, ids }) => {
    const bad = Buffer.from("not-json\r\nnot-json\r\n[]\n");
    const invalidUtf8 = Buffer.from([0xff, 0x0a]);
    const tail = Buffer.from('{"torn":"private');
    writeFileSync(
      filePath,
      Buffer.concat([
        Buffer.from(line(item("first", { createdAt: "2000-01-01T00:00:00.000Z", updateMode: "append" }))),
        bad,
        invalidUtf8,
        Buffer.from(line(item("second", { operationId: "original-operation", updateMode: "replace" }))),
        tail,
      ]),
    );
    const onCorruption = vi.fn();
    const queue = new RetainQueue({ filePath, maxAgeMs: 60_000, onCorruption });

    expect(
      queue
        .peek()
        .filter((queued) => queued.replayState?.quarantine !== "corrupt")
        .map((queued) => queued.id),
    ).toEqual(["first", "second"]);
    run(queue);

    expect(queue.peek().filter((queued) => queued.replayState?.quarantine === "corrupt")).toHaveLength(2);
    expect(recoveries()).toEqual([Buffer.concat([bad, invalidUtf8, tail])]);
    expect(recoveries()[0].includes("private first")).toBe(false);
    expect(recoveries()[0].includes("private second")).toBe(false);
    expect(
      queue
        .peek()
        .filter((queued) => queued.replayState?.quarantine !== "corrupt")
        .map((queued) => queued.id),
    ).toEqual(ids);
    expect(queue.peek().find((queued) => queued.id === "second")).toMatchObject({
      documentId: "document",
      operationId: "original-operation",
      updateMode: "replace",
    });
    expect(onCorruption).toHaveBeenCalledExactlyOnceWith({ malformedJson: 4, invalidShape: 1 });
    new RetainQueue({ filePath }).removeMany([]);
    expect(recoveries()).toHaveLength(1);
    if (process.platform !== "win32") {
      expect(statSync(`${filePath}.recovery`).mode & 0o777).toBe(0o700);
      for (const name of readdirSync(`${filePath}.recovery`)) {
        expect(statSync(join(`${filePath}.recovery`, name)).mode & 0o777).toBe(name === "pending" ? 0o700 : 0o600);
      }
    }
  });

  it.each([
    null,
    [],
    "record",
    12,
    {},
    { id: 1 },
    { id: "" },
    { bankId: null },
    { bankId: "" },
    { content: false },
    { createdAt: "not-a-date" },
    { createdAt: null },
    { metadata: null },
    { metadata: [] },
    { documentId: 1 },
    { context: {} },
    { tags: "tag" },
    { tags: [1] },
    { operationId: false },
    { updateMode: "overwrite" },
    { replayAttempts: -1 },
    { replayAttempts: 1.5 },
    { replayAttempts: "1" },
  ])("isolates invalid persisted shape %j before replay", (invalid) => {
    const record =
      invalid !== null && typeof invalid === "object" && !Array.isArray(invalid)
        ? { ...item("invalid"), ...invalid }
        : invalid;
    // An empty object is intentionally a missing-fields record.
    const raw = line(invalid && typeof invalid === "object" && Object.keys(invalid).length === 0 ? invalid : record);
    const original = raw + line(item("valid"));
    writeFileSync(filePath, original);
    const queue = new RetainQueue({ filePath });
    expect(
      queue
        .peek()
        .filter((queued) => queued.replayState?.quarantine !== "corrupt")
        .map((queued) => queued.id),
    ).toEqual(["valid"]);
    queue.remove("valid");
    expect(recoveries()).toEqual([Buffer.from(raw)]);
    expect(new RetainQueue({ filePath }).peek()).toEqual([
      expect.objectContaining({ replayState: expect.objectContaining({ quarantine: "corrupt" }) }),
    ]);
  });

  it("reuses durable recovery after a queue rewrite fails and the process restarts", async () => {
    const original = `${line(item("first"))}broken\nbroken\n`;
    writeFileSync(filePath, original);
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(renameSync).mockImplementation((source, destination) => {
      if (destination === filePath) throw Object.assign(new Error("write failed"), { code: "EIO" });
      actualFs.renameSync(source, destination);
    });
    expect(() => new RetainQueue({ filePath }).ensureOperationId("first", "operation")).toThrow("write failed");
    expect(readFileSync(filePath, "utf8")).toBe(original);
    expect(recoveries()).toEqual([Buffer.from("broken\nbroken\n")]);

    vi.mocked(renameSync).mockReset();
    appendFileSync(filePath, line(item("later", { operationId: "later-operation" })));
    const restarted = new RetainQueue({ filePath });
    restarted.ensureOperationId("first", "operation");
    expect(
      restarted
        .peek()
        .filter((queued) => queued.replayState?.quarantine !== "corrupt")
        .map(({ id, operationId }) => ({ id, operationId })),
    ).toEqual([
      { id: "first", operationId: "operation" },
      { id: "later", operationId: "later-operation" },
    ]);
    expect(recoveries()).toEqual([Buffer.from("broken\nbroken\n")]);
  });

  it.skipIf(process.platform === "win32")(
    "recovers after a process dies between recovery and queue replacement",
    () => {
      const original = `${line(item("first"))}broken\nbroken\n`;
      writeFileSync(filePath, original);
      const source = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { RetainQueue } from ${JSON.stringify(new URL("../src/upstream/src/retain-queue.ts", import.meta.url).href)};
      const rename = fs.renameSync;
      fs.renameSync = (source, destination) => {
        if (destination === ${JSON.stringify(filePath)}) process.kill(process.pid, "SIGKILL");
        rename(source, destination);
      };
      syncBuiltinESMExports();
      new RetainQueue({ filePath: ${JSON.stringify(filePath)} }).ensureOperationId("first", "operation");
    `;
      expect(() =>
        execFileSync(
          process.execPath,
          [
            "--experimental-transform-types",
            "--experimental-loader",
            new URL("./helpers/typescript-source-loader.mjs", import.meta.url).href,
            "--input-type=module",
            "-e",
            source,
          ],
          {
            stdio: "pipe",
          },
        ),
      ).toThrow(expect.objectContaining({ signal: "SIGKILL" }));
      expect(readFileSync(filePath, "utf8")).toBe(original);
      const restarted = new RetainQueue({ filePath });
      restarted.ensureOperationId("first", "operation");
      expect(recoveries()).toEqual([Buffer.from("broken\nbroken\n")]);
      expect(restarted.peek()[0].operationId).toBe("operation");
    },
  );

  it.each(process.platform === "win32" ? [0, 1] : [0, 1, 2, 3, 4])(
    "keeps original bytes when durability barrier %i fails",
    async (barrier) => {
      const original = `${line(item("first"))}broken\n`;
      writeFileSync(filePath, original);
      const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
      for (let index = 0; index < barrier; index++) vi.mocked(fsyncSync).mockImplementationOnce(actualFs.fsyncSync);
      vi.mocked(fsyncSync).mockImplementationOnce(() => {
        throw new Error("sync failed");
      });
      expect(() => new RetainQueue({ filePath }).removeMany([])).toThrow("sync failed");
      expect(readFileSync(filePath, "utf8")).toBe(original);
      new RetainQueue({ filePath }).removeMany([]);
      expect(recoveries()).toEqual([Buffer.from("broken\n")]);
    },
  );

  it("preserves a malformed-only queue as an active ordering barrier", () => {
    const original = Buffer.from("  \r\nnull\n{unterminated");
    writeFileSync(filePath, original);
    new RetainQueue({ filePath }).removeMany([]);
    expect(recoveries()).toEqual([original]);
    expect(new RetainQueue({ filePath }).peek()).toEqual([
      expect.objectContaining({ replayState: expect.objectContaining({ quarantine: "corrupt" }) }),
    ]);
  });

  it.each(["broken", line(item("first")).trimEnd()])(
    "keeps the next append replayable after an unterminated tail",
    (tail) => {
      writeFileSync(filePath, tail);
      const queue = new RetainQueue({ filePath });
      queue.enqueue("bank", { content: "new", operationId: "new-operation" });
      expect(queue.peek().at(-1)).toMatchObject({ content: "new", operationId: "new-operation" });
      if (tail === "broken") expect(recoveries()).toEqual([Buffer.from(tail)]);
      else expect(queue.peek()[0].id).toBe("first");
    },
  );

  it("fails closed if an existing recovery snapshot is not a prefix of the source", async () => {
    const original = `${line(item("first"))}broken\n`;
    writeFileSync(filePath, original);
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(renameSync).mockImplementation((source, destination) => {
      if (destination === filePath) throw new Error("active rewrite failed");
      actualFs.renameSync(source, destination);
    });
    expect(() => new RetainQueue({ filePath }).removeMany([])).toThrow("active rewrite failed");
    vi.mocked(renameSync).mockReset();
    const recovery = join(
      `${filePath}.recovery`,
      readdirSync(`${filePath}.recovery`).find((name) => name.endsWith(".jsonl")) ?? "missing",
    );
    writeFileSync(recovery, "changed");
    expect(() => new RetainQueue({ filePath }).removeMany([])).toThrow("does not match queued bytes");
    expect(readFileSync(filePath, "utf8")).toBe(original);
  });

  it("extends one recovery snapshot after a failed rewrite and later corrupt appends", async () => {
    const original = `${line(item("first"))}bad-A\nbad-A\n`;
    writeFileSync(filePath, original);
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(renameSync).mockImplementation((source, destination) => {
      if (destination === filePath) throw new Error("active rewrite failed");
      actualFs.renameSync(source, destination);
    });
    expect(() => new RetainQueue({ filePath }).removeMany([])).toThrow("active rewrite failed");
    expect(recoveries()).toEqual([Buffer.from("bad-A\nbad-A\n")]);

    appendFileSync(filePath, "bad-B\n");
    vi.mocked(renameSync).mockImplementation(() => {
      throw new Error("archive replacement failed");
    });
    expect(() => new RetainQueue({ filePath }).removeMany([])).toThrow("archive replacement failed");
    expect(recoveries()).toEqual([Buffer.from("bad-A\nbad-A\n")]);
    expect(readFileSync(filePath, "utf8")).toBe(`${original}bad-B\n`);
    expect(readdirSync(join(`${filePath}.recovery`, "pending"))).toHaveLength(0);

    vi.mocked(renameSync).mockReset();
    new RetainQueue({ filePath }).ensureOperationId("first", "operation");
    expect(recoveries()).toEqual([Buffer.from("bad-A\nbad-A\nbad-B\n")]);
    expect(new RetainQueue({ filePath }).peek()[0].operationId).toBe("operation");
  });

  it("keeps distinct recovery generations after replacing the active queue", () => {
    const original = `${line(item("first"))}bad-A\n`;
    writeFileSync(filePath, original);
    const queue = new RetainQueue({ filePath });
    queue.ensureOperationId("first", "operation");
    appendFileSync(filePath, "bad-B\n");
    queue.removeMany([]);
    expect(recoveries()).toHaveLength(2);
    expect(recoveries()).toEqual(expect.arrayContaining([Buffer.from("bad-A\n"), Buffer.from("bad-B\n")]));
  });

  it.skipIf(process.platform === "win32")(
    "cleans owned unfinished snapshots after repeated crashes before commit",
    async () => {
      const original = `${line(item("first"))}bad-A\n`;
      writeFileSync(filePath, original);
      expect(() =>
        new RetainQueue({
          filePath,
          onCorruption: () => {
            throw new Error("before rewrite");
          },
        }).removeMany([]),
      ).toThrow("before rewrite");
      appendFileSync(filePath, "bad-B\n");
      const pending = join(`${filePath}.recovery`, "pending");
      const unrelated = "notes.tmp";
      const symlink = `retain-${"a".repeat(32)}.tmp`;
      writeFileSync(join(pending, unrelated), "unrelated");
      symlinkSync(filePath, join(pending, symlink));
      const source = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { RetainQueue } from ${JSON.stringify(new URL("../src/upstream/src/retain-queue.ts", import.meta.url).href)};
      import { RetainQueueStorage } from ${JSON.stringify(new URL("../src/shared/retain-queue-storage.ts", import.meta.url).href)};
      const rename = fs.renameSync;
      fs.renameSync = (source, destination) => {
        if (String(source).includes("/pending/")) process.kill(process.pid, "SIGKILL");
        rename(source, destination);
      };
      syncBuiltinESMExports();
      const storage = new RetainQueueStorage(${JSON.stringify(directory)});
      await storage.transaction(() => new RetainQueue({ filePath: ${JSON.stringify(filePath)} }).removeMany([]));
    `;
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(() =>
          execFileSync(
            process.execPath,
            [
              "--experimental-transform-types",
              "--experimental-loader",
              new URL("./helpers/typescript-source-loader.mjs", import.meta.url).href,
              "--input-type=module",
              "-e",
              source,
            ],
            {
              stdio: "pipe",
            },
          ),
        ).toThrow(expect.objectContaining({ signal: "SIGKILL" }));
        expect(readFileSync(filePath, "utf8")).toBe(`${original}bad-B\n`);
        expect(recoveries()).toEqual([Buffer.from("bad-A\n")]);
        expect(
          readdirSync(pending, { withFileTypes: true }).filter(
            (entry) => entry.isFile() && entry.name.startsWith("retain-"),
          ),
        ).toHaveLength(1);
      }
      await new RetainQueueStorage(directory).transaction(() => new RetainQueue({ filePath }).removeMany([]));
      expect(recoveries()).toEqual([Buffer.from("bad-A\nbad-B\n")]);
      expect(readdirSync(pending).sort()).toEqual([unrelated, symlink].sort());
      expect(readFileSync(join(pending, unrelated), "utf8")).toBe("unrelated");
      expect(new RetainQueue({ filePath }).peek()[0].id).toBe("first");
    },
  );

  it.skipIf(process.platform === "win32")("does not follow a preexisting recovery temporary symlink", () => {
    const original = `${line(item("first"))}broken\n`;
    writeFileSync(filePath, original);
    mkdirSync(`${filePath}.recovery`);
    symlinkSync(filePath, join(`${filePath}.recovery`, "pending.tmp"));
    const queue = new RetainQueue({ filePath });
    queue.removeMany([]);
    expect(queue.peek()[0].id).toBe("first");
    expect(recoveries()).toEqual([Buffer.from("broken\n")]);
    expect(
      vi.mocked(openSync).mock.calls.some(([, flags]) => typeof flags === "number" && (flags & constants.O_EXCL) !== 0),
    ).toBe(true);
  });

  it.each(["empty records", "alternating valid and corrupt records"])(
    "recovers %s within a bounded child heap",
    (scenario) => {
      const alternating = scenario === "alternating valid and corrupt records";
      const count = 32_768;
      const bytes = alternating
        ? Buffer.from(`${line(item("valid"))}\n`.repeat(count))
        : Buffer.alloc(4 * 1024 * 1024, 10);
      const corrupt = alternating ? Buffer.alloc(count, 10) : bytes;
      writeFileSync(filePath, bytes);
      const source = `
      import { RetainQueue } from ${JSON.stringify(new URL("../src/upstream/src/retain-queue.ts", import.meta.url).href)};
      const queue = new RetainQueue({ filePath: ${JSON.stringify(filePath)}, maxReadBytes: 16 * 1024 * 1024 });
      if (queue.peek().length !== ${alternating ? 50 : 1}) throw new Error("unexpected replayable records");
      queue.removeMany([]);
      if (queue.size() !== ${alternating ? count * 2 : 1}) throw new Error("valid records lost");
    `;
      execFileSync(
        process.execPath,
        [
          "--max-old-space-size=128",
          "--experimental-transform-types",
          "--experimental-loader",
          new URL("./helpers/typescript-source-loader.mjs", import.meta.url).href,
          "--input-type=module",
          "-e",
          source,
        ],
        {
          stdio: "pipe",
          timeout: 10_000,
        },
      );
      const saved = recoveries();
      expect(saved).toHaveLength(1);
      expect(saved[0].equals(corrupt)).toBe(true);
    },
  );

  it.each(["win32", "darwin"])("rejects recovery on unsupported %s before filesystem access", (platform) => {
    const original = `${line(item("first"))}broken\n`;
    writeFileSync(filePath, original);
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: platform });
    try {
      expect(() => new RetainQueue({ filePath }).removeMany([])).toThrow("require Linux");
      expect(openSync).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
    expect(readFileSync(filePath, "utf8")).toBe(original);
  });
});

it("syncs an accepted append before returning and preserves bytes if append sync fails", async () => {
  const queue = new RetainQueue({ filePath });
  queue.enqueue("bank", { content: "accepted", operationId: "accepted-operation" });
  expect(fsyncSync).toHaveBeenCalledTimes(2); // file contents, then containing directory
  vi.mocked(fsyncSync).mockImplementationOnce(() => {
    throw new Error("append sync failed");
  });
  expect(() => queue.enqueue("bank", { content: "uncertain", operationId: "uncertain-operation" })).toThrow(
    "append sync failed",
  );
  // A failed append acknowledgement is uncertain, never a claim that no bytes
  // reached disk. Keep the identity for explicit reconciliation/retry.
  expect(new RetainQueue({ filePath }).peek()).toMatchObject([
    { content: "accepted", operationId: "accepted-operation" },
    { content: "uncertain", operationId: "uncertain-operation" },
  ]);
});

it.each(["temp sync", "rename"])(
  "keeps the original backlog when gate %s fails before replacement",
  async (failure) => {
    const original = line(item("denied", { operationId: "operation" }));
    writeFileSync(filePath, original);
    if (failure === "temp sync")
      vi.mocked(fsyncSync).mockImplementationOnce(() => {
        throw new Error("sync failed");
      });
    else
      vi.mocked(renameSync).mockImplementationOnce(() => {
        throw new Error("rename failed");
      });
    expect(() => new RetainQueue({ filePath }).setReplayState("denied", { gate: "probe", protected: true })).toThrow(
      "failed",
    );
    expect(readFileSync(filePath, "utf8")).toBe(original);
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    new RetainQueue({ filePath }).setReplayState("denied", { gate: "probe", protected: true });
    expect(new RetainQueue({ filePath }).peek()[0]).toMatchObject({
      operationId: "operation",
      replayState: { gate: "probe", protected: true },
    });
  },
);

it("preserves the newly written gate if directory sync fails after atomic replacement", async () => {
  writeFileSync(filePath, line(item("denied", { operationId: "operation" })));
  const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fsyncSync)
    .mockImplementationOnce(actualFs.fsyncSync)
    .mockImplementationOnce(() => {
      throw new Error("directory sync failed");
    });
  expect(() => new RetainQueue({ filePath }).setReplayState("denied", { gate: "probe", protected: true })).toThrow(
    "directory sync failed",
  );
  expect(new RetainQueue({ filePath }).peek()[0]).toMatchObject({
    operationId: "operation",
    replayState: { gate: "probe", protected: true },
  });
});

it("atomically classifies many mismatches in one replacement and leaves all bytes intact if replacement fails", async () => {
  const items = Array.from({ length: 64 }, (_, index) => item(`item-${index}`, { operationId: `operation-${index}` }));
  const original = items.map(line).join("");
  writeFileSync(filePath, original);
  const updates = items.map(({ id }) => ({ id, state: { quarantine: "bank-mismatch" as const } }));
  vi.mocked(renameSync).mockImplementationOnce(() => {
    throw new Error("replacement failed");
  });
  expect(() => new RetainQueue({ filePath }).setReplayStates(updates)).toThrow("replacement failed");
  expect(readFileSync(filePath, "utf8")).toBe(original);
  vi.mocked(renameSync).mockClear();
  new RetainQueue({ filePath }).setReplayStates(updates);
  expect(renameSync).toHaveBeenCalledTimes(1);
  expect(new RetainQueue({ filePath }).peek(64)).toEqual(
    items.map((record) => ({ ...record, replayState: { quarantine: "bank-mismatch" } })),
  );
});

it("never expands a corrupt queue beyond its bounded read limit", () => {
  const raw = Buffer.from("x\n");
  writeFileSync(filePath, raw);
  const queue = new RetainQueue({ filePath, maxReadBytes: 300 });
  expect(() => queue.snapshot()).toThrow(/rewrite exceeds configured byte limit/);
  expect(readFileSync(filePath)).toEqual(raw);
  expect(recoveries()).toEqual([raw]);
  expect(() => queue.snapshot()).toThrow(/rewrite exceeds configured byte limit/);
  expect(readFileSync(filePath)).toEqual(raw);
  expect(() => new RetainQueue({ filePath, maxReadBytes: 300 }).snapshot()).toThrow(
    /rewrite exceeds configured byte limit/,
  );
  expect(recoveries()).toEqual([raw]);
  const recovered = new RetainQueue({ filePath, maxReadBytes: 1000 }).snapshot();
  expect(recovered[0].replayState).toMatchObject({ quarantine: "corrupt", length: 2 });
  expect(recoveries()).toEqual([raw]);
});

it("preserves valid rows on both sides of an over-cap corruption barrier", () => {
  const first = item("before");
  const last = item("after");
  const raw = Buffer.from(`${line(first)}x\n${line(last)}`);
  writeFileSync(filePath, raw);
  for (let attempt = 0; attempt < 3; attempt++) {
    const queue = new RetainQueue({ filePath, maxReadBytes: raw.length });
    expect(() => queue.snapshot()).toThrow(/rewrite exceeds configured byte limit/);
    expect(readFileSync(filePath)).toEqual(raw);
    expect(recoveries()).toEqual([Buffer.from("x\n")]);
  }
  const restored = new RetainQueue({ filePath, maxReadBytes: raw.length + 1000 }).snapshot();
  expect(restored[0]).toEqual(first);
  expect(restored[1].replayState?.quarantine).toBe("corrupt");
  expect(restored[2]).toEqual(last);
});

it("rejects replay metadata expansion without replacing an in-limit queue", () => {
  const original = line(item("bounded"));
  writeFileSync(filePath, original);
  const queue = new RetainQueue({ filePath, maxReadBytes: Buffer.byteLength(original) });
  expect(() => queue.ensureOperationId("bounded", "new-operation")).toThrow(/rewrite exceeds configured byte limit/);
  expect(readFileSync(filePath, "utf8")).toBe(original);
  expect(queue.snapshot()).toEqual([JSON.parse(original)]);
});
