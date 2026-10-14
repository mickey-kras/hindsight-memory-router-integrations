import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/** Copy/write operations must not follow links outside their snapshotted tree. */
export function assertUnlinkedTree(path: string, rejectHardLinks = false): void {
  const pending = [path];
  while (pending.length) {
    const entry = pending.pop()!;
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(entry); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("linked install path");
    // A write to one hard-link alias also changes every other alias, outside rollback's scope.
    // Source files are read/copied into fresh inodes, so only destination scans need this check.
    if (rejectHardLinks && stat.isFile() && stat.nlink > 1) throw new Error("shared install file");
    if (stat.isDirectory()) {
      for (const child of readdirSync(entry)) pending.push(join(entry, child));
    }
  }
}

/** Snapshot only adapter-owned files/runtime/plugin registries; never harness session history. */
export class InstallTransaction {
  private readonly scratch = mkdtempSync(join(tmpdir(), "memory-install-"));
  private readonly snapshots: { path: string; backup?: string }[] = [];
  private readonly missingParents = new Set<string>();

  constructor(paths: string[]) {
    const unique = [...new Set(paths.map((path) => resolve(path)))];
    try {
      for (const path of unique.filter((path) => !unique.some((parent) => path.startsWith(parent + sep)))) {
        // A link could redirect adapter writes outside the snapshot. Refuse it before mutation.
        let ancestor = path;
        for (;;) {
          try { if (lstatSync(ancestor).isSymbolicLink()) throw new Error("linked install path"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          const next = dirname(ancestor);
          if (next === ancestor) break;
          ancestor = next;
        }
        assertUnlinkedTree(path, true);
        let parent = dirname(path);
        while (!existsSync(parent)) {
          this.missingParents.add(parent);
          parent = dirname(parent);
        }
        let backup: string | undefined;
        // lstat includes dangling links so recovery preserves them, too.
        try { lstatSync(path); backup = join(this.scratch, String(this.snapshots.length)); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (backup) cpSync(path, backup, { recursive: true, dereference: false, verbatimSymlinks: true });
        this.snapshots.push({ path, backup });
      }
    } catch (error) {
      this.commit();
      throw error;
    }
  }

  commit(): void { rmSync(this.scratch, { recursive: true, force: true }); }

  /** Kept available for manual recovery if a filesystem failure prevents rollback. */
  get recoveryDirectory(): string { return this.scratch; }

  rollback(): void {
    const failures: unknown[] = [];
    for (const { path, backup } of [...this.snapshots].reverse()) {
      try {
        rmSync(path, { recursive: true, force: true });
        if (backup) {
          mkdirSync(dirname(path), { recursive: true });
          cpSync(backup, path, { recursive: true, dereference: false, verbatimSymlinks: true });
        }
      } catch (error) { failures.push(error); }
    }
    for (const parent of [...this.missingParents].sort((a, b) => b.length - a.length)) {
      try {
        if (existsSync(parent) && readdirSync(parent).length === 0) rmSync(parent, { recursive: true });
      } catch (error) { failures.push(error); }
    }
    // Never destroy the only recoverable originals when restoring one path failed.
    if (failures.length) throw new AggregateError(failures, "installation rollback incomplete");
    this.commit();
  }
}
