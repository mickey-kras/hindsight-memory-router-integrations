const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const release = require("./release.cjs");
const { rulesets } = require("./release-settings.cjs");

const base = "a".repeat(40);
const sha = "b".repeat(40);
const digest = `sha256:${"c".repeat(64)}`;
const pin = { version: "0.9.2", sha: base, image: `ghcr.io/vectorize-io/hindsight:0.9.2@${digest}` };
const templateData = JSON.parse(readFileSync(".github/rulesets/protect-release-branches.json", "utf8"));
const fixtureChecks = templateData.rules.find((rule) => rule.type === "required_status_checks").parameters
  .required_status_checks;
for (const context of ["quality / container", "guard / guard", "guard", "branch-policy / branch name"]) {
  if (!fixtureChecks.some((check) => check.context === context)) fixtureChecks.push({ context, integration_id: 15368 });
}
const template = JSON.stringify(templateData);
const encode = (value) => ({
  type: "file",
  encoding: "base64",
  content: Buffer.from(`${JSON.stringify(value, null, 2)}\n`).toString("base64"),
});
const notFound = () => {
  throw Object.assign(new Error("Not found"), { status: 404 });
};
const put = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

async function fixture(fn) {
  const before = process.cwd();
  const previousId = process.env.RELEASE_APP_ID;
  const directory = mkdtempSync(join(tmpdir(), "release-test-"));
  process.chdir(directory);
  process.env.RELEASE_APP_ID = "123";
  mkdirSync(".github/rulesets", { recursive: true });
  mkdirSync("compat");
  writeFileSync(".github/rulesets/protect-release-branches.json", template);
  put("compat/hindsight.json", { channel: "latest" });
  put("release-version.json", { version: "0.1.0" });
  writeFileSync("pyproject.toml", '[project]\nversion = "0.1.0"\n');
  try {
    await fn();
  } finally {
    process.chdir(before);
    if (previousId === undefined) delete process.env.RELEASE_APP_ID;
    else process.env.RELEASE_APP_ID = previousId;
    rmSync(directory, { recursive: true, force: true });
  }
}

function mock() {
  const state = {
    refs: { "heads/main": { object: { type: "commit", sha: base } } },
    rules: rulesets(123),
    tags: [],
    branches: [],
    calls: [],
    assets: [],
    releases: [],
    comparison: { status: "ahead", total_commits: 1, commits: [{ sha }], files: [{ filename: "release.json" }] },
  };
  state.rules.push({
    name: "Enforce work branch names",
    enforcement: "active",
    conditions: { ref_name: { exclude: ["refs/heads/release/*"] } },
  });
  state.rules.forEach((rule, index) => {
    rule.id = index + 1;
  });
  const data = (value) => ({ data: value });
  const github = {
    rest: {
      repos: {
        getRepoRulesets: () => data(state.rules),
        getRepoRuleset: ({ ruleset_id }) => data(state.rules.find((rule) => rule.id === ruleset_id)),
        getLatestRelease: () => data({ tag_name: "v0.9.2", draft: false, prerelease: false }),
        listTags: () => data(state.tags),
        listBranches: () => data(state.branches),
        getCommit: () => data({ sha: base }),
        getContent: () => data(encode(state.prepared)),
        compareCommitsWithBasehead: ({ basehead }) =>
          data(basehead.endsWith("...main") ? { status: "identical" } : state.comparison),
        getReleaseByTag: () => (state.release ? data(state.release) : notFound()),
        createRelease: (args) => {
          state.calls.push("draft");
          state.release = { id: 1, ...args };
          return data(state.release);
        },
        listReleaseAssets: () => data(state.assets),
        uploadReleaseAsset: (args) => {
          state.calls.push(`asset:${args.name}`);
          if (state.failUpload) throw new Error("upload failed");
          state.assets.push({
            name: args.name,
            digest: `sha256:${createHash("sha256").update(args.data).digest("hex")}`,
          });
          return data({});
        },
        listReleases: () => data(state.releases),
        updateRelease: (args) => {
          state.calls.push("publish");
          Object.assign(state.release, args);
          return data(state.release);
        },
      },
      git: {
        getRef: ({ repo, ref }) =>
          repo === "hindsight"
            ? data({ object: { type: "commit", sha: base } })
            : state.refs[ref]
              ? data(state.refs[ref])
              : notFound(),
        getCommit: () => data({ tree: { sha: base } }),
        createTree: (args) => {
          state.calls.push("tree");
          state.tree = args.tree;
          return data({ sha });
        },
        createCommit: () => {
          state.calls.push("commit");
          return data({ sha });
        },
        createRef: ({ ref, sha: commit }) => {
          state.calls.push(ref);
          assert.equal(state.refs[ref.replace(/^refs\//, "")], undefined);
          state.refs[ref.replace(/^refs\//, "")] = { object: { type: "commit", sha: commit } };
          return data({});
        },
      },
    },
    paginate: async (method, args) => (await method(args)).data,
  };
  const outputs = {};
  const core = {
    setOutput: (key, value) => {
      outputs[key] = value;
    },
    summary: { addRaw: () => ({ write: async () => {} }) },
  };
  const context = {
    repo: { owner: "example", repo: "hindsight-memory-router" },
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    sha: base,
    runId: 5,
    payload: {},
  };
  return { github, state, context, core, outputs, inspect: () => digest };
}

function prepared(m) {
  const manifest = { schema: 2, version: "0.1.0", base, preparation_run: 5, hindsight: pin, packages: [] };
  m.state.prepared = structuredClone(manifest);
  m.context.ref = "refs/heads/release/0.1.0";
  m.context.sha = sha;
  m.context.eventName = "push";
  m.context.workflow = "release";
  m.state.refs["heads/release/0.1.0"] = { object: { type: "commit", sha } };
  put("release.json", manifest);
  put("compat/hindsight.json", { channel: "release", ...pin });
  writeFileSync("pyproject.toml", '[project]\nversion = "0.1.0"\n');
  writeFileSync("image-digests.txt", `ghcr=${digest}\ndockerhub=${digest}\n`);
  return manifest;
}

test("pins reject floating tags, mismatched versions, malformed SHAs and injected input", () => {
  assert.deepEqual(release.validatePin(pin), pin);
  for (const bad of [
    { image: "ghcr.io/vectorize-io/hindsight:latest" },
    { version: "01.9.2" },
    { sha: "main" },
    { image: pin.image.replace(":0.9.2@", ":0.9.1@") },
    { version: "0.9.2\nmalicious" },
  ]) {
    assert.throws(() => release.validatePin({ ...pin, ...bad }));
  }
});

test("latest resolves versioned image and peels annotated upstream tags", async () => {
  const m = mock();
  m.github.rest.git.getRef = async () => ({ data: { object: { type: "tag", sha } } });
  m.github.rest.git.getTag = async () => ({ data: { object: { type: "commit", sha: base } } });
  assert.deepEqual(
    await release.latestHindsight(m.github, (image) => {
      assert.equal(image, "ghcr.io/vectorize-io/hindsight:0.9.2");
      return digest;
    }),
    pin,
  );
  m.github.rest.repos.getLatestRelease = () => ({ data: { tag_name: "openclaw-v0.12.0" } });
  await assert.rejects(release.latestHindsight(m.github, m.inspect), /stable Hindsight/);
});

test("main and release PRs resolve consistently; release never queries moving upstream", () =>
  fixture(async () => {
    const m = mock();
    assert.deepEqual(await release.resolve(m), pin);
    assert.equal(m.outputs.image, pin.image);
    put("compat/hindsight.json", { channel: "release", ...pin });
    m.context.payload.pull_request = { base: { ref: "release/0.1.0" } };
    m.github.rest.repos.getLatestRelease = () => {
      throw new Error("must not query latest");
    };
    assert.deepEqual(await release.resolve(m), { channel: "release", ...pin });
    put("compat/hindsight.json", { channel: "latest" });
    await assert.rejects(release.resolve(m), /frozen/);
  }));

test("reviewed versions are independent of upstream and cannot reuse reserved branches or tags", () =>
  fixture(async () => {
    assert.equal(release.releaseVersion([], []), "0.1.0");
    assert.throws(() => release.releaseVersion([{ name: "v0.1.0" }], []), /reserved/);
    assert.throws(() => release.releaseVersion([], [{ name: "release/0.1.0" }]), /reserved/);
    for (const version of ["0.1.0-router.1", "0.1.0+build.1", "01.1.0", "main", "0.1.0\n"]) {
      put("release-version.json", { version });
      assert.throws(() => release.releaseVersion([], []), /plain/);
    }
  }));

test("latest follows component release versions, ignoring older releases and drafts", () => {
  assert.equal(release.shouldPromote("0.1.10", [{ tag_name: "v0.1.9" }]), true);
  assert.equal(release.shouldPromote("0.1.10", [{ tag_name: "v0.2.0" }]), false);
  assert.equal(release.shouldPromote("0.1.0", [{ tag_name: "v0.2.0", draft: true }]), true);
  assert.equal(release.shouldPromote("0.1.0", [{ tag_name: "v0.2.0", prerelease: true }]), true);
});

test("rules require creation-only App bypass and retain branch/tag protection", () =>
  fixture(async () => {
    const m = mock();
    // Object key order in GitHub responses is immaterial.
    m.state.rules[0].bypass_actors = [{ bypass_mode: "always", actor_type: "Integration", actor_id: 123 }];
    await release.checkRules(m.github, m.context.repo, 123);
    m.state.rules[1].bypass_actors = [{ actor_id: 123, actor_type: "Integration", bypass_mode: "always" }];
    await assert.rejects(release.checkRules(m.github, m.context.repo, 123), /bypass/);
    m.state.rules[1].bypass_actors = [];
    m.state.rules[3].rules = [{ type: "deletion" }];
    await assert.rejects(release.checkRules(m.github, m.context.repo, 123), /protection/);
  }));

test("disabled naming exception and reduced scanning protections fail closed", () =>
  fixture(async () => {
    const m = mock();
    m.state.rules.at(-1).conditions.ref_name.exclude = [];
    await assert.rejects(release.checkRules(m.github, m.context.repo, 123), /Exclude/);
    m.state.rules.at(-1).conditions.ref_name.exclude = ["refs/heads/release/*"];
    m.state.rules[1].rules = m.state.rules[1].rules.filter((rule) => rule.type !== "code_scanning");
    await assert.rejects(release.checkRules(m.github, m.context.repo, 123), /scanning/);
  }));

test("preparation freezes inputs and retains the reviewed independent version", () =>
  fixture(async () => {
    const m = mock();
    await release.prepare(m);
    assert.deepEqual(m.state.calls, ["tree", "commit", "refs/heads/release/0.1.0"]);
    const files = Object.fromEntries(m.state.tree.map((item) => [item.path, item.content]));
    assert.deepEqual(JSON.parse(files["compat/hindsight.json"]), { channel: "release", ...pin });
    assert.equal(files["pyproject.toml"], undefined);
    assert.equal(JSON.parse(files["release.json"]).version, "0.1.0");
    m.state.prepared = JSON.parse(files["release.json"]);
    m.state.branches = [{ name: "release/0.1.0" }];
    await release.prepare(m);
    assert.equal(m.state.calls.length, 3, "rerunning preparation must not create another branch");
  }));

test("preparation rejects non-main dispatches and a main branch that advanced during checks", () =>
  fixture(async () => {
    const m = mock();
    m.context.ref = "refs/heads/ci/example";
    await assert.rejects(release.prepare(m), /main workflow button/);
    m.context.ref = "refs/heads/main";
    m.context.sha = sha;
    await assert.rejects(release.prepare(m), /Main advanced/);
    assert.equal(m.state.calls.length, 0);
  }));

test("release validation rejects changed pins, workflow changes, stale heads and moved tags", () =>
  fixture(async () => {
    const m = mock();
    const manifest = prepared(m);
    await release.validate(m);
    const changed = { ...manifest, hindsight: { ...pin, sha } };
    put("release.json", changed);
    put("compat/hindsight.json", { channel: "release", ...changed.hindsight });
    await assert.rejects(release.validate(m), /immutable/);
    prepared(m);
    m.state.comparison.files.push({ filename: ".github/workflows/release.yml" });
    await assert.rejects(release.validate(m), /automation/);
    m.state.comparison.files.pop();
    m.state.refs["heads/release/0.1.0"].object.sha = base;
    await assert.rejects(release.validate(m), /advanced/);
    prepared(m);
    m.state.refs["tags/v0.1.0"] = { object: { type: "commit", sha: base } };
    await assert.rejects(release.validate(m), /another commit/);
  }));

test("finalization publishes only after uploading assets and never moves or recreates its tag", () =>
  fixture(async () => {
    const m = mock();
    prepared(m);
    await release.finalize(m);
    assert.deepEqual(m.state.calls, [
      "refs/tags/v0.1.0",
      "draft",
      "asset:release.json",
      "asset:image-digests.txt",
      "publish",
    ]);
    assert.equal(m.outputs.latest, "true");
    await release.finalize(m);
    assert.equal(m.state.calls.filter((call) => call.startsWith("refs/tags/")).length, 1);
    m.state.assets[0].digest = `sha256:${"f".repeat(64)}`;
    await assert.rejects(release.finalize(m), /Existing release asset differs/);
  }));

test("partial release upload remains a draft and can be resumed without changing its tag", () =>
  fixture(async () => {
    const m = mock();
    prepared(m);
    m.state.failUpload = true;
    await assert.rejects(release.finalize(m), /upload failed/);
    assert.equal(m.state.release.draft, true);
    assert.equal(m.state.calls.includes("publish"), false);
    m.state.failUpload = false;
    await release.finalize(m);
    assert.equal(m.state.release.draft, false);
    assert.equal(m.state.calls.filter((call) => call.startsWith("refs/tags/")).length, 1);
  }));

test("publication rejects dispatch even when the selected ref is a release branch", () =>
  fixture(async () => {
    const m = mock();
    prepared(m);
    m.context.eventName = "workflow_dispatch";
    await assert.rejects(release.finalize(m), /only through the release workflow/);
    assert.deepEqual(m.state.calls, []);
  }));

test("integration package fixes can update tested assets while upstream pins remain frozen", () =>
  fixture(async () => {
    const m = mock();
    const manifest = prepared(m);
    m.context.repo.repo = "hindsight-memory-router-integrations";
    writeFileSync(
      "UPSTREAM_VERSION",
      `upstream_repo=vectorize-io/hindsight\nupstream_version=0.11.1\nupstream_commit=${base}\nupstream_path=hindsight-integrations/openclaw\n`,
    );
    mkdirSync("integrations/coding-agents", { recursive: true });
    put("integrations/coding-agents/UPSTREAM.json", {
      source: "https://github.com/vectorize-io/hindsight",
      version: "0.5.1",
      commit: base,
      path: "hindsight-integrations/coding-agents",
    });
    mkdirSync("src/upstream/coding-agents", { recursive: true });
    mkdirSync("packages");
    put("package.json", { name: "@example/openclaw", version: "0.12.0" });
    put("src/upstream/coding-agents/package.json", { name: "@example/coding-agents", version: "0.6.0" });
    writeFileSync("packages/example-openclaw-0.12.0.tgz", "original test fixture");
    writeFileSync("packages/example-coding-agents-0.6.0.tgz", "coding test fixture");
    manifest.packages = release.packageAssets();
    manifest.nix_openclaw = base;
    manifest.router = {
      version: "0.1.0",
      sha: base,
      image: `ghcr.io/mickey-kras/hindsight-memory-router@${digest}`,
      dockerhub_image: `docker.io/mickeykrasilnikov/hindsight-memory-router@${digest}`,
    };
    manifest.integration_upstreams = release.integrationUpstreams();
    m.state.prepared = structuredClone(manifest);
    put("release.json", manifest);
    await release.validate(m);
    put("package.json", { name: "@example/openclaw", version: "0.12.1" });
    writeFileSync("packages/example-openclaw-0.12.1.tgz", "fixed test fixture");
    await assert.rejects(release.validate(m), /Refresh release.json/);
    manifest.packages = release.packageAssets();
    put("release.json", manifest);
    await release.validate(m);
    manifest.nix_openclaw = sha;
    put("release.json", manifest);
    await assert.rejects(release.validate(m), /immutable/);
  }));

test("router pins reject floating images and mismatched registry digests", () => {
  const pin = {
    version: "0.1.0",
    sha: base,
    image: `ghcr.io/mickey-kras/hindsight-memory-router@${digest}`,
    dockerhub_image: `docker.io/mickeykrasilnikov/hindsight-memory-router@${digest}`,
  };
  release.validateRouter(pin);
  for (const change of [
    { image: "ghcr.io/mickey-kras/hindsight-memory-router:latest" },
    { sha: "main" },
    { dockerhub_image: pin.dockerhub_image.replace("cccc", "dddd") },
  ]) {
    assert.throws(() => release.validateRouter({ ...pin, ...change }));
  }
});

test("integration preparation requires a published immutable router for exactly the same Hindsight", async () => {
  const m = mock();
  const bytes = Buffer.from(
    `commit=${sha}\nversion=0.1.0\nghcr=ghcr.io/mickey-kras/hindsight-memory-router@${digest}\ndockerhub=docker.io/mickeykrasilnikov/hindsight-memory-router@${digest}\n`,
  );
  const published = { id: 8, tag_name: "v0.1.0", immutable: true, draft: false, prerelease: false };
  m.github.rest.repos.getLatestRelease = () => ({ data: published });
  m.state.refs["tags/v0.1.0"] = { object: { type: "commit", sha } };
  m.state.prepared = { schema: 2, version: "0.1.0", hindsight: pin, packages: [] };
  m.state.assets = [
    { id: 9, name: "image-digests.txt", digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` },
  ];
  m.github.rest.repos.getReleaseAsset = () => ({ data: bytes });
  assert.equal((await release.releasedRouter(m.github, pin)).sha, sha);
  await assert.rejects(release.releasedRouter(m.github, { ...pin, sha }), /current Hindsight/);
  published.immutable = false;
  await assert.rejects(release.releasedRouter(m.github, pin), /immutable router/);
  published.immutable = true;
  m.state.assets[0].digest = digest;
  await assert.rejects(release.releasedRouter(m.github, pin), /checksum/);
});

test("unchanged integration artifacts can be reused but changed bytes need a new package version", async () => {
  const m = mock();
  m.state.releases = [{ id: 1, tag_name: "v0.1.0", draft: false }];
  const pkg = { path: "packages/example-0.12.0.tgz", sha256: "c".repeat(64) };
  m.state.assets = [{ name: "example-0.12.0.tgz", digest }];
  await release.checkPackageReuse(m.github, m.context.repo, [pkg]);
  await assert.rejects(
    release.checkPackageReuse(m.github, m.context.repo, [{ ...pkg, sha256: "f".repeat(64) }]),
    /different bytes/,
  );
  await release.checkPackageReuse(m.github, m.context.repo, [{ ...pkg, path: "packages/example-0.12.1.tgz" }]);
});
