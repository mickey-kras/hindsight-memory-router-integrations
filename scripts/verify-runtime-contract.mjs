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
} finally {
  rmSync(directory, { recursive: true, force: true });
}
