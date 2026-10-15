import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openPrivateQueueFile,
  privateQueueDirectory,
  removePrivateQueueFile,
  writePrivateQueueFile,
} from "../src/shared/private-queue-files.js";
import { RetainQueueStorage } from "../src/shared/retain-queue-storage.js";
import { RetainQueue } from "../src/upstream/src/retain-queue.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fstatSync: vi.fn(fs.fstatSync) };
});
vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return { ...crypto, randomUUID: vi.fn(crypto.randomUUID) };
});

let directory: string;
let queueFile: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "queue-security-"));
  queueFile = join(directory, "hindsight-retain-queue.main.jsonl");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

describe("private retain queue paths", () => {
  it("tightens permissive legacy paths and preserves their backlog across append and atomic rewrite", async () => {
    const queue = new RetainQueue({ filePath: queueFile });
    queue.enqueue("bank", { content: "legacy" });
    chmodSync(directory, 0o777);
    chmodSync(queueFile, 0o666);
    const lock = join(directory, ".retain-queue.lock");
    writeFileSync(lock, "", { mode: 0o666 });
    chmodSync(lock, 0o666);
    const lockInode = statSync(lock).ino;
    await new RetainQueueStorage(directory).transaction(() => {
      queue.enqueue("bank", { content: "new" });
      queue.ensureOperationId(queue.peek()[0].id, "durable");
    });
    expect(queue.peek().map((item) => item.content)).toEqual(["legacy", "new"]);
    expect(queue.peek()[0].operationId).toBe("durable");
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    for (const path of [queueFile, lock]) expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(lock).ino).toBe(lockInode);
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it.each(["symlink", "hardlink"])("rejects a %s queue during reading, appending, sizing and replacement", (kind) => {
    const target = join(directory, "target");
    writeFileSync(target, "untouched", { mode: 0o644 });
    if (kind === "symlink") symlinkSync(target, queueFile);
    else linkSync(target, queueFile);
    const queue = new RetainQueue({ filePath: queueFile });
    for (const action of [
      () => queue.peek(),
      () => queue.enqueue("bank", { content: "bad" }),
      () => new RetainQueueStorage(directory).assertAppend(1),
      () => writePrivateQueueFile(queueFile, "bad"),
      () => removePrivateQueueFile(queueFile),
    ])
      expect(action).toThrow();
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });

  it.each([".retain-queue.lock", ".retain-replay.lock"])("rejects planted symlink/hardlink locks: %s", async (name) => {
    const target = join(directory, "target");
    writeFileSync(target, "untouched");
    const file = join(directory, name);
    const storage = new RetainQueueStorage(directory);
    const action = vi.fn();
    for (const kind of ["symlink", "hardlink"]) {
      if (kind === "symlink") symlinkSync(target, file);
      else linkSync(target, file);
      const operation =
        name === ".retain-replay.lock" ? storage.replay(async () => action()) : storage.transaction(action);
      await expect(operation).rejects.toThrow();
      rmSync(file);
    }
    expect(action).not.toHaveBeenCalled();
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });

  it.each(["symlink", "hardlink"])("rejects a planted %s orphan temporary without following it", async (kind) => {
    const target = join(directory, "target");
    writeFileSync(target, "untouched");
    const temporary = `${queueFile}.tmp`;
    if (kind === "symlink") symlinkSync(target, temporary);
    else linkSync(target, temporary);
    await expect(new RetainQueueStorage(directory).transaction(() => undefined)).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });

  it("ignores the old predictable temporary during a direct rewrite", () => {
    const target = join(directory, "target");
    writeFileSync(target, "untouched");
    symlinkSync(target, `${queueFile}.tmp`);
    writePrivateQueueFile(queueFile, "new\n");
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expect(readFileSync(queueFile, "utf8")).toBe("new\n");
  });

  it.each(["", "/", "///", "/.", "/./"])(
    "rejects symlink directories with suffix %j without tightening targets",
    (suffix) => {
      const target = join(directory, "target");
      mkdirSync(target, { mode: 0o755 });
      const link = join(directory, "link");
      symlinkSync(target, link);
      expect(() => privateQueueDirectory(link + suffix, true)).toThrow();
      expect(statSync(target).mode & 0o777).toBe(0o755);
    },
  );

  it("accepts an owned directory with trailing separators", () => {
    chmodSync(directory, 0o755);
    privateQueueDirectory(`${directory}///`, true);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  it.each(["helpers", "queue"])("normalizes %s paths consistently before validation and mutation", (api) => {
    const safe = join(directory, "safe");
    const other = join(directory, "other");
    mkdirSync(join(safe, "queue"), { recursive: true, mode: 0o700 });
    mkdirSync(join(other, "child"), { recursive: true, mode: 0o700 });
    mkdirSync(join(other, "queue"), { mode: 0o700 });
    chmodSync(join(other, "queue"), 0o777);
    symlinkSync(join(other, "child"), join(safe, "link"));
    const path = `${safe}/link/../queue/payload`;
    const expected = join(safe, "queue", "payload");
    const unintended = join(other, "queue", "payload");
    writeFileSync(unintended, "untouched", { mode: 0o644 });
    if (api === "helpers") {
      const fd = openPrivateQueueFile(path, constants.O_CREAT | constants.O_WRONLY);
      try {
        writeFileSync(fd, "created");
      } finally {
        closeSync(fd);
      }
      expect(readFileSync(expected, "utf8")).toBe("created");
      writePrivateQueueFile(path, "rewritten");
      expect(readFileSync(expected, "utf8")).toBe("rewritten");
      removePrivateQueueFile(path);
    } else {
      const queue = new RetainQueue({ filePath: path });
      queue.enqueue("bank", { content: "retained" });
      const [item] = queue.peek();
      expect(item.content).toBe("retained");
      queue.ensureOperationId(item.id, "durable");
      expect(JSON.parse(readFileSync(expected, "utf8"))).toMatchObject({ operationId: "durable" });
      queue.remove(item.id);
    }
    expect(readdirSync(join(safe, "queue"))).toEqual([]);
    expect(readdirSync(join(other, "queue"))).toEqual(["payload"]);
    expect(readFileSync(unintended, "utf8")).toBe("untouched");
    expect(statSync(unintended).mode & 0o777).toBe(0o644);
    expect(statSync(join(other, "queue")).mode & 0o777).toBe(0o777);
  });

  it("counts capacity and cleans temporary files in the normalized storage directory", async () => {
    const safe = join(directory, "safe");
    const other = join(directory, "other");
    mkdirSync(join(safe, "queue"), { recursive: true, mode: 0o700 });
    mkdirSync(join(other, "child"), { recursive: true, mode: 0o700 });
    mkdirSync(join(other, "queue"), { mode: 0o700 });
    symlinkSync(join(other, "child"), join(safe, "link"));
    const raw = `${safe}/link/../queue`;
    const storage = new RetainQueueStorage(raw, 1);
    const filePath = join(raw, "hindsight-retain-queue.main.jsonl");
    const queue = new RetainQueue({ filePath, capacity: storage });
    writeFileSync(`${filePath}.orphan.tmp`, "stale");
    await storage.transaction(() => queue.enqueue("bank", { content: "first" }));
    await expect(storage.transaction(() => queue.enqueue("bank", { content: "second" }))).rejects.toMatchObject({
      code: "RETAIN_QUEUE_CAPACITY",
    });
    expect(queue.peek().map((item) => item.content)).toEqual(["first"]);
    expect(readdirSync(join(safe, "queue")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(readdirSync(join(other, "queue"))).toEqual([]);
  });

  it("rejects writable non-sticky ancestors", () => {
    const child = join(directory, "child");
    mkdirSync(child);
    chmodSync(directory, 0o777);
    expect(() => privateQueueDirectory(child)).toThrow("trusted parent");
  });

  it("accepts trusted ancestor symlinks and validates their resolved parents", () => {
    const target = join(directory, "target");
    mkdirSync(target);
    const child = join(target, "child");
    mkdirSync(child);
    const alias = join(directory, "alias");
    symlinkSync(target, alias);
    privateQueueDirectory(join(alias, "child"));
    chmodSync(target, 0o777);
    expect(() => privateQueueDirectory(join(alias, "child"))).toThrow("trusted parent");
  });

  it("rejects non-regular queue files", () => {
    mkdirSync(queueFile);
    expect(() => new RetainQueue({ filePath: queueFile }).peek()).toThrow("regular file");
  });

  it("rejects foreign-owned directories without changing permissions", () => {
    const uid = process.geteuid?.() ?? 0;
    vi.spyOn(process, "geteuid").mockReturnValue(uid + 1);
    expect(() => privateQueueDirectory(directory)).toThrow("another user");
  });

  it("explicitly rejects platforms without the supported permission contract", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    expect(() => privateQueueDirectory(directory)).toThrow("require Linux or macOS");
  });

  it("rejects a foreign-owned file after opening without reading or changing it", async () => {
    writeFileSync(queueFile, "untouched", { mode: 0o644 });
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fstatSync).mockImplementation((fd) => {
      const info = fs.fstatSync(fd);
      if (info.isFile()) info.uid = (process.geteuid?.() ?? 0) + 1;
      return info;
    });
    expect(() => new RetainQueue({ filePath: queueFile }).peek()).toThrow("another user");
    expect(readFileSync(queueFile, "utf8")).toBe("untouched");
    expect(statSync(queueFile).mode & 0o777).toBe(0o644);
    vi.mocked(fstatSync).mockImplementation(fs.fstatSync);
  });

  it.each(["symlink", "hardlink", "regular"])("refuses an exclusive temporary collision (%s)", (kind) => {
    const uuid = "00000000-0000-4000-8000-000000000000";
    vi.mocked(randomUUID).mockReturnValueOnce(uuid);
    const target = join(directory, "target");
    writeFileSync(target, "untouched");
    const temporary = `${queueFile}.${uuid}.tmp`;
    if (kind === "symlink") symlinkSync(target, temporary);
    else if (kind === "hardlink") linkSync(target, temporary);
    else writeFileSync(temporary, "untouched");
    expect(() => writePrivateQueueFile(queueFile, "bad")).toThrow();
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expect(readFileSync(temporary, "utf8")).toBe("untouched");
  });

  it("opens owned regular files with private descriptor permissions", () => {
    writeFileSync(queueFile, "legacy", { mode: 0o644 });
    const fd = openPrivateQueueFile(queueFile, constants.O_RDONLY);
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o600);
    } finally {
      closeSync(fd);
    }
  });
});
