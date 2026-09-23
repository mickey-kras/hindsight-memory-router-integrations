const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const combination = require("./combination.cjs");
const { execFileSync } = require("node:child_process");
const { assertLiveness, verifyRouterVersion } = require("./combination-identity.cjs");

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
    options.context = {
      eventName: "workflow_dispatch",
      workflow: "release",
      ref: "refs/heads/main",
      sha: "c".repeat(40),
      payload: {},
    };
    options.target = { ref: "refs/heads/release/0.1.0", sha };
    await combination(options);
    assert.equal(outputs.router_image, router.image);
    assert.equal(outputs.image, pin.image);
    assert.equal(options.context.ref, "refs/heads/main");
    writeFileSync("release.json", JSON.stringify({ router: { ...router, image: "latest" } }));
    await assert.rejects(combination(options), /digest/);
  } finally {
    process.chdir(before);
    rmSync(directory, { recursive: true, force: true });
  }
});

function identityFixture(
  { source = "0.1.5", installed = "0.1.5", image = "ghcr.io/router@sha256:fixture", version = "0.1.5" },
  check,
) {
  const directory = mkdtempSync(join(tmpdir(), "combination-identity-"));
  const manifest = join(directory, "release-version.json");
  writeFileSync(manifest, JSON.stringify({ version: source }));
  if (installed !== null) {
    const metadata = join(directory, `hindsight_memory_router-${installed}.dist-info`);
    mkdirSync(metadata);
    writeFileSync(
      join(metadata, "METADATA"),
      `Metadata-Version: 2.1\nName: hindsight-memory-router\nVersion: ${installed}\n`,
    );
  }
  let executions = 0;
  const compose = ["docker", "compose", "-p", "combination-fixture", "-f", "fixture.yml"];
  const options = {
    source: manifest,
    image,
    version,
    compose,
    run(command, args) {
      executions++;
      assert.equal(command, "docker");
      assert.deepEqual(args.slice(0, -1), [...compose.slice(1), "exec", "-T", "memory-router", "python", "-c"]);
      return execFileSync("python3", ["-S", "-c", args.at(-1)], {
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, PYTHONPATH: directory },
      });
    },
  };
  try {
    check(options, () => executions);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("released router smoke accepts status-only health and verifies its installed distribution", async () => {
  await assertLiveness(new Response(JSON.stringify({ status: "alive" }), { status: 200 }));
  identityFixture({}, (options, executions) => {
    verifyRouterVersion(options);
    assert.equal(executions(), 1);
  });
});

test("main-built router smoke checks the same runtime identity against the resolved checkout", () => {
  identityFixture({ source: "0.1.6", installed: "0.1.6", image: "", version: "" }, (options, executions) => {
    verifyRouterVersion(options);
    assert.equal(executions(), 1);
  });
});

test("healthy router with a different installed distribution fails the combination gate", () => {
  identityFixture({ installed: "0.1.4" }, (options) => {
    assert.throws(() => verifyRouterVersion(options), /Running router distribution must match/);
  });
});

test("router image without installed package identity fails the combination gate", () => {
  identityFixture({ installed: null }, (options) => {
    assert.throws(() => verifyRouterVersion(options), /No package metadata was found/);
  });
});

test("released image cannot omit or disagree with its frozen router version", () => {
  for (const version of ["", "0.1.4"]) {
    identityFixture({ version }, (options, executions) => {
      assert.throws(() => verifyRouterVersion(options), /Frozen router version must match/);
      assert.equal(executions(), 0);
    });
  }
});

test("main checkout without a valid version fails before starting a runtime identity command", () => {
  identityFixture({ source: "", image: "", version: "" }, (options, executions) => {
    assert.throws(() => verifyRouterVersion(options), /Invalid checked-out router version/);
    assert.equal(executions(), 0);
  });
});

test("liveness HTTP errors or non-alive states fail without consulting a version field", async () => {
  await assert.rejects(
    assertLiveness(new Response(JSON.stringify({ status: "alive" }), { status: 503 })),
    /request must succeed/,
  );
  await assert.rejects(
    assertLiveness(new Response(JSON.stringify({ status: "failed", version: "0.1.5" }))),
    /must report alive/,
  );
});
