import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { managedBank, managedReadScope } from "../src/coding-agents/runtime.js";
import { AccessDeniedError } from "../src/shared/bank-access.js";

let directory: string;
let root: string;

function configure(mapPathToBank: Record<string, string>): void {
  const config = join(directory, "router.json");
  writeFileSync(
    config,
    JSON.stringify({
      routerUrl: "https://router.example.test",
      principals: {
        codex: {
          tokenEnv: "ROOT_MAPPING_TEST_TOKEN",
          writeBank: "private",
          additionalReadBanks: ["shared"],
          mapPathToBank,
        },
      },
    }),
  );
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", config);
}

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "root-mapping-")));
  root = parse(directory).root;
  vi.stubEnv("ROOT_MAPPING_TEST_TOKEN", `mr_codex_${"a".repeat(64)}`);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("maps both a filesystem root and its descendants to the configured bank", () => {
  configure({ [root]: "private" });
  expect(managedBank("codex", root)).toBe("private");
  expect(managedBank("codex", directory)).toBe("private");
});

it("prefers the most specific canonical mapping over a filesystem root", () => {
  const nested = join(directory, "nested");
  mkdirSync(nested);
  configure({ [directory]: "shared", [root]: "private" });
  expect(managedBank("codex", directory)).toBe("shared");
  expect(managedBank("codex", nested)).toBe("shared");
  expect(managedBank("codex", root)).toBe("private");
});

it("rejects sibling prefixes while accepting exact mappings and descendants", () => {
  const workspace = join(directory, "project");
  const nested = join(workspace, "nested");
  const sibling = join(directory, "project-other");
  mkdirSync(nested, { recursive: true });
  mkdirSync(sibling);
  configure({ [workspace]: "private" });
  expect(managedBank("codex", workspace)).toBe("private");
  expect(managedBank("codex", nested)).toBe("private");
  expect(() => managedBank("codex", sibling)).toThrow(AccessDeniedError);
  configure({ [root]: "private" });
  expect(() => managedReadScope("codex", sibling, workspace)).toThrow(AccessDeniedError);
});

it("accepts a filesystem root as the session root for a descendant in the same bank", () => {
  configure({ [root]: "private" });
  expect(managedReadScope("codex", root, root)).toMatchObject({ workspace: root, bankId: "private" });
  expect(managedReadScope("codex", directory, root)).toMatchObject({ workspace: root, bankId: "private" });
});

it("rejects crossing banks even when the session root contains the directory", () => {
  configure({ [root]: "private", [directory]: "shared" });
  expect(() => managedReadScope("codex", directory, root)).toThrow(AccessDeniedError);
});

it("keeps root mappings subject to read authorization", () => {
  configure({ [root]: "forbidden" });
  expect(() => managedBank("codex", directory)).toThrow(AccessDeniedError);
  expect(() => managedReadScope("codex", directory, root)).toThrow(AccessDeniedError);
});

it("canonicalizes mappings and session roots and rejects symlink escapes", () => {
  const workspace = join(directory, "workspace");
  const nested = join(workspace, "nested");
  const sibling = join(directory, "sibling");
  const alias = join(directory, "alias");
  const escapedPath = join(workspace, "escape");
  mkdirSync(nested, { recursive: true });
  mkdirSync(sibling);
  symlinkSync(workspace, alias, "junction");
  symlinkSync(sibling, escapedPath, "junction");
  configure({ [root]: "private", [alias]: "shared", [sibling]: "shared" });
  expect(managedBank("codex", nested)).toBe("shared");
  expect(managedReadScope("codex", join(alias, "nested"), alias)).toMatchObject({
    workspace,
    bankId: "shared",
  });
  expect(() => managedReadScope("codex", escapedPath, alias)).toThrow(AccessDeniedError);
});
