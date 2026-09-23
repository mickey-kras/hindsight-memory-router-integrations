const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");

async function assertLiveness(response) {
  assert.equal(response.status, 200, "Router liveness request must succeed");
  assert.equal((await response.json()).status, "alive", "Router must report alive");
}

function verifyRouterVersion({ source, image, version, compose, run = execFileSync }) {
  const expected = JSON.parse(readFileSync(source, "utf8")).version;
  assert.match(expected, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Invalid checked-out router version");
  if (image) assert.equal(version, expected, "Frozen router version must match checked-out source");
  const actual = run(
    compose[0],
    [
      ...compose.slice(1),
      "exec",
      "-T",
      "memory-router",
      "python",
      "-c",
      "from importlib.metadata import version; print(version('hindsight-memory-router'))",
    ],
    { encoding: "utf8" },
  );
  assert.equal(actual, `${expected}\n`, "Running router distribution must match checked-out source");
}

if (require.main === module) {
  verifyRouterVersion({
    source: process.argv[2],
    compose: process.argv.slice(3),
    image: process.env.ROUTER_TEST_IMAGE,
    version: process.env.ROUTER_TEST_VERSION,
  });
}

module.exports = { assertLiveness, verifyRouterVersion };
