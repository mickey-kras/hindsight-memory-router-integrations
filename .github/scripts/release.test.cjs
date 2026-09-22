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
    tagObjects: {},
    rules: rulesets(123),
    tags: [],
    branches: [],
    calls: [],
    errors: [],
    assets: [],
    releases: [],
    pulls: [],
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
        getContent: ({ path }) =>
          data(
            path === "release.json"
              ? encode(state.prepared)
              : { type: "file", encoding: "base64", content: readFileSync(path).toString("base64") },
          ),
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
          Object.assign(state.release, args, { immutable: !args.draft });
          return data(state.release);
        },
        createOrUpdateFileContents: (args) => {
          state.calls.push(`file:${args.branch}`);
          return data({});
        },
      },
      pulls: {
        list: () => data(state.pulls),
        create: (args) => {
          state.calls.push(`pr:${args.head}`);
          state.pulls.push({ number: 7, head: { ref: args.head } });
          return data(state.pulls[0]);
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
        createTag: (args) => {
          state.calls.push(`tag:${args.tag}`);
          assert.equal(args.type, "commit");
          assert.equal(typeof args.message, "string");
          const tagSha = `f${state.calls.length}`.padEnd(40, "0");
          state.tagObjects[tagSha] = { sha: tagSha, tag: args.tag, object: { type: "commit", sha: args.object } };
          return data(state.tagObjects[tagSha]);
        },
        getTag: ({ tag_sha }) => data(state.tagObjects[tag_sha]),
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
          const type = state.tagObjects[commit] ? "tag" : "commit";
          state.refs[ref.replace(/^refs\//, "")] = { object: { type, sha: commit } };
          return data({});
        },
        deleteRef: async ({ ref }) => {
          if (state.failDelete) throw new Error("forbidden");
          if (!state.refs[ref]) return notFound();
          state.calls.push(`delete:${ref}`);
          delete state.refs[ref];
          return data({});
        },
      },
    },
    paginate: async (method, args) => (await method(args)).data,
  };
  const outputs = {};
  const summary = {
    addHeading: () => summary,
    addRaw: () => summary,
    write: async () => {},
  };
  const core = {
    setOutput: (key, value) => {
      outputs[key] = value;
    },
    summary,
    error: (message) => state.errors.push(message),
  };
  const context = {
    repo: { owner: "example", repo: "hindsight-memory-router" },
    eventName: "workflow_dispatch",
    workflow: "release",
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
    m.state.rules.find((rule) => rule.name === "Protect release tags").rules = [{ type: "deletion" }];
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
    put("compat/hindsight.json", { channel: "release", ...pin });
    m.state.branches = [{ name: "release/0.1.0" }];
    await release.prepare(m);
    assert.equal(m.state.calls.length, 3, "rerunning preparation must not create another branch");
  }));

test("preparation rejects non-main dispatches and a main branch that advanced during checks", () =>
  fixture(async () => {
    const m = mock();
    m.context.ref = "refs/heads/ci/example";
    await assert.rejects(release.prepare(m), /only from main/);
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
    m.state.refs["tags/v0.1.0"] = { object: { type: "tag", sha: "e".repeat(40) } };
    m.state.tagObjects["e".repeat(40)] = { object: { type: "commit", sha: base } };
    await assert.rejects(release.validate(m), /another commit/);
  }));

test("finalization publishes only after uploading assets and never moves or recreates its tag", () =>
  fixture(async () => {
    const m = mock();
    prepared(m);
    await release.finalize(m);
    assert.deepEqual(m.state.calls, [
      "tag:v0.1.0",
      "refs/tags/v0.1.0",
      "draft",
      "asset:release.json",
      "asset:image-digests.txt",
      "publish",
    ]);
    assert.equal(m.outputs.latest, "true");
    const ref = m.state.refs["tags/v0.1.0"];
    assert.equal(ref.object.type, "tag");
    assert.equal(m.state.tagObjects[ref.object.sha].object.sha, m.context.sha);
    m.state.refs["heads/release/0.1.0"] = { object: { type: "commit", sha } };
    await release.finalize(m);
    assert.equal(m.state.calls.filter((call) => call.startsWith("refs/tags/")).length, 1);
    assert.equal(m.state.calls.filter((call) => call.startsWith("tag:")).length, 1);
    assert.equal(m.state.calls.filter((call) => call.startsWith("pr:")).length, 0);
    m.state.refs["heads/release/0.1.0"] = { object: { type: "commit", sha } };
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
    await assert.rejects(release.finalize(m), /only from main/);
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
    mkdirSync("src/mcp", { recursive: true });
    mkdirSync("packages", { recursive: true });
    put("package.json", { name: "@example/openclaw", version: "0.12.0" });
    put("src/upstream/coding-agents/package.json", { name: "@example/coding-agents", version: "0.6.0" });
    put("src/mcp/package.json", { name: "@example/mcp", version: "0.1.0" });
    writeFileSync("packages/example-openclaw-0.12.0.tgz", "original test fixture");
    writeFileSync("packages/example-coding-agents-0.6.0.tgz", "coding test fixture");
    writeFileSync("packages/example-mcp-0.1.0.tgz", "mcp test fixture");
    manifest.packages = release.packageAssets();
    assert.deepEqual(
      manifest.packages.map((pkg) => pkg.name),
      ["@example/openclaw", "@example/coding-agents", "@example/mcp"],
      "the bundle must carry all three packages as separate entries",
    );
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
    put("release.json", { ...manifest, packages: manifest.packages.slice(0, 2) });
    await assert.rejects(release.validate(m), /Invalid release package inventory/);
    put("release.json", manifest);
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

test("preparation refuses a main update during upstream resolution before creating the branch", () =>
  fixture(async () => {
    const m = mock();
    m.context.eventName = "workflow_dispatch";
    m.context.ref = "refs/heads/main";
    m.context.sha = base;
    m.inspect = () => {
      m.state.refs["heads/main"].object.sha = sha;
      return digest;
    };
    await assert.rejects(release.prepare(m), /Main advanced while freezing/);
    assert.ok(!m.state.calls.some((call) => call.startsWith("refs/heads/release/")));
  }));

test("redacted bypass actors require an owner review of the current ruleset revision", () =>
  fixture(async () => {
    const rule = { ...rulesets(123)[0], id: 41, updated_at: "2026-09-11T00:00:00Z" };
    delete rule.bypass_actors;
    const previous = process.env.RELEASE_SETTINGS_REVIEW;
    delete process.env.RELEASE_SETTINGS_REVIEW;
    const check = () => release.checkRule(rule, "branch", "refs/heads/release/*", ["creation"], 123);
    try {
      assert.throws(check, /owner-reviewed/);
      process.env.RELEASE_SETTINGS_REVIEW = JSON.stringify({
        app_id: 123,
        immutable_releases: true,
        rulesets: { 41: rule.updated_at },
      });
      check();
      process.env.RELEASE_SETTINGS_REVIEW = JSON.stringify({
        app_id: 123,
        immutable_releases: true,
        rulesets: { 41: "2026-09-10T17:00:00.000-07:00" },
      });
      check();
      rule.updated_at = "2026-09-11T00:00:00.001Z";
      assert.throws(check, /owner-reviewed/);
      rule.updated_at = "2026-09-11T00:01:00Z";
      assert.throws(check, /owner-reviewed/);
      process.env.RELEASE_SETTINGS_REVIEW = "invalid";
      assert.throws(check, /Invalid RELEASE_SETTINGS_REVIEW/);
    } finally {
      if (previous === undefined) delete process.env.RELEASE_SETTINGS_REVIEW;
      else process.env.RELEASE_SETTINGS_REVIEW = previous;
    }
  }));

test("retry backs off on transient failures and rethrows permanent ones", async () => {
  const sleep = async () => {};
  const fail = (status) => () => Promise.reject(Object.assign(new Error("boom"), { status }));
  let calls = 0;
  const flaky = () => (calls++ < 2 ? Promise.reject(Object.assign(new Error("boom"), { status: 502 })) : "ok");
  assert.equal(await release.retry(flaky, sleep), "ok");
  assert.equal(calls, 3);
  await assert.rejects(release.retry(fail(502), sleep), /boom/);
  for (const status of [400, 403, 404, 422]) {
    let attempts = 0;
    await assert.rejects(
      release.retry(() => {
        attempts++;
        return fail(status)();
      }, sleep),
      /boom/,
    );
    assert.equal(attempts, 1, `status ${status} must not be retried`);
  }
  let rateLimited = 0;
  await assert.rejects(
    release.retry(() => {
      rateLimited++;
      return fail(429)();
    }, sleep),
    /boom/,
  );
  assert.equal(rateLimited, 3);
  assert.equal(await release.retry(() => "plain"), "plain");
});

test("latestHindsight retries transient release lookups and inspect failures", async () => {
  const m = mock();
  let lookups = 0;
  m.github.rest.repos.getLatestRelease = () =>
    lookups++ === 0
      ? Promise.reject(Object.assign(new Error("timeout"), { status: 503 }))
      : { data: { tag_name: "v0.9.2", draft: false, prerelease: false } };
  let inspects = 0;
  const pin = await release.latestHindsight(m.github, () => {
    inspects++;
    if (inspects === 1) throw Object.assign(new Error("registry timeout"), {});
    return digest;
  });
  assert.equal(pin.version, "0.9.2");
  assert.equal(lookups, 2);
  assert.equal(inspects, 2);
});

function integrationPrepared(m, unified = true) {
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
  mkdirSync("src/mcp", { recursive: true });
  mkdirSync("packages", { recursive: true });
  put("package.json", { name: "@example/openclaw", version: "0.12.0" });
  put("src/upstream/coding-agents/package.json", { name: "@example/coding-agents", version: "0.6.0" });
  put("src/mcp/package.json", { name: "@example/mcp", version: "0.1.0" });
  writeFileSync("packages/example-openclaw-0.12.0.tgz", "original test fixture");
  writeFileSync("packages/example-coding-agents-0.6.0.tgz", "coding test fixture");
  writeFileSync("packages/example-mcp-0.1.0.tgz", "mcp test fixture");
  manifest.packages = release.packageAssets();
  assert.deepEqual(
    manifest.packages.map((pkg) => pkg.name),
    ["@example/openclaw", "@example/coding-agents", "@example/mcp"],
    "the bundle must carry all three packages as separate entries",
  );
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
  if (unified) {
    manifest.publication_run = m.context.runId;
    m.context.eventName = "workflow_dispatch";
    m.context.ref = "refs/heads/main";
    m.context.sha = base;
    m.target = { ref: "refs/heads/release/0.1.0", sha };
    m.state.prepared = structuredClone(manifest);
    put("release.json", manifest);
  }
  writeFileSync("PACKAGE_SHA256", "fixture checksums");
  writeFileSync("PACKAGE_NIX_HASHES", "fixture Nix hashes");
  return manifest;
}

function bumpApi(m) {
  m.state.refs["tags/v0.1.0"] = { object: { type: "commit", sha } };
  m.state.release = { id: 1, immutable: true, draft: false, prerelease: false };
  m.state.refs["heads/release/0.1.0"] = { object: { type: "commit", sha } };
  m.github.rest.pulls.get = () => ({
    data: {
      state: "open",
      draft: false,
      base: { ref: "main" },
      head: {
        ref: "ci/bump-release-version-0-1-1",
        sha,
        repo: { full_name: "example/hindsight-memory-router-integrations" },
      },
    },
  });
  m.github.rest.pulls.listFiles = () => ({
    data: [
      {
        filename: "release-version.json",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: '-  "version": "0.1.0"\n+  "version": "0.1.1"',
      },
    ],
  });
  m.merge = (args) => {
    m.state.calls.push(`merge:${args.number}:${args.sha}`);
  };
}

test("main-only dispatch rejects another workflow, PR, tag, or branch before API access", async () => {
  for (const change of [
    { workflow: "main" },
    { eventName: "pull_request" },
    { ref: "refs/tags/v0.1.0" },
    { ref: "refs/heads/release/0.1.0" },
    { sha: "main" },
  ]) {
    const m = mock();
    Object.assign(m.context, change);
    m.github = {};
    await assert.rejects(release.prepare(m), /only from main/);
  }
});

test("unified publication uses the explicit candidate while preserving its main caller", () =>
  fixture(async () => {
    const m = mock();
    integrationPrepared(m);
    await release.finalize(m);
    const tagged = m.state.tagObjects[m.state.refs["tags/v0.1.0"].object.sha];
    assert.equal(tagged.object.sha, sha);
    assert.equal(m.state.release.target_commitish, sha);
    assert.equal(m.context.sha, base);
    assert.equal(m.context.ref, "refs/heads/main");
    assert.deepEqual(
      m.state.assets.map((asset) => asset.name),
      [
        "release.json",
        "example-openclaw-0.12.0.tgz",
        "example-coding-agents-0.6.0.tgz",
        "example-mcp-0.1.0.tgz",
        "PACKAGE_SHA256",
        "PACKAGE_NIX_HASHES",
      ],
    );
  }));

test("publication rejects a candidate from another base or a candidate changed after preparation", () =>
  fixture(async () => {
    const m = mock();
    integrationPrepared(m);
    m.context.sha = "c".repeat(40);
    await assert.rejects(release.validate(m), /another main snapshot/);
    m.context.sha = base;
    m.state.comparison.total_commits = 2;
    m.state.comparison.commits.push({ sha: "d".repeat(40) });
    await assert.rejects(release.validate(m), /changed after preparation/);
    assert.deepEqual(m.state.calls, []);
  }));

test("native preparation retry retains its frozen candidate even after main advances", () =>
  fixture(async () => {
    const m = mock();
    integrationPrepared(m);
    m.state.branches = [{ name: "release/0.1.0" }];
    m.state.refs["heads/main"].object.sha = "d".repeat(40);
    m.github.rest.repos.getLatestRelease = () => {
      throw new Error("must not refresh pins");
    };
    await release.prepare(m);
    assert.equal(m.outputs.sha, sha);
    assert.equal(m.outputs.ref, m.target.ref);
    assert.deepEqual(m.state.calls, []);
  }));

test("another dispatch delegates recovery to the original run without starting publication", () =>
  fixture(async () => {
    const m = mock();
    integrationPrepared(m);
    m.state.branches = [{ name: "release/0.1.0" }];
    m.context.runId = 9;
    await release.prepare(m);
    assert.equal(m.outputs.resume_run, 5);
    assert.equal(m.outputs.resume_sha, sha);
    assert.equal(m.outputs.sha, undefined);
  }));

test("preparation recovers an acknowledged-lost branch creation without reserving another version", () =>
  fixture(async () => {
    const m = mock();
    const create = m.github.rest.git.createRef;
    m.github.rest.git.createRef = (args) => {
      create(args);
      m.state.prepared = JSON.parse(m.state.tree.find((file) => file.path === "release.json").content);
      m.state.branches = [{ name: "release/0.1.0" }];
      throw new Error("lost response");
    };
    await assert.rejects(release.prepare(m), /lost response/);
    put("compat/hindsight.json", { channel: "release", ...pin });
    await release.prepare(m);
    assert.equal(m.outputs.sha, sha);
    assert.equal(m.state.calls.filter((call) => call === "refs/heads/release/0.1.0").length, 1);
  }));

test("native retries recover after successful annotated-tag publication and candidate cleanup", () =>
  fixture(async () => {
    const m = mock();
    integrationPrepared(m);
    await release.finalize(m);
    delete m.state.refs["heads/release/0.1.0"];
    m.state.tags = [{ name: "v0.1.0" }];
    m.state.refs["heads/main"].object.sha = "d".repeat(40);
    await release.prepare(m);
    assert.equal(m.outputs.sha, sha);
    await release.finalize(m);
    assert.equal(m.state.calls.filter((call) => call === "refs/tags/v0.1.0").length, 1);
    m.state.assets[2].digest = `sha256:${"e".repeat(64)}`;
    await assert.rejects(release.finalize(m), /Existing release asset differs/);
  }));

test("missing candidate recovery rejects drafts and foreign immutable tag targets", () =>
  fixture(async () => {
    const m = mock();
    integrationPrepared(m);
    delete m.state.refs["heads/release/0.1.0"];
    m.state.release = { draft: true };
    await assert.rejects(release.validate(m), /no immutable release/);
    m.state.release = { immutable: true, draft: false, prerelease: false };
    m.state.refs["tags/v0.1.0"] = { object: { type: "commit", sha: base } };
    await assert.rejects(release.validate(m), /not immutable and published at this commit/);
  }));

function recoveryApi(m, conclusion = "failure") {
  m.github.rest.actions = {
    getWorkflowRun: async () => ({
      data: {
        id: 5,
        path: ".github/workflows/release.yml",
        event: "workflow_dispatch",
        head_branch: "main",
        head_sha: base,
        status: "completed",
        conclusion,
      },
    }),
    reRunWorkflowFailedJobs: async () => {
      m.state.calls.push("retry-failed");
    },
    reRunWorkflow: async () => {
      m.state.calls.push("retry-all");
    },
  };
  m.context.runId = 9;
}

test("failed and cancelled releases use native recovery on their original run", () =>
  fixture(async () => {
    for (const conclusion of ["failure", "cancelled"]) {
      const m = mock();
      integrationPrepared(m);
      recoveryApi(m, conclusion);
      await release.resumePreparedRelease({ ...m, version: "0.1.0", sha, runId: 5 });
      assert.deepEqual(m.state.calls, [conclusion === "failure" ? "retry-failed" : "retry-all"]);
    }
  }));

test("recovery refuses a foreign run and a candidate that moved before retry", () =>
  fixture(async () => {
    const m = mock();
    integrationPrepared(m);
    recoveryApi(m);
    const fetchRun = m.github.rest.actions.getWorkflowRun;
    m.github.rest.actions.getWorkflowRun = async () => {
      const value = await fetchRun();
      value.data.head_sha = sha;
      return value;
    };
    await assert.rejects(release.resumePreparedRelease({ ...m, version: "0.1.0", sha, runId: 5 }), /source snapshot/);
    m.github.rest.actions.getWorkflowRun = async () => {
      m.state.refs["heads/release/0.1.0"].object.sha = base;
      return fetchRun();
    };
    await assert.rejects(
      release.resumePreparedRelease({ ...m, version: "0.1.0", sha, runId: 5 }),
      /advanced before retry/,
    );
    assert.deepEqual(m.state.calls, []);
  }));

test("retained package retries reuse bytes and fail closed on expired or missing publication artifacts", () =>
  fixture(async () => {
    const m = mock();
    integrationPrepared(m);
    const saved = { id: 17, name: `packages-${sha}`, expired: false };
    let artifacts = [saved];
    m.github.rest.actions = { listWorkflowRunArtifacts: async () => ({ data: artifacts }) };
    await release.retryPackages(m);
    assert.equal(m.outputs.artifact, "17");
    saved.expired = true;
    await assert.rejects(release.retryPackages(m), /expired/);
    artifacts = [];
    m.state.refs["tags/v0.1.0"] = { object: { type: "commit", sha } };
    await assert.rejects(release.retryPackages(m), /retained release packages are missing/);
  }));

test("candidate provenance appends source identity without replacing authenticated workflow claims", () =>
  fixture(async () => {
    const m = mock();
    integrationPrepared(m);
    const before = process.env.RUNNER_TEMP;
    process.env.RUNNER_TEMP = process.cwd();
    const uri = `git+https://github.com/${m.context.repo.owner}/${m.context.repo.repo}@refs/heads/main`;
    const predicate = {
      type: "https://slsa.dev/provenance/v1",
      params: {
        buildDefinition: { resolvedDependencies: [{ uri, digest: { gitCommit: base } }] },
        runDetails: { builder: { id: "authenticated-builder" } },
      },
    };
    try {
      const result = await release.candidateProvenance({ ...m, build: async () => structuredClone(predicate) });
      assert.deepEqual(result.params.runDetails, predicate.params.runDetails);
      assert.deepEqual(result.params.buildDefinition.resolvedDependencies, [
        predicate.params.buildDefinition.resolvedDependencies[0],
        { name: "release-candidate", uri: uri.replace("refs/heads/main", m.target.ref), digest: { gitCommit: sha } },
      ]);
      predicate.params.buildDefinition.resolvedDependencies[0].digest.gitCommit = sha;
      await assert.rejects(release.candidateProvenance({ ...m, build: async () => predicate }), /claims differ/);
    } finally {
      if (before === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = before;
    }
  }));

test("version follow-up queues only the single manifest bump and preserves package versions", () =>
  fixture(async () => {
    const m = mock();
    integrationPrepared(m);
    bumpApi(m);
    await release.bumpReleasedVersion(m);
    assert.deepEqual(
      m.state.tree.map((file) => file.path),
      ["release-version.json"],
    );
    assert.equal(m.state.calls.at(-1), `merge:7:${sha}`);
    assert.ok(m.state.refs["heads/release/0.1.0"]);
    await release.bumpReleasedVersion(m);
    assert.equal(m.state.calls.filter((call) => call.startsWith("pr:")).length, 1);
    await release.deletePublishedBranch(m);
    assert.equal(m.state.refs["heads/release/0.1.0"], undefined);
  }));

test("version follow-up fails loudly and retains the candidate when queueing fails", () =>
  fixture(async () => {
    const m = mock();
    integrationPrepared(m);
    bumpApi(m);
    m.merge = () => {
      throw new Error("queue unavailable");
    };
    await assert.rejects(release.bumpReleasedVersion(m), /queue unavailable/);
    assert.ok(m.state.refs["heads/release/0.1.0"]);
    assert.ok(!m.state.calls.some((call) => call.startsWith("delete:heads/release/")));
  }));

test("version follow-up rejects edited PRs and unpublished tags before merging or deleting", () =>
  fixture(async () => {
    const m = mock();
    integrationPrepared(m);
    bumpApi(m);
    m.state.pulls = [{ number: 7 }];
    m.github.rest.pulls.listFiles = () => ({ data: [{ filename: "README.md" }] });
    await assert.rejects(release.bumpReleasedVersion(m), /beyond the next patch version/);
    m.state.release.draft = true;
    await assert.rejects(release.deletePublishedBranch(m), /not immutable/);
    assert.deepEqual(m.state.calls, []);
  }));

test("cleanup does not delete a candidate advanced beyond its published tag", () =>
  fixture(async () => {
    const m = mock();
    integrationPrepared(m);
    bumpApi(m);
    m.state.refs["heads/release/0.1.0"].object.sha = base;
    await assert.rejects(release.deletePublishedBranch(m), /advanced past the published commit/);
    assert.deepEqual(m.state.calls, []);
  }));

test("preparation freezes all three packages with the tested router and upstream pins", () =>
  fixture(async () => {
    const m = mock();
    const fixtureManifest = integrationPrepared(m);
    delete m.state.refs["heads/release/0.1.0"];
    put("compat/hindsight.json", { channel: "latest" });
    const routerManifest = { schema: 2, version: "0.1.0", hindsight: pin, packages: [] };
    const bytes = Buffer.from(
      `version=0.1.0\ncommit=${base}\nghcr=${fixtureManifest.router.image}\ndockerhub=${fixtureManifest.router.dockerhub_image}\n`,
    );
    m.github.rest.repos.getLatestRelease = ({ repo }) => ({
      data:
        repo === "hindsight"
          ? { tag_name: "v0.9.2", draft: false, prerelease: false }
          : { id: 19, tag_name: "v0.1.0", immutable: true, draft: false, prerelease: false },
    });
    const getRef = m.github.rest.git.getRef;
    m.github.rest.git.getRef = (args) =>
      args.repo === "hindsight-memory-router" ? { data: { object: { type: "commit", sha: base } } } : getRef(args);
    m.github.rest.repos.getContent = () => ({ data: encode(routerManifest) });
    m.github.rest.repos.listReleaseAssets = () => ({
      data: [
        { id: 20, name: "image-digests.txt", digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` },
      ],
    });
    m.github.rest.repos.getReleaseAsset = () => ({ data: bytes });
    await release.prepare(m);
    const manifest = JSON.parse(m.state.tree.find((file) => file.path === "release.json").content);
    assert.deepEqual(manifest.packages, fixtureManifest.packages);
    assert.deepEqual(manifest.router, fixtureManifest.router);
    assert.deepEqual(manifest.integration_upstreams, fixtureManifest.integration_upstreams);
    assert.equal(manifest.nix_openclaw, base);
    assert.equal(manifest.publication_run, m.context.runId);
    assert.equal(m.outputs.sha, sha);
  }));

test("version follow-up accepts a later main version but rejects a rollback or invalid version", () =>
  fixture(async () => {
    const m = mock();
    integrationPrepared(m);
    bumpApi(m);
    put("release-version.json", { version: "0.2.0" });
    await release.bumpReleasedVersion(m);
    assert.deepEqual(m.state.calls, []);
    for (const version of ["0.0.9", "invalid"]) {
      put("release-version.json", { version });
      await assert.rejects(release.bumpReleasedVersion(m), /must advance/);
    }
  }));

test("cleanup retry resumes after deleting its candidate when pruning an older branch failed", () =>
  fixture(async () => {
    const m = mock();
    integrationPrepared(m);
    bumpApi(m);
    m.state.branches = [{ name: "release/0.0.9" }];
    m.state.refs["heads/release/0.0.9"] = { object: { type: "commit", sha: base } };
    m.state.tagObjects["f".repeat(40)] = { object: { type: "commit", sha: base } };
    m.state.refs["tags/v0.0.9"] = { object: { type: "tag", sha: "f".repeat(40) } };
    const remove = m.github.rest.git.deleteRef;
    m.github.rest.git.deleteRef = async (args) => {
      if (args.ref === "heads/release/0.0.9") throw new Error("temporary prune failure");
      return remove(args);
    };
    await assert.rejects(release.deletePublishedBranch(m), /temporary prune failure/);
    assert.equal(m.state.refs["heads/release/0.1.0"], undefined);
    m.github.rest.git.deleteRef = remove;
    await release.deletePublishedBranch(m);
    assert.equal(m.state.refs["heads/release/0.0.9"], undefined);
  }));
