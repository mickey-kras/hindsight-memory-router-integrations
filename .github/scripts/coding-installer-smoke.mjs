import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(await readFile(join(root, "src/upstream/coding-agents/package.json"), "utf8"));
const filename = `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`;
const artifact = join(root, "packages", filename);
const bytes = await readFile(artifact);
const pins = await readFile(join(root, "PACKAGE_SHA256"), "utf8");
assert.ok(pins.split("\n").includes(`${createHash("sha256").update(bytes).digest("hex")}  packages/${filename}`));

function execute(args, cwd, env) {
  return new Promise((resolveResult, reject) => {
    const child = spawn("npm", args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: AbortSignal.timeout(60_000),
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolveResult({ code, output }));
  });
}

test("pinned URL and checksum-verified artifact install the same managed runtime", { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "router-installer-"));
  const server = createServer((request, response) => {
    if (request.url !== `/${filename}`) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes);
  });
  await new Promise((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const specs = [artifact, `http://127.0.0.1:${address.port}/${filename}`];
    for (const [index, spec] of specs.entries()) {
      const home = join(directory, String(index));
      const project = join(home, "project");
      await mkdir(project, { recursive: true });
      const config = join(home, "router.json");
      await writeFile(
        config,
        JSON.stringify({
          routerUrl: "https://router.example.test",
          principals: {
            codex: {
              tokenEnv: "ROUTER_INSTALL_TEST_TOKEN",
              writeBank: "test-bank",
              mapPathToBank: { [project]: "test-bank" },
            },
          },
        }),
      );
      const env = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) =>
            /^(?:https?_proxy|all_proxy|no_proxy|npm_config_(?:https?_proxy|proxy))$/i.test(key),
          ),
        ),
        NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
        SSL_CERT_FILE: process.env.SSL_CERT_FILE,
        SSL_CERT_DIR: process.env.SSL_CERT_DIR,
        PATH: process.env.PATH,
        npm_config_fetch_retries: "0",
        npm_config_fetch_timeout: "20000",
        HOME: home,
        npm_config_cache: join(directory, "npm-cache"),
        npm_config_ignore_scripts: "true",
        npm_config_audit: "false",
        npm_config_fund: "false",
        HINDSIGHT_ROUTER_CONFIG: config,
        HINDSIGHT_MCP_HARNESS: "codex",
        ROUTER_INSTALL_TEST_TOKEN: `mr_synthetic_${"a".repeat(64)}`,
      };
      const args = ["exec", "--yes", `--package=${spec}`, "--", "hindsight-coding-agents", "install"];
      const first = await execute(args, project, env);
      assert.equal(first.code, 0, first.output);
      assert.equal(first.output.includes(env.ROUTER_INSTALL_TEST_TOKEN), false);
      const installedPath = join(home, ".codex", "config.toml");
      const installed = await readFile(installedPath, "utf8");
      assert.ok(installed.includes("HINDSIGHT_ROUTER_CONFIG"));
      assert.equal(installed.includes(env.ROUTER_INSTALL_TEST_TOKEN), false);
      const second = await execute(args, project, env);
      assert.equal(second.code, 0, second.output);
      assert.equal(await readFile(installedPath, "utf8"), installed);
    }
  } finally {
    await new Promise((resolveClosed, reject) => server.close((error) => (error ? reject(error) : resolveClosed())));
    await rm(directory, { recursive: true, force: true });
  }
});
