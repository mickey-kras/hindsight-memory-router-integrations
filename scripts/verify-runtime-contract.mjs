import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(`>=${process.versions.node}`, manifest.engines.node, "run with the advertised minimum Node.js version");
const artifact = resolve("packages", `${manifest.name.slice(1).replace("/", "-")}-${manifest.version}.tgz`);
const directory = mkdtempSync(join(tmpdir(), "router-runtime-contract-"));
try {
  writeFileSync(join(directory, "package.json"), '{"private":true,"type":"module"}\n');
  execFileSync("npm", ["install", artifact, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: directory,
    stdio: "inherit",
  });
  const name = JSON.stringify(manifest.name);
  execFileSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      `
    const { default: plugin, PLUGIN_ID } = require(${name});
    if (typeof plugin !== "function" || PLUGIN_ID !== "hindsight-memory-router") throw new Error("CommonJS root contract failed");
  `,
    ],
    { cwd: directory, stdio: "inherit" },
  );
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import plugin, { PLUGIN_ID } from ${name};
    import { HostedRouterClient } from ${JSON.stringify(`${manifest.name}/hosted`)};
    if (typeof plugin !== "function" || PLUGIN_ID !== "hindsight-memory-router") throw new Error("ESM root contract failed");
    if (typeof HostedRouterClient !== "function") throw new Error("hosted contract failed");
  `,
    ],
    { cwd: directory, stdio: "inherit" },
  );
  // Compile from the installed consumer so repository overrides and development
  // dependencies cannot hide missing production declaration dependencies.
  execFileSync(
    "npm",
    [
      "install",
      "--no-save",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `@types/node@${manifest.devDependencies["@types/node"]}`,
    ],
    {
      cwd: directory,
      stdio: "inherit",
    },
  );
  const consumer = join(directory, "consumer.mts");
  writeFileSync(
    consumer,
    `
    import plugin from ${name};
    import { HostedRouterClient, type HostedRouterOptions } from ${JSON.stringify(`${manifest.name}/hosted`)};
    const options: HostedRouterOptions = {
      routerUrl: "https://router.example.test", principalId: "test", token: "test", writeBank: "test", additionalReadBanks: [],
    };
    const client: HostedRouterClient = new HostedRouterClient(options);
    void plugin;
    void client;
  `,
  );
  execFileSync(
    process.execPath,
    [
      resolve("node_modules/typescript/bin/tsc"),
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--module",
      "NodeNext",
      "--target",
      "ES2022",
      "--types",
      "node",
      consumer,
    ],
    {
      cwd: directory,
      stdio: "inherit",
    },
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
