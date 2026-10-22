const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { test } = require("node:test");
const { publishPackages } = require("../scripts/publish-npm.cjs");

const bytes = Buffer.from("verified release tarball");
const packages = ["openclaw", "coding-agents"].map((suffix) => ({
  name: `@mickey-kras/hindsight-memory-router-${suffix}`,
  version: "1.2.3",
  path: `packages/mickey-kras-hindsight-memory-router-${suffix}-1.2.3.tgz`,
  sha256: createHash("sha256").update(bytes).digest("hex"),
}));
function metadata(pkg) {
  return {
    name: pkg.name,
    version: pkg.version,
    dist: {
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
    },
  };
}
function scenario(existing = []) {
  const published = new Map(existing.map((pkg) => [pkg.name, metadata(pkg)]));
  const calls = [];
  return {
    calls,
    published,
    options: {
      packages,
      read: () => bytes,
      lookup: async (name, version) => (version === "latest" ? null : published.get(name) || null),
      publish: (args) => {
        calls.push(args);
        const pkg = packages.find((item) => args[1].endsWith(item.path));
        published.set(pkg.name, metadata(pkg));
      },
      wait: async () => {},
    },
  };
}

test("publishes the verified archives publicly with provenance and lifecycle scripts disabled", async () => {
  const { calls, options } = scenario();
  await publishPackages(options);
  assert.equal(calls.length, 2);
  for (const args of calls) {
    assert.deepEqual(args.slice(2), [
      "--registry",
      "https://registry.npmjs.org",
      "--access",
      "public",
      "--provenance",
      "--ignore-scripts",
      "--tag",
      "latest",
    ]);
  }
});

test("retries partial publication without republishing the identical version", async () => {
  const { calls, options } = scenario([packages[0]]);
  await publishPackages(options);
  assert.equal(calls.length, 1);
  assert.ok(calls[0][1].endsWith(packages[1].path));
});

test("identical completed publication is a no-op", async () => {
  const { calls, options } = scenario(packages);
  await publishPackages(options);
  assert.deepEqual(calls, []);
});

for (const defect of ["integrity", "provenance"]) {
  test(`rejects existing ${defect} mismatch before publishing another package`, async () => {
    const { calls, published, options } = scenario([packages[1]]);
    if (defect === "integrity") published.get(packages[1].name).dist.integrity = "sha512-other";
    else delete published.get(packages[1].name).dist.attestations;
    await assert.rejects(publishPackages(options), /mismatch|provenance missing/);
    assert.deepEqual(calls, []);
  });
}

test("rejects corrupted local archives before registry access", async () => {
  const { options } = scenario();
  options.read = () => Buffer.from("changed");
  options.lookup = async () => {
    throw new Error("must not query registry");
  };
  await assert.rejects(publishPackages(options), /checksum mismatch/);
});

test("fails closed on registry and publish failures", async () => {
  for (const method of ["lookup", "publish"]) {
    const { options } = scenario();
    options[method] = () => {
      throw new Error("service unavailable");
    };
    await assert.rejects(publishPackages(options), /service unavailable/);
  }
});

test("does not move latest backwards for an older package release", async () => {
  const { calls, options } = scenario();
  const lookup = options.lookup;
  options.lookup = (name, version) => (version === "latest" ? { version: "2.0.0" } : lookup(name, version));
  await publishPackages(options);
  assert.ok(calls.every((args) => args.at(-1) === "release-1.2.3"));
});

test("waits for registry visibility and verifies the published bytes", async () => {
  const { options, published } = scenario();
  let waits = 0;
  const lookup = options.lookup;
  options.lookup = (name, version) => (published.has(name) && waits === 0 ? null : lookup(name, version));
  options.wait = async () => {
    waits++;
  };
  await publishPackages(options);
  assert.equal(waits, 1);
});

test("fails when publication never becomes visible", async () => {
  const { options } = scenario();
  options.publish = () => {};
  await assert.rejects(publishPackages(options), /publication not visible/);
});

test("rejects wrong package inventories and paths", async () => {
  for (const invalid of [[], [packages[0], packages[0]], [{ ...packages[0], path: "other.tgz" }, packages[1]]]) {
    await assert.rejects(publishPackages({ ...scenario().options, packages: invalid }), /Invalid npm/);
  }
});
