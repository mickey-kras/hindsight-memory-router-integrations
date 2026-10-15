import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";

beforeAll(() => {
  execFileSync("npm", ["run", "build", "--silent"], { cwd: process.cwd() });
}, 120000);

it("loads the root plugin through its CommonJS package self-reference", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      `
    const plugin = require("@mickey-kras/hindsight-memory-router-openclaw");
    if (typeof plugin.default !== "function") throw new Error("missing plugin entrypoint");
    process.stdout.write(plugin.PLUGIN_ID);
  `,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  expect(output).toBe("hindsight-memory-router");
});

it("ships root and hosted entrypoints without coding-only adapters", () => {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }),
  ) as Array<{ files: Array<{ path: string }> }>;
  const files = packed[0].files.map((file) => file.path);
  expect(files).toEqual(
    expect.arrayContaining([
      "dist/plugin.js",
      "dist/plugin.d.ts",
      "dist/shared/hosted-client.js",
      "dist/shared/hosted-client.d.ts",
      "dist/upstream/src/retain-queue.js",
      "dist/upstream/src/retain-queue.d.ts",
    ]),
  );
  expect(files.some((file) => file.startsWith("dist/coding-agents/"))).toBe(false);
});

it("loads ESM root and hosted exports", () => {
  const directory = mkdtempSync(join(process.cwd(), ".package-contract-"));
  try {
    const source = `
      import plugin, { PLUGIN_ID } from "@mickey-kras/hindsight-memory-router-openclaw";
      import { HostedRouterClient } from "@mickey-kras/hindsight-memory-router-openclaw/hosted";
      if (typeof plugin !== "function" || PLUGIN_ID !== "hindsight-memory-router") throw new Error("missing root export");
      if (typeof HostedRouterClient !== "function") throw new Error("missing hosted export");
    `;
    execFileSync(process.execPath, ["--input-type=module", "-e", source], { cwd: directory });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
