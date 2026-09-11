const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const combination = require("./combination.cjs");

test("release combinations keep pinned inputs even when newer upstream commits exist", async () => {
  const before = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "combination-test-"));
  process.chdir(directory);
  try {
    mkdirSync("compat");
    const sha = "a".repeat(40);
    const digest = `sha256:${"b".repeat(64)}`;
    const pin = { version: "0.9.2", sha, image: `ghcr.io/vectorize-io/hindsight:0.9.2@${digest}` };
    const router = {
      version: "0.1.0",
      sha,
      image: `ghcr.io/mickey-kras/hindsight-memory-router@${digest}`,
      dockerhub_image: `docker.io/mickeykrasilnikov/hindsight-memory-router@${digest}`,
    };
    writeFileSync("compat/hindsight.json", JSON.stringify({ channel: "release", ...pin }));
    writeFileSync("release.json", JSON.stringify({ router }));
    const outputs = {};
    const options = {
      github: {},
      core: {
        setOutput: (name, value) => {
          outputs[name] = value;
        },
      },
      context: { ref: "refs/heads/fix/example", payload: { pull_request: { base: { ref: "release/0.1.0" } } } },
    };
    await combination(options);
    assert.equal(outputs.router_image, router.image);
    assert.equal(outputs.image, pin.image);
    assert.equal(outputs.router_sha, sha);
    writeFileSync("release.json", JSON.stringify({ router: { ...router, image: "latest" } }));
    await assert.rejects(combination(options), /digest/);
  } finally {
    process.chdir(before);
    rmSync(directory, { recursive: true, force: true });
  }
});
