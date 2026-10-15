import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  fsyncSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type QueuedRetain, RetainQueue } from "../src/upstream/src/retain-queue.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), renameSync: vi.fn(fs.renameSync) };
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
  it.each(mutations)("preserves exact corrupt bytes before $name", ({ run, ids }) => {
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

    expect(queue.peek().map((queued) => queued.id)).toEqual(["first", "second"]);
    run(queue);

    expect(recoveries()).toEqual([Buffer.concat([bad, invalidUtf8, tail])]);
    expect(queue.peek().map((queued) => queued.id)).toEqual(ids);
    expect(queue.peek().find((queued) => queued.id === "second")).toMatchObject({
      documentId: "document",
      operationId: "original-operation",
      updateMode: "replace",
    });
    expect(onCorruption).toHaveBeenCalledExactlyOnceWith({ malformedJson: 4, invalidShape: 1 });
    new RetainQueue({ filePath }).removeMany([]);
    expect(recoveries()).toHaveLength(1);
    expect(statSync(`${filePath}.recovery`).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(`${filePath}.recovery`)) {
      expect(statSync(join(`${filePath}.recovery`, name)).mode & 0o777).toBe(0o600);
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
    writeFileSync(filePath, raw + line(item("valid")));
    const queue = new RetainQueue({ filePath });
    expect(queue.peek().map((queued) => queued.id)).toEqual(["valid"]);
    queue.remove("valid");
    expect(recoveries()).toEqual([Buffer.from(raw)]);
    expect(() => readFileSync(filePath)).toThrow(expect.objectContaining({ code: "ENOENT" }));
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
    expect(restarted.peek().map(({ id, operationId }) => ({ id, operationId }))).toEqual([
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
        execFileSync(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", source], {
          stdio: "pipe",
        }),
      ).toThrow(expect.objectContaining({ signal: "SIGKILL" }));
      expect(readFileSync(filePath, "utf8")).toBe(original);
      const restarted = new RetainQueue({ filePath });
      restarted.ensureOperationId("first", "operation");
      expect(recoveries()).toEqual([Buffer.from("broken\nbroken\n")]);
      expect(restarted.peek()[0].operationId).toBe("operation");
    },
  );

  it.each([0, 1, 2, 3])("keeps original bytes when durability barrier %i fails", async (barrier) => {
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
  });

  it("preserves a malformed-only queue before removing the active file", () => {
    const original = Buffer.from("  \r\nnull\n{unterminated");
    writeFileSync(filePath, original);
    new RetainQueue({ filePath }).removeMany([]);
    expect(recoveries()).toEqual([original]);
    expect(() => readFileSync(filePath)).toThrow(expect.objectContaining({ code: "ENOENT" }));
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

  it("fails closed if an existing recovery file differs from its content address", () => {
    writeFileSync(filePath, "broken\n");
    new RetainQueue({ filePath }).removeMany([]);
    const recovery = join(`${filePath}.recovery`, readdirSync(`${filePath}.recovery`)[0]);
    writeFileSync(recovery, "changed");
    writeFileSync(filePath, "broken\n");
    expect(() => new RetainQueue({ filePath }).removeMany([])).toThrow("does not match queued bytes");
    expect(readFileSync(filePath, "utf8")).toBe("broken\n");
  });
});
