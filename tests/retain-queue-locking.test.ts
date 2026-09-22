import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const storageUrl = new URL("../src/shared/retain-queue-storage.ts", import.meta.url).href;
const queueUrl = new URL("../src/upstream/src/retain-queue.ts", import.meta.url).href;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "queue-lock-owner-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function writer(mode: "append" | "rewrite" | "normal", maxItems = 1) {
  const source = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { RetainQueueStorage } from ${JSON.stringify(storageUrl)};
    import { RetainQueue } from ${JSON.stringify(queueUrl)};
    const mode = ${JSON.stringify(mode)};
    if (mode !== "normal") {
      const method = mode === "append" ? "appendFileSync" : "renameSync";
      const original = fs[method];
      fs[method] = (...args) => {
        process.stdout.write("paused\\n");
        process.kill(process.pid, "SIGSTOP");
        return original(...args);
      };
      syncBuiltinESMExports();
    }
    const storage = new RetainQueueStorage(${JSON.stringify(directory)}, ${maxItems}, 10000);
    const queue = new RetainQueue({
      filePath: ${JSON.stringify(join(directory, "hindsight-retain-queue.main.jsonl"))}, capacity: storage,
    });
    try {
      await storage.transaction(() => {
        if (mode === "rewrite") queue.ensureOperationId("existing", "preserved-operation");
        else queue.enqueue("bank", { content: mode, documentId: mode });
      });
      process.stdout.write("accepted\\n");
    } catch (error) { process.stdout.write(error.code + "\\n"); }
  `;
  const child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let stderr = "";
  let reportPaused: () => void;
  const paused = new Promise<void>((resolve) => {
    reportPaused = resolve;
  });
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes("paused\n")) reportPaused();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const done = new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0 && signal !== "SIGKILL") reject(new Error(stderr));
      else resolve(output);
    });
  });
  return { child, paused, done };
}

function items(): Array<{ content: string; operationId?: string }> {
  return JSON.parse(
    `[${readFileSync(join(directory, "hindsight-retain-queue.main.jsonl"), "utf8").trim().split("\n").join(",")}]`,
  );
}

describe.skipIf(process.platform === "win32")("queue lock process ownership", () => {
  it("keeps a suspended writer exclusive beyond the former stale lease", async () => {
    const first = writer("append");
    try {
      await first.paused;
      await setTimeout(11000);
      expect(await writer("normal").done).toBe("RETAIN_QUEUE_BUSY\n");
      first.child.kill("SIGCONT");
      expect(await first.done).toBe("paused\naccepted\n");
      expect(items().map((item) => item.content)).toEqual(["append"]);
    } finally {
      first.child.kill("SIGKILL");
      await first.done;
    }
  }, 20000);

  it("prevents a suspended full-file rewrite from replacing another writer's accepted data", async () => {
    writeFileSync(
      join(directory, "hindsight-retain-queue.main.jsonl"),
      `${JSON.stringify({
        id: "existing",
        content: "existing",
        documentId: "existing",
        bankId: "bank",
        metadata: {},
        createdAt: new Date().toISOString(),
      })}\n`,
    );
    const first = writer("rewrite", 2);
    try {
      await first.paused;
      utimesSync(join(directory, ".retain-queue.lock"), new Date(0), new Date(0));
      expect(await writer("normal", 2).done).toBe("RETAIN_QUEUE_BUSY\n");
      first.child.kill("SIGCONT");
      await first.done;
      expect(await writer("normal", 2).done).toBe("accepted\n");
      expect(items()).toEqual([
        expect.objectContaining({ content: "existing", operationId: "preserved-operation" }),
        expect.objectContaining({ content: "normal" }),
      ]);
    } finally {
      first.child.kill("SIGKILL");
      await first.done;
    }
  }, 10000);

  it("reclaims a killed owner's lock without deleting the lock inode or waiting for expiry", async () => {
    const first = writer("append");
    try {
      await first.paused;
      first.child.kill("SIGKILL");
      await first.done;
      expect(await writer("normal").done).toBe("accepted\n");
      expect(items().map((item) => item.content)).toEqual(["normal"]);
      expect(readdirSync(directory).filter((name) => name.endsWith(".lock"))).toEqual([".retain-queue.lock"]);
    } finally {
      first.child.kill("SIGKILL");
      await first.done;
    }
  });
  it("recovers a killed rewrite without losing the original queue or keeping orphaned payload copies", async () => {
    const file = join(directory, "hindsight-retain-queue.main.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({
        id: "existing",
        content: "existing",
        documentId: "existing",
        bankId: "bank",
        metadata: {},
        createdAt: new Date().toISOString(),
      })}\n`,
    );
    const first = writer("rewrite", 2);
    try {
      await first.paused;
      expect(readdirSync(directory)).toContain("hindsight-retain-queue.main.jsonl.tmp");
      first.child.kill("SIGKILL");
      await first.done;
      expect(await writer("normal", 2).done).toBe("accepted\n");
      expect(items().map((item) => item.content)).toEqual(["existing", "normal"]);
      expect(readdirSync(directory)).not.toContain("hindsight-retain-queue.main.jsonl.tmp");
    } finally {
      first.child.kill("SIGKILL");
      await first.done;
    }
  });
});
