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
  let elapsed = 0;
  return {
    calls,
    published,
    elapsed: () => elapsed,
    advance: (delay) => {
      elapsed += delay;
    },
    options: {
      packages,
      read: () => bytes,
      lookup: async (name, version) => (version === "latest" ? null : published.get(name) || null),
      publish: (args) => {
        calls.push(args);
        const pkg = packages.find((item) => args[1].endsWith(item.path));
        published.set(pkg.name, metadata(pkg));
      },
      now: () => elapsed,
      wait: async (delay) => {
        elapsed += delay;
      },
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
  const waits = [];
  const lookup = options.lookup;
  options.lookup = (name, version) => (published.has(name) && waits.length === 0 ? null : lookup(name, version));
  const wait = options.wait;
  options.wait = async (delay) => {
    waits.push(delay);
    await wait(delay);
  };
  await publishPackages(options);
  assert.deepEqual(waits, [10_000]);
});

test("waits several minutes for each accepted publication without publishing twice", async () => {
  const { options, calls, published, elapsed } = scenario();
  const acceptedAt = new Map();
  const publish = options.publish;
  options.publish = (args) => {
    publish(args);
    const pkg = packages.find((item) => args[1].endsWith(item.path));
    acceptedAt.set(pkg.name, elapsed());
  };
  options.lookup = (name, version) => {
    const accepted = acceptedAt.get(name);
    return version !== "latest" && accepted !== undefined && elapsed() - accepted >= 180_000
      ? published.get(name)
      : null;
  };
  await publishPackages(options);
  assert.equal(elapsed(), 360_000);
  assert.equal(calls.length, 2);
});

test("starts the visibility window after a slow publication", async () => {
  const { options, calls, elapsed, advance } = scenario();
  options.publish = (args) => {
    calls.push(args);
    advance(60_000);
  };
  await assert.rejects(publishPackages(options), /publication not visible/);
  assert.equal(elapsed(), 360_000);
});

test("checks metadata that becomes visible during the final wait", async () => {
  const { options, calls, published, elapsed } = scenario([packages[1]]);
  const lookup = options.lookup;
  options.lookup = (name, version) => (name === packages[0].name && elapsed() < 295_000 ? null : lookup(name, version));
  await publishPackages(options);
  assert.equal(elapsed(), 300_000);
  assert.equal(calls.length, 1);
  assert.ok(published.has(packages[0].name));
});

test("fails after the bounded visibility window without publishing another package", async () => {
  const { options, calls, elapsed } = scenario();
  const waits = [];
  const wait = options.wait;
  options.wait = async (delay) => {
    waits.push(delay);
    await wait(delay);
  };
  options.publish = (args) => calls.push(args);
  await assert.rejects(publishPackages(options), /publication not visible: .*rerun failed jobs/);
  assert.equal(elapsed(), 300_000);
  assert.ok(waits.every((delay) => delay <= 10_000));
  assert.equal(calls.length, 1);
});

test("counts slow metadata requests against the visibility deadline", async () => {
  const { options, calls, elapsed, advance } = scenario();
  const waits = [];
  const wait = options.wait;
  options.wait = async (delay) => {
    waits.push(delay);
    await wait(delay);
  };
  options.publish = (args) => calls.push(args);
  options.lookup = async () => {
    if (calls.length) advance(7_000);
    return null;
  };
  await assert.rejects(publishPackages(options), /publication not visible/);
  assert.equal(waits.at(-1), 300_000 - 17_000 * (waits.length - 1) - 7_000);
  assert.ok(elapsed() <= 307_000);
  assert.equal(calls.length, 1);
});

test("keeps waiting through registry errors after publication", async () => {
  const { options, calls, published } = scenario();
  let failures = 0;
  const lookup = options.lookup;
  options.lookup = async (name, version) => {
    if (calls.length && version !== "latest" && failures < 3) {
      failures++;
      throw new Error("npm metadata request failed: HTTP 503");
    }
    return lookup(name, version);
  };
  await publishPackages(options);
  assert.equal(failures, 3);
  assert.equal(calls.length, 2);
  assert.equal(published.size, 2);
});

test("reports the last registry error when publication never becomes visible", async () => {
  const { options, calls } = scenario();
  options.publish = (args) => calls.push(args);
  options.lookup = async () => {
    if (calls.length) throw new Error("npm metadata request failed: HTTP 429");
    return null;
  };
  await assert.rejects(publishPackages(options), /not visible: .*last error: npm metadata request failed: HTTP 429/);
  assert.equal(calls.length, 1);
});

for (const defect of ["integrity", "provenance"]) {
  test(`rejects newly visible ${defect} mismatch without waiting or publishing another package`, async () => {
    const { options, calls, published } = scenario();
    const publish = options.publish;
    options.publish = (args) => {
      publish(args);
      const result = published.get(packages[0].name);
      if (defect === "integrity") result.dist.integrity = "sha512-other";
      else delete result.dist.attestations;
    };
    options.wait = async () => {
      throw new Error("must not wait on invalid metadata");
    };
    await assert.rejects(publishPackages(options), /mismatch|provenance missing/);
    assert.equal(calls.length, 1);
  });
}

test("rejects wrong package inventories and paths", async () => {
  for (const invalid of [[], [packages[0], packages[0]], [{ ...packages[0], path: "other.tgz" }, packages[1]]]) {
    await assert.rejects(publishPackages({ ...scenario().options, packages: invalid }), /Invalid npm/);
  }
});
